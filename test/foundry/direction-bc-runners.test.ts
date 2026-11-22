import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadDirectionBTaskPackage,
  runDirectionBTask,
} from "../../src/foundry/grader/direction-b-runner.ts";
import {
  loadDirectionCTaskPackage,
  runDirectionCTask,
} from "../../src/foundry/grader/direction-c-runner.ts";

describe("Direction B Runner (Calc Interrupted Operation)", () => {
  it("loads task package correctly from yaml", () => {
    const pkg = loadDirectionBTaskPackage("tasks/calc-invoice-update.yaml");
    expect(pkg.name).toBe("calc-invoice-update");
    expect(pkg.app).toBe("libreoffice/calc");
    expect(pkg.task).toBe("df-b01-interrupted-record-update");
    expect(pkg.intent.record.id).toBe("INV-2026-088");
    expect(pkg.interruption?.simulateKillMidWrite).toBe(true);
  });

  it("executes interrupted write dry-run and catches unresolved commit as UNCERTAIN with 0 duplicates", async () => {
    const pkg = loadDirectionBTaskPackage("tasks/calc-invoice-update.yaml");
    const result = await runDirectionBTask(pkg, "runs/test-dir-b-interrupted");

    expect(result.verdict).toBe("uncertain");
    expect(result.exitCode).toBe(2);
    expect(result.interrupted).toBe(true);
    expect(result.duplicateCount).toBe(0);
    expect(result.falseSuccess).toBe(true);

    const manifestPath = join(result.runDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.simulated).toBe(true);
    expect(manifest.dryRun).toBe(true);
    expect(manifest.files["result.json"]).toBeDefined();

    const resultPath = join(result.runDir, "result.json");
    expect(existsSync(resultPath)).toBe(true);
    const resultJson = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(resultJson.simulated).toBe(true);
    expect(resultJson.dryRun).toBe(true);
    expect(resultJson.verdict.status).toBe("uncertain");

    expect(existsSync(result.archivePath)).toBe(true);
  });

  it("executes clean write when interruption is disabled", async () => {
    const pkg = {
      ...loadDirectionBTaskPackage("tasks/calc-invoice-update.yaml"),
      interruption: { simulateKillMidWrite: false },
    };
    const result = await runDirectionBTask(pkg, "runs/test-dir-b-clean");

    expect(result.verdict).toBe("verified");
    expect(result.exitCode).toBe(0);
    expect(result.interrupted).toBe(false);
    expect(result.duplicateCount).toBe(0);
    expect(result.persistedCount).toBe(88);
  });
});

describe("Direction C Runner (Branching vs Intent-Log Replay)", () => {
  it("loads task package correctly from yaml", () => {
    const pkg = loadDirectionCTaskPackage("tasks/branch-retry-experiment.yaml");
    expect(pkg.name).toBe("branch-retry-experiment");
    expect(pkg.task).toBe("df-c01-ambiguous-branch-search");
    expect(pkg.comparison.linearRetryRestoreSec).toBe(21.0);
    expect(pkg.comparison.forkSnapshotOverheadSec).toBe(2.0);
  });

  it("executes paired comparison dry-run and calculates fork speedup vs memory overhead", async () => {
    const pkg = loadDirectionCTaskPackage("tasks/branch-retry-experiment.yaml");
    const result = await runDirectionCTask(pkg, "runs/test-dir-c-comparison");

    expect(result.verdict).toBe("verified");
    expect(result.exitCode).toBe(0);
    expect(result.armA.strategy).toBe("intent-log-replay");
    expect(result.armB.strategy).toBe("memory-snapshot-fork");

    // Wall-clock comparison: fork should be faster than 21s cold restore replay
    expect(result.armB.wallClockSec).toBeLessThan(result.armA.wallClockSec);
    expect(result.killCriterionEvaluation.speedupSec).toBeGreaterThan(15);
    expect(result.killCriterionEvaluation.speedupRatio).toBeGreaterThan(2.0);
    expect(result.armB.memoryOverheadMb).toBe(2048);

    const manifestPath = join(result.runDir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.simulated).toBe(true);
    expect(manifest.dryRun).toBe(true);

    const resultPath = join(result.runDir, "result.json");
    expect(existsSync(resultPath)).toBe(true);
    const resultJson = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(resultJson.simulated).toBe(true);
    expect(resultJson.dryRun).toBe(true);
    expect(resultJson.taskParams.comparison.armA.wallClockSec).toBeDefined();

    expect(existsSync(result.archivePath)).toBe(true);
  });
});
