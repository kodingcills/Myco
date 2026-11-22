import { resolve } from "node:path";
import { loadTaskPackage, runDirectionATask } from "../src/tasks/direction-a-runner.ts";

async function main() {
  const yamlArg = process.argv[2] ?? "tasks/todo-save.yaml";
  const absYamlPath = resolve(process.cwd(), yamlArg);

  process.stdout.write(`[myco] Loading task package: ${yamlArg}\n`);
  const taskPkg = loadTaskPackage(absYamlPath);
  process.stdout.write(`[myco] Task: ${taskPkg.name} v${taskPkg.version} (${taskPkg.task})\n`);
  process.stdout.write(`[myco] App: ${taskPkg.app} on ${taskPkg.desktop}\n`);
  process.stdout.write(`[myco] Prompt: "${taskPkg.prompt}"\n\n`);

  process.stdout.write("[myco] Executing task package under Myco verification harness...\n\n");
  const result = await runDirectionATask(taskPkg);

  process.stdout.write("========================================================\n");
  process.stdout.write(`[myco] RUN EXECUTION COMPLETE: ${result.runId}\n`);
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

main().catch((err) => {
  process.stderr.write(`[myco] FATAL: Task execution error: ${String(err)}\n`);
  process.exit(2);
});
