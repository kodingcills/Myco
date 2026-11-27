/**
 * Track J, j-v1 harness side: a fast-path row plus the harness's own counts becomes the
 * analysis row, with the spec's route-record guardrail applied (capability spec §2 J).
 * Synthetic rows only; nothing here ran a model.
 */
import { describe, expect, it } from "vitest";
import {
  type FastPathArmRow,
  type FastPathRunRecord,
  fastPathArmRow,
} from "../../src/actions/arm.ts";
import {
  analyzeJV1,
  isVerified,
  J_BASELINE_ARM,
  J_CAPABILITY_ARM,
  J_V1_TRIAL_SCHEMA,
  type JTrialRow,
} from "../../src/actions/j-v1-analysis.ts";
import {
  jTrialFromFastPathRow,
  jV1Schedule,
  loadJV1Prereg,
} from "../../src/actions/j-v1-harness.ts";
import type { RouteDecision } from "../../src/actions/router.ts";

const decision = (seq: number): RouteDecision => ({
  seq,
  kind: "calc.set-cell",
  action: { cell: "B12", value: "x" },
  candidates: ["api", "gui"],
  route: "api",
  reason: "preferred-route",
  fallbackFrom: null,
  attempts: [{ route: "api", outcome: "ok", code: "OK", ms: 5 }],
  code: "OK",
  ms: 5,
});

function record(over: Partial<FastPathRunRecord> = {}, actions = 2): FastPathRunRecord {
  return {
    schema: "myco.fast-path-run/1",
    arm: "fast-path",
    runId: "run-1",
    taskId: "fc-v1-001",
    policyId: "workspace/1",
    availability: { api: true, script: true, gui: true },
    routing: Array.from({ length: actions }, (_, i) => decision(i)),
    summary: {
      steps: actions,
      byRoute: { api: actions, script: 0, gui: 0, none: 0 },
      fallbacks: 0,
      denials: 0,
      routeMs: 5 * actions,
    },
    claim: "done",
    plannerModelId: "claude-sonnet-5-5",
    wallMs: 41_000,
    evidence: false,
    ...over,
  };
}

const row = (over: Partial<FastPathRunRecord> = {}, grade: FastPathArmRow["grade"] = "pass") =>
  fastPathArmRow({ record: record(over), trialKey: "k", gateVerdict: null, grade });

const INSTRUCTION_SHA = "a".repeat(64);
const FIXTURE_SHA = "b".repeat(64);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const counts = {
  seq: 7,
  toolCalls: 5,
  capToolCalls: 2,
  boundaryBreach: false,
  instructionSha256: INSTRUCTION_SHA,
  fixtureSha256: FIXTURE_SHA,
  stepBudget: 30,
  outputCeiling: 1024,
};

describe("jTrialFromFastPathRow", () => {
  it("builds the analysis row: steps are ALL tool calls, not only routed actions", () => {
    const t = jTrialFromFastPathRow(row(), counts);
    expect(t).toEqual({
      schema: J_V1_TRIAL_SCHEMA,
      taskId: "fc-v1-001",
      arm: J_CAPABILITY_ARM,
      seq: 7,
      plannerModelId: "claude-sonnet-5-5",
      simulated: false,
      claim: "done",
      grade: "pass",
      steps: 5,
      wallMs: 41_000,
      harnessFault: null,
      boundaryBreach: false,
      instructionSha256: INSTRUCTION_SHA,
      fixtureSha256: FIXTURE_SHA,
      stepBudget: 30,
      outputCeiling: 1024,
    });
    expect(isVerified(t)).toBe(true);
    expect(JSON.stringify(t)).not.toContain("B12");
  });

  it("an action without a route record is a harness fault (UNRECORDED_ROUTE), never verified", () => {
    const t = jTrialFromFastPathRow(row(), { ...counts, capToolCalls: 3 });
    expect(t.harnessFault).toBe("UNRECORDED_ROUTE");
    expect(isVerified(t)).toBe(false);
    const fewer = jTrialFromFastPathRow(row(), { ...counts, capToolCalls: 1 });
    expect(fewer.harnessFault).toBe("UNRECORDED_ROUTE");
  });

  it("carries the boundary breach and other harness faults, and maps a failure claim to not-done", () => {
    expect(jTrialFromFastPathRow(row(), { ...counts, boundaryBreach: true }).boundaryBreach).toBe(
      true,
    );
    expect(
      jTrialFromFastPathRow(row(), { ...counts, harnessFault: "CAPTURE_FAILED" }).harnessFault,
    ).toBe("CAPTURE_FAILED");
    expect(jTrialFromFastPathRow(row({ claim: "failure" }), counts).claim).toBe("not-done");
    expect(jTrialFromFastPathRow(row({}, null), counts).grade).toBeNull();
  });

  it("refuses a row with a gate verdict (j-v1 is gate-absent), even when gate and grader disagree", () => {
    const gated = (gateVerdict: FastPathArmRow["gateVerdict"], grade: FastPathArmRow["grade"]) =>
      fastPathArmRow({ record: record(), trialKey: "k", gateVerdict, grade });
    // The gate says verified, the independent grader says fail: the grade must never be
    // replaced by the gate's verdict, and the row did not run gate-absent, so it is refused.
    expect(() => jTrialFromFastPathRow(gated("verified", "fail"), counts)).toThrow(
      /gate-absent, but the row has a gate verdict/,
    );
    expect(() => jTrialFromFastPathRow(gated("refuted", "pass"), counts)).toThrow(/gate verdict/);
    expect(() => jTrialFromFastPathRow(gated("uncertain", null), counts)).toThrow(/gate verdict/);
    // Without a gate verdict the analysis row carries the grader's grade as-is.
    expect(jTrialFromFastPathRow(gated(null, "fail"), counts).grade).toBe("fail");
  });

  it("carries the parity fields from the harness record, each to its own field", () => {
    const t = jTrialFromFastPathRow(row(), {
      ...counts,
      instructionSha256: "c".repeat(64),
      fixtureSha256: "d".repeat(64),
      stepBudget: 29,
      outputCeiling: 2048,
    });
    expect([t.instructionSha256, t.fixtureSha256, t.stepBudget, t.outputCeiling]).toEqual([
      "c".repeat(64),
      "d".repeat(64),
      29,
      2048,
    ]);
  });

  it("keeps a simulated planner simulated", () => {
    const t = jTrialFromFastPathRow(row({ plannerModelId: "simulated:scripted" }), counts);
    expect(t.simulated).toBe(true);
  });

  it("refuses an evidence-claiming row and impossible counts", () => {
    const bad = { ...row(), evidence: true } as unknown as FastPathArmRow;
    expect(() => jTrialFromFastPathRow(bad, counts)).toThrow(/never evidence/);
    expect(() => jTrialFromFastPathRow(row(), { ...counts, toolCalls: 1 })).toThrow(
      /more myco-cap calls/,
    );
    expect(() => jTrialFromFastPathRow(row(), { ...counts, seq: -1 })).toThrow(/seq/);
    expect(() => jTrialFromFastPathRow(row(), { ...counts, toolCalls: 2.5 })).toThrow(/toolCalls/);
  });
});

describe("the j-v1 harness pieces fit the frozen analysis", () => {
  it("rows built in schedule order are analysed; simulated plumbing rows are never shown", () => {
    const { prereg, hash } = loadJV1Prereg(process.cwd());
    const rows: JTrialRow[] = jV1Schedule(prereg).map((s) =>
      s.arm === J_CAPABILITY_ARM
        ? jTrialFromFastPathRow(
            row({ taskId: s.taskId, plannerModelId: "simulated:scripted", wallMs: 30_000 }),
            { ...counts, seq: s.seq },
          )
        : {
            schema: J_V1_TRIAL_SCHEMA,
            taskId: s.taskId,
            arm: J_BASELINE_ARM,
            seq: s.seq,
            plannerModelId: "simulated:scripted",
            simulated: true,
            claim: "done",
            grade: "pass",
            steps: 9,
            wallMs: 90_000,
            harnessFault: null,
            boundaryBreach: false,
            instructionSha256: INSTRUCTION_SHA,
            fixtureSha256: FIXTURE_SHA,
            stepBudget: 30,
            outputCeiling: 1024,
          },
    );
    const r = analyzeJV1({ prereg, packPreregHash: hash, packPreregCommit: COMMIT, rows });
    expect(r.computed).toBe(true);
    expect(r.preregHash).toBe(hash);
    expect(r.n).toBe(180);
    expect(r.reasons.some((x) => x.startsWith("LEAD_RULING_PENDING"))).toBe(false);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^SIMULATED: 360 row/),
        expect.stringMatching(/^PLANNER_MISMATCH/),
      ]),
    );
  });
});
