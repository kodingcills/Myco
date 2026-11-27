/**
 * Track C, the binding guarantees: an agent-written check is NEVER the grader and NEVER
 * changes a gate verdict or R1 evidence. Each test is an attempt to make a signal do one of
 * those things, and shows it refused.
 *
 * The signal used is a real one: an accepted, target-only check that VERIFIES a document with
 * collateral damage, which the gate refutes and the grader fails. If a signal could leak into
 * either, this is the document where it would show.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AgentCheckSignal,
  proposeAgentCheck,
  runAgentCheck,
} from "../../src/agent-checks/check.ts";
import {
  AGENT_CHECK_EVIDENCE_CLASS,
  AGENT_CHECK_SIGNAL_KIND,
  AGENT_CHECK_SOURCE,
  agentCheckRowsError,
  carriesAgentCheckSignal,
} from "../../src/agent-checks/label.ts";
import {
  type BenchmarkArmRow,
  checkBenchmark,
  expectedAccepted,
} from "../../src/benchmark/check.ts";
import { type ColumnType, grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import type { BenchmarkGradeRow } from "../../src/benchmark/grade/row.ts";
import { parseGateRequest } from "../../src/gate/api.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { checkPack } from "../../src/m2/evidence.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";
import { tempRoot, writeState } from "../gate/helpers.ts";
import { input, manifest, r1Trials } from "../m2/pack-fixture.ts";
import {
  BINDING,
  TASK,
  cleanupPlugins,
  collateralCsv,
  csvDoc,
  exactCsv,
  honestSource,
  makeCheck,
  SEED,
  SPEC,
} from "./helpers.ts";

afterAll(cleanupPlugins);

let signal: AgentCheckSignal;
beforeAll(() => {
  const r = proposeAgentCheck(makeCheck(honestSource()), BINDING, TASK);
  if (!r.ok) throw new Error(r.code);
  signal = runAgentCheck(r.check, BINDING, csvDoc(collateralCsv), SPEC);
}, 120_000);

function gateFor(csv: string) {
  const root = tempRoot();
  writeState(root, BINDING.runId, "sheet.csv", csv);
  return createGate({
    tasks: buildRegistry([
      { id: BINDING.taskId, family: "calc-record-edit", stateFile: "sheet.csv", spec: SPEC },
    ]),
    reader: fileEvidenceReader(root),
    assignment: { taskId: BINDING.taskId, runId: BINDING.runId },
  });
}

const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);
function gradeInput(csv: string) {
  const fixtureCsv = Buffer.from(generateFixture(SEED).csv);
  return {
    fixtureCsv,
    fixtureSha256: sha256(fixtureCsv),
    persisted: { format: "csv" as const, bytes: Buffer.from(csv) },
    intent: { rowKey: SPEC.rowKey, column: SPEC.column, newValue: SPEC.newValue },
    columnTypes: COLUMN_TYPES,
  };
}

describe("track C: the signal under test disagrees with the gate and the grader", () => {
  it("the check verifies the collateral document; the gate refutes it; the grader fails it", async () => {
    expect([signal.status, signal.codeSource, signal.advisory]).toEqual([
      "verified",
      "check",
      true,
    ]);
    const g = await gateFor(collateralCsv).check({ taskId: BINDING.taskId, runId: BINDING.runId });
    expect(g.verdict).toBe("refuted");
    expect(grade(gradeInput(collateralCsv)).status).toBe("fail");
    // Control: on the exact document all three agree, so the disagreement is the collateral.
    expect(
      (await gateFor(exactCsv).check({ taskId: BINDING.taskId, runId: BINDING.runId })).verdict,
    ).toBe("verified");
  });
});

describe("track C: a signal never changes a gate verdict (myco.gate/v1 takes taskId/runId/claim only)", () => {
  const base = { taskId: BINDING.taskId, runId: BINDING.runId };

  it("a request carrying the signal, under any field name, is rejected and nothing is read", async () => {
    const attempts: Array<[Record<string, unknown>, string]> = [
      [{ ...base, agentCheck: signal }, "UNKNOWN_FIELD"],
      [{ ...base, signal }, "UNKNOWN_FIELD"],
      [{ ...base, advisory: signal }, "UNKNOWN_FIELD"],
      [{ ...base, evidence: signal }, "ORACLE_INPUT_REJECTED"],
      [{ ...base, verdict: signal.status }, "ORACLE_INPUT_REJECTED"],
      [{ ...base, oracle: signal }, "ORACLE_INPUT_REJECTED"],
      [{ ...base, status: signal.status }, "ORACLE_INPUT_REJECTED"],
    ];
    for (const [req, code] of attempts) {
      const parsed = parseGateRequest(req);
      expect(parsed.ok, JSON.stringify(Object.keys(req))).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe(code);
      const r = await gateFor(collateralCsv).check(req);
      expect(r.verdict).toBe("uncertain");
      expect(r.accepted).toBe(false);
      expect(r.reasonCodes).toEqual([code]);
      // Nothing was read and no oracle ran.
      expect(r.evidenceRefs).toEqual([]);
      expect(r.oracle).toBeUndefined();
    }
  });

  it("the signal smuggled into the claim text leaves the verdict, codes and evidence refs unchanged", async () => {
    const plain = await gateFor(collateralCsv).check({ ...base, claim: "done" });
    const smuggled = await gateFor(collateralCsv).check({
      ...base,
      claim: `done; ${JSON.stringify(signal)}`.slice(0, 4000),
    });
    expect(smuggled.verdict).toBe("refuted");
    expect(smuggled.verdict).toBe(plain.verdict);
    expect(smuggled.accepted).toBe(false);
    expect(smuggled.reasonCodes).toEqual(plain.reasonCodes);
    expect(smuggled.reasons).toEqual(plain.reasons);
    expect(smuggled.evidenceRefs).toEqual(plain.evidenceRefs);
    expect(smuggled.oracle).toEqual(plain.oracle);
  });
});

describe("track C: a signal is never the grader", () => {
  it("grade() with the signal attached returns exactly what it returns without it", () => {
    for (const csv of [collateralCsv, exactCsv]) {
      const plain = grade(gradeInput(csv));
      const attached = grade({
        ...gradeInput(csv),
        agentCheck: signal,
        status: signal.status,
        verdict: signal.status,
      } as never);
      expect(attached).toEqual(plain);
    }
    expect(grade(gradeInput(collateralCsv)).status).toBe("fail");
  });
});

const FIX = "a".repeat(64);
function armRow(i: number): BenchmarkArmRow {
  const row: BenchmarkArmRow = {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: "fc-v1",
    arm: "myco-gate",
    trialKey: `t${i}`,
    taskId: `fc-${i}`,
    faultClass: "none",
    fixtureSha256: FIX,
    instructionSha256: "b".repeat(64),
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: 8192,
    claim: "done",
    gate: { called: true, verdict: "verified" },
    accepted: true,
    persistedSha256: i.toString(16).padStart(64, "0"),
    cause: null,
    cost: { modelUsd: null, wallClockS: 1, vmS: null },
  };
  return { ...row, accepted: expectedAccepted(row) };
}
function gradeRow(row: BenchmarkArmRow): BenchmarkGradeRow {
  return {
    schema: "myco.benchmark.grade-row/1",
    trialKey: row.trialKey,
    taskId: row.taskId,
    graderVersion: "false-completion-grader/1",
    status: "pass",
    reasons: [],
    fixtureSha256: row.fixtureSha256,
    persistedSha256: row.persistedSha256,
    target: "C3",
    targetSatisfied: true,
    mismatchCount: 0,
  };
}

const AGENT = /agent-written check signal.*advisory only, never evidence/;

describe("track C: a signal is never R1 evidence (checkBenchmark, checkPack)", () => {
  const rows = [armRow(1), armRow(2)];
  const grades = rows.map(gradeRow);
  const opts = { expectTrials: { "myco-gate": 2 } };

  it("control: the clean ledger carries no agent-check error", () => {
    expect(checkBenchmark(rows, grades, opts).errors.join("\n")).not.toMatch(AGENT);
    expect(checkBenchmark(rows, grades, { ...opts, evidence: true }).errors.join("\n")).not.toMatch(
      AGENT,
    );
  });

  it("refuses the signal as an arm row, a grade row, or a field nested in either, evidence or not", () => {
    const attempts: Array<[unknown[], unknown[]]> = [
      [[...rows, signal], grades],
      [rows, [...grades, signal]],
      [[{ ...rows[0], agentCheck: signal }, rows[1]], grades],
      [[{ ...rows[0], gate: { ...rows[0]?.gate, note: signal } }, rows[1]], grades],
      [rows, [{ ...grades[0], reasons: [signal] }, grades[1]]],
    ];
    for (const [a, g] of attempts) {
      for (const evidence of [false, true]) {
        const r = checkBenchmark(a, g, { ...opts, evidence });
        expect(r.ok).toBe(false);
        expect(r.errors.join("\n")).toMatch(AGENT);
      }
    }
  });

  it("refuses a row carrying any ONE of the three markers, even with the others stripped", () => {
    for (const marker of [
      { kind: AGENT_CHECK_SIGNAL_KIND },
      { evidenceClass: AGENT_CHECK_EVIDENCE_CLASS },
      { provenance: { source: AGENT_CHECK_SOURCE } },
    ]) {
      const r = checkBenchmark([{ ...rows[0], x: marker }, rows[1]], grades, opts);
      expect(r.errors.join("\n"), JSON.stringify(marker)).toMatch(AGENT);
    }
  });

  it("checkPack refuses the signal in every committed record of a pack", () => {
    const base = input(r1Trials(), manifest());
    expect(checkPack(base).errors.join("\n")).not.toMatch(AGENT);
    const ops = base.ops as Record<string, unknown>[];
    const attempts = [
      { ...base, arm: [...base.arm, signal] },
      { ...base, grades: [...base.grades, signal] },
      { ...base, ops: [{ ...ops[0], agentCheck: signal }, ...ops.slice(1)] },
      { ...base, manifest: { ...(base.manifest as object), agentCheck: signal } },
      { ...base, attempts: [...(base.attempts ?? []), signal] },
      { ...base, anchor: [...(base.anchor ?? []), signal] },
      { ...base, superseded: [signal] },
    ];
    attempts.forEach((a, i) => {
      const r = checkPack(a);
      expect(r.ok, `attempt ${i}`).toBe(false);
      expect(r.errors.join("\n"), `attempt ${i}`).toMatch(AGENT);
    });
  });
});

describe("track C: the label scan", () => {
  it("finds a marker at any depth, survives cycles, and fails closed past its depth bound", () => {
    expect(carriesAgentCheckSignal({ a: [{ b: { c: signal } }] })).toBe(true);
    expect(carriesAgentCheckSignal({ a: 1, b: ["x", null] })).toBe(false);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(carriesAgentCheckSignal(cyc)).toBe(false);
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(carriesAgentCheckSignal(deep)).toBe(true);
    let shallow: unknown = "leaf";
    for (let i = 0; i < 30; i++) shallow = { d: shallow };
    expect(carriesAgentCheckSignal(shallow)).toBe(false);
    expect(agentCheckRowsError([{}, signal, {}], "arm")).toMatch(/1 arm row\(s\).*row 1\b/);
    expect(agentCheckRowsError([{}, {}], "arm")).toBeNull();
  });
});
