/**
 * Track N: an assisted (or human-gated) trial is never unassisted R1 evidence.
 *
 * Built on the published fc-v1 task set so the base check's R1 PASSES without handoffs; then a
 * handoff ledger marking one trial assisted must flip it, under `evidence: true` and without.
 * The label is recomputed from the entries, so a row cannot declare itself unassisted.
 */
import { describe, expect, it } from "vitest";
import {
  type BenchmarkArmRow,
  checkBenchmark,
  expectedAccepted,
} from "../../src/benchmark/check.ts";
import type { BenchmarkGradeRow } from "../../src/benchmark/grade/row.ts";
import { buildTaskSet } from "../../src/benchmark/taskset.ts";
import {
  checkBenchmarkWithHandoffs,
  HANDOFF_R1,
  type HandoffTrialRow,
  handoffEvidenceError,
  parseHandoffRows,
} from "../../src/handoff/evidence.ts";
import type { HandoffEntry, HandoffLog } from "../../src/handoff/protocol.ts";

const doc = (n: number) => n.toString(16).padStart(64, "0");

function fcV1(): { arm: BenchmarkArmRow[]; grades: BenchmarkGradeRow[]; unreg: number } {
  const arm: BenchmarkArmRow[] = [];
  const grades: BenchmarkGradeRow[] = [];
  let unreg = 0;
  buildTaskSet().tasks.forEach((t, i) => {
    const unsat = !t.satisfiable;
    if (unsat) unreg += 1;
    const row0: BenchmarkArmRow = {
      schema: "myco.benchmark.arm-row/1",
      taskSetVersion: t.taskSetVersion,
      arm: "myco-gate",
      trialKey: `t${i}`,
      taskId: t.taskId,
      faultClass: t.faultClass,
      fixtureSha256: t.fixtureSha256,
      instructionSha256: t.instructionSha256,
      plannerModelId: "claude-opus-5-5",
      outputCeiling: 8192,
      claim: "done",
      gate: unsat
        ? { called: false, verdict: null, unregistrable: true }
        : { called: true, verdict: "verified" },
      accepted: false,
      persistedSha256: doc(i + 1),
      cause: null,
      cost: { modelUsd: 0.01, wallClockS: 10, vmS: null },
    };
    const row = { ...row0, accepted: expectedAccepted(row0) };
    arm.push(row);
    grades.push({
      schema: "myco.benchmark.grade-row/1",
      trialKey: row.trialKey,
      taskId: row.taskId,
      graderVersion: "false-completion-grader/1",
      status: unsat ? "fail" : "pass",
      reasons: unsat ? ["x"] : [],
      fixtureSha256: row.fixtureSha256,
      persistedSha256: row.persistedSha256,
      target: "C3",
      targetSatisfied: !unsat,
      mismatchCount: unsat ? 1 : 0,
    });
  });
  return { arm, grades, unreg };
}

function entry(over: Partial<HandoffEntry> = {}): HandoffEntry {
  return {
    handoffId: "ho-1",
    runId: "run-1",
    taskId: "fc-001",
    source: "agent",
    policyId: null,
    reason: "needs-approval",
    note: "ok to save?",
    requestedAt: "2026-11-26T15:00:00.000Z",
    resolvedAt: "2026-11-26T15:00:30.000Z",
    durationMs: 30_000,
    resolution: "fixed-it",
    resolvedBy: "operator:cli",
    operatorLabel: "operator",
    humanNote: null,
    ...over,
  };
}

function row(
  trialKey: string,
  entries: HandoffEntry[],
  over: Partial<HandoffLog> = {},
): HandoffTrialRow {
  const assistance =
    entries.length === 0
      ? "unassisted"
      : entries.some((e) => e.resolution === "fixed-it")
        ? "assisted"
        : "human-gated";
  return {
    schema: "myco.handoff.trial/1",
    trialKey,
    log: {
      schema: "myco.handoff.log/1",
      assistance,
      attemptEnd: entries.some((e) => e.resolution === "timeout") ? "handoff-timeout" : null,
      timeoutMs: 900_000,
      entries,
      ...over,
    },
  };
}

const OPTS = {
  expectTrials: { "myco-gate": 100 },
  bindTaskSet: true,
  evidence: true,
} as const;

describe("assisted trials are refused as R1 evidence", () => {
  const { arm, grades, unreg } = fcV1();
  const opts = { ...OPTS, expectUnregistrable: { "myco-gate": unreg } };

  it("baseline: the fixture passes R1 without handoffs, and with an all-unassisted ledger", () => {
    const base = checkBenchmark(arm, grades, opts);
    expect(base.errors).toEqual([]);
    expect(base.r1?.pass).toBe(true);
    const withEmpty = checkBenchmarkWithHandoffs(arm, grades, [row("t0", [])], opts);
    expect(withEmpty.errors).toEqual([]);
    expect(withEmpty.r1?.pass).toBe(true);
  });

  it("one assisted (fixed-it) trial: R1 fails and the ledger is not evidence", () => {
    const r = checkBenchmarkWithHandoffs(arm, grades, [row("t3", [entry()])], opts);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/1 row\(s\) with a human handoff \(t3=assisted\)/);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toContain(HANDOFF_R1);
  });

  it("a human-gated (approve-only) trial is not unassisted either", () => {
    const r = checkBenchmarkWithHandoffs(
      arm,
      grades,
      [row("t4", [entry({ resolution: "approve" })])],
      opts,
    );
    expect(r.r1?.pass).toBe(false);
    expect(r.errors.join("\n")).toMatch(/t4=human-gated/);
  });

  it("R1 fails on an assisted row even when evidence mode is off (R1 is unassisted by definition)", () => {
    const r = checkBenchmarkWithHandoffs(arm, grades, [row("t3", [entry()])], {
      ...opts,
      evidence: false,
    });
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toContain(HANDOFF_R1);
  });

  it("a row that declares unassisted while carrying a fixed-it is caught and counted assisted", () => {
    const forged = row("t5", [entry()], { assistance: "unassisted" });
    const parsed = parseHandoffRows([forged]);
    expect(parsed.errors.join("\n")).toMatch(
      /declared assistance unassisted but its handoffs imply assisted/,
    );
    expect(parsed.byTrial.get("t5")).toBe("assisted");
    const r = checkBenchmarkWithHandoffs(arm, grades, [forged], opts);
    expect(r.r1?.pass).toBe(false);
  });

  it("a row that declares assisted with no entries stays assisted (the stricter label)", () => {
    const parsed = parseHandoffRows([row("t6", [], { assistance: "assisted" })]);
    expect(parsed.byTrial.get("t6")).toBe("assisted");
  });

  it("inconsistent rows are errors: timeout without attemptEnd, human outcome by host, stray keys", () => {
    const parsed = parseHandoffRows([
      row(
        "t7",
        [entry({ resolution: "timeout", resolvedBy: "host:timeout", operatorLabel: null })],
        {
          attemptEnd: null,
        },
      ),
      row("t8", [entry({ resolution: "approve", resolvedBy: "host:timeout" })]),
      row("t9", [entry({ source: "policy", policyId: null })]),
      row("t10", [entry({ note: "see /home/someone/x" })]),
      row("t7", []),
    ]);
    const text = parsed.errors.join("\n");
    expect(text).toMatch(/t7: attemptEnd disagrees/);
    expect(text).toMatch(/t8: ho-1 resolvedBy host:timeout with approve/);
    expect(text).toMatch(/t9: ho-1 policyId must be set exactly for policy handoffs/);
    expect(text).toMatch(/t10: ho-1 agent note fails note hygiene/);
    expect(text).toMatch(/duplicate handoff row for trialKey t7/);
  });

  it("a handoff row naming no arm row is an error, and a malformed row fails schema", () => {
    const r = checkBenchmarkWithHandoffs(arm, grades, [row("nope", []), { schema: "x" }], opts);
    expect(r.errors.join("\n")).toMatch(/handoff row nope has no arm row/);
    expect(r.errors.join("\n")).toMatch(/handoff row 1:/);
    expect(r.r1?.pass).toBe(false);
  });

  it("handoffEvidenceError mirrors correctionsOnError: null when nobody was helped", () => {
    expect(handoffEvidenceError(arm, new Map())).toBeNull();
    expect(handoffEvidenceError(arm, new Map([["t1", "unassisted"]]))).toBeNull();
    expect(handoffEvidenceError(arm, new Map([["t1", "assisted"]]))).toMatch(/t1=assisted/);
  });
});
