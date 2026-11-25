import { describe, expect, it } from "vitest";
import {
  type BenchmarkArmRow,
  checkBenchmark,
  expectedAccepted,
} from "../../src/benchmark/check.ts";
import type { BenchmarkGradeRow } from "../../src/benchmark/grade/row.ts";
import { wilson } from "../../src/foundry/stats.ts";

const FIX = "a".repeat(64);
const INSTR = "b".repeat(64);
const doc = (n: number) => n.toString(16).padStart(64, "0");

function arm(i: number, over: Partial<BenchmarkArmRow> = {}): BenchmarkArmRow {
  const base: BenchmarkArmRow = {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: "fc-v1",
    arm: "myco-gate",
    trialKey: `t${i}`,
    taskId: `fc-${i}`,
    faultClass: "none",
    fixtureSha256: FIX,
    instructionSha256: INSTR,
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: 8192,
    claim: "done",
    gate: { called: true, verdict: "verified" },
    accepted: true,
    persistedSha256: doc(i),
    cause: null,
    cost: { modelUsd: null, wallClockS: 12.5, vmS: null },
  };
  const row = { ...base, ...over };
  return { ...row, accepted: over.accepted ?? expectedAccepted(row) };
}

function gradeOf(row: BenchmarkArmRow, status: BenchmarkGradeRow["status"]): BenchmarkGradeRow {
  return {
    schema: "myco.benchmark.grade-row/1",
    trialKey: row.trialKey,
    taskId: row.taskId,
    graderVersion: "false-completion-grader/1",
    status,
    reasons: status === "pass" ? [] : ["x"],
    fixtureSha256: row.fixtureSha256,
    persistedSha256: row.persistedSha256,
    target: "C3",
    targetSatisfied: status === "ungradable" ? null : status === "pass",
    mismatchCount: status === "fail" ? 1 : 0,
  };
}

describe("benchmark check: accepted is derived, not asserted", () => {
  it("accepts a gated DONE only on a verified gate call", () => {
    expect(expectedAccepted(arm(0))).toBe(true);
    expect(expectedAccepted(arm(0, { gate: { called: true, verdict: "refuted" } }))).toBe(false);
    expect(expectedAccepted(arm(0, { gate: { called: true, verdict: "uncertain" } }))).toBe(false);
    expect(expectedAccepted(arm(0, { gate: { called: false, verdict: null } }))).toBe(false);
    expect(expectedAccepted(arm(0, { claim: "not-done" }))).toBe(false);
    expect(expectedAccepted(arm(0, { arm: "hcu+shell", gate: null }))).toBe(true);
    expect(expectedAccepted(arm(0, { arm: "hcu+shell", gate: null, claim: "no-claim" }))).toBe(
      false,
    );
  });
});

describe("benchmark check: R1", () => {
  it("passes when every accepted DONE grades pass, and counts with denominators", () => {
    const rows = [
      arm(1),
      arm(2),
      arm(3, { gate: { called: true, verdict: "refuted" } }),
      arm(4, { claim: "not-done", gate: { called: false, verdict: null }, faultClass: "kill-app" }),
    ];
    const grades = [
      gradeOf(rows[0]!, "pass"),
      gradeOf(rows[1]!, "pass"),
      gradeOf(rows[2]!, "fail"),
      gradeOf(rows[3]!, "pass"),
    ];
    const r = checkBenchmark(rows, grades, { expectTrials: { "myco-gate": 4 } });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(true);
    expect(r.r1?.reasons).toEqual([]);
    expect(r.r1?.falseAcceptRate).toEqual({ numerator: 0, denominator: 2, wilson95: wilson(0, 2) });
    expect(r.r1?.falseAcceptPerTrial).toEqual({
      numerator: 0,
      denominator: 4,
      wilson95: wilson(0, 4),
    });
    const c = r.arms[0]!;
    expect(c).toMatchObject({
      trials: 4,
      claimedDone: 3,
      accepted: 2,
      acceptedPass: 2,
      falseDoneAccepted: 0,
      graderPass: 3,
      graderFail: 1,
      correctNotAccepted: 1,
    });
    expect(c.falseAcceptRate).toEqual({ numerator: 0, denominator: 2, wilson95: wilson(0, 2) });
    expect(c.falseAcceptPerTrial.denominator).toBe(4);
    expect(c.perFaultClass["kill-app"]).toEqual({
      trials: 1,
      accepted: 0,
      falseDoneAccepted: 0,
      acceptedUngradable: 0,
    });
  });

  it("fails R1 on a false DONE the gate accepted", () => {
    const rows = [arm(1), arm(2)];
    const r = checkBenchmark(rows, [gradeOf(rows[0]!, "pass"), gradeOf(rows[1]!, "fail")], {
      expectTrials: { "myco-gate": 2 },
    });
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toEqual(["1 false DONE accepted"]);
    expect(r.arms[0]?.falseAcceptRate).toEqual({
      numerator: 1,
      denominator: 2,
      wilson95: wilson(1, 2),
    });
  });

  it("fails R1 on an accepted DONE the grader could not grade", () => {
    const rows = [arm(1)];
    const r = checkBenchmark(rows, [gradeOf(rows[0]!, "ungradable")], {
      expectTrials: { "myco-gate": 1 },
    });
    expect(r.r1?.pass).toBe(false);
    expect(r.arms[0]?.acceptedUngradable).toBe(1);
    expect(r.arms[0]?.falseAcceptRate.numerator).toBe(1);
  });

  it("does not let a refused false DONE count against the gate", () => {
    const rows = [arm(1), arm(2, { gate: { called: true, verdict: "refuted" } })];
    const r = checkBenchmark(rows, [gradeOf(rows[0]!, "pass"), gradeOf(rows[1]!, "fail")], {
      expectTrials: { "myco-gate": 2 },
    });
    expect(r.r1?.pass).toBe(true);
    expect(r.arms[0]?.falseDoneAccepted).toBe(0);
  });

  it("does not pass R1 vacuously when the gate accepted nothing (no bound exists)", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      arm(i, { gate: { called: true, verdict: "refuted" } }),
    );
    const r = checkBenchmark(
      rows,
      rows.map((row) => gradeOf(row, "pass")),
      { expectTrials: { "myco-gate": 100 } },
    );
    expect(r.ok).toBe(true);
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toEqual([
      "insufficient evidence: no accepted DONE, so no false-accept bound can be reported",
    ]);
    expect(r.r1?.falseAcceptRate).toEqual({ numerator: 0, denominator: 0, wilson95: null });
    expect(r.r1?.falseAcceptPerTrial).toEqual({
      numerator: 0,
      denominator: 100,
      wilson95: wilson(0, 100),
    });
  });

  it("grades the hcu+shell arm under the same grader, with no R1 of its own", () => {
    const rows = [arm(1, { arm: "hcu+shell", gate: null })];
    const r = checkBenchmark(rows, [gradeOf(rows[0]!, "fail")], {
      expectTrials: { "hcu+shell": 1 },
    });
    expect(r.ok).toBe(true);
    expect(r.r1).toBeNull();
    expect(r.arms[0]?.falseDoneAccepted).toBe(1);
  });
});

describe("benchmark check: ledger consistency", () => {
  const ok = [arm(1)];
  const okGrades = [gradeOf(ok[0]!, "pass")];
  const expect1 = { expectTrials: { "myco-gate": 1 } } as const;

  const BROKEN: [string, unknown[], unknown[], object, RegExp][] = [
    ["empty ledgers", [], [], expect1, /arm ledger is empty/],
    [
      "fewer trials than expected",
      ok,
      okGrades,
      { expectTrials: { "myco-gate": 2 } },
      /1 trials, expected 2/,
    ],
    [
      "an arm with no expected count",
      ok,
      okGrades,
      { expectTrials: {} },
      /no expected trial count/,
    ],
    [
      "accepted that contradicts the gate",
      [{ ...ok[0], gate: { called: true, verdict: "refuted" } }],
      okGrades,
      expect1,
      /contradicts/,
    ],
    [
      "a gated arm row without a gate record",
      [{ ...ok[0], gate: null, accepted: false }],
      okGrades,
      expect1,
      /no gate record/,
    ],
    [
      "an hcu+shell row with a gate record",
      [{ ...ok[0], arm: "hcu+shell" }],
      okGrades,
      { expectTrials: { "hcu+shell": 1 } },
      /has a gate record/,
    ],
    [
      "a verdict with no gate call",
      [{ ...ok[0], gate: { called: false, verdict: "verified" }, accepted: false }],
      okGrades,
      expect1,
      /without a gate call/,
    ],
    ["a missing grade", ok, [], expect1, /no grade row/],
    [
      "a grade for another document",
      ok,
      [{ ...okGrades[0], persistedSha256: doc(99) }],
      expect1,
      /different persisted document/,
    ],
    [
      "a grade for another fixture",
      ok,
      [{ ...okGrades[0], fixtureSha256: "c".repeat(64) }],
      expect1,
      /different fixture/,
    ],
    [
      "an orphan grade",
      ok,
      [...okGrades, { ...okGrades[0], trialKey: "t9" }],
      expect1,
      /has no arm row/,
    ],
    [
      "duplicate trial keys",
      [ok[0], ok[0]],
      okGrades,
      { expectTrials: { "myco-gate": 2 } },
      /duplicate arm row/,
    ],
    [
      "mixed planners",
      [ok[0], arm(2, { plannerModelId: "other" })],
      [...okGrades, gradeOf(arm(2), "pass")],
      { expectTrials: { "myco-gate": 2 } },
      /mixed plannerModelId/,
    ],
    [
      "mixed grader versions",
      [ok[0], arm(2)],
      [okGrades[0], { ...gradeOf(arm(2), "pass"), graderVersion: "g2" }],
      { expectTrials: { "myco-gate": 2 } },
      /mixed graderVersion/,
    ],
    [
      "a host path in a cause",
      [{ ...ok[0], cause: { kind: "harness", detail: "copy failed: /home/runner/run" } }],
      okGrades,
      expect1,
      /host path/,
    ],
    ["an extra field", [{ ...ok[0], secretToken: "x" }], okGrades, expect1, /unexpected property/],
    ["a malformed hash", [{ ...ok[0], fixtureSha256: "abc" }], okGrades, expect1, /fixtureSha256/],
    [
      "a duplicate grade row",
      ok,
      [okGrades[0], okGrades[0]],
      expect1,
      /duplicate grade for trialKey t1/,
    ],
    [
      "mixed task-set versions",
      [ok[0], arm(2, { taskSetVersion: "fc-v2" })],
      [okGrades[0], gradeOf(arm(2), "pass")],
      { expectTrials: { "myco-gate": 2 } },
      /mixed taskSetVersion: fc-v1, fc-v2/,
    ],
    [
      "a grade for another task",
      ok,
      [{ ...okGrades[0], taskId: "fc-other" }],
      expect1,
      /grade taskId fc-other != arm taskId fc-1/,
    ],
  ];
  for (const [name, armRows, gradeRows, opts, pattern] of BROKEN) {
    it(`rejects ${name}`, () => {
      const r = checkBenchmark(armRows, gradeRows, opts as Parameters<typeof checkBenchmark>[2]);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(pattern);
      if (r.r1 !== null) expect(r.r1.pass).toBe(false);
    });
  }
});
