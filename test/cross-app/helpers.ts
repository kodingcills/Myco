/** Shared helpers for the cross-app tests (hermetic and real-LibreOffice). Not a test file. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gradeCrossApp } from "../../src/benchmark/grade/cross-app.ts";
import type { ColumnType } from "../../src/benchmark/grade/grade.ts";
import {
  CROSS_APP_SCENARIOS,
  type CrossAppActuator,
  type CrossAppScenarioRun,
  crossAppTaskEntry,
  runCrossAppScenario,
} from "../../src/gate/cross-app-demo.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import {
  END_DIR,
  REPORT_FILE,
  SHEET_FILE,
  SOURCE_FILE,
  stepDir,
} from "../../src/tasks/cross-app.ts";
import type { XaTask } from "../../src/tasks/cross-app-taskset.ts";

const ROOT = join(import.meta.dirname, "..", "..");
export const BUNDLE = join(ROOT, "benchmark", "cross-app", "xa-v1");

/** Grade one trial's final evidence with the independent grader, from committed bundle bytes. */
export function gradeTrial(task: XaTask, evidenceDir: string) {
  const read = (path: string) => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
  };
  const n = task.spec.steps.length;
  const dirs = [...Array.from({ length: n }, (_, i) => stepDir(i + 1)), END_DIR];
  return gradeCrossApp({
    fixtureCsv: readFileSync(join(BUNDLE, task.fixtureFile)),
    fixtureSha256: task.fixtureSha256,
    reportTemplate: readFileSync(join(BUNDLE, task.reportTemplateFile)),
    reportTemplateSha256: task.reportTemplateSha256,
    source: read(join(evidenceDir, SOURCE_FILE)),
    sourceSha256: task.sourceSha256,
    steps: task.spec.steps,
    columnTypes: task.columnTypes as Record<string, ColumnType>,
    snapshots: dirs.map((dir) => ({
      sheet: read(join(evidenceDir, dir, SHEET_FILE)),
      report: read(join(evidenceDir, dir, REPORT_FILE)),
    })),
  });
}

/** Run every scenario for `task` with `actuator`, in-process gate per trial. */
export async function runAll(
  task: XaTask,
  actuator: CrossAppActuator,
  root: string,
): Promise<CrossAppScenarioRun[]> {
  const tasks = buildRegistry([crossAppTaskEntry(task.taskId, task.spec)]);
  const runs: CrossAppScenarioRun[] = [];
  for (const scenario of CROSS_APP_SCENARIOS) {
    runs.push(
      await runCrossAppScenario({
        scenario,
        spec: task.spec,
        taskId: task.taskId,
        root,
        actuator,
        openGate: async (runId) => {
          const gate = createGate({
            tasks,
            reader: fileEvidenceReader(join(root, "evidence")),
            assignment: { taskId: task.taskId, runId },
          });
          return { check: (request) => gate.check(request) };
        },
      }),
    );
  }
  return runs;
}
