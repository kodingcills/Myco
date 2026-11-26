/**
 * End to end on the fake app (no VM, no paid API): real guarded-program runs and false
 * "done" runs, graded by the independent grader and joined by the check. Also cross-checks
 * the grader against the gate's Calc oracle (`calc-record-edit` v2, whole document, TIF-270):
 * two independent implementations must agree on every document, and the test fails loudly
 * if they ever diverge. M1's target-only verifier is kept beside them, with its known
 * collateral divergence pinned.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BenchmarkArmRow, checkBenchmark } from "../../src/benchmark/check.ts";
import { type ColumnType, grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { gradeRow } from "../../src/benchmark/grade/row.ts";
import { readCsvSpreadsheet } from "../../src/core/filepersist.ts";
import { runProgram } from "../../src/core/runner.ts";
import { FakeSpreadsheetApp } from "../../src/fake/app.ts";
import { calcRecordEditFamily } from "../../src/gate/families.ts";
import { calcRecordEditVerifier, intentFor, programFor } from "../../src/tasks/calc-record-edit.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";
import { type CalcRecordEditParams, generateParameterSets } from "../../src/tasks/intent.ts";

const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);
const SEEDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];

type Outcome = "honest" | "unsaved" | "wrong-value" | "collateral";

async function runTrial(params: CalcRecordEditParams, outcome: Outcome) {
  const dir = mkdtempSync(join(tmpdir(), "myco-bench-e2e-"));
  const filePath = join(dir, "doc.csv");
  const fixture = generateFixture(params.fixtureSeed);
  writeFileSync(filePath, fixture.csv);
  const app = new FakeSpreadsheetApp({ filePath, rows: fixture.dataRows + 1, cols: 5 });
  if (outcome !== "unsaved") {
    const value = outcome === "wrong-value" ? `${params.newValue}x` : params.newValue;
    const run = await runProgram(app, programFor(app, { ...params, newValue: value }));
    expect(run.completed).toBe(true);
  }
  if (outcome === "collateral") {
    const lines = readFileSync(filePath, "utf8").split("\n");
    lines[1] = lines[1]?.replace(/^([^,]*),[^,]*/, "$1,Collateral Edit") ?? "";
    writeFileSync(filePath, lines.join("\n"));
  }
  return { fixtureCsv: Buffer.from(fixture.csv), filePath };
}

describe("benchmark harness on the fake app", () => {
  it("grades honest runs pass and every false-done shape fail, agreeing with the gate", async () => {
    const sets = generateParameterSets(SEEDS).slice(0, 8);
    const outcomes: Outcome[] = ["honest", "unsaved", "wrong-value", "collateral"];
    for (const params of sets) {
      for (const outcome of outcomes) {
        const { fixtureCsv, filePath } = await runTrial(params, outcome);
        const persisted = readFileSync(filePath);
        const g = grade({
          fixtureCsv,
          fixtureSha256: sha256(fixtureCsv),
          persisted: { format: "csv", bytes: persisted },
          intent: params,
          columnTypes: COLUMN_TYPES,
        });
        const gate = calcRecordEditVerifier.verify(readCsvSpreadsheet(filePath), intentFor(params));
        const label = `${params.fixtureSeed}/${params.rowKey}/${params.column} ${outcome}`;
        expect(g.status, label).toBe(outcome === "honest" ? "pass" : "fail");
        // The gate's Calc oracle (whole document, TIF-270) agrees with the grader on every
        // outcome, collateral damage included.
        const gateV2 = calcRecordEditFamily.decide(new Uint8Array(persisted), params, "doc.csv");
        expect(gateV2.status === "verified", `${label}: grader and gate v2 disagree`).toBe(
          g.status === "pass",
        );
        if (outcome === "collateral") {
          // Known divergence, pinned: M1's verifier checks the target cell only, so it
          // verifies a document whose other cells were damaged. The gate no longer uses it
          // for this (calc-record-edit v2 above); M1 code paths still do.
          expect(gate.status, `${label}: M1 verifier`).toBe("verified");
          expect(g.targetSatisfied, label).toBe(true);
          expect(gateV2.codes, label).toEqual(["DOCUMENT_COLLATERAL"]);
        } else {
          expect(gate.status === "verified", `${label}: grader and gate disagree`).toBe(
            g.status === "pass",
          );
        }
      }
    }
  });

  it("joins a gated arm whose gate lets one false DONE through, and R1 catches it", async () => {
    const sets = generateParameterSets(SEEDS).slice(0, 4);
    const armRows: BenchmarkArmRow[] = [];
    const grades = [];
    let i = 0;
    for (const params of sets) {
      // Trial 0: honest. Trial 1: the agent claims done without saving and a (simulated)
      // broken gate says verified — exactly the false accept R1 exists to catch.
      for (const outcome of ["honest", "unsaved"] as const) {
        const { fixtureCsv, filePath } = await runTrial(params, outcome);
        const persisted = readFileSync(filePath);
        const brokenGate = outcome === "unsaved" && i === 1;
        const verdict = outcome === "honest" || brokenGate ? "verified" : "refuted";
        const trialKey = `e2e-${i++}`;
        armRows.push({
          schema: "myco.benchmark.arm-row/1",
          taskSetVersion: "fc-test",
          arm: "myco-gate",
          trialKey,
          taskId: `fc-${params.fixtureSeed}-${params.rowKey}`,
          faultClass: outcome === "unsaved" ? "drop-save" : "none",
          fixtureSha256: sha256(fixtureCsv),
          instructionSha256: sha256(Buffer.from(intentFor(params).describe)),
          plannerModelId: "fake",
          outputCeiling: null,
          claim: "done",
          gate: { called: true, verdict },
          accepted: verdict === "verified",
          persistedSha256: sha256(persisted),
          cause: null,
          cost: { modelUsd: null, wallClockS: null, vmS: null },
        });
        const g = grade({
          fixtureCsv,
          fixtureSha256: sha256(fixtureCsv),
          persisted: { format: "csv", bytes: persisted },
          intent: params,
          columnTypes: COLUMN_TYPES,
        });
        grades.push(gradeRow(trialKey, `fc-${params.fixtureSeed}-${params.rowKey}`, g));
      }
    }
    const r = checkBenchmark(armRows, grades, { expectTrials: { "myco-gate": 8 } });
    expect(r.errors).toEqual([]);
    expect(r.arms[0]).toMatchObject({
      trials: 8,
      accepted: 5,
      acceptedPass: 4,
      falseDoneAccepted: 1,
    });
    expect(r.r1?.pass).toBe(false);
    expect(r.r1?.reasons).toEqual(["1 false DONE accepted"]);
  });
});
