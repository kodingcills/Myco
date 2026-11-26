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
import { config, PUBLISHED, ROOT, SOURCES, tmp } from "./helpers.ts";

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
      ["Claude AI usage limit reached|1700000000", "rate-limit"],
      ["Sonnet limit reached · resets 3pm", "rate-limit"],
      ["5-hour limit reached ∙ resets 3pm", "rate-limit"],
      ["Weekly limit reached ∙ resets Mon", "rate-limit"],
      ["Invalid API key · Please run /login", "auth"],
    ];
    for (const [text, cls] of probes) {
      expect(faultOf(() => interpretResult(result(text, { is_error: true }), "", 1))).toBe(cls);
      // An unflagged result from a process that exited non-zero did not complete normally.
      expect(faultOf(() => interpretResult(result(text), "", 1))).toBe(cls);
      // And as bare stderr with no JSON result at all.
      expect(faultOf(() => interpretResult("", text, 1))).toBe(cls);
      // A CLEAN, completed result is the agent's outcome even with this text (round 2, D4).
      expect(faultOf(() => interpretResult(result(text), "", 0))).toBe("none");
      expect(interpretResult(result(text), "", 0).claim).toBe("no-claim");
    }
  });

  // Verifier round 2, D4: the text fallback never applies to a clean, completed run. Each
  // probe from the verdict, plus fixture-shaped text (fc-v1 holds qty 401, 403 and 429).
  it("a clean completed run with no claim is the agent's outcome, whatever its text (round 2, D4)", () => {
    const probes = [
      "I updated the billing totals in column C.",
      "Fixed the quota column. Done.",
      "Done — the weekly limit column is fixed.",
      "The pay period resets on Mon 3 March.",
      "The cell was locked (forbidden). I stopped.",
      "I set the credential column to blank.",
      "I looked at EMP-0055: its qty is 429. I could not save the file.",
      "Row EMP-0127 has qty 401; I left it unchanged.",
      "EMP-0090 qty 403 is now 430.",
      "Set the API key column header and the OAuth flag; usage limit noted in B4.",
      "Claude AI usage limit reached|1700000000",
      "Invalid API key · Please run /login",
    ];
    for (const text of probes) {
      expect([text, faultOf(() => interpretResult(result(text), "", 0))]).toEqual([text, "none"]);
      expect([text, interpretResult(result(text), "", 0).claim]).toEqual([text, "no-claim"]);
    }
    // The fallback still fires when the same run did NOT complete normally.
    expect(faultOf(() => interpretResult(result(probes[6] as string), "", 1))).toBe("rate-limit");
    expect(faultOf(() => interpretResult(result(probes[7] as string), "", 1))).toBe("auth");
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
    expect(faultOf(() => interpretResult(verbose({ error: "billing_error" }), "", 1))).toBe(
      "rate-limit",
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
    for (const t of [
      "Claude AI usage limit reached|1700000000",
      "API Error: 429 rate_limit_error",
      "API Error: 529 overloaded_error",
      "Too many requests",
      "Opus limit reached ∙ resets 11pm",
      "Your limit will reset at 5pm",
      "You're out of extra usage",
      "Weekly limit reached",
      "daily limit exceeded",
      "Credit balance is too low",
      "quota exceeded",
    ])
      expect([t, classOfText(t)]).toEqual([t, "rate-limit"]);
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
