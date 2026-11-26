import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadDirectionBTaskPackage,
  runDirectionBTask,
} from "../../src/foundry/grader/direction-b-runner.ts";
import {
  loadDirectionCTaskPackage,
  runDirectionCTask,
} from "../../src/foundry/grader/direction-c-runner.ts";

/**
 * Both loaders fall back to a hard-coded default for every field, and those defaults equal
 * the committed task files. Asserting the committed file's values therefore passed even with
 * the YAML parser returning `{}` (test audit, mutation M1). These tests load a temp package
 * whose every asserted value differs from the default, so only a real read can pass.
 */
const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
function tempYaml(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-direction-bc-"));
  tmpDirs.push(dir);
  const path = join(dir, "task.yaml");
  writeFileSync(path, text);
  return path;
}

describe("Direction B Runner (Calc Interrupted Operation)", () => {
  it("reads every field from the yaml, not from the built-in defaults", () => {
    const pkg = loadDirectionBTaskPackage(
      tempYaml(
        [
          "name: audit-b",
          "version: 7",
          "app: audit/app-b",
          "task: audit-b-task",
          "intent:",
          "  kind: audit.kind-b",
          "  record:",
          '    id: "INV-AUDIT-1"',
          '    client: "Audit Client"',
          '    amount: "$1.00"',
          '    status: "OPEN"',
          "interruption:",
          "  simulateKillMidWrite: false",
          "  checkpointStep: 5",
          "",
        ].join("\n"),
      ),
    );
    expect(pkg.name).toBe("audit-b");
    expect(pkg.version).toBe(7);
    expect(pkg.app).toBe("audit/app-b");
    expect(pkg.task).toBe("audit-b-task");
    expect(pkg.intent.kind).toBe("audit.kind-b");
    expect(pkg.intent.record).toEqual({
      id: "INV-AUDIT-1",
      client: "Audit Client",
      amount: "$1.00",
      status: "OPEN",
    });
    expect(pkg.interruption).toEqual({ simulateKillMidWrite: false, checkpointStep: 5 });
  });

  it("loads the committed calc-invoice-update package", () => {
    const pkg = loadDirectionBTaskPackage("tasks/calc-invoice-update.yaml");
    expect(pkg.name).toBe("calc-invoice-update");
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
    // Every manifest entry must be the sha256 of the file it names. `toBeDefined()` here let
    // a manifest that hashed the wrong body pass (test audit, mutation M3b).
    expect(Object.keys(manifest.files)).toEqual(
      expect.arrayContaining(["trace.jsonl", "result.json", "ledger.jsonl"]),
    );
    for (const [path, digest] of Object.entries(manifest.files)) {
      const actual = createHash("sha256")
        .update(readFileSync(join(result.runDir, path)))
        .digest("hex");
      expect(digest, path).toBe(actual);
    }

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
  it("reads every field from the yaml, not from the built-in defaults", () => {
    const pkg = loadDirectionCTaskPackage(
      tempYaml(
        [
          "name: audit-c",
          "version: 4",
          "task: audit-c-task",
          "intent:",
          "  kind: audit.kind-c",
          "comparison:",
          "  linearRetryRestoreSec: 33.5",
          "  forkSnapshotOverheadSec: 4.25",
          "  forkMemoryOverheadMb: 1024",
          "evidence:",
          '  outputDir: "runs/audit-c"',
          "",
        ].join("\n"),
      ),
    );
    expect(pkg.name).toBe("audit-c");
    expect(pkg.version).toBe(4);
    expect(pkg.task).toBe("audit-c-task");
    expect(pkg.intent.kind).toBe("audit.kind-c");
    expect(pkg.comparison).toEqual({
      linearRetryRestoreSec: 33.5,
      forkSnapshotOverheadSec: 4.25,
      forkMemoryOverheadMb: 1024,
    });
    expect(pkg.evidence?.outputDir).toBe("runs/audit-c");
  });

  it("loads the committed branch-retry-experiment package", () => {
    const pkg = loadDirectionCTaskPackage("tasks/branch-retry-experiment.yaml");
    expect(pkg.name).toBe("branch-retry-experiment");
    expect(pkg.comparison.linearRetryRestoreSec).toBe(21.0);
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
    expect(typeof resultJson.taskParams.comparison.armA.wallClockSec).toBe("number");
    for (const [path, digest] of Object.entries(manifest.files)) {
      const actual = createHash("sha256")
        .update(readFileSync(join(result.runDir, path)))
        .digest("hex");
      expect(digest, path).toBe(actual);
    }

    expect(existsSync(result.archivePath)).toBe(true);
  });
});
