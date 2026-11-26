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
import { mcpConfigJson } from "../../src/integrity/launch.ts";
import {
  classOfText,
  claudeDriver,
  interpretResult,
  parseClaim,
  type SpawnFn,
} from "../../src/pilot/claude-transport.ts";
import { CHILD_ENV_ALLOWLIST } from "../../src/pilot/config.ts";
import { trialLaunchPlan } from "../../src/pilot/launch.ts";
import { HarnessFault } from "../../src/pilot/runner.ts";
import { config, PUBLISHED, ROOT, tmp } from "./helpers.ts";

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

  it("classifies each limit and login message from the round-1 verdict as a harness fault, flagged or not", () => {
    const probes: [string, string][] = [
      ["Claude AI usage limit reached|1700000000", "rate-limit"],
      ["Sonnet limit reached · resets 3pm", "rate-limit"],
      ["5-hour limit reached ∙ resets 3pm", "rate-limit"],
      ["Weekly limit reached ∙ resets Mon", "rate-limit"],
      ["Invalid API key · Please run /login", "auth"],
    ];
    for (const [text, cls] of probes) {
      expect(faultOf(() => interpretResult(result(text, { is_error: true }), "", 1))).toBe(cls);
      // The same text on a result Claude Code did not flag as an error, with no claim.
      expect(faultOf(() => interpretResult(result(text), "", 0))).toBe(cls);
      // And as bare stderr with no JSON result at all.
      expect(faultOf(() => interpretResult("", text, 1))).toBe(cls);
    }
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
