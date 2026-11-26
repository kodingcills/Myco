/**
 * TIF-274 (M2-12) dry run, SIMULATED: the R1 plumbing over the whole fc-v1 task set with no
 * model and no VM. Never evidence: every row's `plannerModelId` is `simulated:scripted-credulous`,
 * the run directory carries a `SIMULATED` marker, and `checkBenchmark(..., { evidence: true })`
 * refuses the ledger (that planner is not a Claude model id, so the rows lack evidence
 * provenance).
 *
 * What is real: the gate (`runGatedTrial` on a sealed vault, the `calc-record-edit` family),
 * the registry (invalid-target tasks come back `unregistrable`), the arm-row mapping, the
 * independent grader and the check. What is scripted: the "agent", a credulous policy that
 * always claims done and leaves behind the document its task's fault class implies:
 *  - none: the honest edit;
 *  - kill-app, delayed-save: the untouched fixture (nothing persisted);
 *  - focus-change: the value written to the neighbouring column;
 *  - invalid-target: the untouched fixture (there is no valid target to edit).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGatedTrial } from "../gate/gated-trial.ts";
import { GATE_TOOL } from "../gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../integrity/launch.ts";
import { newVaultKey, VerdictVault } from "../integrity/vault.ts";
import { DATA_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import type { BenchmarkArmRow } from "./check.ts";
import { gatedArmRow, registerTask } from "./gated-rows.ts";
import type { BenchmarkTask } from "./taskset.ts";

export const DRY_RUN_PLANNER = "simulated:scripted-credulous";
export const SIMULATED_MARKER =
  "SIMULATED dry run (TIF-274). Scripted agent, no model, no VM. These rows are plumbing tests and are never evidence.\n";

function editCsv(csv: string, rowKey: string, column: string, value: string): string {
  const rows = csv
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const col = (rows[0] as string[]).indexOf(column);
  const row = rows.findIndex((r, i) => i > 0 && r[0] === rowKey);
  if (col < 1 || row < 1) return csv;
  (rows[row] as string[])[col] = value;
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

/** The document the scripted credulous agent leaves behind for a task. */
export function scriptedDocument(task: BenchmarkTask): string {
  const pristine = generateFixture(task.fixtureSeed).csv;
  const { rowKey, column, newValue } = task.intent;
  switch (task.faultClass) {
    case "none":
      return editCsv(pristine, rowKey, column, newValue);
    case "focus-change": {
      const names = DATA_COLUMNS.map((c) => c.name);
      const neighbour = names[(names.indexOf(column) + 1) % names.length] as string;
      return editCsv(pristine, rowKey, neighbour, newValue);
    }
    default:
      return pristine;
  }
}

function plan(base: string): AgentLaunchPlan {
  return {
    argv: [
      "-p",
      "simulated dry run",
      "--strict-mcp-config",
      "--mcp-config",
      join(base, "mcp.json"),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      `mcp__myco-gate__${GATE_TOOL}`,
    ],
    mcpServers: { "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} } },
  };
}

export interface DryRunResult {
  readonly dir: string;
  readonly armRows: readonly BenchmarkArmRow[];
}

/**
 * Run the dry run over `tasks`, writing `<dir>/SIMULATED`, `<dir>/arm.jsonl` and
 * `<dir>/docs/<trialKey>.csv`. `oracleSources` are the gate family's source files (hashed at
 * seal). The caller grades with `make-requests` + the grader and checks with the check.
 */
export async function runDryRun(
  tasks: readonly BenchmarkTask[],
  dir: string,
  oracleSources: readonly string[],
): Promise<DryRunResult> {
  if (/docs[\\/]research[\\/]experiments/.test(dir)) {
    throw new Error(
      "a simulated dry run is never written under docs/research/experiments (evidence packs live there)",
    );
  }
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "SIMULATED"), SIMULATED_MARKER);
  const work = mkdtempSync(join(tmpdir(), "myco-r1-dryrun-"));
  mkdirSync(join(work, "agent"));
  const vault = new VerdictVault({
    root: join(work, "vault"),
    key: newVaultKey(),
    agentRoots: [join(work, "agent")],
  });
  const armRows: BenchmarkArmRow[] = [];
  for (const task of tasks) {
    const trialKey = `dry-${task.taskId}`;
    const runId = `run-${task.taskId}`;
    const doc = scriptedDocument(task);
    const persisted = new TextEncoder().encode(doc);
    writeFileSync(join(dir, "docs", `${trialKey}.csv`), doc);
    const common = {
      taskId: task.taskId,
      trialKey,
      runId,
      agentClaim: "done" as const,
      instruction: task.instruction,
      persisted,
      persistedFormat: "csv" as const,
      plannerModelId: DRY_RUN_PLANNER,
      outputCeiling: null,
      cost: { modelUsd: null, wallClockS: null, vmS: null },
    };
    const reg = registerTask(task);
    if (!reg.ok) {
      armRows.push(
        gatedArmRow({ ...common, outcome: { status: "unregistrable", reason: reg.reason } }, tasks),
      );
      continue;
    }
    const outcome = await runGatedTrial({
      vault,
      runId,
      taskId: task.taskId,
      tasks: reg.registry,
      plan: plan(work),
      oracleSources,
      transport: {
        async runAgent() {},
        async captureAfterStop(): Promise<Record<string, Uint8Array>> {
          return { "persisted/doc.csv": persisted };
        },
      },
    });
    if (outcome.status === "refused")
      throw new Error(`${trialKey}: the launch audit refused the dry-run plan`);
    armRows.push(gatedArmRow({ ...common, outcome }, tasks));
  }
  writeFileSync(join(dir, "arm.jsonl"), `${armRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return { dir, armRows };
}
