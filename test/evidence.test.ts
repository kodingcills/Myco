import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerRowSchema } from "../schemas/ledger-row.ts";
import { resultRecordSchema } from "../schemas/result-record.ts";
import { traceEventSchema } from "../schemas/trace-events.ts";
import { runEvaluation } from "../src/core/eval.ts";
import {
  assertSchema,
  auditLedgerRows,
  InvalidEvidenceError,
  type LedgerRow,
} from "../src/core/evidence.ts";
import { FakeSpreadsheetApp } from "../src/fake/app.ts";
import { delayedSave, focusChange, invalidTarget, killApp } from "../src/fake/faults.ts";
import { cellVerifier, setCellFamily } from "../src/fake/tasks.ts";

function freshSheet(name: string): { dir: string; file: (trial: number) => string } {
  const dir = mkdtempSync(join(tmpdir(), `myco-evidence-${name}-`));
  const file = (trial: number) => {
    const p = join(dir, `sheet-${trial}.csv`);
    writeFileSync(p, ",\n,\n,\n,\n");
    return p;
  };
  return { dir, file };
}

function readLedgerRows(runsDir: string, evalId: string): LedgerRow[] {
  const ledgerPath = join(runsDir, evalId, "ledger.jsonl");
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LedgerRow);
}

describe("evidence schema validation", () => {
  it("rejects a tampered result.json", async () => {
    const { dir, file } = freshSheet("tamper");
    const runsDir = join(dir, "runs");
    await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [{ name: "none" }],
      trials: 1,
      filePathFor: file,
      runsDir,
      evalId: "eval-tamper",
    });
    const runId = readdirSync(runsDir).find((d) => d !== "eval-tamper");
    expect(runId).toBeDefined();
    const resultPath = join(runsDir, runId as string, "result.json");
    const tampered = JSON.parse(readFileSync(resultPath, "utf8"));
    tampered.verdict.status = "definitely-fine"; // tamper: invalid enum value

    expect(() => assertSchema(tampered, resultRecordSchema, "result.json")).toThrow(
      InvalidEvidenceError,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a trace line with an unknown event type", () => {
    expect(() =>
      assertSchema({ type: "mystery-event", data: 1 }, traceEventSchema, "trace event"),
    ).toThrow(InvalidEvidenceError);
  });

  it("rejects a ledger row missing its oracle", () => {
    const row = {
      evalId: "e",
      runId: "r",
      trialIndex: 0,
      corruptionClass: "kill-app",
      actionKind: "click",
      state: "pass",
      refusalCode: null,
    };
    expect(() => assertSchema(row, ledgerRowSchema, "ledger row")).toThrow(InvalidEvidenceError);
  });

  it("accepts a valid ledger row", () => {
    const row: LedgerRow = {
      evalId: "e",
      runId: "r",
      trialIndex: 0,
      corruptionClass: "kill-app",
      actionKind: "click",
      state: "gap",
      oracle: "verifier:uncertain",
      refusalCode: null,
    };
    expect(() => assertSchema(row, ledgerRowSchema, "ledger row")).not.toThrow();
  });
});

describe("conformance ledger", () => {
  it("has no unaccounted rows after a mixed normal+corrupted eval", async () => {
    const { dir, file } = freshSheet("mixed");
    const runsDir = join(dir, "runs");
    const summary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [killApp(), delayedSave(), focusChange(), invalidTarget(), { name: "none" }],
      trials: 5,
      filePathFor: file,
      runsDir,
      evalId: "eval-mixed",
    });

    expect(summary.ledger).toBeDefined();
    expect(summary.ledger?.unaccounted).toBe(0);
    expect(summary.ledger?.rows).toBeGreaterThan(0);

    const rows = readLedgerRows(runsDir, "eval-mixed");
    // every persisted row is schema-valid
    for (const row of rows) {
      expect(() => assertSchema(row, ledgerRowSchema, "ledger row")).not.toThrow();
    }
    // every row is accounted for by the accounting function
    const accounting = auditLedgerRows(rows);
    expect(accounting.unaccounted).toBe(0);
    expect(accounting.rows).toBe(rows.length);
    // one row per (trial, corruption-class, action-kind): no duplicate keys
    const keys = new Set(rows.map((r) => `${r.trialIndex}|${r.corruptionClass}|${r.actionKind}`));
    expect(keys.size).toBe(rows.length);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never counts gap rows as passes", () => {
    const accounting = auditLedgerRows([
      {
        evalId: "e",
        runId: "r1",
        trialIndex: 0,
        corruptionClass: "kill-app",
        actionKind: "click",
        state: "gap",
        oracle: "verifier:uncertain",
        refusalCode: null,
      },
      {
        evalId: "e",
        runId: "r2",
        trialIndex: 1,
        corruptionClass: "none",
        actionKind: "click",
        state: "pass",
        oracle: "verifier:verified+ground-truth",
        refusalCode: null,
      },
    ]);
    expect(accounting.gap).toBe(1);
    expect(accounting.pass).toBe(1);
    expect(accounting.rows).toBe(2);
    expect(accounting.unaccounted).toBe(0);
  });
});

describe("eval summary rate reporting", () => {
  it("reports successRate and checkPassRate separately", async () => {
    const { dir, file } = freshSheet("rates");
    const summary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [killApp(), { name: "none" }],
      trials: 2,
      filePathFor: file,
      runsDir: join(dir, "runs"),
      evalId: "eval-rates",
    });

    // trial 0 is killed before save (not satisfied, refuted or uncertain);
    // trial 1 is clean (satisfied, verified)
    expect(summary.results[0]?.groundTruthSatisfied).toBe(false);
    expect(summary.results[1]?.groundTruthSatisfied).toBe(true);
    // successRate: intent-satisfaction rate over trials
    expect(summary.successRate).toBe(0.5);
    // checkPassRate: per-check pass rate — distinct field, distinct value source
    expect(summary.checkPassRate).toBeDefined();
    expect(summary.checkPassRate).toBeLessThanOrEqual(1);
    expect(summary.checkPassRate).toBeGreaterThanOrEqual(0);
    // both fields present and independently computed, never aliased
    expect(summary).toHaveProperty("successRate");
    expect(summary).toHaveProperty("checkPassRate");
    rmSync(dir, { recursive: true, force: true });
  });
});
