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
 *  - both arms' rows are GATED rows (spec §1.1): a verified task is a done claim that the gate
 *    verified (after the harness's checks) AND the grader graded `pass` (`isVerifiedRow`).
 *    A grader `pass` that the gate refuted or left uncertain, that the harness failed closed,
 *    or that had no done claim, is reported as "correct, not verified" and never counted.
 *  - `checkRecoveryPack` refuses a pack whose attempt count is not the harness's, whose arm
 *    config is not the arm's, whose contrast is not K-vs-nothing, whose rows disagree with
 *    themselves (accepted vs verdict vs harness codes), whose planner, step budget or task
 *    set is mixed, or (evidence) any row that is simulated or whose planner is not one of
 *    `RECOVERY_EVIDENCE_PLANNERS`.
 *  - `recoveryBar`: exact one-sided McNemar, K better than no-recovery, p <= 0.05 with at
 *    least 5 discordant tasks, on verified tasks. It refuses arms that differ in planner,
 *    step budget, task set, or a task's instruction or fixture hash (spec §1.3 parity).
 *    Secondary (reported, not the bar): the same split by faulted / unfaulted, and steps and
 *    cost per verified task (null cost is unknown, never 0).
 */
import {
  ARM_CONFIG,
  HARNESS_CODES,
  type HarnessCode,
  type RecoveryArm,
  type RecoveryTrialRecord,
} from "./trial.ts";

export const RECOVERY_ROW_SCHEMA = "myco.recovery.arm-row/1" as const;
export const RECOVERY_TASKSET_VERSION = "ms-long-v1" as const;
export const RECOVERY_CONTRAST = "K-vs-nothing" as const;
export const BAR_ALPHA = 0.05;
export const BAR_MIN_DISCORDANT = 5;

export type GraderVerdict = "pass" | "fail" | "ungradable";

/**
 * Planners whose rows may be evidence: a mirror of `EVIDENCE_PLANNERS` in
 * `src/benchmark/check.ts`, which this module cannot import (it reaches the published task
 * manifests; spec §1.2.4). `test/recovery/boundary.test.ts` pins the two sets equal.
 */
export const RECOVERY_EVIDENCE_PLANNERS: ReadonlySet<string> = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
]);

/** The final attempt's claim, as the repo's gated rows record it. */
export type RecoveryClaim = "done" | "not-done" | "no-claim";
const CLAIMS: readonly string[] = ["done", "not-done", "no-claim"];
const SHA256 = /^[0-9a-f]{64}$/;

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
  readonly instructionSha256: string;
  readonly fixtureSha256: string;
  /** The final attempt's claim: `done` only when the agent's claim was exactly "done". */
  readonly claim: RecoveryClaim;
  readonly gate: {
    readonly called: true;
    /** The final attempt's verdict AFTER the harness's checks (`uncertain` when it failed closed). */
    readonly verdict: RecoveryTrialRecord["verdict"];
    readonly corrections: "on" | "off";
  };
  /** The final attempt was accepted: the gate verified it and the harness's checks passed. */
  readonly accepted: boolean;
  /** The final attempt's harness codes (empty unless it failed closed or faulted). */
  readonly harnessCodes: readonly HarnessCode[];
  readonly retryBudget: 0 | 1;
  readonly recoveryTools: boolean;
  readonly attempts: number;
  readonly stepBudget: number;
  readonly steps: number;
  readonly elapsedMs: number;
  readonly costUsd: number | null;
  /**
   * The grader's verdict on the final captured document. NOT the primary metric on its own:
   * a task is verified only under `isVerifiedRow`.
   */
  readonly grade: GraderVerdict;
}

/**
 * A verified task on a gated row (spec §1.1): a done claim, accepted (the gate's `verified`,
 * after the harness's checks, no harness code), and the grader's `pass`. Everything else, an
 * uncertain, refuted, fail-closed or harness-faulted attempt, or no done claim, is not
 * verified, whatever the grader said.
 */
export function isVerifiedRow(r: RecoveryRow): boolean {
  return (
    r.claim === "done" &&
    r.accepted === true &&
    r.gate?.verdict === "verified" &&
    Array.isArray(r.harnessCodes) &&
    r.harnessCodes.length === 0 &&
    r.grade === "pass"
  );
}

export interface BatchTrial {
  readonly trialKey: string;
  readonly taskId: string;
  readonly faulted: boolean;
  readonly simulated: boolean;
  readonly plannerModelId: string;
  /** sha256 of the instruction text the agent got (parity across arms, spec §1.3). */
  readonly instructionSha256: string;
  /** sha256 of the pristine fixture (parity across arms, spec §1.3). */
  readonly fixtureSha256: string;
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
    const last = record.attempts[record.attempts.length - 1];
    const claim: RecoveryClaim =
      last === undefined || last.claim === null || last.claim === ""
        ? "no-claim"
        : last.claim === "done"
          ? "done"
          : "not-done";
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
      instructionSha256: trial.instructionSha256,
      fixtureSha256: trial.fixtureSha256,
      claim,
      gate: { called: true, verdict: record.verdict, corrections: record.config.corrections },
      accepted: record.accepted,
      harnessCodes: [...(last?.harnessCodes ?? [])],
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
  // Parity within the arm (spec §1.3): one planner, one step budget, one task set.
  for (const [field, label] of [
    ["plannerModelId", "planners"],
    ["stepBudget", "step budgets"],
    ["taskSetVersion", "task sets"],
  ] as const) {
    const values = new Set(rows.map((r) => r[field]));
    if (values.size > 1) errors.push(`mixed ${label} in one arm: ${[...values].join(", ")}`);
  }
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
    // The row must agree with itself, so a hand-edited row cannot claim a verified task.
    const codes: unknown = r.harnessCodes;
    const codesOk =
      Array.isArray(codes) && codes.every((c) => (HARNESS_CODES as readonly unknown[]).includes(c));
    if (!codesOk) errors.push(`${r.trialKey}: harness codes are not a list of known codes`);
    if (r.accepted !== true && r.accepted !== false)
      errors.push(`${r.trialKey}: accepted is not a boolean`);
    if (r.accepted === true && (r.gate?.verdict !== "verified" || !codesOk || codes.length > 0))
      errors.push(`${r.trialKey}: accepted, but the verdict is not a clean verified`);
    if (codesOk && codes.length > 0 && r.gate?.verdict !== "uncertain")
      errors.push(`${r.trialKey}: failed closed, but the verdict is not uncertain`);
    if (!CLAIMS.includes(r.claim)) errors.push(`${r.trialKey}: unknown claim`);
    if (!SHA256.test(String(r.instructionSha256)) || !SHA256.test(String(r.fixtureSha256)))
      errors.push(`${r.trialKey}: instruction and fixture hashes must be sha256 hex`);
    if (opts.evidence) {
      if (r.simulated !== false) errors.push(`${r.trialKey}: simulated rows are never evidence`);
      if (!RECOVERY_EVIDENCE_PLANNERS.has(r.plannerModelId))
        errors.push(
          `${r.trialKey}: planner ${JSON.stringify(r.plannerModelId)} is not a model id; never evidence`,
        );
    }
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
  /** Grader `pass` that is not a verified task ("correct, not verified"): reported, never counted. */
  readonly kCorrectNotVerified: number;
  readonly noneCorrectNotVerified: number;
}

export interface RecoveryBarResult {
  /**
   * True only when every row passed the evidence check. A `simulated: true` (plumbing) bar
   * is `false` here and is never evidence, whatever `passes` says.
   */
  readonly evidence: boolean;
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
  const kv = (p: { k: RecoveryRow }) => isVerifiedRow(p.k);
  const nv = (p: { none: RecoveryRow }) => isVerifiedRow(p.none);
  return {
    tasks: pairs.length,
    kVerified: pairs.filter(kv).length,
    noneVerified: pairs.filter(nv).length,
    kOnly: pairs.filter((p) => kv(p) && !nv(p)).length,
    noneOnly: pairs.filter((p) => !kv(p) && nv(p)).length,
    kCorrectNotVerified: pairs.filter((p) => p.k.grade === "pass" && !kv(p)).length,
    noneCorrectNotVerified: pairs.filter((p) => p.none.grade === "pass" && !nv(p)).length,
  };
}

function perVerified(rows: readonly RecoveryRow[]) {
  const verified = rows.filter(isVerifiedRow).length;
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
  // Parity between the arms (spec §1.3): same planner, step budget and task set; for each
  // task, the same fault label, instruction and fixture. A mismatch refuses the bar.
  const [k0, n0] = [k.rows[0], none.rows[0]];
  if (k0 !== undefined && n0 !== undefined) {
    if (k0.plannerModelId !== n0.plannerModelId)
      throw new Error("parity: the arms ran different planners");
    if (k0.stepBudget !== n0.stepBudget)
      throw new Error("parity: the arms had different step budgets");
    if (k0.taskSetVersion !== n0.taskSetVersion)
      throw new Error("parity: the arms ran different task sets");
  }
  for (const p of pairs) {
    if (p.k.faulted !== p.none.faulted) throw new Error(`task ${p.k.taskId}: fault labels differ`);
    if (p.k.instructionSha256 !== p.none.instructionSha256)
      throw new Error(`parity: task ${p.k.taskId}: instructions differ`);
    if (p.k.fixtureSha256 !== p.none.fixtureSha256)
      throw new Error(`parity: task ${p.k.taskId}: fixtures differ`);
  }
  const all = split(pairs);
  const p = mcnemarExactOneSided(all.kOnly, all.noneOnly);
  return {
    evidence: opts.simulated !== true,
    passes: p <= BAR_ALPHA && all.kOnly + all.noneOnly >= BAR_MIN_DISCORDANT,
    p,
    all,
    faulted: split(pairs.filter((x) => x.k.faulted)),
    unfaulted: split(pairs.filter((x) => !x.k.faulted)),
    perVerified: { K: perVerified(k.rows), "no-recovery": perVerified(none.rows) },
  };
}
