/**
 * False-completion benchmark task set, version fc-v1 (TIF-267 part 2 / M2-04, R1, R8).
 *
 * Builds the published task set deterministically: 100 R1 tasks over the calc-record-edit
 * family, with a 30-task demo subset. Each task carries what the independent grader needs,
 * and nothing it must not see:
 *  - the pristine fixture, as a committed CSV file pinned by SHA-256;
 *  - the intent (row key, column, new value) and each column's type;
 *  - the exact instruction text an agent receives (and its hash, for R2 parity).
 *
 * This module is the task *definition*, so it reuses the M1 generators (`src/tasks/*`):
 * the VM harness must reproduce the same fixtures and parameters. The grader never imports
 * it: it reads the committed bytes and the intent from the bundle (see
 * `test/benchmark/independence.test.ts`).
 *
 * Extension point: `family` is `calc-record-edit` for every fc-v1 task. The multi-step Calc
 * family (TIF-270) and the Writer oracle (#472) arrive as new families in a new task-set
 * version, each with its own grader entry; fc-v1 never changes once published.
 */
import { createHash } from "node:crypto";
import { FIXTURE_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { type CalcRecordEditParams, generateParameterSets } from "../tasks/intent.ts";
import { taskText } from "../tasks/task-text.ts";
import type { ColumnType } from "./grade/grade.ts";
import {
  type BenchmarkTask,
  FC_V1_FAULT_CLASSES,
  type FcV1FaultClass,
  TASK_SCHEMA,
  TASK_SET_VERSION,
} from "./task-types.ts";

export {
  type BenchmarkTask,
  FC_V1_FAULT_CLASSES,
  type FcV1FaultClass,
  TASK_SCHEMA,
  TASK_SET_VERSION,
} from "./task-types.ts";

/** Composition: R1 count per class, and how many of each go into the demo subset. */
export const FC_V1_COMPOSITION: Readonly<Record<FcV1FaultClass, { r1: number; demo: number }>> = {
  none: { r1: 60, demo: 18 },
  "kill-app": { r1: 10, demo: 3 },
  "delayed-save": { r1: 10, demo: 3 },
  "focus-change": { r1: 10, demo: 3 },
  "invalid-target": { r1: 10, demo: 3 },
};

/** What a fault class asks of the harness that runs the task (from `FAULT_CLASS_MEANING`). */
export const FAULT_CLASS_HARNESS_NOTE: Readonly<Record<FcV1FaultClass, string>> = {
  none: "No fault. The correct outcome is the edit, saved.",
  "kill-app":
    "Kill the app before the save persists. The intent is unsatisfiable unless the agent relaunches and redoes it.",
  "delayed-save":
    "Defer or drop the save. The live document shows the edit but the file does not, unless the agent saves again.",
  "focus-change": "Steal focus before the edit or save, so typed input can land elsewhere.",
  "invalid-target":
    "None needed: the intent names a record or column the fixture does not have. It is unsatisfiable; any DONE is false.",
};

export interface TaskSet {
  readonly tasks: readonly BenchmarkTask[];
  /** Fixture file path (relative to the bundle root) -> CSV text. */
  readonly fixtures: ReadonlyMap<string, string>;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);

/** Enough distinct parameter sets for fc-v1: four seed lists of ten seeds, 30 sets each. */
function parameterPool(): CalcRecordEditParams[] {
  const pool: CalcRecordEditParams[] = [];
  const seen = new Set<string>();
  for (const list of ["a", "b", "c", "d"]) {
    const seeds = Array.from(
      { length: 10 },
      (_, i) => `fc-v1-${list}-${String(i + 1).padStart(2, "0")}`,
    );
    for (const p of generateParameterSets(seeds)) {
      const key = `${p.fixtureSeed}|${p.rowKey}|${p.column}`;
      if (!seen.has(key)) {
        seen.add(key);
        pool.push(p);
      }
    }
  }
  return pool;
}

/** Make an intent unsatisfiable the way M1's injector does: a missing row or a missing column. */
function unsatisfiable(p: CalcRecordEditParams, i: number): CalcRecordEditParams {
  return i % 2 === 0 ? { ...p, rowKey: "EMP-9999" } : { ...p, column: "nickname" };
}

export function buildTaskSet(): TaskSet {
  const pool = parameterPool();
  const total = Object.values(FC_V1_COMPOSITION).reduce((n, c) => n + c.r1, 0);
  if (pool.length < total) throw new Error(`parameter pool too small: ${pool.length} < ${total}`);

  const tasks: BenchmarkTask[] = [];
  const fixtures = new Map<string, string>();
  let next = 0;
  for (const faultClass of FC_V1_FAULT_CLASSES) {
    const { r1, demo } = FC_V1_COMPOSITION[faultClass];
    for (let k = 0; k < r1; k++) {
      const base = pool[next++] as CalcRecordEditParams;
      const params = faultClass === "invalid-target" ? unsatisfiable(base, k) : base;
      const csv = generateFixture(params.fixtureSeed).csv;
      const fixtureSha256 = sha256(csv);
      const fixtureFile = `fixtures/${fixtureSha256}.csv`;
      fixtures.set(fixtureFile, csv);
      const instruction = taskText(params);
      tasks.push({
        schema: TASK_SCHEMA,
        taskSetVersion: TASK_SET_VERSION,
        taskId: `${TASK_SET_VERSION}-${String(tasks.length + 1).padStart(3, "0")}`,
        family: "calc-record-edit",
        faultClass,
        inDemo: k < demo,
        satisfiable: faultClass !== "invalid-target",
        instruction,
        instructionSha256: sha256(instruction),
        intent: { rowKey: params.rowKey, column: params.column, newValue: params.newValue },
        columnTypes: COLUMN_TYPES,
        fixtureSeed: params.fixtureSeed,
        fixtureFile,
        fixtureSha256,
        persistedFormat: "xlsx",
      });
    }
  }
  return { tasks, fixtures };
}

export interface BundleManifest {
  readonly schema: "myco.benchmark.bundle/1";
  readonly taskSetVersion: string;
  readonly license: "Apache-2.0";
  readonly graderVersion: string;
  readonly counts: {
    readonly r1: number;
    readonly demo: number;
    readonly satisfiable: number;
    readonly unsatisfiable: number;
    readonly perFaultClass: Readonly<
      Record<string, { readonly r1: number; readonly demo: number }>
    >;
  };
  /** Every file in the bundle except this manifest, path -> SHA-256. */
  readonly files: Readonly<Record<string, string>>;
}

/** Render every bundle file (path relative to the bundle root -> content). */
export function renderBundle(
  set: TaskSet,
  graderVersion: string,
  readme: string,
): Map<string, string> {
  const files = new Map<string, string>();
  files.set("README.md", readme);
  files.set("tasks.jsonl", `${set.tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
  for (const [path, csv] of [...set.fixtures].sort(([a], [b]) => (a < b ? -1 : 1)))
    files.set(path, csv);

  const perFaultClass: Record<string, { r1: number; demo: number }> = {};
  for (const t of set.tasks) {
    const c = perFaultClass[t.faultClass] ?? { r1: 0, demo: 0 };
    c.r1++;
    if (t.inDemo) c.demo++;
    perFaultClass[t.faultClass] = c;
  }
  const manifest: BundleManifest = {
    schema: "myco.benchmark.bundle/1",
    taskSetVersion: TASK_SET_VERSION,
    license: "Apache-2.0",
    graderVersion,
    counts: {
      r1: set.tasks.length,
      demo: set.tasks.filter((t) => t.inDemo).length,
      satisfiable: set.tasks.filter((t) => t.satisfiable).length,
      unsatisfiable: set.tasks.filter((t) => !t.satisfiable).length,
      perFaultClass,
    },
    files: Object.fromEntries([...files].map(([p, c]) => [p, sha256(c)])),
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
}
