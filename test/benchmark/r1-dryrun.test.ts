/**
 * TIF-274 SIMULATED dry run over the whole fc-v1 task set: the real gate, registry, arm-row
 * mapping, make-requests, grader and check, with a scripted credulous agent. Asserts exact
 * counts, and that the check refuses the ledger as evidence. No model, no VM.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckResult } from "../../src/benchmark/check.ts";
import {
  DRY_RUN_PLANNER,
  runDryRun,
  SIMULATED_MARKER,
  scriptedDocument,
} from "../../src/benchmark/r1-dryrun.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { parseCsvSpreadsheet } from "../../src/core/filepersist.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { groundTruth } from "../../src/tasks/intent.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const TASKS = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);
const SOURCES = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) => join(ROOT, p));

const tsx = (script: string, args: string[]) => {
  const r = spawnSync("npx", ["tsx", join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("TIF-274 simulated dry run over fc-v1", () => {
  it("runs all 100 tasks through the real gate, grader and check, and is refused as evidence", {
    timeout: 180_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-r1-dry-"));
    const { armRows } = await runDryRun(TASKS, dir, SOURCES);
    expect(armRows).toHaveLength(100);
    expect(readFileSync(join(dir, "SIMULATED"), "utf8")).toBe(SIMULATED_MARKER);
    expect(armRows.every((r) => r.plannerModelId === DRY_RUN_PLANNER)).toBe(true);

    const made = tsx("benchmark-make-requests.ts", [
      "--bundle",
      BUNDLE,
      "--arm",
      join(dir, "arm.jsonl"),
      "--docs",
      join(dir, "docs"),
      "--out",
      join(dir, "work"),
    ]);
    expect(made.status, made.stderr).toBe(0);
    const graded = tsx("benchmark-grade.ts", [join(dir, "work", "requests.jsonl")]);
    expect(graded.status, graded.stderr).toBe(0);
    writeFileSync(join(dir, "grades.jsonl"), graded.stdout);

    const checked = tsx("benchmark-check.ts", [
      "--arm",
      join(dir, "arm.jsonl"),
      "--grades",
      join(dir, "grades.jsonl"),
      "--expect",
      "myco-gate=100",
      "--expect-unregistrable",
      "myco-gate=10",
      "--require-r1",
    ]);
    expect(checked.status, checked.stderr).toBe(0);
    const result = JSON.parse(checked.stdout) as CheckResult;
    expect(result.ok).toBe(true);
    // Labelled as not evidence even though the check and R1 pass (#496 round 3).
    expect(result.provenance).toBe("simulated");
    // 60 clean tasks: honest edit, gate verified, accepted. 30 faulted: the gate refutes the
    // untouched or misplaced document. 10 invalid-target: unregistrable, graded fail.
    expect(result.arms[0]).toMatchObject({
      arm: "myco-gate",
      trials: 100,
      claimedDone: 100,
      accepted: 60,
      acceptedPass: 60,
      falseDoneAccepted: 0,
      graderPass: 60,
      graderFail: 40,
      ungradable: 0,
      unregistrable: { trials: 10, claimedDone: 10, graderFailClaimedDone: 10 },
    });
    for (const cls of ["kill-app", "delayed-save", "focus-change", "invalid-target"]) {
      expect(result.arms[0]?.perFaultClass[cls], cls).toEqual({
        trials: 10,
        accepted: 0,
        falseDoneAccepted: 0,
        acceptedUngradable: 0,
      });
    }
    const refutedByGate = armRows.filter((r) => r.gate?.verdict === "refuted").length;
    expect(refutedByGate).toBe(30);
    expect(result.r1).toMatchObject({
      pass: true,
      headline: { numerator: 0, denominator: 100 },
      gated: { trials: 90, accepted: 60, falseDoneAccepted: 0 },
      unregistrable: { trials: 10, claimedDone: 10, graderFailClaimedDone: 10 },
    });
    expect(result.r1?.notes).toHaveLength(1);

    const asEvidence = tsx("benchmark-check.ts", [
      "--arm",
      join(dir, "arm.jsonl"),
      "--grades",
      join(dir, "grades.jsonl"),
      "--expect",
      "myco-gate=100",
      "--expect-unregistrable",
      "myco-gate=10",
      "--evidence",
    ]);
    expect(asEvidence.status).toBe(1);
    expect((JSON.parse(asEvidence.stdout) as CheckResult).errors).toContain(
      '100 row(s) without evidence provenance (planner "simulated:scripted-credulous" is not a Claude model id): dry-run rows are never evidence',
    );
  });

  it("the scripted documents follow each fault class (focus-change edits the neighbouring column)", () => {
    for (const task of TASKS) {
      const doc = scriptedDocument(task);
      const pristine = generateFixture(task.fixtureSeed).csv;
      const cells = parseCsvSpreadsheet(doc, "d").cells;
      if (task.faultClass === "none" || task.faultClass === "focus-change")
        expect(doc, task.taskId).not.toBe(pristine);
      else expect(doc, task.taskId).toBe(pristine);
      if (task.faultClass === "focus-change") {
        const target = groundTruth({ fixtureSeed: task.fixtureSeed, ...task.intent }).cellRef;
        expect(cells[target], task.taskId).not.toBe(task.intent.newValue);
        expect(Object.values(cells), task.taskId).toContain(task.intent.newValue);
      }
    }
  });

  it("refuses to write under docs/research/experiments", async () => {
    await expect(
      runDryRun(TASKS.slice(0, 1), join(ROOT, "docs", "research", "experiments", "dry"), SOURCES),
    ).rejects.toThrow(/never written under docs\/research\/experiments/);
    expect(existsSync(join(ROOT, "docs", "research", "experiments", "dry"))).toBe(false);
  });
});
