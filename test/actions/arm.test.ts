/**
 * Track J: the fast-path arm - its launch plan passes the integrity launch audit only when
 * `myco-cap` is pinned to this trial's run and workspace, and its rows are never R1
 * evidence.
 */
import { describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  auditFastPathLaunch,
  CAP_RUN_ENV,
  CAP_SERVER,
  CAP_WORKSPACE_ENV,
  FAST_PATH_ARM_SPEC,
  type FastPathRunRecord,
  fastPathArmRow,
  fastPathLaunchPlan,
  fastPathRowProblems,
} from "../../src/actions/arm.ts";
import { checkBenchmark } from "../../src/benchmark/check.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";

const WS = "/srv/myco/trials/run-1";
const PIN = { runId: "run-1", workspace: WS };
const plan = (over: Partial<Parameters<typeof fastPathLaunchPlan>[0]> = {}) =>
  fastPathLaunchPlan({
    ...PIN,
    mcpConfigPath: "/srv/myco/trials/run-1.mcp.json",
    prompt: "do the task",
    capCommand: "myco-cap",
    ...over,
  });

function withEnv(env: Record<string, string>): AgentLaunchPlan {
  const p = plan();
  return { ...p, mcpServers: { [CAP_SERVER]: { command: "myco-cap", args: [], env } } };
}

describe("fast-path launch audit", () => {
  it("a pinned plan passes the integrity audit with only the two cap tools", () => {
    const audit = auditFastPathLaunch(plan(), PIN);
    expect(audit.violations).toEqual([]);
    expect(audit).toMatchObject({ ok: true, capPinned: true, hostRoots: [] });
    expect(audit.effective).toEqual(["mcp__myco-cap__act", "mcp__myco-cap__act_script"]);
  });

  it.each([
    ["no env", {}],
    ["only the run id", { [CAP_RUN_ENV]: "run-1" }],
    ["another run id", { [CAP_RUN_ENV]: "run-2", [CAP_WORKSPACE_ENV]: WS }],
    [
      "another trial's workspace",
      { [CAP_RUN_ENV]: "run-1", [CAP_WORKSPACE_ENV]: "/srv/myco/trials/run-2" },
    ],
    ["a parent workspace", { [CAP_RUN_ENV]: "run-1", [CAP_WORKSPACE_ENV]: "/srv/myco/trials" }],
    ["an extra variable", { [CAP_RUN_ENV]: "run-1", [CAP_WORKSPACE_ENV]: WS, PATH: "/usr/bin" }],
  ])("refuses %s", (_what, env) => {
    const audit = auditFastPathLaunch(withEnv(env), PIN);
    expect(audit.ok).toBe(false);
    expect(audit.capPinned).toBe(false);
    expect(audit.violations.map((v) => v.reach)).toContain("host-fs");
  });

  it.each([
    ["relative", "trials/run-1"],
    ["dot-dot", "/srv/myco/trials/../trials/run-1"],
    ["trailing slash", "/srv/myco/trials/run-1/"],
    ["the filesystem root", "/"],
    ["empty", ""],
  ])("refuses a %s workspace even when env matches it", (_what, workspace) => {
    const p = plan({ workspace });
    expect(auditFastPathLaunch(p, { runId: "run-1", workspace }).ok).toBe(false);
  });

  it("refuses an empty run id", () => {
    expect(auditFastPathLaunch(plan({ runId: "" }), { runId: "", workspace: WS }).ok).toBe(false);
  });

  it("a plan without myco-cap is not a fast-path launch", () => {
    const p = plan();
    const bare: AgentLaunchPlan = {
      ...p,
      argv: [...p.argv.filter((a) => !a.startsWith("mcp__myco-cap")), "TodoWrite"],
      mcpServers: {},
    };
    const audit = auditFastPathLaunch(bare, PIN);
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(false);
  });

  it("granting a host tool next to the cap tools is refused by the integrity audit", () => {
    const p = plan();
    const audit = auditFastPathLaunch({ ...p, argv: [...p.argv, "Bash"] }, PIN);
    expect(audit.ok).toBe(false);
    expect(audit.violations.map((v) => v.tool)).toContain("Bash");
  });

  it("the caller cannot classify myco-cap itself", () => {
    expect(() =>
      auditFastPathLaunch(plan(), PIN, { [CAP_SERVER]: { act: { reach: "guest", note: "x" } } }),
    ).toThrow(/classified here/);
  });
});

const record = (over: Partial<FastPathRunRecord> = {}): FastPathRunRecord => ({
  schema: "myco.fast-path-run/1",
  arm: "fast-path",
  runId: "run-1",
  taskId: "fc-v1-001",
  policyId: "p",
  availability: { api: true, script: true, gui: true },
  routing: [
    {
      seq: 1,
      kind: "calc.set-cell",
      action: { kind: "calc.set-cell", cell: "B12", value: "x" },
      candidates: ["api", "gui"],
      route: "gui",
      reason: "fallback-after-failure",
      fallbackFrom: "api",
      attempts: [],
      code: "OK",
      ms: 3,
    },
  ],
  summary: {
    steps: 1,
    byRoute: { api: 0, script: 0, gui: 1, none: 0 },
    fallbacks: 1,
    denials: 0,
    routeMs: 3,
  },
  claim: "done",
  plannerModelId: "simulated:scripted",
  wallMs: 10,
  evidence: false,
  ...over,
});

describe("fast-path rows are never R1 evidence", () => {
  it("the arm sits next to screenshot-only and hcu+shell, not run, not evidence", () => {
    expect(FAST_PATH_ARM_SPEC).toMatchObject({
      id: "fast-path",
      specName: "hcu+shell+J",
      pairsWith: ["hcu+shell", "screenshot-only"],
      status: "not-run",
      evidence: false,
    });
  });

  it("a row carries the route log without action payloads, and evidence false", () => {
    const row = fastPathArmRow({
      record: record(),
      trialKey: "k",
      gateVerdict: "verified",
      grade: "pass",
    });
    expect(row).toMatchObject({
      arm: "fast-path",
      evidence: false,
      simulated: true,
      verified: true,
      steps: 1,
      fallbacks: 1,
    });
    expect(row.routeLog).toEqual([
      {
        kind: "calc.set-cell",
        route: "gui",
        reason: "fallback-after-failure",
        fallbackFrom: "api",
        code: "OK",
      },
    ]);
    expect(JSON.stringify(row)).not.toContain("B12");
    expect(fastPathRowProblems(row)).toEqual([]);
  });

  it("verified needs a done claim graded pass: a gate verdict or a claim alone is not enough", () => {
    expect(
      fastPathArmRow({ record: record(), trialKey: "k", gateVerdict: "verified", grade: "fail" })
        .verified,
    ).toBe(false);
    expect(
      fastPathArmRow({ record: record(), trialKey: "k", gateVerdict: "verified", grade: null })
        .verified,
    ).toBe(false);
    expect(
      fastPathArmRow({
        record: record({ claim: "failure" }),
        trialKey: "k",
        gateVerdict: null,
        grade: "pass",
      }).verified,
    ).toBe(false);
  });

  it("a model planner is not simulated; a scripted one is", () => {
    expect(
      fastPathArmRow({
        record: record({ plannerModelId: "claude-opus-5-5" }),
        trialKey: "k",
        gateVerdict: null,
        grade: null,
      }).simulated,
    ).toBe(false);
  });

  it("fastPathRowProblems refuses evidence, a forged verified, and a mismatched simulated flag", () => {
    const row = fastPathArmRow({
      record: record(),
      trialKey: "k",
      gateVerdict: "verified",
      grade: "fail",
    });
    expect(fastPathRowProblems({ ...row, evidence: true })).toContain(
      "a fast-path row is never evidence",
    );
    expect(fastPathRowProblems({ ...row, verified: true })).toContain(
      "verified without a done claim graded pass",
    );
    expect(fastPathRowProblems({ ...row, simulated: false })).toContain(
      "simulated flag disagrees with the planner id",
    );
    expect(fastPathRowProblems({ ...row, arm: "myco-gate" })).toContain("arm is not fast-path");
    expect(fastPathRowProblems(null)).toEqual(["not an object"]);
  });

  it("the benchmark arm-row schema and checkBenchmark refuse a fast-path row (R1 rules unchanged)", () => {
    const row = fastPathArmRow({
      record: record(),
      trialKey: "k",
      gateVerdict: "verified",
      grade: "pass",
    });
    expect(validateSchema(row, benchmarkArmRowSchema).length).toBeGreaterThan(0);
    const relabelled = { ...row, schema: "myco.benchmark.arm-row/1" };
    expect(validateSchema(relabelled, benchmarkArmRowSchema).length).toBeGreaterThan(0);
    const result = checkBenchmark([row], [], { expectTrials: { "myco-gate": 1 } } as never);
    expect(result.errors.some((e) => e.startsWith("arm row 0:"))).toBe(true);
  });
});
