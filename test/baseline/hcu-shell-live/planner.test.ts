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

describe("auth, credit, billing and quota faults fail closed", () => {
  const errorResult = (extra: Record<string, unknown>) =>
    stream(init(), result("", { is_error: true, subtype: "error_during_execution", ...extra }));
  it.each([
    ["authentication_failed", "planner-auth"],
    ["oauth_org_not_allowed", "planner-auth"],
    ["billing_error", "planner-quota"],
    ["rate_limit", "planner-quota"],
  ])("structured error %s halts with %s", async (cls, code) => {
    const e = await haltOf(
      stream(init(), { type: "assistant", error: cls, message: {} }, result("")),
      "",
      1,
    );
    expect(e).toBeInstanceOf(PlannerHalt);
    expect((e as PlannerHalt).code).toBe(code);
  });
  it.each([
    ["Credit balance is too low", "planner-quota"],
    ["Claude usage limit reached. Your limit will reset at 3pm", "planner-quota"],
    ["API Error: 429 Too Many Requests", "planner-quota"],
    ["Invalid API key · Please run /login", "planner-auth"],
    ["OAuth token has expired", "planner-auth"],
  ])("CLI text %j halts with %s", async (text, code) => {
    const e = await haltOf(errorResult({}), text, 1);
    expect((e as PlannerHalt).code).toBe(code);
  });
  it("an HTTP 401 status halts with planner-auth, a 529 with planner-quota", async () => {
    const e401 = await haltOf(errorResult({ api_error_status: 401 }), "", 1);
    expect((e401 as PlannerHalt).code).toBe("planner-auth");
    const e529 = await haltOf(errorResult({ api_error_status: 529 }), "", 1);
    expect((e529 as PlannerHalt).code).toBe("planner-quota");
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
  it("a halt is final: the planner surfaces it once and spawns nothing more", async () => {
    const fake = fakeClaude([{ stdout: "", stderr: "Credit balance is too low", code: 1 }]);
    const p = planner(fake.spawn);
    await expect(p.act(turn)).rejects.toMatchObject({ code: "planner-quota" });
    expect(fake.calls).toHaveLength(1);
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
