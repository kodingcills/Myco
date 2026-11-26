/**
 * Binding of a gated arm's rows to a PUBLISHED task set (TIF-274; #506 rounds 1-2). One module,
 * used by the M2 evidence-pack check (`src/m2/evidence.ts`) and, after #506, by the
 * benchmark check CLI, so the two can never bind differently.
 *
 * On a task set this module knows (today: fc-v1, built by `buildTaskSet`, which
 * `test/benchmark/taskset.test.ts` pins byte-identical to `benchmark/false-completion/fc-v1/`),
 * the rows must be exactly that task set, run a whole number of times:
 *  - every row names one of its tasks, with that task's `faultClass`, `fixtureSha256` and
 *    `instructionSha256` (so an fc-v1 label over other fixtures or instructions is refused);
 *  - a row is `unregistrable` exactly when its task is unsatisfiable, in both directions;
 *  - with `exactMultiset`, every task appears exactly k times for one k >= 1: no duplicate
 *    standing in for another task, no task missing.
 * A task set this module does not know binds nothing, so it is reported as unknown and the
 * caller decides (R1 evidence refuses it).
 */
import type { BenchmarkArmRow } from "./check.ts";
import { type BenchmarkTask, buildTaskSet, TASK_SET_VERSION } from "./taskset.ts";

let known: ReadonlyMap<string, readonly BenchmarkTask[]> | undefined;

/** The published tasks of `version`, or undefined when this module does not know it. */
export function knownTaskSet(version: string): readonly BenchmarkTask[] | undefined {
  known ??= new Map([[TASK_SET_VERSION, buildTaskSet().tasks]]);
  return known.get(version);
}

export interface TaskSetBinding {
  /** The rows' single task-set version, or null when there are none or several. */
  readonly version: string | null;
  /** Whether that version is a published task set this module knows. */
  readonly known: boolean;
  /** k: how many times each task ran (exactMultiset only, and only when whole); else null. */
  readonly repetitions: number | null;
  /** The unregistrable rows the task set implies (k x its unsatisfiable tasks), or null. */
  readonly expectedUnregistrable: number | null;
  readonly errors: readonly string[];
}

/** At most this many per-task multiplicity errors are listed; the rest are counted. */
const MAX_LISTED = 5;

export function bindToTaskSet(
  rows: readonly BenchmarkArmRow[],
  opts: { readonly exactMultiset: boolean },
): TaskSetBinding {
  const errors: string[] = [];
  const versions = [...new Set(rows.map((r) => r.taskSetVersion))];
  if (versions.length !== 1) {
    errors.push(
      versions.length === 0
        ? "no rows to bind to a task set"
        : `rows name several task sets: ${versions.join(", ")}`,
    );
    return { version: null, known: false, repetitions: null, expectedUnregistrable: null, errors };
  }
  const version = versions[0] as string;
  const tasks = knownTaskSet(version);
  if (tasks === undefined) {
    errors.push(`task set ${JSON.stringify(version)} is not a published task set this check knows`);
    return { version, known: false, repetitions: null, expectedUnregistrable: null, errors };
  }

  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const count = new Map<string, number>();
  for (const r of rows) {
    const task = byId.get(r.taskId);
    if (task === undefined) {
      errors.push(`${r.trialKey}: task ${r.taskId} is not in ${version}`);
      continue;
    }
    count.set(task.taskId, (count.get(task.taskId) ?? 0) + 1);
    if (task.faultClass !== r.faultClass)
      errors.push(
        `${r.trialKey}: faultClass ${r.faultClass} is not task ${r.taskId}'s (${task.faultClass})`,
      );
    if (task.fixtureSha256 !== r.fixtureSha256)
      errors.push(`${r.trialKey}: fixtureSha256 is not task ${r.taskId}'s published fixture`);
    if (task.instructionSha256 !== r.instructionSha256)
      errors.push(
        `${r.trialKey}: instructionSha256 is not task ${r.taskId}'s published instruction`,
      );
    const unregistrable = r.gate?.unregistrable === true;
    if (unregistrable && task.satisfiable)
      errors.push(`${r.trialKey}: task ${r.taskId} is satisfiable, so it cannot be unregistrable`);
    if (!unregistrable && !task.satisfiable && r.arm === "myco-gate")
      errors.push(`${r.trialKey}: task ${r.taskId} is unsatisfiable, so it must be unregistrable`);
  }

  const unsat = tasks.filter((t) => !t.satisfiable).length;
  let repetitions: number | null = null;
  if (opts.exactMultiset) {
    if (rows.length === 0 || rows.length % tasks.length !== 0) {
      errors.push(
        `${rows.length} rows is not a whole number of runs of ${version}'s ${tasks.length} tasks`,
      );
    } else {
      const k = rows.length / tasks.length;
      const off = tasks
        .map((t) => [t.taskId, count.get(t.taskId) ?? 0] as const)
        .filter(([, n]) => n !== k);
      for (const [id, n] of off.slice(0, MAX_LISTED))
        errors.push(
          `task ${id} ran ${n} time(s), expected ${k} (each ${version} task exactly ${k})`,
        );
      if (off.length > MAX_LISTED)
        errors.push(
          `${off.length - MAX_LISTED} more task(s) of ${version} ran other than ${k} time(s)`,
        );
      if (off.length === 0) repetitions = k;
    }
  }
  return {
    version,
    known: true,
    repetitions,
    expectedUnregistrable: repetitions === null ? null : repetitions * unsat,
    errors,
  };
}
