/**
 * TIF-268: the hcu+shell subscription planner. Injected `spawn` only: no real `claude` (a
 * trap binary is first on PATH), no network (fetch is trapped), no VM.
 */
import { describe, expect, it } from "vitest";
import { HCU_SHELL_PROMPT } from "../../../src/baseline/hcu-shell/decision.ts";
import {
  createSubscriptionPlanner,
  HCU_PLANNER_MODEL,
  PLANNER_ARGV,
  PLANNER_FIXED_ENV,
  PlannerHalt,
  PlannerTransient,
  PROBE_SCREENSHOT,
  plannerInput,
  readPlannerCall,
  SubscriptionPlannerFailure,
} from "../../../src/baseline/hcu-shell-live/planner.ts";
import { API_CREDENTIAL_NAMES } from "../../../src/pilot/claude-cli.ts";
import { ARGV_TEMPLATE, CHILD_ENV_ALLOWLIST, PILOT_MODEL } from "../../../src/pilot/config.ts";
import {
  fakeClaude,
  init,
  okReply,
  result,
  stream,
  useClaudeTrap,
  useFetchTrap,
} from "./helpers.ts";

useClaudeTrap();
useFetchTrap();

const price = (t: { inputTokens: number; outputTokens: number }) =>
  (t.inputTokens * 2 + t.outputTokens * 10) / 1_000_000;
const ENV = { HOME: "/home/op", PATH: "/usr/bin", LANG: "C", UNRELATED_SETTING: "x" };
const turn = {
  instruction: 'Set the cell at record EMP-0011, column name, to "X", and save the file.',
  screenshot: PROBE_SCREENSHOT,
  shellHistory: [],
};
const planner = (
  spawn: ReturnType<typeof fakeClaude>["spawn"],
  env: Record<string, string> = ENV,
) =>
  createSubscriptionPlanner({
    spawn,
    command: "claude",
    env,
    cwd: "/tmp",
    price,
    callTimeoutMs: 2_000,
    killGraceMs: 50,
  });

async function haltOf(stdout: string, stderr = "", code: number | null = 0): Promise<unknown> {
  try {
    readPlannerCall(stdout, stderr, code, price);
  } catch (error) {
    return error;
  }
  return null;
}

describe("settings parity with the myco-gate arm", () => {
  it("runs the gate arm's model, with its settings flags", () => {
    expect(HCU_PLANNER_MODEL).toBe(PILOT_MODEL);
    const at = (argv: readonly string[], f: string) => argv[argv.indexOf(f) + 1];
    for (const f of ["--model", "--setting-sources", "--tools", "--permission-mode"])
      expect(at(PLANNER_ARGV, f), f).toBe(at(ARGV_TEMPLATE, f));
    expect(PLANNER_ARGV).toContain("--strict-mcp-config");
    expect(PLANNER_ARGV).not.toContain("--mcp-config");
  });
  it("passes only the gate arm's allowlisted names plus the output ceiling", async () => {
    const fake = fakeClaude([okReply('{"claim":"done"}')]);
    await planner(fake.spawn).act(turn);
    const call = fake.calls[0];
    expect(call?.command).toBe("claude");
    expect(call?.args).toEqual(PLANNER_ARGV);
    const allowed = new Set([...CHILD_ENV_ALLOWLIST, ...Object.keys(PLANNER_FIXED_ENV)]);
    expect(Object.keys(call?.env ?? {}).every((k) => allowed.has(k))).toBe(true);
    expect(call?.env.UNRELATED_SETTING).toBeUndefined();
    expect(call?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("1024");
  });
});

describe("no API-key path", () => {
  it.each(API_CREDENTIAL_NAMES)("refuses to construct when %s is set, before any spawn", (name) => {
    const fake = fakeClaude([okReply('{"claim":"done"}')]);
    let error: unknown;
    try {
      planner(fake.spawn, { ...ENV, [name]: "" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PlannerHalt);
    expect((error as PlannerHalt).code).toBe("api-key-path-configured");
    expect(fake.calls).toHaveLength(0);
  });
  it("never reads the value of ANTHROPIC_API_KEY (names only)", () => {
    const env: Record<string, string> = { ...ENV };
    let reads = 0;
    Object.defineProperty(env, "ANTHROPIC_API_KEY", {
      enumerable: true,
      get() {
        reads++;
        return "trap-value";
      },
    });
    expect(() => planner(fakeClaude([]).spawn, env)).toThrow(/api-key-path-configured/);
    expect(reads).toBe(0);
  });
  it("halts when the CLI reports an API credential instead of the subscription", async () => {
    for (const source of ["ANTHROPIC_API_KEY", "apiKeyHelper", "user", ""]) {
      const e = await haltOf(stream(init({ apiKeySource: source }), result('{"claim":"done"}')));
      expect((e as PlannerHalt).code, source).toBe("planner-api-key-path");
    }
  });
  it("halts when the CLI does not say how it authenticated", async () => {
    const e = await haltOf(stream(result('{"claim":"done"}')));
    expect((e as PlannerHalt).code).toBe("planner-auth-source-unknown");
    const e2 = await haltOf(
      stream({ type: "system", subtype: "init", model: HCU_PLANNER_MODEL }, result("x")),
    );
    expect((e2 as PlannerHalt).code).toBe("planner-auth-source-unknown");
  });
  it("halts when the CLI ran another model", async () => {
    const e = await haltOf(stream(init({ model: "claude-opus-5-5" }), result('{"claim":"done"}')));
    expect((e as PlannerHalt).code).toBe("planner-model-mismatch");
  });
});

describe("auth, credit, billing, quota and usage-limit faults fail closed (round 2, D1)", () => {
  const errorResult = (extra: Record<string, unknown> = {}, text = "") =>
    stream(init(), result(text, { is_error: true, subtype: "error_during_execution", ...extra }));
  const structured = (extra: Record<string, unknown>, text = "") =>
    stream(init(), { type: "assistant", message: {}, ...extra }, result(text));
  const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

  // Every input from the round-1 verdict's D1 table, plus each class by every channel the CLI
  // reports it on: structured error, HTTP status, result text and bare stderr.
  const halts: [string, string, string, number | null, string][] = [
    // [label, stdout, stderr, exit, halt code]
    [
      "authentication_failed",
      structured({ error: "authentication_failed" }),
      "",
      1,
      "planner-auth",
    ],
    [
      "oauth_org_not_allowed",
      structured({ error: "oauth_org_not_allowed" }),
      "",
      1,
      "planner-auth",
    ],
    ["status 401", errorResult({ api_error_status: 401 }), "", 1, "planner-auth"],
    ["status 403", errorResult({ api_error_status: 403 }), "", 1, "planner-auth"],
    ["/login text", errorResult({}, "Invalid API key · Please run /login"), "", 1, "planner-auth"],
    ["OAuth expiry on stderr", "", "OAuth token has expired", 1, "planner-auth"],
    ["billing_error", structured({ error: "billing_error" }), "", 1, "planner-billing"],
    ["api_error_status 402", errorResult({ api_error_status: 402 }), "", 1, "planner-billing"],
    ["Payment required text", errorResult({}, "Payment required"), "", 1, "planner-billing"],
    ["stderr API Error 402", "", "API Error: 402 payment required", 1, "planner-billing"],
    ["Credit balance text", errorResult({}, "Credit balance is too low"), "", 1, "planner-billing"],
    ["quota exceeded", "", "quota exceeded", 1, "planner-billing"],
    ["out of extra usage", errorResult({}, "You're out of extra usage"), "", 1, "planner-billing"],
    [
      "usage limit text",
      errorResult({}, "Claude usage limit reached. Your limit will reset at 3pm"),
      "",
      1,
      "planner-usage-limit",
    ],
    ["5-hour limit", "", "5-hour limit reached ∙ resets 3pm", 1, "planner-usage-limit"],
    [
      "Weekly limit",
      errorResult({}, "Weekly limit reached ∙ resets Mon"),
      "",
      1,
      "planner-usage-limit",
    ],
    ["reset at", "", "Your limit will reset at 5pm", 1, "planner-usage-limit"],
    ["usage_limit_reached", "", "usage_limit_reached", 1, "planner-usage-limit"],
    // Claude Code reports the quota through the structured rate_limit class too: refined.
    [
      "rate_limit + quota text",
      structured({ error: "rate_limit" }, "Claude AI usage limit reached|1700000000"),
      "",
      1,
      "planner-usage-limit",
    ],
    [
      "429 + quota text",
      errorResult({ api_error_status: 429 }, "Weekly limit reached"),
      "",
      1,
      "planner-usage-limit",
    ],
  ];
  it.each(halts)("%s halts the run with its own code", async (_label, out, err, code, halt) => {
    const e = await haltOf(out, err, code);
    expect(e).toBeInstanceOf(PlannerHalt);
    expect(codeOf(e)).toBe(halt);
  });

  const transients: [string, string, string][] = [
    ["rate_limit", structured({ error: "rate_limit" }), ""],
    ["overloaded", structured({ error: "overloaded" }), ""],
    ["status 429", errorResult({ api_error_status: 429 }), ""],
    ["status 529", errorResult({ api_error_status: 529 }), ""],
    ["429 on stderr", "", "API Error: 429 Too Many Requests"],
    ["overloaded on stderr", "", "API Error: 529 overloaded_error"],
  ];
  it.each(transients)(
    "a transient %s is a PlannerTransient (bounded back-off), not a halt",
    async (_l, out, err) => {
      const e = await haltOf(out, err, 1);
      expect(e).toBeInstanceOf(PlannerTransient);
      expect(codeOf(e)).toBe("planner-rate-limit");
    },
  );

  it("each halting class has a distinct code", () => {
    expect(new Set(halts.map((h) => h[4]))).toEqual(
      new Set(["planner-auth", "planner-billing", "planner-usage-limit"]),
    );
  });
  it("an unclassified error is a per-trial failure, not a halt", async () => {
    const e = await haltOf(errorResult({}), "something odd", 1);
    expect(e).toBeInstanceOf(SubscriptionPlannerFailure);
    expect((e as SubscriptionPlannerFailure).code).toBe("planner-error-result");
  });
  it("unparseable output is a per-trial transport failure", async () => {
    const e = await haltOf("not json at all", "", 0);
    expect((e as SubscriptionPlannerFailure).code).toBe("planner-transport-error");
  });
  it("an apiKeySource other than none halts even on a failed call (as #598)", async () => {
    const e = await haltOf(
      stream(init({ apiKeySource: "ANTHROPIC_API_KEY" }), result("", { is_error: true })),
      "something odd",
      1,
    );
    expect(codeOf(e)).toBe("planner-api-key-path");
  });
  it("the broad vocabulary never applies to a clean call (fc-v1 holds qty 401, 402-like text)", async () => {
    // Round 3 (N1): only the usage-quota wording, on a clean result with NO decision, stops the
    // run; "Weekly limit column" moved to the N1 tests below (it names the quota).
    for (const text of ["qty 402 billing quota", "429", "401 forbidden credential", "403"]) {
      const r = readPlannerCall(stream(init(), result(text)), "", 0, price);
      expect(r.text).toBe(text);
    }
  });
  it("a halt is final: the planner surfaces it once and spawns nothing more", async () => {
    const fake = fakeClaude([{ stdout: "", stderr: "Credit balance is too low", code: 1 }]);
    const p = planner(fake.spawn);
    await expect(p.act(turn)).rejects.toMatchObject({ code: "planner-billing" });
    expect(fake.calls).toHaveLength(1);
  });
  it("cancel() stops an in-flight call at once (the runner's trial deadline)", async () => {
    const fake = fakeClaude([{ stdout: "", hang: true }]);
    const p = createSubscriptionPlanner({
      spawn: fake.spawn,
      command: "claude",
      env: ENV,
      cwd: "/tmp",
      price,
      callTimeoutMs: 60_000,
      killGraceMs: 50,
    });
    const pending = p.act(turn);
    await new Promise((r) => setImmediate(r));
    p.cancel?.();
    await expect(pending).rejects.toMatchObject({ code: "planner-timeout" });
    expect(fake.signals[0]).toBe("SIGTERM");
  });
});

describe("a clean call", () => {
  it("sends the screenshot and the hcu+shell prompt on stdin and reads one decision", async () => {
    const fake = fakeClaude([okReply('{"tool":"click","arguments":{"x":5,"y":7}}')]);
    const r = await planner(fake.spawn).act(turn);
    expect(r.decision).toEqual({ tool: "click", arguments: { x: 5, y: 7 } });
    expect(r.calls).toEqual([
      {
        model: HCU_PLANNER_MODEL,
        usage: {
          prompt: 1000,
          completion: 20,
          cost: price({ inputTokens: 1000, outputTokens: 20 }),
        },
      },
    ]);
    const sent = JSON.parse(fake.calls[0]?.stdin ?? "{}");
    expect(sent.type).toBe("user");
    expect(sent.message.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PROBE_SCREENSHOT.data },
    });
    expect(sent.message.content[1].text).toBe(`${HCU_SHELL_PROMPT}\nTask: ${turn.instruction}`);
    expect(plannerInput(turn)).toBe(fake.calls[0]?.stdin);
  });
  it("an unreadable reply is no decision (the loop records planner-no-action)", async () => {
    const r = await planner(fakeClaude([okReply("I think I should click")]).spawn).act(turn);
    expect(r.decision).toBeUndefined();
    expect(r.calls).toHaveLength(1);
  });
  it("leaves cost absent when the tokens are unmeasured (never 0)", async () => {
    const out = stream(init(), result('{"claim":"done"}', { usage: null }));
    const r = await planner(fakeClaude([{ stdout: out }]).spawn).act(turn);
    expect(r.calls[0]?.usage.cost).toBeUndefined();
  });
  it("times out a hung call with a per-trial code", async () => {
    const fake = fakeClaude([{ stdout: "", hang: true }]);
    await expect(planner(fake.spawn).act(turn)).rejects.toMatchObject({ code: "planner-timeout" });
    expect(fake.signals[0]).toBe("SIGTERM");
  });
});
