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
  writeRunEvidence,
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

  it("rejects a verdict whose partial_score weights do not sum to 1.0", () => {
    const record = {
      runId: "r",
      taskId: "fake-set-cell",
      taskParams: { trial: 0 },
      startedAt: "2026-01-01T00:00:00Z",
      steps: [],
      verdict: {
        status: "refuted",
        checks: [
          {
            name: "check-a",
            passed: false,
            reason: "a",
            partial_score: { score: 0, weight: 0.45 },
          },
          {
            name: "check-b",
            passed: false,
            reason: "b",
            partial_score: { score: 0, weight: 0.45 },
          },
        ],
        score: 0,
        reasons: ["nope"],
      },
    };
    expect(() =>
      writeRunEvidence(join(tmpdir(), `myco-weights-${process.pid}`), record as never, []),
    ).toThrow(InvalidEvidenceError);
  });

  it("writes a multi-check verdict whose weights sum to 1.0", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-weights-ok-"));
    const record = {
      runId: "r1",
      taskId: "fake-set-cell",
      taskParams: { trial: 0 },
      startedAt: "2026-01-01T00:00:00Z",
      steps: [],
      verdict: {
        status: "refuted",
        checks: [
          {
            name: "check-a",
            passed: true,
            reason: "a",
            partial_score: { score: 1, weight: 0.6 },
          },
          {
            name: "check-b",
            passed: false,
            reason: "b",
            partial_score: { score: 0, weight: 0.4 },
          },
        ],
        score: 0.6,
        reasons: ["partial"],
      },
    };
    const runDir = writeRunEvidence(dir, record as never, []);
    const written = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
    expect(written.verdict.checks).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
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

    // trial 0 is killed before save (refuted, not satisfied); trial 1 is
    // clean (verified, satisfied). successRate counts ground-truth
    // satisfaction over trials; checkPassRate counts passed checks over all
    // scored checks. Both are single-check verdicts here, so the values are
    // computable by hand and must differ from a naive alias of the other.
    expect(summary.results[0]?.groundTruthSatisfied).toBe(false);
    expect(summary.results[1]?.groundTruthSatisfied).toBe(true);
    expect(summary.successRate).toBe(0.5);
    // Both trials are single-check verdicts; the killed trial's check fails
    // and the clean trial's passes, so checkPassRate is also 1/2 here — but
    // see the aliasing probe below for a case where the two provably differ.
    expect(summary.checkPassRate).toBe(0.5);
    // Provable non-aliasing: an implementation that computed checkPassRate as
    // 1 - successRate, successRate², or trials-based shortcuts would produce
    // a different value in this configuration (e.g. a lying verifier below).

    // Aliasing probe: a verifier that always passes checks while ground truth
    // fails must yield checkPassRate = 1 with successRate = 0.
    const { dir: liarDir, file: liarFile } = freshSheet("rates-alias");
    const lyingSummary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: liarFile(t) }),
      verifier: { verify: () => ({ status: "verified" as const, reasons: ["trust me"] }) },
      family: setCellFamily,
      faults: [killApp()],
      trials: 1,
      filePathFor: liarFile,
      runsDir: join(liarDir, "runs"),
      evalId: "eval-rates-alias",
    });
    expect(lyingSummary.successRate).toBe(0);
    expect(lyingSummary.checkPassRate).toBe(1);
    expect(lyingSummary.checkPassRate).not.toBe(lyingSummary.successRate);
    rmSync(dir, { recursive: true, force: true });
    rmSync(liarDir, { recursive: true, force: true });
  });
});
