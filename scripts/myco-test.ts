import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadTaskPackage,
  parseYamlSimple,
  runDirectionATask,
} from "../src/foundry/grader/direction-a-runner.ts";
import {
  loadDirectionBTaskPackage,
  runDirectionBTask,
} from "../src/foundry/grader/direction-b-runner.ts";
import {
  loadDirectionCTaskPackage,
  runDirectionCTask,
} from "../src/foundry/grader/direction-c-runner.ts";

async function main() {
  const yamlArg = process.argv[2] ?? "tasks/todo-save.yaml";
  const absYamlPath = resolve(process.cwd(), yamlArg);
  const rawContent = readFileSync(absYamlPath, "utf8");
  const parsed = parseYamlSimple(rawContent);

  const taskName = (parsed.name as string) || "";
  const taskRef = (parsed.task as string) || "";
  const appRef = (parsed.app as string) || "";

  process.stdout.write(`[myco] Loading task package: ${yamlArg}\n`);
  process.stdout.write(`[myco] Task: ${taskName} (${taskRef})\n`);
  process.stdout.write(`[myco] App: ${appRef} on ${parsed.desktop ?? "linux-x11"}\n`);
  process.stdout.write(`[myco] Prompt: "${parsed.prompt ?? ""}"\n\n`);

  process.stdout.write(
    "[myco] Executing task package under Myco simulated contract dry-run harness...\n",
  );
  process.stdout.write(
    "[myco] NOTE: Dry-run harness only. Live head-to-head evidence requires Runtime RT-020 desktop + Coordinator VM/host GO.\n\n",
  );

  if (
    taskName === "calc-invoice-update" ||
    taskRef.startsWith("df-b01") ||
    appRef.includes("calc")
  ) {
    const taskPkg = loadDirectionBTaskPackage(absYamlPath);
    const result = await runDirectionBTask(taskPkg);

    process.stdout.write("========================================================\n");
    process.stdout.write(`[myco] DIRECTION B RUN EXECUTION COMPLETE: ${result.runId}\n`);
    process.stdout.write(`[myco] Final Verdict: ${result.verdict.toUpperCase()}\n`);
    process.stdout.write(`[myco] Interrupted Mid-Write: ${result.interrupted ? "YES" : "NO"}\n`);
    process.stdout.write(`[myco] Silent Duplicates: ${result.duplicateCount} (Expected: 0)\n`);
    process.stdout.write(`[myco] Exit Code: ${result.exitCode}\n`);
    process.stdout.write("========================================================\n");
    process.stdout.write(`Agent Claim:      "${result.agentClaim}"\n`);
    process.stdout.write(`Record Attempted: ${JSON.stringify(result.recordAttempted)}\n`);
    process.stdout.write(`Persisted Count:  ${result.persistedCount} records\n\n`);

    process.stdout.write("[myco] Ground-Truth Checks:\n");
    for (const c of result.checks) {
      const mark = c.passed ? "✓ PASS" : "✗ FAIL (UNRESOLVED / REFUTED)";
      process.stdout.write(`  ${mark} - ${c.name}: ${c.reason}\n`);
    }

    process.stdout.write(`\n[myco] Evidence folder:  ${result.runDir}\n`);
    process.stdout.write(`[myco] Evidence archive: ${result.archivePath}\n`);
    process.exit(result.exitCode);
  } else if (
    taskName === "branch-retry-experiment" ||
    taskRef.startsWith("df-c01") ||
    taskName.includes("branch")
  ) {
    const taskPkg = loadDirectionCTaskPackage(absYamlPath);
    const result = await runDirectionCTask(taskPkg);

    process.stdout.write("========================================================\n");
    process.stdout.write(`[myco] DIRECTION C RUN EXECUTION COMPLETE: ${result.runId}\n`);
    process.stdout.write(`[myco] Final Verdict: ${result.verdict.toUpperCase()}\n`);
    process.stdout.write(
      `[myco] Arm A (Intent-Log Replay): ${result.armA.wallClockSec}s wall-clock, ${result.armA.memoryOverheadMb}MB delta\n`,
    );
    process.stdout.write(
      `[myco] Arm B (Snapshot Fork):     ${result.armB.wallClockSec}s wall-clock, ${result.armB.memoryOverheadMb}MB delta\n`,
    );
    process.stdout.write(
      `[myco] Fork Speedup:              ${result.killCriterionEvaluation.speedupSec}s (${result.killCriterionEvaluation.speedupRatio}x)\n`,
    );
    process.stdout.write(
      `[myco] Kill Criterion Eval:       ${result.killCriterionEvaluation.recommendation}\n`,
    );
    process.stdout.write(`[myco] Exit Code: ${result.exitCode}\n`);
    process.stdout.write("========================================================\n\n");

    process.stdout.write("[myco] Ground-Truth Checks:\n");
    for (const c of result.checks) {
      const mark = c.passed ? "✓ PASS" : "✗ FAIL";
      process.stdout.write(`  ${mark} - ${c.name}: ${c.reason}\n`);
    }

    process.stdout.write(`\n[myco] Evidence folder:  ${result.runDir}\n`);
    process.stdout.write(`[myco] Evidence archive: ${result.archivePath}\n`);
    process.exit(result.exitCode);
  } else {
    // Default to Direction A
    const taskPkg = loadTaskPackage(absYamlPath);
    const result = await runDirectionATask(taskPkg);

    process.stdout.write("========================================================\n");
    process.stdout.write(`[myco] DIRECTION A RUN EXECUTION COMPLETE: ${result.runId}\n`);
    process.stdout.write(`[myco] Final Verdict: ${result.verdict.toUpperCase()}\n`);
    process.stdout.write(`[myco] False Success Caught: ${result.falseSuccess ? "YES" : "NO"}\n`);
    process.stdout.write(`[myco] Exit Code: ${result.exitCode}\n`);
    process.stdout.write("========================================================\n");
    process.stdout.write(`UI Status Claim:   "${result.appStatusClaim}"\n`);
    process.stdout.write(`Agent Self-Report: "${result.agentClaim}"\n`);
    process.stdout.write(
      `Items Attempted:   [${result.itemsAttempted.map((s) => `"${s}"`).join(", ")}]\n`,
    );
    process.stdout.write(
      `Items Persisted:   [${result.itemsPersisted.map((s) => `"${s}"`).join(", ")}]\n`,
    );
    process.stdout.write(
      `Items Missing:     [${result.itemsMissing.map((s) => `"${s}"`).join(", ")}]\n\n`,
    );

    process.stdout.write("[myco] Ground-Truth Checks:\n");
    for (const c of result.checks) {
      const mark = c.passed ? "✓ PASS" : "✗ FAIL (REFUTED)";
      process.stdout.write(`  ${mark} - ${c.name}: ${c.reason}\n`);
    }

    process.stdout.write(`\n[myco] Evidence folder:  ${result.runDir}\n`);
    process.stdout.write(`[myco] Evidence archive: ${result.archivePath}\n`);
    process.stdout.write(
      `[myco] Captured screens: ${result.screenshots.filter((s) => s.endsWith(".png")).length} frames (1440x900)\n`,
    );

    process.exit(result.exitCode);
  }
}

main().catch((err) => {
  process.stderr.write(`[myco] FATAL: Task execution error: ${String(err)}\n`);
  process.exit(2);
});
