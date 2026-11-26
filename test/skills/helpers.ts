/**
 * Track M test helpers: real gated trials ($0, no model, no VM) on published fc-v1 tasks.
 *
 * `gatedRun` seals a trial in a real `VerdictVault`, runs the real sealed gate through
 * `runGatedTrial` with a scripted transport that "saves" the document the scripted agent
 * produced, and grades the captured bytes with the independent grader
 * (`src/benchmark/grade/grade.ts`). Nothing here is a mock of the gate or the grader.
 */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { GATE_STATE_FILE, gateEntryFor } from "../../src/benchmark/gated-rows.ts";
import { grade } from "../../src/benchmark/grade/grade.ts";
import { type BenchmarkTask, buildTaskSet } from "../../src/benchmark/taskset.ts";
import { buildRegistry } from "../../src/gate/gate.ts";
import { runGatedTrial } from "../../src/gate/gated-trial.ts";
import { GATE_TOOL } from "../../src/gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import type { VerdictVault } from "../../src/integrity/vault.ts";
import {
  type AdmissionCandidate,
  type AdmissionResult,
  admit as admitReal,
} from "../../src/skills/admission.ts";
import { taskFeatures } from "../../src/skills/arm.ts";
import type { ForbiddenValues } from "../../src/skills/record.ts";
import { forbiddenValuesFor } from "../../src/skills/record.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const TASKS: readonly BenchmarkTask[] = buildTaskSet().tasks;
export const taskById = (id: string): BenchmarkTask => {
  const t = TASKS.find((x) => x.taskId === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
export const NONE_TASK = TASKS.find(
  (t) => t.faultClass === "none" && t.satisfiable,
) as BenchmarkTask;

export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A generic, clean procedure: no values, no paths, no oracle words. */
export const GOOD_STEPS = [
  "Open the spreadsheet named in the instruction in Calc",
  "Find the row whose key column holds the record key from the instruction",
  "Select the cell in the column the instruction names and type the new value",
  "Press Enter, then save with Keep Current Format so the file stays CSV",
  "Call the completion gate with your taskId and runId",
] as const;
export const GOOD_PRECONDITIONS = ["The document is open in Calc and focused"] as const;

/** The task's document with `value` written into the target cell (or another column). */
export function docWith(task: BenchmarkTask, value: string, columnOffset = 0): string {
  const rows = generateFixture(task.fixtureSeed)
    .csv.trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const header = rows[0] as string[];
  const col = header.indexOf(task.intent.column);
  // A non-zero offset always lands on a different data column (wrapping at the last one).
  const target =
    columnOffset === 0
      ? col
      : 1 + ((col - 1 + columnOffset + (header.length - 1)) % (header.length - 1));
  const row = rows.findIndex((r, i) => i > 0 && r[0] === task.intent.rowKey);
  (rows[row] as string[])[target] = value;
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

export const pristine = (task: BenchmarkTask) => generateFixture(task.fixtureSeed).csv;

export function plan(base: string): AgentLaunchPlan {
  return {
    mcpConfigPath: join(base, "mcp.json"),
    argv: [
      "-p",
      "edit the cell, save, then call the gate",
      "--strict-mcp-config",
      "--tools",
      "",
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

/** One real gated trial on `doc` (null = the agent saved nothing), graded independently. */
export async function gatedRun(
  vault: VerdictVault,
  base: string,
  task: BenchmarkTask,
  runId: string,
  doc: string | null,
  corrections?: { families: string[] },
) {
  const outcome = await runGatedTrial({
    vault,
    runId,
    taskId: task.taskId,
    tasks: buildRegistry([gateEntryFor(task)]),
    plan: plan(base),
    oracleSources: [join(ROOT, "src/gate/families.ts")],
    transport: {
      async runAgent() {},
      async captureAfterStop(): Promise<Record<string, Uint8Array>> {
        return doc === null ? {} : { [`persisted/${GATE_STATE_FILE}`]: Buffer.from(doc) };
      },
    },
    ...(corrections ? { corrections } : {}),
  });
  if (outcome.status !== "decided") throw new Error("launch refused");
  const fixture = generateFixture(task.fixtureSeed);
  const g = grade({
    fixtureCsv: Buffer.from(fixture.csv),
    fixtureSha256: task.fixtureSha256,
    persisted: doc === null ? null : { format: "csv", bytes: Buffer.from(doc) },
    intent: task.intent,
    columnTypes: task.columnTypes,
  });
  return { outcome, grade: g };
}

export const forbiddenFor = (task: BenchmarkTask) =>
  forbiddenValuesFor({ intent: task.intent, fixtureRows: generateFixture(task.fixtureSeed).rows });

export const LEDGER_REF = { ledger: "attempts.jsonl", entrySha256: "a".repeat(64) };

/** A candidate built from a real gated run. */
export function candidateFrom(
  task: BenchmarkTask,
  runId: string,
  run: Awaited<ReturnType<typeof gatedRun>>,
  extra: Partial<AdmissionCandidate> = {},
): AdmissionCandidate {
  return {
    runId,
    taskId: task.taskId,
    taskFamily: task.family,
    fixtureSha256: task.fixtureSha256,
    features: taskFeatures(task),
    preconditions: [...GOOD_PRECONDITIONS],
    steps: [...GOOD_STEPS],
    ledgerRef: LEDGER_REF,
    gate: run.outcome.status === "decided" ? run.outcome.result : null,
    grade: run.grade,
    assisted: false,
    corrections: run.outcome.status === "decided" ? run.outcome.corrections : "off",
    plannerModelId: "simulated:scripted",
    ...extra,
  };
}

/**
 * Admission explicitly scoped as simulated: these $0 tests use a scripted planner
 * (`simulated:scripted`), which a real admission refuses (`SIMULATED_PLANNER`).
 */
export const admitSimulated = (c: AdmissionCandidate, f: ForbiddenValues): AdmissionResult =>
  admitReal(c, f, { simulated: true });
