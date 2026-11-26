/**
 * The PUBLISHED task set, read from its committed bundle (`benchmark/false-completion/<version>/
 * tasks.jsonl`), not rebuilt from the task generators (#547 O1 follow-up, TIF-274).
 *
 * Why: the task-set binding (`taskset-binding.ts`) and the corrections A/B analysis need only the
 * published rows (task ids, fault classes, fixture and instruction hashes). Rebuilding them with
 * `buildTaskSet()` pulled `src/tasks/fixture.ts` and `src/tasks/intent.ts` (code the gate also
 * imports) into the analysis's import closure. This module reads bytes and imports no generator;
 * `test/benchmark/independence.test.ts` walks it.
 *
 * Fail closed. A published task set never changes, so its `tasks.jsonl` is pinned by SHA-256 here
 * (`PUBLISHED_TASK_SETS`); other bytes are refused before parsing. Every row is then checked for
 * shape (schema, version, unique ids, hex hashes, a known fault class, a content-addressed
 * fixture path, `instructionSha256` = sha256(instruction)) and the counts are checked, so a
 * malformed or substituted file throws instead of binding anything.
 * `test/benchmark/taskset.test.ts` pins the bundle byte-identical to `buildTaskSet()`, so reading
 * it changes no binding.
 *
 * Packaging: the bundle is read from the repository checkout (resolved from this module's
 * location, `src/` or `dist/`). The npm package ships `dist/` only; a hosted or installed use of
 * the binding must ship the bundle next to it or pass `root`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type BenchmarkTask,
  FC_V1_FAULT_CLASSES,
  TASK_SCHEMA,
  TASK_SET_VERSION,
} from "./task-types.ts";

/** The published task sets this repository knows: bundle path, pinned bytes, and counts. */
export const PUBLISHED_TASK_SETS: Readonly<
  Record<
    string,
    {
      readonly bundle: string;
      readonly tasksSha256: string;
      readonly tasks: number;
      readonly unsatisfiable: number;
      readonly demo: number;
    }
  >
> = {
  [TASK_SET_VERSION]: {
    bundle: "benchmark/false-completion/fc-v1",
    tasksSha256: "59d10dd1a3d3a0912df0cd9a44f09bd86e663388df9859ceab67f3e0f7312356",
    tasks: 100,
    unsatisfiable: 10,
    demo: 30,
  },
};

/** The repository root: two levels above this module, from `src/benchmark/` or `dist/benchmark/`. */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** Parses and checks `tasks.jsonl` bytes for `version`; throws on anything off. */
export function parsePublishedTasks(version: string, bytes: Uint8Array): readonly BenchmarkTask[] {
  const pub = PUBLISHED_TASK_SETS[version];
  if (pub === undefined) throw new Error(`task set ${JSON.stringify(version)} is not published`);
  const got = sha256(bytes);
  if (got !== pub.tasksSha256)
    throw new Error(
      `${version} tasks.jsonl is not the published file (sha256 ${got}, pinned ${pub.tasksSha256})`,
    );
  return checkTaskRows(version, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * The row and count checks on `tasks.jsonl` text, without the byte pin (exported so each check is
 * tested on its own; the pin would otherwise mask them). Throws on the first bad row, or on the
 * counts.
 */
export function checkTaskRows(version: string, text: string): readonly BenchmarkTask[] {
  const pub = PUBLISHED_TASK_SETS[version];
  if (pub === undefined) throw new Error(`task set ${JSON.stringify(version)} is not published`);
  const lines = text.split("\n").filter((l) => l !== "");
  const tasks = lines.map((line, i) => checkRow(version, JSON.parse(line) as unknown, i + 1));
  const ids = new Set(tasks.map((t) => t.taskId));
  const errors: string[] = [];
  if (ids.size !== tasks.length) errors.push(`${tasks.length - ids.size} duplicated task id(s)`);
  if (tasks.length !== pub.tasks) errors.push(`${tasks.length} tasks, published ${pub.tasks}`);
  const unsat = tasks.filter((t) => !t.satisfiable).length;
  if (unsat !== pub.unsatisfiable)
    errors.push(`${unsat} unsatisfiable tasks, published ${pub.unsatisfiable}`);
  const demo = tasks.filter((t) => t.inDemo).length;
  if (demo !== pub.demo) errors.push(`${demo} demo tasks, published ${pub.demo}`);
  if (errors.length > 0) throw new Error(`${version} tasks.jsonl: ${errors.join("; ")}`);
  return tasks;
}

function checkRow(version: string, value: unknown, line: number): BenchmarkTask {
  const bad = (why: string): never => {
    throw new Error(`${version} tasks.jsonl line ${line}: ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("not an object");
  const r = value as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : bad(`${k} missing`));
  if (r.schema !== TASK_SCHEMA) bad(`schema is not ${TASK_SCHEMA}`);
  if (r.taskSetVersion !== version) bad(`taskSetVersion is not ${version}`);
  if (!/^[a-z0-9-]+-\d{3}$/.test(str("taskId"))) bad("taskId malformed");
  if (r.family !== "calc-record-edit") bad("family is not calc-record-edit");
  if (!(FC_V1_FAULT_CLASSES as readonly unknown[]).includes(r.faultClass))
    bad("faultClass unknown");
  if (typeof r.inDemo !== "boolean" || typeof r.satisfiable !== "boolean")
    bad("inDemo/satisfiable not boolean");
  if (!HEX64.test(str("instructionSha256"))) bad("instructionSha256 malformed");
  if (sha256(str("instruction")) !== r.instructionSha256)
    bad("instructionSha256 is not the instruction's sha256");
  if (!HEX64.test(str("fixtureSha256"))) bad("fixtureSha256 malformed");
  if (str("fixtureFile") !== `fixtures/${r.fixtureSha256}.csv`)
    bad("fixtureFile is not content-addressed by fixtureSha256");
  str("fixtureSeed");
  const intent = r.intent as Record<string, unknown> | null;
  if (
    typeof intent !== "object" ||
    intent === null ||
    ["rowKey", "column", "newValue"].some((k) => typeof intent[k] !== "string")
  )
    bad("intent malformed");
  if (typeof r.columnTypes !== "object" || r.columnTypes === null) bad("columnTypes malformed");
  if (r.persistedFormat !== "xlsx") bad("persistedFormat is not xlsx");
  return r as unknown as BenchmarkTask;
}

const cache = new Map<string, readonly BenchmarkTask[]>();

/**
 * The published tasks of `version`, read from its committed bundle under `root` (default: this
 * checkout), or undefined when `version` is not a published task set. Throws when the bundle is
 * missing or is not the published file.
 */
export function publishedTasks(
  version: string,
  root: string = REPO_ROOT,
): readonly BenchmarkTask[] | undefined {
  const pub = PUBLISHED_TASK_SETS[version];
  if (pub === undefined) return undefined;
  const key = `${root}\0${version}`;
  let tasks = cache.get(key);
  if (tasks === undefined) {
    tasks = parsePublishedTasks(version, readFileSync(join(root, pub.bundle, "tasks.jsonl")));
    cache.set(key, tasks);
  }
  return tasks;
}
