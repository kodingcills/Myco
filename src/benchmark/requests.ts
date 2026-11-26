/**
 * Turn an arm's rows plus its saved documents into grade requests (TIF-267 part 2).
 *
 * This is how any arm, ours or a third party's, gets graded: the requests carry the task's
 * fixture and intent from the published bundle and the arm's saved document, and nothing
 * the arm claimed. The arm row is used only to find the task and the document. Its
 * `taskSetVersion`, `faultClass`, `fixtureSha256` and `instructionSha256` must all match
 * the task's, so a row cannot point the grader at a different fixture, nor publish a result
 * under another task-set version or relabel a trial's fault class.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { BenchmarkTask } from "./taskset.ts";

export interface ArmRowRef {
  readonly trialKey: string;
  readonly taskId: string;
  readonly taskSetVersion: string;
  readonly faultClass: string;
  readonly fixtureSha256: string;
  readonly instructionSha256: string;
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

/** The row fields that must equal the task's, in the order they are checked. */
const PINNED_FIELDS = [
  "taskSetVersion",
  "faultClass",
  "fixtureSha256",
  "instructionSha256",
] as const;

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
    for (const field of PINNED_FIELDS) {
      if (row[field] !== task[field]) {
        throw new RequestBuildError(
          `${row.trialKey}: arm row ${field} ${JSON.stringify(row[field])} does not match task ${task.taskId} (${JSON.stringify(task[field])})`,
        );
      }
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

/**
 * Resolve `name` under `root` and refuse it unless it stays strictly inside `root`. Every
 * path make-requests reads or writes goes through this, after the rows are validated, so a
 * file name built from untrusted input cannot leave its directory.
 */
export function pathInside(root: string, name: string): string {
  const full = resolve(root, name);
  const rel = relative(resolve(root), full);
  if (rel === "" || isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") {
    throw new RequestBuildError(`path ${JSON.stringify(name)} escapes ${root}`);
  }
  return full;
}
