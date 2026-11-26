/**
 * Track M warm-vs-cold agent arm, wired for later measurement (no measurement runs here).
 *
 * The frozen task set `skills-rs-v1` is built from published fc-v1 tasks (no fault,
 * satisfiable), paired by the target column's type: each pair has a SEED task (run cold to
 * fill the store), whose later re-run is the REPEAT task, and a SIMILAR task (same family,
 * same column type, different record, column value and fixture). `SKILLS_TASKSET_SHA256`
 * pins the exact pairs; `test/skills/arm.test.ts` recomputes it.
 *
 * Protocol shape (see docs/skills/learning-from-verified-outcomes.md for the pre-registered
 * bar):
 *  1. seed phase: every seed task runs cold with `learn: true`; only outcomes the gate
 *     verified AND the grader passed become skills (`admit`). The store head is then pinned.
 *  2. measurement phase: every pair's repeat and similar task runs in BOTH arms, cold (no
 *     store at all) and warm (skills retrieved through the `myco_skills_retrieve` tool path
 *     and given to the agent as advice). A warm trial retrieves only from the pinned head
 *     (`pinnedHead`; any other head refuses the trial, `STORE_NOT_PINNED`) and writes
 *     nothing to the store: no learning (`learn` is refused outside the seed phase) and no
 *     `use` events. So every measured warm trial sees the same store, whatever the order.
 *  3. after the measurement phase, `recordMeasuredUses` writes each warm trial's `use`
 *     events; quarantine from refuted uses takes effect from then on, between phases.
 *  4. every trial is verified exactly as a cold one: the gate (myco.gate/v1, unchanged) and
 *     the independent grader on the gate's own bytes. A row is `verified` only when both
 *     say so on the same bytes.
 *
 * Simulated planners (scripted agents) are plumbing: a trial declares `simulated` up front
 * (checked against the planner it reports), a real trial never receives a
 * simulated-provenance skill, and simulated rows never count in a real summary or paired
 * counts (`summarizeSkillArms`, `pairedCounts`; only an explicitly simulated scope counts
 * them, for the $0 tests).
 *
 * Rows are `myco.skills.arm-row/1`, NOT `myco.benchmark.arm-row/1`: they fail the benchmark
 * ledger schema, name a task set the R1 binding does not know, and carry
 * `evidence: "never-r1"`. They are never R1 evidence. Cost is a token-derived ESTIMATE
 * (`estimatedUsd`), never billed USD; a null cost is never read as 0.
 */
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { buildTaskSet } from "../benchmark/taskset.ts";
import { type AdmissionGate, type AdmissionGrade, admit } from "./admission.ts";
import { callRetrieve } from "./mcp-server.ts";
import { canonicalJson, type ForbiddenValues, isSimulatedPlanner, sha256 } from "./record.ts";
import type { RetrievalResult, SkillAdvice } from "./retrieve.ts";
import { type SkillStore, SkillStoreError, useOutcome } from "./store.ts";

export const SKILLS_TASKSET_VERSION = "skills-rs-v1";
export const SKILL_ARM_ROW_SCHEMA = "myco.skills.arm-row/1";
export const SKILL_ARMS = ["cold", "warm"] as const;
export type SkillArm = (typeof SKILL_ARMS)[number];
export type TrialKind = "seed" | "repeat" | "similar";
/** The agent harness each arm runs on (the baseline arms the bar compares against). */
export type BaseArm = "c1-screenshot" | "hcu-shell";

export interface SkillTaskPair {
  readonly pairId: string;
  readonly columnType: string;
  readonly seedTaskId: string;
  readonly similarTaskId: string;
}

/** Abstract similarity features of a task: never its record key, value or fixture. */
export function taskFeatures(task: Pick<BenchmarkTask, "intent" | "columnTypes">): string[] {
  const type = task.columnTypes[task.intent.column] ?? "unknown";
  return ["app:calc", "edit:single-cell", "format:csv", `column-type:${type}`];
}

let frozen: readonly SkillTaskPair[] | undefined;

/** The frozen pairs of `skills-rs-v1`. Deterministic from the published fc-v1 task set. */
export function skillTaskPairs(): readonly SkillTaskPair[] {
  if (frozen) return frozen;
  const tasks = buildTaskSet().tasks.filter((t) => t.faultClass === "none" && t.satisfiable);
  const byType = new Map<string, BenchmarkTask[]>();
  for (const t of tasks) {
    const type = t.columnTypes[t.intent.column] ?? "unknown";
    byType.set(type, [...(byType.get(type) ?? []), t]);
  }
  const pairs: SkillTaskPair[] = [];
  for (const type of [...byType.keys()].sort()) {
    const list = byType.get(type) ?? [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      const seed = list[i] as BenchmarkTask;
      const similar = list[i + 1] as BenchmarkTask;
      pairs.push({
        pairId: `${SKILLS_TASKSET_VERSION}-${type}-${String(i / 2 + 1).padStart(2, "0")}`,
        columnType: type,
        seedTaskId: seed.taskId,
        similarTaskId: similar.taskId,
      });
    }
  }
  frozen = Object.freeze(pairs.map((p) => Object.freeze(p)));
  return frozen;
}

/** SHA-256 of the canonical pairs list. Pinned in the tests; a change is a new version. */
export function skillTaskSetDigest(): string {
  return sha256(canonicalJson(skillTaskPairs()));
}

/** Advice text for the warm arm's agent. Labelled as advice; the gate decides. */
export function renderAdvice(skills: readonly SkillAdvice[]): string | null {
  if (skills.length === 0) return null;
  const parts = skills.map((s) => {
    const pre = s.preconditions.length > 0 ? ` Preconditions: ${s.preconditions.join("; ")}.` : "";
    const steps = s.steps.map((step, i) => `${i + 1}. ${step}`).join(" ");
    return `Skill ${s.skillId} (similarity ${s.similarity}).${pre} Steps: ${steps}`;
  });
  return (
    "Advice from earlier runs that were verified and independently graded. It is advice, " +
    "not evidence: your result is checked the same way with or without it.\n" +
    parts.join("\n")
  );
}

/** What one trial produced, as the harness (or a scripted agent in tests) reports it. */
export interface SkillTrialRun {
  /** The harness's post-stop gate check (`runGatedTrial`'s `result`). */
  readonly gate: AdmissionGate;
  /** The independent grader's result on the captured bytes, or null when ungraded. */
  readonly grade: AdmissionGrade | null;
  /** The procedure the run followed, as extracted by the harness, or null. */
  readonly procedure: {
    readonly preconditions: readonly string[];
    readonly steps: readonly string[];
  } | null;
  readonly plannerModelId: string;
  readonly assisted: boolean;
  readonly corrections: "on" | "off";
  readonly ledgerRef: { readonly ledger: string; readonly entrySha256: string };
  /** Token-derived ESTIMATE in USD, or null when unknown. Never billed USD. */
  readonly estimatedUsd: number | null;
}

export interface SkillArmRow {
  readonly schema: typeof SKILL_ARM_ROW_SCHEMA;
  readonly taskSetVersion: typeof SKILLS_TASKSET_VERSION;
  readonly taskSetSha256: string;
  readonly baseArm: BaseArm;
  readonly arm: SkillArm;
  readonly kind: TrialKind;
  readonly pairId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly plannerModelId: string;
  readonly simulated: boolean;
  /** The store head the warm arm retrieved from (null for cold). */
  readonly storeHead: string | null;
  readonly retrievedSkillIds: readonly string[];
  readonly gate: {
    readonly verdict: "verified" | "refuted" | "uncertain";
    readonly accepted: boolean;
  };
  readonly grade: { readonly status: "pass" | "fail" | "ungradable" | null };
  /** The grader graded the bytes the gate decided on (its persisted-state ref digest). */
  readonly gradedGateBytes: boolean;
  /** Gate verified AND grader passed, on the same bytes. The only success this arm counts. */
  readonly verified: boolean;
  /** The skill this trial added (seed phase only), or null. */
  readonly admittedSkillId: string | null;
  /** Why it was not added, when it was offered and refused. */
  readonly admissionCode: string | null;
  readonly cost: { readonly estimatedUsd: number | null; readonly estimate: true };
  readonly evidence: "never-r1";
}

export interface SkillArmTrialOptions {
  readonly baseArm: BaseArm;
  readonly arm: SkillArm;
  readonly kind: TrialKind;
  readonly pairId: string;
  readonly task: BenchmarkTask;
  readonly runId: string;
  /** Required for warm (retrieval) and for learn (admission). Cold never retrieves. */
  readonly store: SkillStore | null;
  /** The store head pinned after the seed phase. Required for warm; another head refuses. */
  readonly pinnedHead?: string;
  /**
   * Whether this trial's planner is simulated (a scripted agent). Declared up front, checked
   * against the planner the run reports. A real trial is never served simulated skills;
   * a simulated trial may admit simulated skills (the $0 tests).
   */
  readonly simulated: boolean;
  /** Offer the outcome to admission. Seed phase only. */
  readonly learn: boolean;
  /** The task's forbidden values (`forbiddenValuesFor`), required when learning. */
  readonly forbidden?: ForbiddenValues;
  /** Run the trial with this advice (null for cold, or warm with nothing retrieved). */
  readonly execute: (advice: string | null) => Promise<SkillTrialRun>;
}

export async function runSkillArmTrial(o: SkillArmTrialOptions): Promise<SkillArmRow> {
  if (o.learn && o.kind !== "seed")
    throw new Error("learning is only allowed in the seed phase (the measured store is frozen)");
  if (o.learn && o.arm !== "cold") throw new Error("the seed phase runs cold");
  if ((o.arm === "warm" || o.learn) && o.store === null)
    throw new Error(`${o.arm}${o.learn ? " learning" : ""} trial needs a store`);
  if (o.arm === "warm" && o.pinnedHead === undefined)
    throw new Error("a warm trial needs the pinned store head");
  const family = o.task.family;
  let retrieved: RetrievalResult | null = null;
  let storeHead: string | null = null;
  if (o.arm === "warm" && o.store !== null && o.pinnedHead !== undefined) {
    // Through the MCP tool path, the same code the agent-facing server runs, scoped to the
    // pinned head (another head is refused) and to this trial's planner kind.
    const r = callRetrieve(
      {
        store: o.store,
        taskFamily: family,
        serveSimulated: o.simulated,
        expectHead: o.pinnedHead,
      },
      { taskFamily: family, features: taskFeatures(o.task) },
    );
    if (!r.ok) throw new Error("retrieval failed");
    const body = (r.result as { structuredContent: RetrievalResult & { codes?: string[] } })
      .structuredContent;
    if (body.codes !== undefined) throw new Error(`retrieval refused: ${body.codes.join(",")}`);
    retrieved = body;
    storeHead = o.pinnedHead;
  }
  const advice = o.arm === "warm" ? renderAdvice(retrieved?.skills ?? []) : null;
  const run = await o.execute(advice);
  const simulated = isSimulatedPlanner(run.plannerModelId);
  if (simulated !== o.simulated)
    throw new Error("the run's planner contradicts the trial's declared simulated flag");
  const persistedRefs = (run.gate.evidenceRefs ?? []).filter((r) => r.kind === "persisted-state");
  const gradedGateBytes =
    persistedRefs.length === 1 &&
    typeof run.grade?.persistedSha256 === "string" &&
    persistedRefs[0]?.sha256 === run.grade.persistedSha256;
  const verified =
    run.gate.verdict === "verified" &&
    run.gate.accepted === true &&
    run.grade?.status === "pass" &&
    gradedGateBytes;
  // No store write here: measured warm trials leave the pinned store as it is.
  // `recordMeasuredUses` writes their use events after the measurement phase.

  let admittedSkillId: string | null = null;
  let admissionCode: string | null = null;
  if (o.learn && o.store !== null) {
    if (run.procedure === null) admissionCode = "NO_PROCEDURE";
    else {
      const added = o.store.add(
        admit(
          {
            runId: o.runId,
            taskId: o.task.taskId,
            taskFamily: family,
            fixtureSha256: o.task.fixtureSha256,
            features: taskFeatures(o.task),
            preconditions: run.procedure.preconditions,
            steps: run.procedure.steps,
            ledgerRef: run.ledgerRef,
            gate: run.gate,
            grade: run.grade,
            assisted: run.assisted,
            corrections: run.corrections,
            plannerModelId: run.plannerModelId,
          },
          o.forbidden ?? { values: [] },
          { simulated: o.simulated },
        ),
      );
      if (added.stored) admittedSkillId = added.skillId;
      else admissionCode = added.code;
    }
  }
  return {
    schema: SKILL_ARM_ROW_SCHEMA,
    taskSetVersion: SKILLS_TASKSET_VERSION,
    taskSetSha256: skillTaskSetDigest(),
    baseArm: o.baseArm,
    arm: o.arm,
    kind: o.kind,
    pairId: o.pairId,
    taskId: o.task.taskId,
    runId: o.runId,
    plannerModelId: run.plannerModelId,
    simulated,
    storeHead,
    retrievedSkillIds: (retrieved?.skills ?? []).map((s) => s.skillId),
    gate: { verdict: run.gate.verdict, accepted: run.gate.accepted },
    grade: { status: run.grade?.status ?? null },
    gradedGateBytes,
    verified,
    admittedSkillId,
    admissionCode,
    cost: { estimatedUsd: run.estimatedUsd, estimate: true },
    evidence: "never-r1",
  };
}

export interface ArmCell {
  readonly baseArm: BaseArm;
  readonly arm: SkillArm;
  readonly kind: TrialKind;
  readonly trials: number;
  readonly verified: number;
  readonly verifiedRate: number | null;
  /** Total estimated cost of ALL trials / verified; null when any cost is null or none verified. */
  readonly estimatedCostPerVerified: number | null;
}

export interface ArmSummary {
  readonly cells: readonly ArmCell[];
  readonly errors: readonly string[];
  /** Always false: these rows are never R1 evidence. */
  readonly r1Evidence: false;
}

/**
 * Which rows count. Real by default: simulated rows never count and are reported as errors.
 * `{ simulated: true }` (the $0 tests only) counts simulated rows and refuses real ones, so
 * the two never mix in one cell or one paired count.
 */
export interface ArmScope {
  readonly simulated?: boolean;
}

/** Whether a row belongs to the scope; a row whose flag contradicts its planner never does. */
function inScope(r: SkillArmRow, scope: ArmScope): boolean {
  if (r.simulated !== isSimulatedPlanner(r.plannerModelId)) return false;
  return r.simulated === (scope.simulated === true);
}

/**
 * Summarise rows per (base arm, arm, kind). Refuses rows that break the arm's invariants.
 * Rows outside the scope (simulated rows in a real summary, and the reverse) are reported
 * and left out of every cell.
 */
export function summarizeSkillArms(rows: readonly SkillArmRow[], scope: ArmScope = {}): ArmSummary {
  const errors: string[] = [];
  const digest = skillTaskSetDigest();
  const groups = new Map<string, SkillArmRow[]>();
  for (const r of rows) {
    if (r.simulated !== isSimulatedPlanner(r.plannerModelId))
      errors.push(`${r.runId}: simulated flag contradicts the planner`);
    else if (!inScope(r, scope))
      errors.push(
        r.simulated
          ? `${r.runId}: a simulated row never counts in a real summary`
          : `${r.runId}: a real row in a simulated summary`,
      );
    if (r.schema !== SKILL_ARM_ROW_SCHEMA) errors.push(`${r.runId}: not a skills arm row`);
    if (r.evidence !== "never-r1") errors.push(`${r.runId}: evidence must be never-r1`);
    if (r.taskSetVersion !== SKILLS_TASKSET_VERSION || r.taskSetSha256 !== digest)
      errors.push(`${r.runId}: not the frozen ${SKILLS_TASKSET_VERSION} task set`);
    const shouldVerify =
      r.gate.verdict === "verified" &&
      r.gate.accepted &&
      r.grade.status === "pass" &&
      r.gradedGateBytes === true;
    if (r.verified !== shouldVerify) errors.push(`${r.runId}: verified contradicts gate and grade`);
    if (r.admittedSkillId !== null && !shouldVerify)
      errors.push(`${r.runId}: a skill was stored from an outcome that is not verified and graded`);
    if (r.admittedSkillId !== null && (r.kind !== "seed" || r.arm !== "cold"))
      errors.push(`${r.runId}: a skill was stored outside the cold seed phase`);
    if (r.arm === "cold" && r.retrievedSkillIds.length > 0)
      errors.push(`${r.runId}: a cold trial retrieved skills`);
    if (!inScope(r, scope)) continue;
    const key = `${r.baseArm}|${r.arm}|${r.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const cells: ArmCell[] = [...groups.entries()].sort().map(([key, list]) => {
    const [baseArm, arm, kind] = key.split("|") as [BaseArm, SkillArm, TrialKind];
    const verified = list.filter((r) => r.verified).length;
    const anyNull = list.some((r) => r.cost.estimatedUsd === null);
    const total = list.reduce((s, r) => s + (r.cost.estimatedUsd ?? 0), 0);
    return {
      baseArm,
      arm,
      kind,
      trials: list.length,
      verified,
      verifiedRate: list.length === 0 ? null : verified / list.length,
      estimatedCostPerVerified: anyNull || verified === 0 ? null : total / verified,
    };
  });
  return { cells, errors, r1Evidence: false };
}

/**
 * Paired counts for the pre-registered test: one pair = (pairId, kind), cold vs warm. Rows
 * outside the scope (simulated rows by default) never count; they are tallied as `excluded`.
 */
export function pairedCounts(
  rows: readonly SkillArmRow[],
  baseArm: BaseArm,
  scope: ArmScope = {},
): {
  both: number;
  warmOnly: number;
  coldOnly: number;
  neither: number;
  unpaired: number;
  excluded: number;
} {
  const byKey = new Map<string, { cold?: boolean; warm?: boolean; dup: boolean }>();
  let excluded = 0;
  for (const r of rows) {
    if (r.baseArm !== baseArm || r.kind === "seed") continue;
    if (!inScope(r, scope)) {
      excluded++;
      continue;
    }
    const key = `${r.pairId}|${r.kind}`;
    const e = byKey.get(key) ?? { dup: false };
    if (e[r.arm] !== undefined) e.dup = true;
    e[r.arm] = r.verified;
    byKey.set(key, e);
  }
  const out = { both: 0, warmOnly: 0, coldOnly: 0, neither: 0, unpaired: 0, excluded };
  for (const e of byKey.values()) {
    if (e.dup || e.cold === undefined || e.warm === undefined) out.unpaired++;
    else if (e.cold && e.warm) out.both++;
    else if (e.warm) out.warmOnly++;
    else if (e.cold) out.coldOnly++;
    else out.neither++;
  }
  return out;
}

/**
 * After the measurement phase: write each warm trial's `use` events (its outcome from the
 * gate verdict AND the grader status) to the store, so quarantine applies from the next
 * phase on. The store must still be at `pinnedHead` (nothing was written during the
 * phase), and every warm row must have retrieved from it. Returns the number of events.
 */
export function recordMeasuredUses(
  store: SkillStore,
  rows: readonly SkillArmRow[],
  pinnedHead: string,
): number {
  if (store.snapshot().head !== pinnedHead)
    throw new SkillStoreError("STORE_NOT_PINNED", "the store moved during the measurement phase");
  const warm = rows.filter((r) => r.arm === "warm");
  for (const r of warm)
    if (r.storeHead !== pinnedHead)
      throw new SkillStoreError("STORE_NOT_PINNED", `${r.runId} did not read the pinned head`);
  let n = 0;
  for (const r of warm) {
    const outcome = useOutcome(r.gate.verdict, r.grade.status);
    for (const id of r.retrievedSkillIds) {
      store.recordUse(id, r.runId, outcome);
      n++;
    }
  }
  return n;
}

/** One-sided exact McNemar p-value: P(X >= warmOnly) for X ~ Binomial(warmOnly+coldOnly, 1/2). */
export function mcnemarOneSided(warmOnly: number, coldOnly: number): number {
  const n = warmOnly + coldOnly;
  if (n === 0) return 1;
  let p = 0;
  let c = 1; // C(n, 0)
  for (let k = 0; k <= n; k++) {
    if (k >= warmOnly) p += c;
    c = (c * (n - k)) / (k + 1);
  }
  return Math.min(1, p / 2 ** n);
}
