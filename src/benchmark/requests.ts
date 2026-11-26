/**
 * Turn an arm's rows plus its saved documents into grade requests (TIF-267 part 2).
 *
 * This is how any arm, ours or a third party's, gets graded: the requests carry the task's
 * fixture and intent from the published bundle and the arm's saved document, and nothing
 * the arm claimed. The arm row is used only to find the task and the document; its
 * `fixtureSha256` must match the task's, so a row cannot point the grader at a different
 * fixture.
 */
import type { BenchmarkTask } from "./taskset.ts";

export interface ArmRowRef {
  readonly trialKey: string;
  readonly taskId: string;
  readonly fixtureSha256: string;
}

export interface GradeRequest {
  readonly trialKey: string;
  readonly taskId: string;
  readonly fixtureSha256: string;
  readonly fixtureFile: string;
  readonly persistedFile: string | null;
  readonly persistedFormat: "xlsx" | "csv";
  readonly intent: BenchmarkTask["intent"];
  readonly columnTypes: BenchmarkTask["columnTypes"];
}

export class RequestBuildError extends Error {
  override name = "RequestBuildError";
}

/**
 * One request per arm row. `documentFor(trialKey)` returns the saved document's file name
 * (relative to the request directory, e.g. `docs/t1.xlsx`) and its format, or null if the
 * arm captured none (the grade is then `ungradable`).
 */
export function buildRequests(
  tasks: readonly BenchmarkTask[],
  rows: readonly ArmRowRef[],
  documentFor: (trialKey: string) => { file: string; format: "xlsx" | "csv" } | null,
): GradeRequest[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  return rows.map((row) => {
    const task = byId.get(row.taskId);
    if (task === undefined)
      throw new RequestBuildError(`${row.trialKey}: unknown taskId ${row.taskId}`);
    if (row.fixtureSha256 !== task.fixtureSha256) {
      throw new RequestBuildError(
        `${row.trialKey}: arm row fixture does not match task ${task.taskId}`,
      );
    }
    const doc = documentFor(row.trialKey);
    return {
      trialKey: row.trialKey,
      taskId: task.taskId,
      fixtureSha256: task.fixtureSha256,
      fixtureFile: task.fixtureFile,
      persistedFile: doc === null ? null : doc.file,
      persistedFormat: doc === null ? task.persistedFormat : doc.format,
      intent: task.intent,
      columnTypes: task.columnTypes,
    };
  });
}
