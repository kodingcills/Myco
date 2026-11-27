/**
 * Capability track K: the batch, its rows, the pack check and the pre-registered bar
 * (docs/product/capability-spec.md, "K. Recovery"; docs/recovery/recovery.md).
 *
 *  - `runRecoveryBatch`: runs trials in order and HALTS on the first gate miss: an attempt
 *    the gate verified (after the harness's checks) that the independent grader grades
 *    `fail` or `ungradable`. A grader that throws or returns anything else is `ungradable`.
 *    The halted batch reports the trial and attempt and runs nothing after it; a halted
 *    batch has no summary (`recoveryBar` refuses it). The grader is injected: this module
 *    never imports `src/benchmark/grade/` (grader independence).
 *  - rows are `myco.recovery.arm-row/1`, never R1 evidence: they record
 *    `gate.corrections` ("on" for K), so a K row relabelled `myco-gate` is still refused by
 *    the existing R1 check (`correctionsOnError`, src/benchmark/check.ts); and they carry
 *    `contrast: "K-vs-nothing"`, so a K result is never read as a corrections result.
 *  - `checkRecoveryPack` refuses a pack whose attempt count is not the harness's, whose arm
 *    config is not the arm's, whose contrast is not K-vs-nothing, or (evidence) any
 *    simulated row.
 *  - `recoveryBar`: exact one-sided McNemar, K better than no-recovery, p <= 0.05 with at
 *    least 5 discordant tasks, on the grader's verdict on the final captured document.
 *    Secondary (reported, not the bar): the same split by faulted / unfaulted, and steps and
 *    cost per verified task (null cost is unknown, never 0).
 */
import { ARM_CONFIG, type RecoveryArm, type RecoveryTrialRecord } from "./trial.ts";

export const RECOVERY_ROW_SCHEMA = "myco.recovery.arm-row/1" as const;
export const RECOVERY_TASKSET_VERSION = "ms-long-v1" as const;
export const RECOVERY_CONTRAST = "K-vs-nothing" as const;
export const BAR_ALPHA = 0.05;
export const BAR_MIN_DISCORDANT = 5;

export type GraderVerdict = "pass" | "fail" | "ungradable";

export interface RecoveryRow {
  readonly schema: typeof RECOVERY_ROW_SCHEMA;
  readonly taskSetVersion: string;
  readonly contrast: typeof RECOVERY_CONTRAST;
  readonly evidence: "never-r1";
  readonly arm: RecoveryArm;
  readonly trialKey: string;
  readonly taskId: string;
  readonly faulted: boolean;
  readonly simulated: boolean;
  readonly plannerModelId: string;
  readonly gate: {
    readonly called: true;
    readonly verdict: RecoveryTrialRecord["verdict"];
    readonly corrections: "on" | "off";
  };
  readonly retryBudget: 0 | 1;
  readonly recoveryTools: boolean;
  readonly attempts: number;
  readonly stepBudget: number;
  readonly steps: number;
  readonly elapsedMs: number;
  readonly costUsd: number | null;
  /** The grader's verdict on the final captured document: the primary metric. */
  readonly grade: GraderVerdict;
}

export interface BatchTrial {
  readonly trialKey: string;
  readonly taskId: string;
  readonly faulted: boolean;
  readonly simulated: boolean;
  readonly plannerModelId: string;
  run(): Promise<RecoveryTrialRecord>;
  /** The independent grader on one attempt's captured document. */
  grade(attempt: 1 | 2): Promise<GraderVerdict>;
}

export type BatchResult =
  | {
      readonly status: "complete";
      readonly rows: readonly RecoveryRow[];
      readonly harnessAttempts: number;
    }
  | {
      readonly status: "halted";
      readonly halt: {
        readonly trialKey: string;
        readonly attempt: 1 | 2;
        readonly grade: GraderVerdict;
      };
      readonly rows: readonly RecoveryRow[];
      readonly harnessAttempts: number;
    };

async function safeGrade(trial: BatchTrial, attempt: 1 | 2): Promise<GraderVerdict> {
  try {
    const g = await trial.grade(attempt);
    return g === "pass" || g === "fail" || g === "ungradable" ? g : "ungradable";
  } catch {
    return "ungradable";
  }
}

export async function runRecoveryBatch(
  trials: readonly BatchTrial[],
  options: { readonly arm: RecoveryArm; readonly taskSetVersion?: string },
): Promise<BatchResult> {
  const rows: RecoveryRow[] = [];
  let harnessAttempts = 0;
  for (const trial of trials) {
    const record = await trial.run();
    if (record.arm !== options.arm)
      throw new Error(`trial ${trial.trialKey} ran arm ${record.arm}, batch is ${options.arm}`);
    harnessAttempts += record.attempts.length;
    let finalGrade: GraderVerdict = "ungradable";
    for (const a of record.attempts) {
      const isFinal = a === record.attempts[record.attempts.length - 1];
      if (!a.accepted && !isFinal) continue;
      const grade = await safeGrade(trial, a.attempt);
      if (a.accepted && grade !== "pass")
        return {
          status: "halted",
          halt: { trialKey: trial.trialKey, attempt: a.attempt, grade },
          rows,
          harnessAttempts,
        };
      if (isFinal) finalGrade = grade;
    }
    rows.push({
      schema: RECOVERY_ROW_SCHEMA,
      taskSetVersion: options.taskSetVersion ?? RECOVERY_TASKSET_VERSION,
      contrast: RECOVERY_CONTRAST,
      evidence: "never-r1",
      arm: record.arm,
      trialKey: trial.trialKey,
      taskId: trial.taskId,
      faulted: trial.faulted,
      simulated: trial.simulated,
      plannerModelId: trial.plannerModelId,
      gate: { called: true, verdict: record.verdict, corrections: record.config.corrections },
      retryBudget: record.config.retryBudget,
      recoveryTools: record.config.recoveryTools,
      attempts: record.attempts.length,
      stepBudget: record.stepBudget,
      steps: record.steps,
      elapsedMs: record.elapsedMs,
      costUsd: record.costUsd,
      grade: finalGrade,
    });
  }
  return { status: "complete", rows, harnessAttempts };
}

/** Errors with a recovery pack; empty means it passes. */
export function checkRecoveryPack(
  rows: readonly RecoveryRow[],
  opts: { readonly harnessAttempts: number; readonly evidence?: boolean },
): string[] {
  const errors: string[] = [];
  const counted = rows.reduce((s, r) => s + r.attempts, 0);
  if (counted !== opts.harnessAttempts)
    errors.push(
      `attempt count ${counted} in the pack does not match the harness's ${opts.harnessAttempts}`,
    );
  const keys = new Set<string>();
  for (const r of rows) {
    if (keys.has(r.trialKey)) errors.push(`${r.trialKey}: duplicate trial`);
    keys.add(r.trialKey);
    if (r.schema !== RECOVERY_ROW_SCHEMA) errors.push(`${r.trialKey}: not a recovery row`);
    if (r.contrast !== RECOVERY_CONTRAST)
      errors.push(`${r.trialKey}: contrast must be ${RECOVERY_CONTRAST}`);
    const config = Object.hasOwn(ARM_CONFIG, r.arm) ? ARM_CONFIG[r.arm] : undefined;
    if (
      config === undefined ||
      r.gate?.corrections !== config.corrections ||
      r.retryBudget !== config.retryBudget ||
      r.recoveryTools !== config.recoveryTools
    )
      errors.push(`${r.trialKey}: arm ${String(r.arm)} does not match its arm config`);
    if (
      !Number.isInteger(r.attempts) ||
      r.attempts < 1 ||
      r.attempts > 1 + (config?.retryBudget ?? 0)
    )
      errors.push(`${r.trialKey}: ${String(r.attempts)} attempts is outside the arm's budget`);
    if (opts.evidence && r.simulated)
      errors.push(`${r.trialKey}: simulated rows are never evidence`);
  }
  return errors;
}

/** Exact one-sided McNemar: P(X >= kOnly) for X ~ Binomial(kOnly + noneOnly, 1/2). */
export function mcnemarExactOneSided(kOnly: number, noneOnly: number): number {
  const n = kOnly + noneOnly;
  if (n === 0) return 1;
  let p = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= n; i++) {
    if (i >= kOnly) p += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, p / 2 ** n);
}

export interface SplitCounts {
  readonly tasks: number;
  readonly kVerified: number;
  readonly noneVerified: number;
  readonly kOnly: number;
  readonly noneOnly: number;
}

export interface RecoveryBarResult {
  readonly passes: boolean;
  readonly p: number;
  readonly all: SplitCounts;
  readonly faulted: SplitCounts;
  readonly unfaulted: SplitCounts;
  readonly perVerified: Readonly<
    Record<RecoveryArm, { readonly steps: number | null; readonly costUsd: number | null }>
  >;
}

function split(pairs: readonly { k: RecoveryRow; none: RecoveryRow }[]): SplitCounts {
  const kv = (p: { k: RecoveryRow }) => p.k.grade === "pass";
  const nv = (p: { none: RecoveryRow }) => p.none.grade === "pass";
  return {
    tasks: pairs.length,
    kVerified: pairs.filter(kv).length,
    noneVerified: pairs.filter(nv).length,
    kOnly: pairs.filter((p) => kv(p) && !nv(p)).length,
    noneOnly: pairs.filter((p) => !kv(p) && nv(p)).length,
  };
}

function perVerified(rows: readonly RecoveryRow[]) {
  const verified = rows.filter((r) => r.grade === "pass").length;
  if (verified === 0) return { steps: null, costUsd: null };
  const steps = rows.reduce((s, r) => s + r.steps, 0) / verified;
  const costUsd = rows.some((r) => r.costUsd === null)
    ? null
    : rows.reduce((s, r) => s + (r.costUsd as number), 0) / verified;
  return { steps, costUsd };
}

/**
 * The pre-registered bar on two COMPLETE batches over the same tasks, one per arm. Throws
 * (refuses) on a halted batch, a failing pack, a task missing from either arm, a repeated
 * task, or simulated rows unless `simulated: true` (plumbing tests only).
 */
export function recoveryBar(
  k: BatchResult,
  none: BatchResult,
  opts: { readonly simulated?: boolean } = {},
): RecoveryBarResult {
  for (const [name, batch, arm] of [
    ["K", k, "K"],
    ["no-recovery", none, "no-recovery"],
  ] as const) {
    if (batch.status !== "complete")
      throw new Error(`the ${name} batch halted: a halted batch is reported, never summarized`);
    const errors = checkRecoveryPack(batch.rows, {
      harnessAttempts: batch.harnessAttempts,
      evidence: opts.simulated !== true,
    });
    if (errors.length > 0) throw new Error(`the ${name} pack is refused: ${errors[0]}`);
    if (batch.rows.some((r) => r.arm !== arm))
      throw new Error(`the ${name} batch holds rows of another arm`);
  }
  const byTask = (rows: readonly RecoveryRow[]) => {
    const m = new Map<string, RecoveryRow>();
    for (const r of rows) {
      if (m.has(r.taskId)) throw new Error(`task ${r.taskId} appears twice in one arm`);
      m.set(r.taskId, r);
    }
    return m;
  };
  const kRows = byTask(k.rows);
  const noneRows = byTask(none.rows);
  if (kRows.size !== noneRows.size || [...kRows.keys()].some((t) => !noneRows.has(t)))
    throw new Error("the arms do not cover the same tasks");
  const pairs = [...kRows.entries()].map(([t, row]) => ({
    k: row,
    none: noneRows.get(t) as RecoveryRow,
  }));
  for (const p of pairs)
    if (p.k.faulted !== p.none.faulted) throw new Error(`task ${p.k.taskId}: fault labels differ`);
  const all = split(pairs);
  const p = mcnemarExactOneSided(all.kOnly, all.noneOnly);
  return {
    passes: p <= BAR_ALPHA && all.kOnly + all.noneOnly >= BAR_MIN_DISCORDANT,
    p,
    all,
    faulted: split(pairs.filter((x) => x.k.faulted)),
    unfaulted: split(pairs.filter((x) => !x.k.faulted)),
    perVerified: { K: perVerified(k.rows), "no-recovery": perVerified(none.rows) },
  };
}
