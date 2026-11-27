/**
 * Track M's measurement task set `rep-v1` (capability-spec §2 M, "Task set (new)").
 *
 * Built deterministically from the published fc-v1 tasks with a pre-registered build seed, so
 * the committed manifest (`docs/product/capability-prereg/m-v1/rep-v1-manifest.json`) can be
 * re-derived and compared byte for byte:
 *  - learn split: 20 tasks, run in the learn phase to fill the store;
 *  - test split: 20 REPEAT units (the same task as a learn task, a new run) and 20 SIMILAR
 *    units (same family, a different fc-v1 task whose fixture seed, record and column all
 *    differ from its learn task's, and whose fixture seed no learn task uses).
 *
 * Only no-fault, satisfiable fc-v1 tasks are used: M's bar is about learning, not fault
 * handling. fc-v1 has one family, `calc-record-edit`; the spec's second learn family,
 * `calc-multi-step`, has no published, graded task set yet (TIF-270), so rep-v1 is
 * calc-record-edit only. That deviation is flagged "lead ruling pending" in the
 * pre-registration; adding the family is a new task-set version.
 *
 * Selection order comes from SHA-256 of (build seed, item), never from Math.random.
 */
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { buildTaskSet } from "../benchmark/taskset.ts";
import { canonicalJson, sha256 } from "./record.ts";

export const REP_TASKSET_VERSION = "rep-v1";
export const REP_MANIFEST_SCHEMA = "myco.skills.rep-taskset/1";
export const REP_LEARN_N = 20;
export const REP_REPEAT_N = 20;
export const REP_SIMILAR_N = 20;

export type RepKind = "repeat" | "similar";

export interface RepTaskRef {
  readonly taskId: string;
  readonly family: string;
  readonly fixtureSeed: string;
  readonly fixtureSha256: string;
  readonly instructionSha256: string;
}

export interface RepTestUnit extends RepTaskRef {
  /** `rep-v1-repeat-01` .. `rep-v1-similar-20`: the paired unit of the McNemar test. */
  readonly unitId: string;
  readonly kind: RepKind;
  /** The learn task this unit repeats, or is similar to. */
  readonly learnTaskId: string;
}

export interface RepManifest {
  readonly schema: typeof REP_MANIFEST_SCHEMA;
  readonly taskSetVersion: typeof REP_TASKSET_VERSION;
  readonly sourceTaskSet: "fc-v1";
  readonly buildSeed: string;
  readonly learn: readonly RepTaskRef[];
  readonly test: readonly RepTestUnit[];
}

const order = (seed: string, item: string) => sha256(`${seed}\u0000${item}`);
const byOrder =
  <T>(seed: string, key: (t: T) => string) =>
  (a: T, b: T) => {
    const x = order(seed, key(a));
    const y = order(seed, key(b));
    return x < y ? -1 : x > y ? 1 : 0;
  };

const ref = (t: BenchmarkTask): RepTaskRef => ({
  taskId: t.taskId,
  family: t.family,
  fixtureSeed: t.fixtureSeed,
  fixtureSha256: t.fixtureSha256,
  instructionSha256: t.instructionSha256,
});

/**
 * Build rep-v1 from fc-v1 with `buildSeed`. Throws when the constraints cannot be met, never
 * relaxes them.
 */
export function buildRepTaskSet(
  buildSeed: string,
  published: readonly BenchmarkTask[] = buildTaskSet().tasks,
): RepManifest {
  const pool = published.filter(
    (t) => t.taskSetVersion === "fc-v1" && t.faultClass === "none" && t.satisfiable,
  );
  const bySeed = new Map<string, BenchmarkTask[]>();
  for (const t of pool) bySeed.set(t.fixtureSeed, [...(bySeed.get(t.fixtureSeed) ?? []), t]);
  const seeds = [...bySeed.keys()].sort(byOrder(buildSeed, (s: string) => `fixture:${s}`));
  // Fixture seeds are split in two halves: learn tasks come from the first, similar tasks
  // from the second, so no similar task shares a fixture with any learn task.
  const half = Math.ceil(seeds.length / 2);
  const pick = (from: readonly string[], n: number) => {
    const out: BenchmarkTask[] = [];
    // Round-robin over fixture seeds keeps the split spread across fixtures.
    const lists = from.map((s) =>
      [...(bySeed.get(s) ?? [])].sort(byOrder(buildSeed, (t: BenchmarkTask) => t.taskId)),
    );
    for (let round = 0; out.length < n && lists.some((l) => l.length > round); round++)
      for (const l of lists) {
        const t = l[round];
        if (t !== undefined && out.length < n) out.push(t);
      }
    if (out.length < n) throw new Error(`rep-v1: only ${out.length} tasks for a split of ${n}`);
    return out;
  };
  const learn = pick(seeds.slice(0, half), REP_LEARN_N);
  const candidates = pick(seeds.slice(half), seeds.slice(half).length * 3).filter(
    (t) => !learn.some((l) => l.taskId === t.taskId),
  );
  const used = new Set<string>();
  const similar: { t: BenchmarkTask; learn: BenchmarkTask }[] = [];
  for (const l of learn) {
    const s = candidates.find(
      (c) =>
        !used.has(c.taskId) &&
        c.family === l.family &&
        c.fixtureSeed !== l.fixtureSeed &&
        c.intent.rowKey !== l.intent.rowKey &&
        c.intent.column !== l.intent.column,
    );
    if (s === undefined) throw new Error(`rep-v1: no similar task for ${l.taskId}`);
    used.add(s.taskId);
    similar.push({ t: s, learn: l });
  }
  const unit = (kind: RepKind, i: number) =>
    `${REP_TASKSET_VERSION}-${kind}-${String(i + 1).padStart(2, "0")}`;
  const test: RepTestUnit[] = [
    ...learn.slice(0, REP_REPEAT_N).map((l, i) => ({
      unitId: unit("repeat", i),
      kind: "repeat" as const,
      learnTaskId: l.taskId,
      ...ref(l),
    })),
    ...similar.slice(0, REP_SIMILAR_N).map(({ t, learn: l }, i) => ({
      unitId: unit("similar", i),
      kind: "similar" as const,
      learnTaskId: l.taskId,
      ...ref(t),
    })),
  ];
  return {
    schema: REP_MANIFEST_SCHEMA,
    taskSetVersion: REP_TASKSET_VERSION,
    sourceTaskSet: "fc-v1",
    buildSeed,
    learn: learn.map(ref),
    test,
  };
}

/** The manifest SHA-256 the pre-registration records: over its canonical JSON. */
export function repManifestSha256(manifest: RepManifest): string {
  return sha256(canonicalJson(manifest));
}

/**
 * Problems with a manifest against the rep-v1 rules (counts, splits, similarity). Empty when
 * it holds. Used by the tests and by the analysis on the committed manifest.
 */
export function repManifestProblems(
  m: RepManifest,
  published: readonly BenchmarkTask[] = buildTaskSet().tasks,
): string[] {
  const out: string[] = [];
  const byId = new Map(published.map((t) => [t.taskId, t]));
  if (m.schema !== REP_MANIFEST_SCHEMA) out.push("schema");
  if (m.taskSetVersion !== REP_TASKSET_VERSION) out.push("taskSetVersion");
  if (m.learn.length !== REP_LEARN_N) out.push(`learn has ${m.learn.length}`);
  const repeat = m.test.filter((u) => u.kind === "repeat");
  const similar = m.test.filter((u) => u.kind === "similar");
  if (repeat.length !== REP_REPEAT_N) out.push(`repeat has ${repeat.length}`);
  if (similar.length !== REP_SIMILAR_N) out.push(`similar has ${similar.length}`);
  if (new Set(m.test.map((u) => u.unitId)).size !== m.test.length) out.push("duplicate unitId");
  if (new Set(m.learn.map((r) => r.taskId)).size !== m.learn.length) out.push("duplicate learn");
  const learnIds = new Set(m.learn.map((r) => r.taskId));
  const learnSeeds = new Set(m.learn.map((r) => r.fixtureSeed));
  for (const r of [...m.learn, ...m.test]) {
    const t = byId.get(r.taskId);
    if (t === undefined || t.faultClass !== "none" || !t.satisfiable) {
      out.push(`${r.taskId}: not a no-fault satisfiable fc-v1 task`);
      continue;
    }
    if (
      t.fixtureSha256 !== r.fixtureSha256 ||
      t.instructionSha256 !== r.instructionSha256 ||
      t.fixtureSeed !== r.fixtureSeed ||
      t.family !== r.family
    )
      out.push(`${r.taskId}: does not match the published task`);
  }
  for (const u of repeat)
    if (u.taskId !== u.learnTaskId) out.push(`${u.unitId}: a repeat is not its learn task`);
  for (const u of similar) {
    const t = byId.get(u.taskId);
    const l = byId.get(u.learnTaskId);
    if (learnIds.has(u.taskId)) out.push(`${u.unitId}: similar task is in the learn split`);
    if (learnSeeds.has(u.fixtureSeed)) out.push(`${u.unitId}: similar shares a learn fixture`);
    if (!learnIds.has(u.learnTaskId)) out.push(`${u.unitId}: learnTaskId not in learn split`);
    if (t && l && (t.intent.rowKey === l.intent.rowKey || t.intent.column === l.intent.column))
      out.push(`${u.unitId}: similar keeps its learn task's record or column`);
    if (t && l && t.family !== l.family) out.push(`${u.unitId}: family differs`);
  }
  if (new Set(similar.map((u) => u.taskId)).size !== similar.length)
    out.push("duplicate similar task");
  return out;
}
