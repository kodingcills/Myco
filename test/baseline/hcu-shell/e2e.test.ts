/**
 * TIF-268 x TIF-267: a fake end-to-end run of the hcu+shell arm over the published fc-v1 demo
 * subset (`benchmark/false-completion/fc-v1/`, the 30 tasks with `inDemo`, R2's paired count),
 * graded by TIF-267's independent grader and joined by its check
 * (`docs/benchmark/false-completion.md` §4, §8).
 *
 * Rows carry the task's real `taskSetVersion` (`fc-v1`), `taskId` and `faultClass`, built by
 * `armRowForTask` / `gradeRequestForTask`, which refuse a trial that did not run the task.
 * The requests are made twice, by the arm itself and by the published `make-requests` CLI
 * (which pins fixture and instruction hashes to the task), and must be identical.
 *
 * No VM, no model: the GUI and shell are the fake Calc guest, the planner is scripted, and
 * the saved document is a Calc-shaped `.xlsx` built from the fixture plus what was actually
 * saved. Three scripted behaviours rotate across the tasks (honest, credulous, self-checking).
 * The fault class is recorded, not injected (the fake guest has no faults; M2-12 applies
 * them live). What this proves is the plumbing - fc-v1 ids, task parity, captured bytes, the
 * shared ledger, the real CLIs - not any rate.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkArmRowSchema, benchmarkTaskSchema } from "../../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../../schemas/validate.ts";
import {
  armRowForTask,
  gradeRequestForTask,
  type PublishedTask,
} from "../../../src/baseline/hcu-shell/ledger.ts";
import {
  gradeHcuShellRow,
  type HcuShellRow,
  isHcuShellRow,
  type PreparedHcuShell,
  runHcuShellTrial,
} from "../../../src/baseline/hcu-shell/trial.ts";
import { isBaselineRow } from "../../../src/baseline/index.ts";
import { checkBenchmark } from "../../../src/benchmark/check.ts";
import { fixtureFingerprint, generateFixture } from "../../../src/tasks/fixture.ts";
import { groundTruth } from "../../../src/tasks/intent.ts";
import { fakeCalc } from "./fake-calc.ts";
import { credulous, honest, selfChecking } from "./planners.ts";

const BUNDLE = resolve("benchmark/false-completion/fc-v1");
type Task = PublishedTask & {
  readonly fixtureSeed: string;
  readonly inDemo: boolean;
  readonly satisfiable: boolean;
};
const DEMO: Task[] = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as Task)
  .filter((t) => t.inDemo);

const behaviours = [honest, credulous, selfChecking] as const;
const PLANNER = "stub";

interface Trial {
  readonly row: HcuShellRow;
  readonly trialKey: string;
  readonly task: Task;
}

/**
 * The cell the fake guest treats as the target. For a satisfiable task it is the real target
 * (the harness computes it from the params, never the arm). An unsatisfiable task has no
 * target, so the fake guest uses B2: an honest planner then edits the wrong cell, which the
 * grader fails, as any DONE on such a task must be.
 */
function fakeTarget(task: Task, fixtureCsv: string) {
  const params = { fixtureSeed: task.fixtureSeed, ...task.intent };
  if (task.satisfiable) {
    const t = groundTruth(params);
    return { cellRef: t.cellRef, previousValue: t.previousValue, expected: t.expectedValue };
  }
  const b2 = fixtureCsv.split("\n")[1]?.split(",")[1] ?? "";
  return { cellRef: "B2", previousValue: b2, expected: task.intent.newValue };
}

/** Runs the arm over the demo subset, writing what a live harness would write to `dir`. */
async function runArm(dir: string, captureFailsAt?: number): Promise<Trial[]> {
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  const trials: Trial[] = [];
  const requests: string[] = [];
  const armRows: string[] = [];
  for (const [index, task] of DEMO.entries()) {
    const params = { fixtureSeed: task.fixtureSeed, ...task.intent };
    const fixture = generateFixture(task.fixtureSeed);
    writeFileSync(join(dir, task.fixtureFile), fixture.csv);
    const target = fakeTarget(task, fixture.csv);
    const fake = fakeCalc({
      ...target,
      fixtureCsv: fixture.csv,
      captureFails: index === captureFailsAt,
    });
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
    const behaviour = behaviours[index % behaviours.length] ?? honest;
    const row = await runHcuShellTrial(
      { index, params, ...target },
      prepared,
      behaviour(target.cellRef, task.intent.newValue),
    );
    const trialKey = `hcu-shell-${task.taskId}`;
    let persistedFile: string | null = null;
    if (captured !== null) {
      persistedFile = `docs/${trialKey}.xlsx`;
      writeFileSync(join(dir, persistedFile), captured);
    }
    requests.push(JSON.stringify(gradeRequestForTask(row, task, { trialKey, persistedFile })));
    armRows.push(JSON.stringify(armRowForTask(row, task, { trialKey, plannerModelId: PLANNER })));
    trials.push({ row, trialKey, task });
  }
  writeFileSync(join(dir, "requests.jsonl"), `${requests.join("\n")}\n`);
  writeFileSync(join(dir, "arm.jsonl"), `${armRows.join("\n")}\n`);
  return trials;
}

/** The published make-requests CLI over the same arm rows and saved documents. */
function makeRequestsCli(dir: string): { status: number | null; stderr: string; requests: string } {
  const out = join(dir, "via-cli");
  const r = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/benchmark-make-requests.ts",
      "--bundle",
      BUNDLE,
      "--arm",
      join(dir, "arm.jsonl"),
      "--docs",
      join(dir, "docs"),
      "--out",
      out,
    ],
    { encoding: "utf8" },
  );
  return {
    status: r.status,
    stderr: r.stderr,
    requests: r.status === 0 ? readFileSync(join(out, "requests.jsonl"), "utf8") : "",
  };
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

    // The demo subset: 30 tasks, stratified, every task valid against the published schema.
    expect(DEMO).toHaveLength(30);
    for (const t of DEMO) expect(validateSchema(t, benchmarkTaskSchema)).toEqual([]);
    expect(trials.map((t) => t.row.params.rowKey)).toEqual(DEMO.map((t) => t.intent.rowKey));
    for (const { row } of trials) {
      expect(isHcuShellRow(row)).toBe(true);
      expect(isBaselineRow(row)).toBe(true);
      expect(gradeHcuShellRow(row)).toEqual({ verdict: row.verdict, reason: row.verdictReason });
      expect(row.persistedSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // Shared ledger: every arm row passes the published schema and names no verdict.
    const armRows = jsonl(join(dir, "arm.jsonl"));
    for (const [i, armRow] of armRows.entries()) {
      expect(validateSchema(armRow, benchmarkArmRowSchema)).toEqual([]);
      expect(JSON.stringify(armRow)).not.toMatch(/verified|refuted|mycoVerdict/);
      // Real fc-v1 identifiers, no placeholders.
      expect(armRow).toMatchObject({
        taskSetVersion: "fc-v1",
        taskId: DEMO[i]?.taskId,
        faultClass: DEMO[i]?.faultClass,
        fixtureSha256: DEMO[i]?.fixtureSha256,
        instructionSha256: DEMO[i]?.instructionSha256,
      });
    }
    // The published make-requests CLI accepts every row (it pins fixture and instruction
    // hashes to the task) and writes exactly the requests the arm wrote itself.
    const viaCli = makeRequestsCli(dir);
    expect(viaCli.status, viaCli.stderr).toBe(0);
    expect(viaCli.requests).toBe(readFileSync(join(dir, "requests.jsonl"), "utf8"));
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
    // 30 demo tasks rotate honest / credulous / self-checking (10 each). Honest and credulous
    // claim done (20). Honest is correct on its 9 satisfiable tasks; its 10th (index 27,
    // fc-v1-091) is invalid-target, so its DONE is false. Credulous claims done without
    // editing: 10 false DONEs. Total 9 correct accepted, 11 false accepted.
    expect(result.arms[0]).toMatchObject({
      arm: "hcu+shell",
      trials: 30,
      claimedDone: 20,
      accepted: 20,
      acceptedPass: 9,
      falseDoneAccepted: 11,
      acceptedUngradable: 0,
      graderPass: 9,
      graderFail: 21,
      ungradable: 0,
    });
    expect(result.arms[0]?.perFaultClass["invalid-target"]).toEqual({
      trials: 3,
      accepted: 2,
      falseDoneAccepted: 2,
      acceptedUngradable: 0,
    });

    // Two independent readings of the same trials agree: the arm's own judge (a C1-style
    // persisted read) and TIF-267's grader (the saved bytes). Neither saw the other.
    // (Unsatisfiable tasks are excluded from the agreement: the fake guest's stand-in target
    // is not a real one, and the grader fails every document for them.)
    const byKey = new Map(grades.map((g) => [g.trialKey, g.status]));
    for (const { row, trialKey, task } of trials) {
      if (task.satisfiable)
        expect(byKey.get(trialKey), trialKey).toBe(row.verdict === "verified" ? "pass" : "fail");
      else expect(byKey.get(trialKey), trialKey).toBe("fail");
    }
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
    expect(result.arms[0]).toMatchObject({ acceptedPass: 8, acceptedUngradable: 1, ungradable: 1 });
  });
});
