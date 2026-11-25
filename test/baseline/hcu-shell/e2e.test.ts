/**
 * TIF-268: a fake end-to-end run of the hcu+shell arm over the SAME 30 pinned tasks the M1
 * comparison used (`src/baseline/sweep-v3.json`), producing ledger rows a grader can score.
 *
 * No VM, no model: the GUI and shell are the fake Calc guest, and the planner is scripted.
 * Three scripted behaviours rotate across the rows, so the ledger holds verified rows, a
 * false done, and a self-check that avoided one. What this proves is the plumbing - task
 * parity, fixture hash, ledger format, regrading - not any rate.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  gradeHcuShellRow,
  type HcuShellRow,
  isHcuShellRow,
  runHcuShellTrial,
} from "../../../src/baseline/hcu-shell/trial.ts";
import { isBaselineRow } from "../../../src/baseline/index.ts";
import manifest from "../../../src/baseline/sweep-v3.json" with { type: "json" };
import { fixtureFingerprint, generateFixture } from "../../../src/tasks/fixture.ts";
import { groundTruth } from "../../../src/tasks/intent.ts";
import { fakeCalc } from "./fake-calc.ts";
import { credulous, honest, selfChecking } from "./planners.ts";

const behaviours = [honest, credulous, selfChecking] as const;

async function runLedger(): Promise<string> {
  const lines: string[] = [];
  for (const task of manifest.rows) {
    // Grader side: the harness computes the target from the params, never the arm.
    const truth = groundTruth(task.params);
    const fake = fakeCalc({
      cellRef: truth.cellRef,
      previousValue: truth.previousValue,
      expected: truth.expectedValue,
    });
    const prepared = {
      ...fake.prepared,
      fixtureSha256: fixtureFingerprint(generateFixture(task.params.fixtureSeed)).csvSha256,
    };
    const behaviour = behaviours[task.index % behaviours.length] ?? honest;
    const row = await runHcuShellTrial(
      {
        index: task.index,
        params: task.params,
        cellRef: truth.cellRef,
        expected: truth.expectedValue,
        previousValue: truth.previousValue,
      },
      prepared,
      behaviour(truth.cellRef, task.params.newValue),
    );
    lines.push(JSON.stringify(row));
  }
  const dir = mkdtempSync(join(tmpdir(), "hcu-shell-e2e-"));
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

describe("fake end-to-end hcu+shell run", () => {
  it("produces one gradeable ledger row per pinned task", async () => {
    const path = await runLedger();
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as HcuShellRow);

    expect(rows).toHaveLength(30);
    // Same task set, same order, as the M1 comparison.
    expect(rows.map((r) => [r.index, r.params])).toEqual(
      manifest.rows.map((t) => [t.index, t.params]),
    );
    for (const row of rows) {
      expect(isHcuShellRow(row)).toBe(true);
      expect(isBaselineRow(row)).toBe(true);
      // Re-graded from the recorded evidence alone, the verdict is the same.
      expect(gradeHcuShellRow(row)).toEqual({ verdict: row.verdict, reason: row.verdictReason });
      // The arm's row never carries Myco's verdict for the same task (TIF-207).
      expect(JSON.stringify(row)).not.toContain("mycoVerdict");
    }

    const tally = (pick: (r: HcuShellRow) => unknown) =>
      rows.reduce<Record<string, number>>((acc, r) => {
        const key = String(pick(r));
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
    expect(tally((r) => r.verdict)).toEqual({ verified: 10, refuted: 20 });
    expect(tally((r) => r.falseDone)).toEqual({ false: 20, true: 10 });
    expect(tally((r) => r.shell.storeChecked)).toEqual({ true: 20, false: 10 });
  });
});
