/**
 * TIF-268: a fake end-to-end run of the hcu+shell arm over the SAME 30 pinned tasks the M1
 * comparison used (`src/baseline/sweep-v3.json`), graded by TIF-267's independent grader and
 * joined by its check (`docs/benchmark/false-completion.md` §4).
 *
 * No VM, no model: the GUI and shell are the fake Calc guest, the planner is scripted, and
 * the saved document is a Calc-shaped `.xlsx` built from the fixture plus what was actually
 * saved. Three scripted behaviours rotate across the rows (honest, credulous, self-checking),
 * so the ledger holds accepted correct DONEs, accepted false DONEs, and refusals. What this
 * proves is the plumbing - task parity, captured bytes, the shared ledger, the real grader
 * CLI and check - not any rate.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkArmRowSchema } from "../../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../../schemas/validate.ts";
import {
  benchmarkArmRow,
  type ColumnType,
  gradeRequest,
} from "../../../src/baseline/hcu-shell/ledger.ts";
import {
  gradeHcuShellRow,
  type HcuShellRow,
  isHcuShellRow,
  type PreparedHcuShell,
  runHcuShellTrial,
} from "../../../src/baseline/hcu-shell/trial.ts";
import { isBaselineRow } from "../../../src/baseline/index.ts";
import manifest from "../../../src/baseline/sweep-v3.json" with { type: "json" };
import { checkBenchmark } from "../../../src/benchmark/check.ts";
import {
  FIXTURE_COLUMNS,
  fixtureFingerprint,
  generateFixture,
} from "../../../src/tasks/fixture.ts";
import { groundTruth } from "../../../src/tasks/intent.ts";
import { fakeCalc } from "./fake-calc.ts";
import { credulous, honest, selfChecking } from "./planners.ts";

const behaviours = [honest, credulous, selfChecking] as const;
const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type as ColumnType]),
);
const TASK_SET = "m1-sweep-v3";
const PLANNER = "stub";

interface Trial {
  readonly row: HcuShellRow;
  readonly trialKey: string;
  readonly taskId: string;
}

/** Runs the arm over the manifest, writing what a live harness would write to `dir`. */
async function runArm(dir: string, captureFailsAt?: number): Promise<Trial[]> {
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  mkdirSync(join(dir, "persisted"), { recursive: true });
  const trials: Trial[] = [];
  const requests: string[] = [];
  const armRows: string[] = [];
  for (const task of manifest.rows) {
    // Grader side: the harness computes the target from the params, never the arm.
    const truth = groundTruth(task.params);
    const fixture = generateFixture(task.params.fixtureSeed);
    const fixtureFile = `fixtures/${task.params.fixtureSeed}.csv`;
    writeFileSync(join(dir, fixtureFile), fixture.csv);
    const fake = fakeCalc({
      cellRef: truth.cellRef,
      previousValue: truth.previousValue,
      expected: truth.expectedValue,
      fixtureCsv: fixture.csv,
      captureFails: task.index === captureFailsAt,
    });
    // The harness keeps the captured bytes (to hand to the grader); the row keeps their hash.
    let captured: Uint8Array | null = null;
    const prepared: PreparedHcuShell = {
      ...fake.prepared,
      fixtureSha256: fixtureFingerprint(fixture).csvSha256,
      async capturePersisted() {
        const document = await fake.prepared.capturePersisted();
        captured = document?.bytes ?? null;
        return document;
      },
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
    const trialKey = `hcu-shell-${task.index}`;
    const taskId = `calc-${task.index}`;
    let persistedFile: string | null = null;
    if (captured !== null) {
      persistedFile = `persisted/${trialKey}.xlsx`;
      writeFileSync(join(dir, persistedFile), captured);
    }
    requests.push(
      JSON.stringify(
        gradeRequest(row, {
          trialKey,
          taskId,
          fixtureFile,
          persistedFile,
          columnTypes: COLUMN_TYPES,
        }),
      ),
    );
    armRows.push(
      JSON.stringify(
        benchmarkArmRow(row, {
          taskSetVersion: TASK_SET,
          trialKey,
          taskId,
          faultClass: "none",
          plannerModelId: PLANNER,
        }),
      ),
    );
    trials.push({ row, trialKey, taskId });
  }
  writeFileSync(join(dir, "requests.jsonl"), `${requests.join("\n")}\n`);
  writeFileSync(join(dir, "arm.jsonl"), `${armRows.join("\n")}\n`);
  return trials;
}

const jsonl = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** TIF-267's own grader CLI, run as the benchmark doc says, over the requests we wrote. */
function gradeCli(dir: string) {
  const out = execFileSync(
    "npx",
    ["tsx", "scripts/benchmark-grade.ts", join(dir, "requests.jsonl")],
    {
      encoding: "utf8",
    },
  );
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("fake end-to-end hcu+shell run, graded by TIF-267", () => {
  it("writes one arm row and one grade request per pinned task, and the check joins them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-shell-e2e-"));
    const trials = await runArm(dir);

    // Internal rows: same task set and order as the M1 comparison, and re-gradeable.
    expect(trials.map((t) => [t.row.index, t.row.params])).toEqual(
      manifest.rows.map((t) => [t.index, t.params]),
    );
    for (const { row } of trials) {
      expect(isHcuShellRow(row)).toBe(true);
      expect(isBaselineRow(row)).toBe(true);
      expect(gradeHcuShellRow(row)).toEqual({ verdict: row.verdict, reason: row.verdictReason });
      expect(row.persistedSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // Shared ledger: every arm row passes the published schema and names no verdict.
    const armRows = jsonl(join(dir, "arm.jsonl"));
    for (const armRow of armRows) {
      expect(validateSchema(armRow, benchmarkArmRowSchema)).toEqual([]);
      expect(JSON.stringify(armRow)).not.toMatch(/verified|refuted|mycoVerdict/);
    }
    // The grader's input has no field for a claim or any verdict.
    for (const request of jsonl(join(dir, "requests.jsonl")))
      expect(Object.keys(request).sort()).toEqual([
        "columnTypes",
        "fixtureFile",
        "fixtureSha256",
        "intent",
        "persistedFile",
        "persistedFormat",
        "taskId",
        "trialKey",
      ]);

    const grades = gradeCli(dir);
    const result = checkBenchmark(armRows, grades, { expectTrials: { "hcu+shell": 30 } });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.r1).toBeNull(); // R1 is the gated arm's row; this arm feeds R2
    expect(result.arms[0]).toMatchObject({
      arm: "hcu+shell",
      trials: 30,
      claimedDone: 20,
      accepted: 20,
      acceptedPass: 10,
      falseDoneAccepted: 10,
      acceptedUngradable: 0,
      graderPass: 10,
      graderFail: 20,
      ungradable: 0,
    });

    // Two independent readings of the same trials agree: the arm's own judge (a C1-style
    // persisted read) and TIF-267's grader (the saved bytes). Neither saw the other.
    const byKey = new Map(grades.map((g) => [g.trialKey, g.status]));
    for (const { row, trialKey } of trials)
      expect(byKey.get(trialKey), trialKey).toBe(row.verdict === "verified" ? "pass" : "fail");
  });

  it("an uncaptured document is ungradable, and its accepted DONE is counted as such", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-shell-e2e-"));
    // Index 0 runs the honest planner, so its DONE is accepted; its capture fails.
    const trials = await runArm(dir, 0);
    const first = trials[0]?.row;
    expect(first?.persistedSha256).toBeNull();
    expect(first?.deviations).toContain("persisted-capture-failed");
    const armRows = jsonl(join(dir, "arm.jsonl"));
    expect(armRows[0]).toMatchObject({
      accepted: true,
      persistedSha256: null,
      cause: { kind: "harness", detail: "persisted document not captured" },
    });
    const grades = gradeCli(dir);
    expect(grades[0]).toMatchObject({ status: "ungradable" });
    const result = checkBenchmark(armRows, grades, { expectTrials: { "hcu+shell": 30 } });
    expect(result.errors).toEqual([]);
    expect(result.arms[0]).toMatchObject({ acceptedPass: 9, acceptedUngradable: 1, ungradable: 1 });
  });
});
