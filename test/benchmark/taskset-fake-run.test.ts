/**
 * TIF-267 part 2: a fake run over the full fc-v1 task set, end to end through the CLIs a
 * third party would use (make-requests -> grade -> check). No VM, no paid API.
 *
 * Per task, a credulous fake agent works the fake app under the task's fault class and
 * always claims "done":
 *  - none: the guarded program edits and saves (the honest outcome);
 *  - kill-app: the app is killed before the program starts, nothing persists;
 *  - delayed-save: the save is dropped, nothing persists;
 *  - focus-change: input lands in the neighbouring column, which is saved;
 *  - invalid-target: the program refuses (precondition), nothing changes.
 *
 * Two arms are scored on the same documents:
 *  - myco-gate: "done" is accepted only when the gate (the M1 verifier, used here as the
 *    gate) returns verified;
 *  - hcu+shell: every "done" is accepted (the credulous self-check).
 * The check must give consistent counts, R1 must pass for the gated arm, and the
 * credulous arm must show exactly the 40 false DONEs the fault classes produce.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BenchmarkArmRow, CheckResult } from "../../src/benchmark/check.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { readCsvSpreadsheet } from "../../src/core/filepersist.ts";
import { runProgram } from "../../src/core/runner.ts";
import { FakeSpreadsheetApp } from "../../src/fake/app.ts";
import { calcRecordEditVerifier, intentFor, programFor } from "../../src/tasks/calc-record-edit.ts";
import { DATA_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";
import type { CalcRecordEditParams } from "../../src/tasks/intent.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const tasks = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);

function neighbourColumn(column: string): string {
  const names = DATA_COLUMNS.map((c) => c.name);
  return names[(names.indexOf(column) + 1) % names.length] as string;
}

async function fakeTrial(task: BenchmarkTask, docPath: string): Promise<void> {
  const fixture = generateFixture(task.fixtureSeed);
  writeFileSync(docPath, fixture.csv);
  const app = new FakeSpreadsheetApp({ filePath: docPath, rows: fixture.dataRows + 1, cols: 5 });
  const params: CalcRecordEditParams = { fixtureSeed: task.fixtureSeed, ...task.intent };
  switch (task.faultClass) {
    case "none":
      await runProgram(app, programFor(app, params));
      return;
    case "kill-app":
      app.crash();
      await runProgram(app, programFor(app, params)).catch(() => undefined);
      return;
    case "delayed-save":
      app.dropSave();
      await runProgram(app, programFor(app, params)).catch(() => undefined);
      return;
    case "focus-change": {
      const wrong = { ...params, column: neighbourColumn(params.column) };
      await runProgram(app, programFor(app, wrong)).catch(() => undefined);
      return;
    }
    case "invalid-target":
      await runProgram(app, programFor(app, params)).catch(() => undefined);
      return;
  }
}

function tsx(
  script: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("fake run over the full fc-v1 task set", () => {
  it("gives consistent counts through make-requests, grade and check", {
    timeout: 120_000,
  }, async () => {
    const work = mkdtempSync(join(tmpdir(), "myco-fc-v1-"));
    const docs = join(work, "docs");
    mkdirSync(docs);
    const armRows: BenchmarkArmRow[] = [];
    for (const task of tasks) {
      for (const arm of ["myco-gate", "hcu+shell"] as const) {
        const trialKey = `${arm === "myco-gate" ? "g" : "h"}-${task.taskId}`;
        const docPath = join(docs, `${trialKey}.csv`);
        await fakeTrial(task, docPath);
        const persisted = readFileSync(docPath);
        let gate: BenchmarkArmRow["gate"] = null;
        if (arm === "myco-gate") {
          const params: CalcRecordEditParams = { fixtureSeed: task.fixtureSeed, ...task.intent };
          const verdict = calcRecordEditVerifier.verify(
            readCsvSpreadsheet(docPath),
            intentFor(params),
          ).status;
          gate = { called: true, verdict };
        }
        armRows.push({
          schema: "myco.benchmark.arm-row/1",
          taskSetVersion: task.taskSetVersion,
          arm,
          trialKey,
          taskId: task.taskId,
          faultClass: task.faultClass,
          fixtureSha256: task.fixtureSha256,
          instructionSha256: task.instructionSha256,
          plannerModelId: "fake-credulous",
          outputCeiling: null,
          claim: "done",
          gate,
          accepted: arm === "hcu+shell" || gate?.verdict === "verified",
          persistedSha256: sha(persisted),
          cause: null,
          cost: { modelUsd: null, wallClockS: null, vmS: null },
        });
      }
    }
    const armPath = join(work, "arm.jsonl");
    writeFileSync(armPath, `${armRows.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const reqDir = join(work, "req");
    const made = tsx("benchmark-make-requests.ts", [
      "--bundle",
      BUNDLE,
      "--arm",
      armPath,
      "--docs",
      docs,
      "--out",
      reqDir,
    ]);
    expect(made.status, made.stderr).toBe(0);
    const graded = tsx("benchmark-grade.ts", [join(reqDir, "requests.jsonl")]);
    expect(graded.status, graded.stderr).toBe(0);
    const gradesPath = join(work, "grades.jsonl");
    writeFileSync(gradesPath, graded.stdout);
    expect(graded.stdout.trimEnd().split("\n")).toHaveLength(200);

    const checked = tsx("benchmark-check.ts", [
      "--arm",
      armPath,
      "--grades",
      gradesPath,
      "--expect",
      "myco-gate=100",
      "--expect",
      "hcu+shell=100",
      "--require-r1",
    ]);
    expect(checked.status, checked.stderr).toBe(0);
    const result = JSON.parse(checked.stdout) as CheckResult;
    expect(result.ok).toBe(true);
    expect(result.taskSetVersion).toBe("fc-v1");

    const gated = result.arms.find((a) => a.arm === "myco-gate");
    const credulous = result.arms.find((a) => a.arm === "hcu+shell");
    expect(gated).toMatchObject({
      trials: 100,
      claimedDone: 100,
      accepted: 60,
      acceptedPass: 60,
      falseDoneAccepted: 0,
      graderPass: 60,
      ungradable: 0,
    });
    expect(result.r1?.pass).toBe(true);
    expect(result.r1?.falseAcceptRate.denominator).toBe(60);
    expect(credulous).toMatchObject({
      trials: 100,
      accepted: 100,
      acceptedPass: 60,
      falseDoneAccepted: 40,
      ungradable: 0,
    });
    for (const cls of ["kill-app", "delayed-save", "focus-change", "invalid-target"]) {
      expect(credulous?.perFaultClass[cls], cls).toEqual({
        trials: 10,
        accepted: 10,
        falseDoneAccepted: 10,
        acceptedUngradable: 0,
      });
      expect(gated?.perFaultClass[cls], cls).toEqual({
        trials: 10,
        accepted: 0,
        falseDoneAccepted: 0,
        acceptedUngradable: 0,
      });
    }
  });
});

describe("bundle builder --check", () => {
  it("passes on an exact copy and fails on an extra or tampered file", { timeout: 60_000 }, () => {
    const copy = mkdtempSync(join(tmpdir(), "myco-fc-v1-copy-"));
    cpSync(BUNDLE, copy, { recursive: true });
    expect(tsx("benchmark-build-taskset.ts", ["--out", copy, "--check"]).status).toBe(0);
    writeFileSync(join(copy, "notes.txt"), "x");
    const extra = tsx("benchmark-build-taskset.ts", ["--out", copy, "--check"]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toMatch(/extra notes\.txt/);
    rmSync(join(copy, "notes.txt"));
    const fixture = (tasks[0] as BenchmarkTask).fixtureFile;
    writeFileSync(join(copy, fixture), `${readFileSync(join(copy, fixture), "utf8")}tampered\n`);
    const tampered = tsx("benchmark-build-taskset.ts", ["--out", copy, "--check"]);
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toMatch(new RegExp(`differs ${fixture}`));
  });
});
