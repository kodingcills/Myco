/**
 * The published task row's shape and the fc-v1 constants, with no dependency on the task
 * generators (`src/tasks/*`). Split out of `taskset.ts` (#547 O1 follow-up) so the published-task
 * loader, the task-set binding and the corrections A/B analysis can name a task without
 * importing the code that builds one. `taskset.ts` re-exports everything here.
 */
import type { ColumnType } from "./grade/grade.ts";

export const TASK_SET_VERSION = "fc-v1";
export const TASK_SCHEMA = "myco.benchmark.task/1";

/** Fault classes in fc-v1: the four M1 classes (`src/faults/types.ts`) plus `none`. */
export const FC_V1_FAULT_CLASSES = [
  "none",
  "kill-app",
  "delayed-save",
  "focus-change",
  "invalid-target",
] as const;
export type FcV1FaultClass = (typeof FC_V1_FAULT_CLASSES)[number];

export interface BenchmarkTask {
  readonly schema: typeof TASK_SCHEMA;
  readonly taskSetVersion: string;
  readonly taskId: string;
  readonly family: "calc-record-edit";
  readonly faultClass: FcV1FaultClass;
  readonly inDemo: boolean;
  /** Whether the intent can be satisfied in the fixture (diagnostic; the grader decides independently). */
  readonly satisfiable: boolean;
  readonly instruction: string;
  readonly instructionSha256: string;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly columnTypes: Readonly<Record<string, ColumnType>>;
  /** Fixture seed for the VM harness (`generateFixture(seed)` reproduces `fixtureFile`'s bytes). */
  readonly fixtureSeed: string;
  readonly fixtureFile: string;
  readonly fixtureSha256: string;
  readonly persistedFormat: "xlsx";
}
