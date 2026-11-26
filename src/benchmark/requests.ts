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
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  // Saved documents are named `<trialKey>.<ext>`. On a case-insensitive filesystem (macOS
  // by default) two keys that differ only in case would share one file, so refuse them here,
  // in planning, before anything is written.
  const seenKeys = new Map<string, string>();
  for (const row of rows) {
    const folded = row.trialKey.toLowerCase();
    const prior = seenKeys.get(folded);
    if (prior !== undefined) {
      throw new RequestBuildError(
        prior === row.trialKey
          ? `duplicate trialKey ${row.trialKey}`
          : `trialKey ${row.trialKey} collides with ${prior} on a case-insensitive filesystem`,
      );
    }
    seenKeys.set(folded, row.trialKey);
  }
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
 * Resolve `name` under `root` and refuse it unless it stays strictly inside `root`. This is
 * the lexical check only (it does not look at the disk): `regularFileInside` and
 * `destinationInside` call it first and then check the disk, so symlinks cannot escape.
 */
export function pathInside(root: string, name: string): string {
  const full = resolve(root, name);
  const rel = relative(resolve(root), full);
  if (rel === "" || isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") {
    throw new RequestBuildError(`path ${JSON.stringify(name)} escapes ${root}`);
  }
  return full;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (e) {
    throw new RequestBuildError(`cannot resolve ${root}: ${(e as Error).message}`);
  }
}

function assertRealInside(
  rootReal: string,
  real: string,
  name: string,
  root: string,
  orEqual: boolean,
) {
  const rel = relative(rootReal, real);
  if ((rel === "" && !orEqual) || isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") {
    throw new RequestBuildError(`path ${JSON.stringify(name)} resolves outside ${root}`);
  }
}

/**
 * Plan a read of `name` under `root`. On top of `pathInside`, every component below `root`
 * is `lstat`ed: each directory component must be a real directory and the entry itself a
 * regular file with a single link, so a symlink (or a FIFO, socket or device) anywhere below
 * `root`, or a hard-linked file, is refused, and `realpath(entry)` must lie inside
 * `realpath(root)` (implied by the walk; kept against a swap between the two checks). `root` itself is the operator's
 * argument and may be reached through symlinks. Returns null when nothing is at the path
 * (any component missing) and `optional` is set; otherwise a missing entry is refused.
 */
export function regularFileInside(
  root: string,
  name: string,
  opts: { optional?: boolean } = {},
): string | null {
  const full = pathInside(root, name);
  const rootReal = realRoot(root);
  const parts = relative(resolve(root), full).split(/[\\/]/);
  let cur = resolve(root);
  for (const [i, part] of parts.entries()) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (st === null) {
      if (opts.optional === true) return null;
      throw new RequestBuildError(`path ${JSON.stringify(name)} not found under ${root}`);
    }
    if (st.isSymbolicLink())
      throw new RequestBuildError(
        `path ${JSON.stringify(name)} under ${root}: ${part} is a symlink`,
      );
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) {
      throw new RequestBuildError(
        `path ${JSON.stringify(name)} under ${root}: ${part} is not a ${last ? "regular file" : "directory"}`,
      );
    }
    // a hard link is a regular file whose inode may also live outside `root`
    if (last && st.nlink > 1)
      throw new RequestBuildError(
        `path ${JSON.stringify(name)} under ${root}: ${part} has ${st.nlink} hard links`,
      );
  }
  assertRealInside(rootReal, realpathSync(full), name, root, false);
  return full;
}

/**
 * Plan the output directory: refuse an `out` that already exists unless it is an empty, real
 * directory (not a symlink), so nothing planted under it can redirect a write. Reads only.
 */
export function assertFreshOut(out: string): void {
  const st = lstatOrNull(out);
  if (st === null) return;
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new RequestBuildError(`--out ${out} exists and is not a plain directory`);
  if (readdirSync(out).length > 0)
    throw new RequestBuildError(`--out ${out} exists and is not empty`);
}

/**
 * Prepare a write of `name` under `out` (which must exist): `pathInside`, then each directory
 * component below `out` is created if absent, or refused if it is a symlink or not a
 * directory, and `realpath` of the parent must lie inside `realpath(out)`. The final entry is
 * not touched here; the caller creates it exclusively (`COPYFILE_EXCL` / flag `wx`), so a
 * planted entry there is refused rather than written through.
 */
export function destinationInside(out: string, name: string): string {
  const full = pathInside(out, name);
  const outReal = realRoot(out);
  const parts = relative(resolve(out), full).split(/[\\/]/);
  let cur = resolve(out);
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (st === null) mkdirSync(cur);
    else if (st.isSymbolicLink() || !st.isDirectory())
      throw new RequestBuildError(
        `path ${JSON.stringify(name)} under ${out}: ${part} is ${st.isSymbolicLink() ? "a symlink" : "not a directory"}`,
      );
  }
  assertRealInside(outReal, realpathSync(dirname(full)), name, out, true);
  return full;
}

/**
 * The write phase, run only after planning succeeded: create `out`, copy each planned file
 * to its destination (relative to `out`) without overwriting anything, then write
 * `requests.jsonl` the same way. Returns the requests path.
 *
 * Refusals normally all happen in planning. This phase can still refuse if the disk changed
 * between planning and writing (a race) or on an I/O error: any filesystem error here is
 * re-raised as a `RequestBuildError` naming the destination, so the CLI prints one refusal
 * line, and it can leave a partial `out`.
 */
export function writePlanned(
  out: string,
  copies: readonly { src: string; dst: string }[],
  requestsText: string,
): string {
  const fsStep = <T>(what: string, step: () => T): T => {
    try {
      return step();
    } catch (e) {
      if (e instanceof RequestBuildError) throw e;
      const code = (e as NodeJS.ErrnoException).code ?? (e as Error).name;
      throw new RequestBuildError(`write refused for ${what}: ${code} (--out may be partial)`);
    }
  };
  fsStep(`--out ${out}`, () => mkdirSync(out, { recursive: true }));
  const st = fsStep(`--out ${out}`, () => lstatSync(out));
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new RequestBuildError(`--out ${out} is not a plain directory`);
  const done = new Map<string, string>();
  for (const { src, dst } of copies) {
    const prior = done.get(dst);
    if (prior !== undefined) {
      if (prior === src) continue;
      throw new RequestBuildError(`two sources planned for ${dst}`);
    }
    fsStep(dst, () => copyFileSync(src, destinationInside(out, dst), constants.COPYFILE_EXCL));
    done.set(dst, src);
  }
  const requestsPath = fsStep("requests.jsonl", () => destinationInside(out, "requests.jsonl"));
  fsStep("requests.jsonl", () => writeFileSync(requestsPath, requestsText, { flag: "wx" }));
  return requestsPath;
}
