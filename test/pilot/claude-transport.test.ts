/**
 * Track E: the live headless Claude Code transport, with an injected FAKE spawn. No `claude`
 * process runs: the fake checks the argv and environment it is handed and replays canned
 * `--output-format json` output. Covers the MCP config write, the allowlisted environment,
 * claim and usage parsing, and the harness-fault classification (rate limit, transport
 * error, spawn failure, timeout).
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { scriptedDocument } from "../../src/benchmark/r1-dryrun.ts";
import { mcpConfigJson } from "../../src/integrity/launch.ts";
import {
  classOfStatus,
  classOfText,
  claudeDriver,
  interpretResult,
  parseClaim,
  type SpawnFn,
} from "../../src/pilot/claude-transport.ts";
import { CHILD_ENV_ALLOWLIST, configSha256 } from "../../src/pilot/config.ts";
import { virtualClock } from "../../src/pilot/dry-run.ts";
import { trialLaunchPlan } from "../../src/pilot/launch.ts";
import { loadLedger, PROGRESS_FILE } from "../../src/pilot/ledger.ts";
import { HarnessFault, runPilot } from "../../src/pilot/runner.ts";
import {
  CLEAN_RESULT_FAULT_PHRASES,
  CLEAN_RESULT_TASK_DATA,
  config,
  FAULT_WORDING,
  FOLDED_USAGE_PHRASES,
  NBSP,
  PUBLISHED,
  ROOT,
  SOURCES,
  spaced,
  THIN_SPACE,
  tmp,
  UNICODE_SPACES,
  UNMAPPED_STRUCTURED,
  USAGE_LIMIT_PHRASES,
  ZWSP,
} from "./helpers.ts";

interface Call {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

/**
 * A fake child process that prints `stdout` and exits `code`, or hangs until killed. With
 * `ignoreTerm` it ignores SIGTERM and only a SIGKILL ends it. `signals` records every kill.
 */
function fakeSpawn(stdout: string, code: number | null = 0, hang = false, ignoreTerm = false) {
  const calls: Call[] = [];
  const signals: string[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const out = new PassThrough();
    const err = new PassThrough();
    Object.assign(child, {
      stdout: out,
      stderr: err,
      kill: (signal: string = "SIGTERM") => {
        signals.push(signal);
        if (!(ignoreTerm && signal === "SIGTERM")) setImmediate(() => child.emit("close", null));
        return true;
      },
    });
    if (!hang)
      setImmediate(() => {
        out.write(stdout);
        out.end();
        err.end();
        setImmediate(() => child.emit("close", code));
      });
    return child;
  };
  return { spawn, calls, signals };
}

const result = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
    ...extra,
  });

function setup(stdout: string, code: number | null = 0, hang = false, ignoreTerm = false) {
  const task = PUBLISHED.find((t) => t.taskId === "fc-v1-001");
  if (task === undefined) throw new Error("fixture");
  const trialDir = tmp();
  const ids = { runId: "r1p-fc-v1-001-a1", trialKey: "r1p-fc-v1-001-a1" };
  const plan = trialLaunchPlan(config(), task, ids, trialDir, ROOT);
  const fake = fakeSpawn(stdout, code, hang, ignoreTerm);
  const controller = new AbortController();
  const driver = claudeDriver({
    spawn: fake.spawn,
    command: "claude",
    env: { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "synthetic", SOMETHING: "else" },
    envAllowlist: CHILD_ENV_ALLOWLIST,
    capture: async () => ({ "persisted/doc.csv": new Uint8Array() }),
    killGraceMs: 5,
  });
  const transport = driver.transport({ task, ...ids, trialDir, signal: controller.signal });
  return { plan, fake, transport, trialDir, controller };
}

describe("headless Claude Code transport (fake spawn)", () => {
  it("writes the MCP config, spawns exactly the audited argv with allowlisted env names only", async () => {
    const { plan, fake, transport, trialDir } = setup(result("Edited the cell.\nDONE"));
    await transport.runAgent(plan, null);
    expect(readFileSync(plan.mcpConfigPath, "utf8")).toBe(mcpConfigJson(plan));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.command).toBe("claude");
    expect(fake.calls[0]?.args).toEqual(plan.argv);
    expect(Object.keys(fake.calls[0]?.options.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    expect(fake.calls[0]?.options.cwd).toBe(trialDir);
    expect(transport.report()).toEqual({
      claim: "done",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 20,
      },
    });
    expect(readFileSync(join(trialDir, "transcript.json"), "utf8")).toContain('"type":"result"');
  });

  it("reads the claim from the last line only", () => {
    expect(parseClaim("did it\nDONE")).toBe("done");
    expect(parseClaim("could not\nNOT DONE\n")).toBe("not-done");
    expect(parseClaim("DONE\nmaybe")).toBe("no-claim");
    expect(parseClaim("done")).toBe("no-claim");
  });

  // Verifier round 1, D2: every probe from the verdict, and the "uncertain is a harness fault" rule.
  const faultOf = (fn: () => unknown) => {
    try {
      fn();
      return "none";
    } catch (e) {
      return e instanceof HarnessFault ? e.harnessClass : "other";
    }
  };

  it("classifies each limit and login message from the round-1 verdict as a harness fault on a run that did not complete normally", () => {
    const probes: [string, string][] = [
      ["Claude AI usage limit reached|1700000000", "usage-limit"],
      ["Sonnet limit reached · resets 3pm", "usage-limit"],
      ["5-hour limit reached ∙ resets 3pm", "usage-limit"],
      ["Weekly limit reached ∙ resets Mon", "usage-limit"],
      ["Invalid API key · Please run /login", "auth"],
    ];
    for (const [text, cls] of probes) {
      expect(faultOf(() => interpretResult(result(text, { is_error: true }), "", 1))).toBe(cls);
      // An unflagged result from a process that exited non-zero did not complete normally.
      expect(faultOf(() => interpretResult(result(text), "", 1))).toBe(cls);
      // And as bare stderr with no JSON result at all.
      expect(faultOf(() => interpretResult("", text, 1))).toBe(cls);
      // A CLEAN, completed result WITH a claim line is the agent's outcome even with this
      // text; without one, quota wording is usage-limit (round 3, R2-D3b) and the exact CLI
      // login wording is auth (#607 round 3, L1).
      expect(interpretResult(result(`${text}\nNOT DONE`), "", 0).claim).toBe("not-done");
      expect(faultOf(() => interpretResult(result(text), "", 0))).toBe(cls);
    }
  });

  // Verifier round 2, D4: the text fallback never applies to a clean, completed run. Each
  // probe from the verdict, plus fixture-shaped text (fc-v1 holds qty 401, 403 and 429).
  it("a clean completed run with no claim is the agent's outcome unless it names the usage quota (round 2, D4; round 3, R2-D3b)", () => {
    const probes = [
      "I updated the billing totals in column C.",
      "Fixed the quota column. Done.",
      "The cell was locked (forbidden). I stopped.",
      "I set the credential column to blank.",
      "I looked at EMP-0055: its qty is 429. I could not save the file.",
      "Row EMP-0127 has qty 401; I left it unchanged.",
      "EMP-0090 qty 403 is now 430.",
      // #607 round 3, L1: the broad words alone ("API key", "login", "OAuth", "credit") stay
      // the agent's; only the exact CLI phrases stop (next test).
      "I renamed the API key column and the OAuth login field; credit was unchanged.",
    ];
    for (const text of probes) {
      expect([text, faultOf(() => interpretResult(result(text), "", 0))]).toEqual([text, "none"]);
      expect([text, interpretResult(result(text), "", 0).claim]).toEqual([text, "no-claim"]);
    }
    // Usage-quota wording with no claim line fails closed to usage-limit (stop, nothing
    // counted), even when it might be the agent's prose: the coordinator's narrow fix.
    const quotaish = [
      "Done — the weekly limit column is fixed.",
      "The pay period resets on Mon 3 March.",
      "Set the API key column header and the OAuth flag; usage limit noted in B4.",
      "Claude AI usage limit reached|1700000000",
    ];
    for (const text of quotaish) {
      expect([text, faultOf(() => interpretResult(result(text), "", 0))]).toEqual([
        text,
        "usage-limit",
      ]);
      // With a claim line it is never reclassified.
      for (const [line, claim] of [
        ["DONE", "done"],
        ["NOT DONE", "not-done"],
      ] as const)
        expect([text, interpretResult(result(`${text}\n${line}`), "", 0).claim]).toEqual([
          text,
          claim,
        ]);
    }
    // The fallback still fires when the same run did NOT complete normally.
    expect(faultOf(() => interpretResult(result(probes[4] as string), "", 1))).toBe("rate-limit");
    expect(faultOf(() => interpretResult(result(probes[5] as string), "", 1))).toBe("auth");
  });

  // Verifier round 2, V-B and V-C: auth outranks rate-limit in the structured class, and
  // HTTP 403 is auth (both pause, which is the safe direction for a lost or refused login).
  it("structured auth outranks rate-limit, and 403 is auth (round 2, V-B, V-C)", () => {
    expect(classOfStatus(403)).toBe("auth");
    expect(classOfStatus(401)).toBe("auth");
    expect(classOfStatus(429)).toBe("rate-limit");
    expect(classOfStatus(500)).toBe("error-result");
    const both = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      JSON.stringify([
        { type: "assistant", message: { content: [] }, ...a },
        { type: "assistant", message: { content: [] }, ...b },
        JSON.parse(result("API Error", { is_error: true })),
      ]);
    expect(
      faultOf(() =>
        interpretResult(both({ error: "rate_limit" }, { api_error_status: 403 }), "", 1),
      ),
    ).toBe("auth");
    expect(
      faultOf(() =>
        interpretResult(both({ api_error_status: 429 }, { error: "authentication_failed" }), "", 1),
      ),
    ).toBe("auth");
    expect(faultOf(() => interpretResult(both({ api_error_status: 403 }, {}), "", 1))).toBe("auth");
  });

  it("classifies from structured fields first: the error class and the API status", () => {
    const verbose = (assistant: Record<string, unknown>, res: Record<string, unknown> = {}) =>
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "assistant", message: { content: [] }, ...assistant },
        JSON.parse(result("API Error", { is_error: true, ...res })),
      ]);
    expect(faultOf(() => interpretResult(verbose({ error: "rate_limit" }), "", 1))).toBe(
      "rate-limit",
    );
    expect(faultOf(() => interpretResult(verbose({ error: "overloaded" }), "", 1))).toBe(
      "rate-limit",
    );
    // TIF-274 live driver: a billing error stops the run (fail closed), it is not a rate limit.
    expect(faultOf(() => interpretResult(verbose({ error: "billing_error" }), "", 1))).toBe(
      "billing",
    );
    expect(faultOf(() => interpretResult(verbose({ api_error_status: 402 }), "", 1))).toBe(
      "billing",
    );
    expect(faultOf(() => interpretResult(verbose({ error: "authentication_failed" }), "", 1))).toBe(
      "auth",
    );
    expect(faultOf(() => interpretResult(verbose({ api_error_status: 429 }), "", 1))).toBe(
      "rate-limit",
    );
    expect(faultOf(() => interpretResult(verbose({ api_error_status: 529 }), "", 1))).toBe(
      "rate-limit",
    );
    expect(faultOf(() => interpretResult(verbose({ api_error_status: 401 }), "", 1))).toBe("auth");
    expect(faultOf(() => interpretResult(verbose({ api_error_status: 500 }), "", 1))).toBe(
      "error-result",
    );
    // An unknown future error class is an unclassified harness fault, never an agent outcome.
    expect(faultOf(() => interpretResult(verbose({ error: "something_new" }), "", 1))).toBe(
      "error-result",
    );
    // A structured class wins over the text: the result text names no limit at all.
    const quiet = JSON.stringify([
      { type: "assistant", error: "rate_limit", message: { content: [] } },
      JSON.parse(result("Something went wrong.\nDONE")),
    ]);
    expect(faultOf(() => interpretResult(quiet, "", 0))).toBe("rate-limit");
  });

  it("an error the classifier cannot name is a harness fault (re-run in place), never an agent outcome", () => {
    expect(
      faultOf(() =>
        interpretResult(
          result("I gave up.", { is_error: true, subtype: "error_during_execution" }),
          "",
          1,
        ),
      ),
    ).toBe("error-result");
    expect(
      faultOf(() => interpretResult(result("x\nDONE", { subtype: "error_max_turns" }), "", 0)),
    ).toBe("error-result");
    expect(faultOf(() => interpretResult(result("x\nDONE", { is_error: true }), "", 0))).toBe(
      "error-result",
    );
    // A clean-looking result from a process that exited non-zero (or was killed).
    expect(faultOf(() => interpretResult(result("x\nDONE"), "", 1))).toBe("error-result");
    expect(faultOf(() => interpretResult(result("x\nDONE"), "", null))).toBe("error-result");
    // No is_error field at all is not a clean result.
    const noFlag = JSON.stringify({ type: "result", subtype: "success", result: "x\nDONE" });
    expect(faultOf(() => interpretResult(noFlag, "", 0))).toBe("error-result");
    // The structured errors[] list is read for the class.
    expect(
      faultOf(() =>
        interpretResult(
          result("", {
            is_error: true,
            subtype: "error_during_execution",
            errors: ["429 Too Many Requests"],
          }),
          "",
          1,
        ),
      ),
    ).toBe("rate-limit");
  });

  it("only a clean result is the agent's outcome; a claim is never overridden by the text", () => {
    expect(interpretResult(result("Hit the sheet's rate limit cell.\nDONE"), "", 0).claim).toBe(
      "done",
    );
    expect(interpretResult(result("Could not.\nNOT DONE"), "", 0).claim).toBe("not-done");
    expect(interpretResult(result("I edited the cell."), "", 0).claim).toBe("no-claim");
  });

  it("pins the text-fallback vocabulary", () => {
    // Transient limits only (lead ruling, round 2, D3): these back off.
    for (const t of [
      "API Error: 429 rate_limit_error",
      "API Error: 529 overloaded_error",
      "Too many requests",
      "Rate limit exceeded",
      "rate_limit reached, retry later",
      "Overloaded",
    ])
      expect([t, classOfText(t)]).toEqual([t, "rate-limit"]);
    // The subscription's usage quota: stops at once with its own code (D3).
    for (const t of USAGE_LIMIT_PHRASES) expect([t, classOfText(t)]).toEqual([t, "usage-limit"]);
    // TIF-274 live driver: credit, billing and quota wording stops the run (fail closed).
    for (const t of [
      "You're out of extra usage",
      "Credit balance is too low",
      "quota exceeded",
      "API Error: 402 Payment Required",
      "Your credits are exhausted",
      "Insufficient credit to continue",
      "billing_error: your plan is suspended for billing",
    ])
      expect([t, classOfText(t)]).toEqual([t, "billing"]);
    for (const t of [
      "Invalid API key · Please run /login",
      "OAuth token has expired. Please obtain a new token or refresh your existing token.",
      "Not logged in",
      "API Error: 401 authentication_error",
      "403 Forbidden",
    ])
      expect([t, classOfText(t)]).toEqual([t, "auth"]);
    for (const t of ["I edited cell B2 to 42.", "The document is saved.", "Opened the sheet."])
      expect([t, classOfText(t)]).toEqual([t, null]);
  });

  // Lead ruling, PR #598 round 2, D3: the subscription's quota stops; only transient limits back off.
  it("every quota phrasing is usage-limit on each failed-run path; a structured limit is refined by it", () => {
    for (const t of USAGE_LIMIT_PHRASES) {
      expect([t, faultOf(() => interpretResult(result(t, { is_error: true }), "", 1))]).toEqual([
        t,
        "usage-limit",
      ]);
      expect([t, faultOf(() => interpretResult("", t, 1))]).toEqual([t, "usage-limit"]);
      // Claude Code reports the quota through the structured rate_limit class / HTTP 429 too.
      for (const s of [{ error: "rate_limit" }, { api_error_status: 429 }]) {
        const v = JSON.stringify([
          { type: "assistant", message: { content: [] }, ...s },
          JSON.parse(result(t, { is_error: true })),
        ]);
        expect([t, s, faultOf(() => interpretResult(v, "", 1))]).toEqual([t, s, "usage-limit"]);
        expect([t, s, faultOf(() => interpretResult(JSON.stringify(s), t, 1))]).toEqual([
          t,
          s,
          "usage-limit",
        ]);
      }
      // Plain (non-JSON) stdout, exit 1 and exit 0 (round 3, R2-D3a).
      for (const code of [1, 0])
        expect([t, code, faultOf(() => interpretResult(t, "", code))]).toEqual([
          t,
          code,
          "usage-limit",
        ]);
      // A clean result with no claim line: usage-limit (round 3, R2-D3b); with a claim line
      // it stays the agent's outcome.
      expect([t, faultOf(() => interpretResult(result(t), "", 0))]).toEqual([t, "usage-limit"]);
      expect(interpretResult(result(`${t}\nDONE`), "", 0).claim).toBe("done");
      expect(interpretResult(result(`${t}\nNOT DONE`), "", 0).claim).toBe("not-done");
    }
    // A structured transient limit with no quota wording stays transient.
    for (const s of [{ error: "rate_limit" }, { error: "overloaded" }, { api_error_status: 529 }]) {
      const v = JSON.stringify([
        { type: "assistant", message: { content: [] }, ...s },
        JSON.parse(result("API Error: Too many requests", { is_error: true })),
      ]);
      expect([s, faultOf(() => interpretResult(v, "", 1))]).toEqual([s, "rate-limit"]);
    }
  });

  it("round 3: the verdict's exact inputs (R2-D3a plain stdout, R2-D3b clean result) are usage-limit", () => {
    const exact =
      '{"type":"result","subtype":"success","is_error":false,"result":"Claude AI usage limit reached|1700000000"}';
    expect(faultOf(() => interpretResult(exact, "", 0))).toBe("usage-limit");
    for (const code of [1, 0]) {
      expect(
        faultOf(() => interpretResult("Claude AI usage limit reached|1700000000", "", code)),
      ).toBe("usage-limit");
      expect(faultOf(() => interpretResult("5-hour limit reached ∙ resets 3pm", "", code))).toBe(
        "usage-limit",
      );
      // Plain stdout with no quota wording is still a transport error (re-run in place).
      expect(faultOf(() => interpretResult("not json", "", code))).toBe("transport-error");
    }
    // Task data with 429 / 401 / 403 and no usage wording stays the agent's outcome.
    for (const text of ["qty 429 on EMP-0055", "EMP-0127 401, EMP-0090 403", "429\n401\n403"]) {
      expect(faultOf(() => interpretResult(result(text), "", 0))).toBe("none");
      expect(interpretResult(result(text), "", 0).claim).toBe("no-claim");
    }
  });

  it("#606 S1: quota wording on stderr only, with a claimless clean result, is usage-limit; a claim line keeps the agent's outcome", () => {
    for (const t of USAGE_LIMIT_PHRASES) {
      for (const code of [0, 1])
        expect([t, code, faultOf(() => interpretResult(result("Edited."), t, code))]).toEqual([
          t,
          code,
          "usage-limit",
        ]);
      expect(interpretResult(result("Edited.\nDONE"), t, 0).claim).toBe("done");
      expect(interpretResult(result("Edited.\nNOT DONE"), t, 0).claim).toBe("not-done");
    }
    // Stderr with only the broad vocabulary (no usage wording) never touches a clean result.
    for (const e of ["API Error: 429 Too Many Requests", "401 Unauthorized", "billing; quota"])
      expect([e, interpretResult(result("Edited."), e, 0).claim]).toEqual([e, "no-claim"]);
  });

  it("#606 S2: every Unicode whitespace in the quota wording is folded on every path; a claim line is unchanged", () => {
    for (const t0 of USAGE_LIMIT_PHRASES)
      for (const [name, sp] of UNICODE_SPACES) {
        const t = spaced(t0, sp);
        const probe = (stdout: string, stderr: string, code: number) =>
          faultOf(() => interpretResult(stdout, stderr, code));
        expect([
          t0,
          name,
          probe("", t, 1), // stderr, no result
          probe(t, "", 1), // plain stdout
          probe(t, "", 0),
          probe(result(t, { is_error: true }), "", 1), // error result
          probe(result("API Error", { is_error: true, errors: [t] }), "", 1), // errors[]
          probe(JSON.stringify({ error: "rate_limit" }), t, 1), // structured limit, refined
          probe(result(t), "", 0), // clean claimless result
          probe(result("Edited."), t, 0), // clean claimless result, stderr
        ]).toEqual([t0, name, ...Array(8).fill("usage-limit")]);
        expect(interpretResult(result(`${t}\nDONE`), t, 0).claim).toBe("done");
        expect(interpretResult(result(`${t}\nNOT DONE`), t, 0).claim).toBe("not-done");
      }
    // Task data with 401 / 403 / 429 and NBSP is still the agent's outcome.
    for (const text of [
      "qty 429 on EMP-0055",
      "EMP-0127 401, EMP-0090 403",
      "status 429 401 403",
    ]) {
      const t = spaced(text, NBSP);
      expect(interpretResult(result(t), t, 0).claim).toBe("no-claim");
    }
  });

  // Round-1 verdict N3: the text-fallback order is auth, billing, usage-limit, rate-limit.
  it("pins the classification order: auth before billing before usage-limit before rate-limit", () => {
    expect(classOfText("Credit balance is too low · Please run /login")).toBe("auth");
    expect(classOfText("Weekly limit reached; billing will resume")).toBe("billing");
    expect(classOfText("429 rate_limit_error: usage limit reached")).toBe("usage-limit");
    const both = JSON.stringify([
      { type: "assistant", message: { content: [] }, error: "billing_error" },
      { type: "assistant", message: { content: [] }, error: "authentication_failed" },
      JSON.parse(result("x", { is_error: true })),
    ]);
    expect(faultOf(() => interpretResult(both, "", 1))).toBe("auth");
  });

  // #607 round 2, B1: "You've hit your limit" (each apostrophe, spacing and case) is the quota.
  it('round 2 B1: "You\'ve hit your limit" is usage-limit; "your rate limit" is not', () => {
    for (const t of [
      "You've hit your limit",
      "You\u2019ve hit your limit",
      "You\u2018ve hit your limit",
      "You\u02bcve hit your limit",
      "Youve hit your limit",
      "YOU HAVE HIT YOUR LIMIT",
      "You have reached your usage limit",
      "you've reached your limit",
      spaced("You've hit your limit", NBSP),
      spaced("You've hit your limit", THIN_SPACE),
      spaced("You've hit your limit", "\t"),
    ]) {
      expect([t, classOfText(t)]).toEqual([t, "usage-limit"]);
      expect([t, faultOf(() => interpretResult(result(t), "", 0))]).toEqual([t, "usage-limit"]);
      expect(interpretResult(result(`${t}\nDONE`), t, 0).claim).toBe("done");
    }
    for (const t of ["You've hit your rate limit", "You've hit the cell limit", "your limit"])
      expect([t, interpretResult(result(t), t, 0).claim]).toEqual([t, "no-claim"]);
  });

  // #607 round 2, F-A: format characters and hyphen variants are folded before every match.
  it("round 2 F-A: a format character or hyphen variant inside quota wording is usage-limit on every path", () => {
    for (const [name, t] of FOLDED_USAGE_PHRASES) {
      const probe = (stdout: string, stderr: string, code: number) =>
        faultOf(() => interpretResult(stdout, stderr, code));
      expect([
        name,
        classOfText(t),
        probe("", t, 1),
        probe(t, "", 1),
        probe(t, "", 0),
        probe(result(t, { is_error: true }), "", 1),
        probe(JSON.stringify({ error: "rate_limit" }), t, 1),
        probe(result(t), "", 0),
        probe(result("Edited."), t, 0),
      ]).toEqual([name, ...Array(8).fill("usage-limit")]);
      expect(interpretResult(result(`${t}\nNOT DONE`), t, 0).claim).toBe("not-done");
    }
    // A transient limit with a format character stays transient, and never touches a clean result.
    for (const t of [`rate${ZWSP}limit reached`, `rate${ZWSP} limit reached`]) {
      expect([t, classOfText(t)]).toEqual([t, "rate-limit"]);
      expect([t, interpretResult(result(t), t, 0).claim]).toEqual([t, "no-claim"]);
    }
  });

  // #607 round 2, F-B: auth, billing and rate wording is folded as the usage wording is.
  it("round 2 F-B: auth, billing and rate wording with NBSP, a thin space or ZWSP is classified on plain stdout and stderr", () => {
    for (const [t0, cls] of [
      ["Not logged in", "auth"],
      ["OAuth token has expired", "auth"],
      ["Invalid API key", "auth"],
      ["Credit balance is too low", "billing"],
      ["You're out of extra usage", "billing"],
      ["Insufficient credit to continue", "billing"],
      ["Too many requests", "rate-limit"],
      ["Rate limit exceeded", "rate-limit"],
    ] as const)
      for (const sp of [NBSP, THIN_SPACE, ZWSP, "\t"]) {
        const t = spaced(t0, sp);
        expect([t0, sp.charCodeAt(0), classOfText(t)]).toEqual([t0, sp.charCodeAt(0), cls]);
        for (const code of [1, 0])
          expect([t0, sp.charCodeAt(0), code, faultOf(() => interpretResult(t, "", code))]).toEqual(
            [t0, sp.charCodeAt(0), code, cls],
          );
        expect([t0, sp.charCodeAt(0), faultOf(() => interpretResult("", t, 1))]).toEqual([
          t0,
          sp.charCodeAt(0),
          cls,
        ]);
        // The broad vocabulary is never applied to a clean result (D4). A claimless clean
        // result stops only on the narrow exact CLI phrases (#607 round 3, L1); with a claim
        // line the claim always stands.
        const narrow = ![
          "Insufficient credit to continue",
          "Too many requests",
          "Rate limit exceeded",
        ].includes(t0);
        expect([t0, faultOf(() => interpretResult(result(t), t, 0))]).toEqual([
          t0,
          narrow ? cls : "none",
        ]);
        expect(interpretResult(result(`${t}\nDONE`), t, 0).claim).toBe("done");
      }
  });

  // #607 round 3, B2: an unmapped structured class (`error-result`) falls back to the text.
  it("round 3 B2: an unmapped structured error with quota, billing, auth or transient wording is classified by its text on every errored path", () => {
    const withAssistant = (s: Record<string, unknown>, res: string | null) =>
      JSON.stringify([
        { type: "assistant", message: { content: [] }, ...s },
        ...(res === null ? [] : [JSON.parse(res)]),
      ]);
    for (const [sname, s] of UNMAPPED_STRUCTURED) {
      for (const [t, cls] of FAULT_WORDING) {
        const errRes = (text: string, extra: Record<string, unknown> = {}) =>
          result(text, { is_error: true, subtype: "error_during_execution", ...extra });
        expect([
          sname,
          t,
          // The error result's own text.
          faultOf(() => interpretResult(withAssistant(s, errRes(t)), "", 1)),
          // Its errors[] list.
          faultOf(() =>
            interpretResult(withAssistant(s, errRes("API Error", { errors: [t] })), "", 1),
          ),
          // stderr only.
          faultOf(() => interpretResult(withAssistant(s, errRes("API Error")), t, 1)),
          // No result event: the structured field and the wording on stderr.
          faultOf(() => interpretResult(withAssistant(s, null), t, 1)),
          // A clean-looking result with a claim line, exit 0: the structured error makes it
          // errored, so the claim is never counted.
          faultOf(() => interpretResult(withAssistant(s, result("x\nDONE")), t, 0)),
          // The structured field on the result message itself.
          faultOf(() => interpretResult(errRes(t, s), "", 1)),
        ]).toEqual([sname, t, cls, cls, cls, cls, cls, cls]);
      }
      // With no vocabulary the structured class stands: a status 500 alone is error-result.
      expect([
        sname,
        faultOf(() =>
          interpretResult(
            withAssistant(s, result("Something went wrong.", { is_error: true })),
            "",
            1,
          ),
        ),
        faultOf(() => interpretResult(withAssistant(s, null), "boom", 1)),
      ]).toEqual([sname, "error-result", "error-result"]);
    }
    // A mapped structured class still wins over the text.
    const mapped = (e: Record<string, unknown>) =>
      withAssistant(e, result("Credit balance is too low", { is_error: true }));
    expect(faultOf(() => interpretResult(mapped({ error: "authentication_failed" }), "", 1))).toBe(
      "auth",
    );
    expect(faultOf(() => interpretResult(mapped({ error: "rate_limit" }), "", 1))).toBe(
      "rate-limit",
    );
  });

  // #607 round 3, L1: the narrow billing and auth phrases stop a claimless clean result.
  it("round 3 L1: a claimless clean result with a narrow billing or auth phrase (text or stderr) stops with its class; a claim line is never reclassified", () => {
    for (const [t0, cls] of CLEAN_RESULT_FAULT_PHRASES)
      for (const t of [
        t0,
        t0.toUpperCase(),
        spaced(t0, NBSP),
        spaced(t0, ZWSP),
        spaced(t0, "\t"),
      ]) {
        expect([
          t,
          faultOf(() => interpretResult(result(t), "", 0)),
          faultOf(() => interpretResult(result("Edited."), t, 0)),
          faultOf(() => interpretResult(result(`I tried.\n${t}`), "", 0)),
        ]).toEqual([t, cls, cls, cls]);
        for (const [line, claim] of [
          ["DONE", "done"],
          ["NOT DONE", "not-done"],
        ] as const)
          expect([t, interpretResult(result(`${t}\n${line}`), t, 0).claim]).toEqual([t, claim]);
      }
    // Auth before billing before usage, as in classOfText.
    expect(
      faultOf(() => interpretResult(result("Credit balance is too low; not logged in"), "", 0)),
    ).toBe("auth");
    expect(
      faultOf(() => interpretResult(result("Out of extra usage; usage limit reached"), "", 0)),
    ).toBe("billing");
    // Task data sharing the broad vocabulary stays the agent's no-claim, in the text or on stderr.
    for (const t of CLEAN_RESULT_TASK_DATA) {
      expect([t, faultOf(() => interpretResult(result(t), "", 0))]).toEqual([t, "none"]);
      expect([t, interpretResult(result("Edited."), spaced(t, NBSP), 0).claim]).toEqual([
        t,
        "no-claim",
      ]);
    }
  });

  // #607 round 3, F-E: "log-in again" (hyphenated, or a folded hyphen variant) is auth.
  it("round 3 F-E: 'please log-in again' is auth on a failed run, with an ASCII or folded hyphen", () => {
    for (const t of [
      "Session expired: please log-in again",
      // Without "please", only the `log[ -]?in again` alternative can match.
      "Session expired; log-in again to continue",
      `Session expired; log${String.fromCharCode(0x2011)}in again`,
      `Please sign${String.fromCharCode(0x2010)}in`,
      `please log${String.fromCharCode(0x2011)}in again`,
      `Please log${String.fromCharCode(0x2010)}in again`,
      "please log in again",
      "please login again",
    ]) {
      expect([t, classOfText(t)]).toEqual([t, "auth"]);
      expect([t, faultOf(() => interpretResult("", t, 1))]).toEqual([t, "auth"]);
    }
  });

  it("classifies rate limits, unreadable output and spawn failures as harness faults", async () => {
    expect(() =>
      interpretResult(result("Claude AI usage limit reached", { is_error: true }), "", 1),
    ).toThrow(HarnessFault);
    expect(faultOf(() => interpretResult("", "API Error: 429 rate_limit_error", 1))).toBe(
      "rate-limit",
    );
    expect(faultOf(() => interpretResult("not json", "boom", 1))).toBe("transport-error");
    expect(faultOf(() => interpretResult(result("fine\nDONE"), "", 0))).toBe("none");
    const { plan, transport } = setup("");
    const bad = claudeDriver({
      spawn: () => {
        throw new Error("ENOENT");
      },
      command: "claude",
      env: {},
      envAllowlist: CHILD_ENV_ALLOWLIST,
      capture: async () => ({}),
    }).transport({
      task: PUBLISHED[0] as (typeof PUBLISHED)[number],
      runId: "x",
      trialKey: "x",
      trialDir: tmp(),
      signal: new AbortController().signal,
    });
    await expect(bad.runAgent(plan, null)).rejects.toMatchObject({ harnessClass: "spawn-failed" });
    expect(() => transport.report()).toThrow(/did not finish/);
  });

  it("on the trial deadline it stops the process and reports a harness timeout", async () => {
    const { plan, transport, controller } = setup("", 0, true);
    const running = transport.runAgent(plan, null);
    controller.abort();
    await expect(running).rejects.toMatchObject({ harnessClass: "timeout" });
  });

  it("escalates to SIGKILL when the process ignores SIGTERM on the deadline", async () => {
    const { plan, transport, controller, fake } = setup("", 0, true, true);
    const running = transport.runAgent(plan, null);
    controller.abort();
    await expect(running).rejects.toMatchObject({ harnessClass: "timeout" });
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

// Verifier round 2, D4 end to end: `runPilot` with the live `claudeDriver` and a fake spawn (no
// `claude`, no model, no VM). A clean first attempt with no claim and fixture-shaped text is
// decided as the agent's outcome: never re-run, never a rate-limit backoff, never an auth pause.
describe("runPilot with claudeDriver: a clean no-claim attempt is decided once (round 2, D4)", () => {
  const runOne = async (firstText: string) => {
    const base = config();
    const cfg = { ...base, trials: base.trials.slice(0, 1) };
    const outputs = [result(firstText), result("Fixed it.\nDONE")];
    let calls = 0;
    const spawn: SpawnFn = (command, args, options) => {
      const out = outputs[Math.min(calls++, outputs.length - 1)] as string;
      return fakeSpawn(out).spawn(command, args, options);
    };
    const driver = claudeDriver({
      spawn,
      command: "claude",
      env: { PATH: "/bin", HOME: "/h" },
      envAllowlist: CHILD_ENV_ALLOWLIST,
      capture: async (ctx) => ({
        "persisted/doc.csv": new TextEncoder().encode(scriptedDocument(ctx.task)),
      }),
      killGraceMs: 5,
    });
    const dir = tmp();
    const clock = virtualClock();
    const r = await runPilot({
      config: cfg,
      published: PUBLISHED,
      outDir: dir,
      repoRoot: ROOT,
      oracleSources: SOURCES,
      driver,
      plannerModelId: cfg.model,
      liveLaunchSha256: configSha256(cfg),
      sleep: clock.sleep,
      now: clock.now,
    });
    const attempts = [...loadLedger(join(dir, PROGRESS_FILE)).byTask.values()].flat();
    return { r, attempts, calls };
  };

  it("qty 429 in a clean final message: decided on attempt 1, not a rate-limit re-run", async () => {
    const { r, attempts, calls } = await runOne(
      "I looked at EMP-0055: its qty is 429. I could not save the file.",
    );
    expect(r).toMatchObject({ status: "complete", ran: 1, faulted: 0 });
    expect(calls).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.end).toMatchObject({ outcome: "decided", harnessClass: null });
  });

  it("qty 401 in a clean final message: decided, the run does not pause on auth", async () => {
    const { r, attempts, calls } = await runOne("Row EMP-0127 has qty 401; I left it unchanged.");
    expect(r.status).not.toBe("paused");
    expect(r).toMatchObject({ status: "complete", ran: 1, faulted: 0 });
    expect(calls).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.end).toMatchObject({ outcome: "decided", harnessClass: null });
  });
});
