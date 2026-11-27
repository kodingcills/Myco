/**
 * Capability track K: the pre-registered analysis (`docs/product/capability-spec.md` §3,
 * "K. Recovery"). `scripts/k-recovery-analysis.ts` is the command line around it; this
 * module is I/O-free (file and git reads are injected).
 *
 * A pack is `myco.recovery.pack/1`: one arm's batch plus the pre-registration hash and the
 * commit it was frozen in (§3.2). The analysis REFUSES (throws, naming the problem) when:
 *  - the pre-registration fails `checkKPrereg`;
 *  - a pack's recorded hash is not the pre-registration's, or the pre-registration at the
 *    pack's recorded commit does not hash to it (§3.2: "the analysis refuses a pack whose
 *    hash does not match a committed pre-registration");
 *  - the pre-registration is a draft and the run is not plumbing: a draft never analyses
 *    evidence (§3.1, frozen before measurement);
 *  - a row disagrees with the pre-registration: task set version, step budget; and for
 *    evidence, the model id, the task count and the faulted-task count.
 * A halted batch is REPORTED (status `halted`, with the trial and attempt), never summarized
 * (spec: "the pack is reported as halted with that trial"). Otherwise the bar is
 * `recoveryBar` from `./batch.ts`, unchanged, with `evidence` false for plumbing.
 *
 * Before any decision it calls the shared capability-analysis guard
 * (`src/capability/analysis-guard.ts`, #652): a pack hash mismatch is refused, and the
 * verdict is never "shown" while the pre-registration's `pending` list is non-empty
 * (`LEAD_RULING_PENDING`, exit code 3 from the command line) or any row's `simulated` is
 * anything but absent or `false`.
 */

import { guardCapabilityAnalysis, guardedVerdict } from "../capability/analysis-guard.ts";
import {
  type BatchResult,
  type RecoveryBarResult,
  type RecoveryRow,
  recoveryBar,
} from "./batch.ts";
import { checkKPrereg, type KPrereg, type PreregFiles } from "./prereg.ts";
import type { RecoveryArm } from "./trial.ts";

export const RECOVERY_PACK_SCHEMA = "myco.recovery.pack/1" as const;
const COMMIT = /^[0-9a-f]{40}$/;

export interface RecoveryPack {
  readonly schema: typeof RECOVERY_PACK_SCHEMA;
  readonly arm: RecoveryArm;
  readonly preregistrationHash: string;
  /** The commit the pre-registration was frozen in (40-hex). */
  readonly preregCommit: string;
  readonly batch: BatchResult;
}

export interface AnalysisInputs {
  readonly prereg: unknown;
  readonly files: PreregFiles;
  /** The pre-registration hash of `prereg.json` as committed at `commit`, or null if absent. */
  committedPreregHash(commit: string): string | null;
  readonly k: RecoveryPack;
  readonly none: RecoveryPack;
  /** Plumbing run: simulated rows allowed, a draft pre-registration allowed, never evidence. */
  readonly plumbing?: boolean;
}

export type AnalysisResult =
  | {
      readonly status: "analyzed";
      readonly preregistrationHash: string;
      readonly frozen: boolean;
      readonly evidence: boolean;
      /**
       * "shown" only when the shared guard (#652) allows it (nothing pending, no simulated
       * row), the bar is evidence and it passes. Never "shown" in a plumbing run.
       */
      readonly verdict: "shown" | "not-shown";
      /** The guard's LEAD_RULING_PENDING / SIMULATED reasons; empty only when shown. */
      readonly reasons: readonly string[];
      /** 3 when a lead ruling is pending (computed, never shown), else 0. */
      readonly exitCode: number;
      readonly bar: RecoveryBarResult;
    }
  | {
      readonly status: "halted";
      readonly preregistrationHash: string;
      readonly arm: RecoveryArm;
      readonly halt: Extract<BatchResult, { status: "halted" }>["halt"];
    };

export function analyzeRecoveryPacks(inputs: AnalysisInputs): AnalysisResult {
  const plumbing = inputs.plumbing === true;
  const check = checkKPrereg(inputs.prereg, inputs.files);
  if (check.problems.length > 0 || check.hash === null)
    throw new Error(`the pre-registration is refused: ${check.problems.join("; ")}`);
  const prereg = inputs.prereg as KPrereg;
  const hash = check.hash;
  if (!check.frozen && !plumbing)
    throw new Error(
      `the pre-registration is a draft (pending: ${prereg.pending.map((x) => x.field).join(", ")}); a draft never analyses evidence (LEAD_RULING_PENDING)`,
    );

  for (const [arm, pack] of [
    ["K", inputs.k],
    ["no-recovery", inputs.none],
  ] as const) {
    if (pack?.schema !== RECOVERY_PACK_SCHEMA)
      throw new Error(`the ${arm} pack is not a recovery pack`);
    if (pack.arm !== arm) throw new Error(`the ${arm} pack is labelled ${String(pack.arm)}`);
    if (pack.preregistrationHash !== hash)
      throw new Error(`the ${arm} pack records another pre-registration hash`);
    if (!COMMIT.test(String(pack.preregCommit)))
      throw new Error(`the ${arm} pack does not record the pre-registration's commit`);
    if (inputs.committedPreregHash(pack.preregCommit) !== hash)
      throw new Error(
        `the ${arm} pack's commit does not hold this pre-registration (a pack must be run against a committed pre-registration)`,
      );
  }

  // The shared guard (#652), before any decision: the hash rule refuses; pending rulings and
  // simulated rows block "shown".
  const guard = guardCapabilityAnalysis({
    prereg: inputs.prereg,
    preregHash: hash,
    packs: [inputs.k, inputs.none].map((pack) => ({
      recordedHash: pack.preregistrationHash,
      committedHash: inputs.committedPreregHash(pack.preregCommit),
    })),
    rows: [inputs.k, inputs.none].flatMap((pack) =>
      pack.batch.status === "complete" ? pack.batch.rows : [],
    ),
  });
  if (guard.refused) throw new Error(`refused: ${guard.reasons.join("; ")}`);

  for (const [arm, pack] of [
    ["K", inputs.k],
    ["no-recovery", inputs.none],
  ] as const) {
    if (pack.batch.status === "halted")
      return { status: "halted", preregistrationHash: hash, arm, halt: pack.batch.halt };
    const rows: readonly RecoveryRow[] = pack.batch.rows;
    const bad = (why: string) =>
      new Error(`the ${arm} pack disagrees with the pre-registration: ${why}`);
    if (rows.some((r) => r.taskSetVersion !== prereg.taskSet.version))
      throw bad(`a row's task set is not ${prereg.taskSet.version}`);
    if (rows.some((r) => r.stepBudget !== prereg.stepBudget))
      throw bad(`a row's step budget is not ${prereg.stepBudget}`);
    if (!plumbing) {
      if (rows.some((r) => r.plannerModelId !== prereg.modelId))
        throw bad(`a row's planner is not ${prereg.modelId}`);
      if (rows.length !== prereg.taskSet.size)
        throw bad(`${rows.length} rows, pre-registered at ${prereg.taskSet.size} tasks`);
      const faulted = rows.filter((r) => r.faulted).length;
      if (faulted !== prereg.taskSet.faultedTasks)
        throw bad(`${faulted} faulted tasks, pre-registered at ${prereg.taskSet.faultedTasks}`);
    }
  }

  const bar = recoveryBar(inputs.k.batch, inputs.none.batch, { simulated: plumbing });
  return {
    status: "analyzed",
    preregistrationHash: hash,
    frozen: check.frozen,
    // False for plumbing (`simulated: true` above); a draft never reaches here without it.
    evidence: bar.evidence,
    verdict: guardedVerdict(guard, bar.evidence && bar.passes),
    reasons: [
      ...guard.reasons,
      ...(bar.evidence ? [] : ["PLUMBING: never evidence"]),
      ...(bar.passes ? [] : ["BAR_NOT_SHOWN"]),
    ],
    exitCode: guard.exitCode,
    bar,
  };
}

/**
 * The command line's exit code for a result: 0 analyzed (shown or not) or halted (reported),
 * 3 analyzed while a lead ruling is pending (never shown). A refusal throws (exit 1).
 */
export function analysisExitCode(result: AnalysisResult): number {
  return result.status === "analyzed" ? result.exitCode : 0;
}
