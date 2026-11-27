/**
 * Capability track K: the pre-registered analysis (`docs/product/capability-spec.md` §3,
 * "K. Recovery"). `scripts/k-recovery-analysis.ts` is the command line around it; this
 * module is I/O-free (file and git reads are injected).
 *
 * A pack is `myco.recovery.pack/1`: one arm's batch plus the pre-registration hash and the
 * commit it was frozen in (§3.2). The analysis REFUSES (throws, naming the problem) when:
 *  - the pre-registration fails `checkKPrereg`;
 *  - a pack's recorded hash is not the pre-registration's, or the pack's recorded commit is
 *    not on main, or the pre-registration at that commit does not hash to it (§3.1 "one
 *    commit on main"; §3.2 "the analysis refuses a pack whose hash does not match a committed
 *    pre-registration"; #652 rule 3);
 *  - the pre-registration is a draft and the run is not plumbing: a draft never analyses
 *    evidence (§3.1, frozen before measurement);
 *  - a row is simulated under evidence, or real under plumbing (#652 rule 2: a row is real
 *    only when its `simulated` member is absent or exactly `false`; any other value is
 *    simulated). Plumbing never analyses real rows, so a draft cannot be used to peek at data;
 *  - a complete batch holds a gate miss (a `verified` verdict the grader did not grade
 *    `pass`): the run should have halted on it (spec K guardrail);
 *  - a row disagrees with the pre-registration: task set version, step budget; and for
 *    evidence, the model id, the task count and the faulted-task count.
 * A halted batch is REPORTED (status `halted`, with the trial and attempt), never summarized
 * (spec: "the pack is reported as halted with that trial").
 *
 * ## Shown or not shown
 *
 * `shown` is true only when the bar passes AND the run is evidence AND the pre-registration
 * is frozen AND it is confirmatory AND no lead ruling is pending (#652 rule 1). Otherwise
 * `shown` is false, `bar.passes` is false, and `notShown` lists every reason as a code:
 * `PLUMBING`, `DRAFT`, `LEAD_RULING_PENDING`, `EXPLORATORY`, `UNDERPOWERED`, `P_ABOVE_ALPHA`.
 * The statistics (`p`, the discordant counts) are reported unchanged. The command line exits
 * non-zero on `LEAD_RULING_PENDING`.
 */
import {
  BAR_ALPHA,
  BAR_MIN_DISCORDANT,
  type BatchResult,
  type RecoveryBarResult,
  type RecoveryRow,
  recoveryBar,
} from "./batch.ts";
import { checkKPrereg, type KPrereg, leadRulingsPending, type PreregFiles } from "./prereg.ts";
import type { RecoveryArm } from "./trial.ts";

export const RECOVERY_PACK_SCHEMA = "myco.recovery.pack/1" as const;
const COMMIT = /^[0-9a-f]{40}$/;

export const NOT_SHOWN_CODES = [
  "PLUMBING",
  "DRAFT",
  "LEAD_RULING_PENDING",
  "EXPLORATORY",
  "UNDERPOWERED",
  "P_ABOVE_ALPHA",
] as const;
export type NotShownCode = (typeof NOT_SHOWN_CODES)[number];

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
  /** Whether `commit` is on main (§3.1: "one commit on `main`"). */
  commitOnMain(commit: string): boolean;
  readonly k: RecoveryPack;
  readonly none: RecoveryPack;
  /** Plumbing run: simulated rows only, a draft pre-registration allowed, never evidence. */
  readonly plumbing?: boolean;
}

export type AnalysisResult =
  | {
      readonly status: "analyzed";
      readonly preregistrationHash: string;
      readonly frozen: boolean;
      readonly evidence: boolean;
      readonly designation: KPrereg["designation"];
      readonly shown: boolean;
      readonly notShown: readonly NotShownCode[];
      readonly leadRulingsPending: readonly string[];
      readonly bar: RecoveryBarResult;
    }
  | {
      readonly status: "halted";
      readonly preregistrationHash: string;
      readonly frozen: boolean;
      readonly evidence: boolean;
      readonly shown: false;
      readonly arm: RecoveryArm;
      readonly halt: Extract<BatchResult, { status: "halted" }>["halt"];
    };

/** The command line's exit code for a result: 1 while a lead ruling is pending (#652), else 0. */
export function analysisExitCode(result: AnalysisResult): 0 | 1 {
  return result.status === "analyzed" && result.notShown.includes("LEAD_RULING_PENDING") ? 1 : 0;
}

/** #652 rule 2: a row is real only when `simulated` is absent or exactly `false`. */
export function isSimulatedRow(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return true;
  return Object.hasOwn(row, "simulated") && (row as { simulated: unknown }).simulated !== false;
}

export function analyzeRecoveryPacks(inputs: AnalysisInputs): AnalysisResult {
  const plumbing = inputs.plumbing === true;
  const check = checkKPrereg(inputs.prereg, inputs.files);
  if (check.problems.length > 0 || check.hash === null)
    throw new Error(`the pre-registration is refused: ${check.problems.join("; ")}`);
  const prereg = inputs.prereg as KPrereg;
  const hash = check.hash;
  if (!check.frozen && !plumbing)
    throw new Error(
      `the pre-registration is a draft (pending: ${prereg.pending.map((x) => x.field).join(", ")}); a draft never analyses evidence`,
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
    if (inputs.commitOnMain(pack.preregCommit) !== true)
      throw new Error(
        `the ${arm} pack's commit is not on main (a pre-registration is frozen in one commit on main)`,
      );
    if (inputs.committedPreregHash(pack.preregCommit) !== hash)
      throw new Error(
        `the ${arm} pack's commit does not hold this pre-registration (a pack must be run against a committed pre-registration)`,
      );
  }

  for (const [arm, pack] of [
    ["K", inputs.k],
    ["no-recovery", inputs.none],
  ] as const) {
    if (pack.batch.status === "halted")
      return {
        status: "halted",
        preregistrationHash: hash,
        frozen: check.frozen,
        evidence: false,
        shown: false,
        arm,
        halt: pack.batch.halt,
      };
    const rows: readonly RecoveryRow[] = pack.batch.rows;
    const bad = (why: string) =>
      new Error(`the ${arm} pack disagrees with the pre-registration: ${why}`);
    if (plumbing && rows.some((r) => !isSimulatedRow(r)))
      throw new Error(
        `the ${arm} pack holds a real row: plumbing analyses simulated rows only (simulated: true)`,
      );
    if (!plumbing && rows.some((r) => isSimulatedRow(r)))
      throw new Error(`the ${arm} pack holds a simulated row: simulated rows are never evidence`);
    const miss = rows.find((r) => r.gate?.verdict === "verified" && r.grade !== "pass");
    if (miss !== undefined)
      throw new Error(
        `the ${arm} pack holds a gate miss (${miss.trialKey}: verified, graded ${String(miss.grade)}): the run must halt on it, so the pack is refused`,
      );
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
  const open = leadRulingsPending(inputs.prereg);
  const notShown: NotShownCode[] = [];
  if (plumbing || !bar.evidence) notShown.push("PLUMBING");
  if (!check.frozen) notShown.push("DRAFT");
  if (open.length > 0) notShown.push("LEAD_RULING_PENDING");
  if (prereg.designation !== "confirmatory") notShown.push("EXPLORATORY");
  if (bar.all.kOnly + bar.all.noneOnly < BAR_MIN_DISCORDANT) notShown.push("UNDERPOWERED");
  if (!(bar.p <= BAR_ALPHA)) notShown.push("P_ABOVE_ALPHA");
  const shown = notShown.length === 0 && bar.passes === true;
  return {
    status: "analyzed",
    preregistrationHash: hash,
    frozen: check.frozen,
    // False for plumbing (`simulated: true` above); a draft never reaches here without it.
    evidence: bar.evidence,
    designation: prereg.designation,
    shown,
    notShown,
    leadRulingsPending: open,
    bar: { ...bar, passes: shown },
  };
}
