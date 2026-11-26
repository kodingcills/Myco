/**
 * The corrections ON/OFF A/B, analysed under the independent grader (TIF-274 / TIF-265 track B;
 * pre-registered in the M2 plan, #526 §7.2.1). It compares the gate with the agent-safe
 * corrections (#514) ON against the same gate with them OFF, on paired tasks.
 *
 * Pre-registered rules, as code (change them here and the tests fail, by design):
 *  - **Stage 0, plumbing:** 30 pairs. Its only purpose is to show the paired pipeline works;
 *    NO effect claim is made, whatever the numbers say (`effect: "not-claimed"`).
 *  - **Stage 1, confirmatory:** the fc-v1 task set, 100 pairs (each arm exactly fc-v1, bound
 *    by `src/benchmark/taskset-binding.ts`). Test: a ONE-SIDED exact sign test on the
 *    discordant pairs (H1: ON succeeds more often), alpha 0.05, with a 95% confidence interval
 *    on the paired difference (Newcombe 1998, method 10: the hybrid score interval for paired
 *    proportions). Concordant pairs carry no weight in the test and are still reported.
 *  - **Gates:** any false DONE accepted in either arm (an accepted DONE the grader does not
 *    pass) is an INTEGRITY INCIDENT: the run halts and is reported, never counted as data.
 *
 * Success is a verified task: an accepted DONE the independent grader passes. The grader never
 * sees corrections (its inputs are the bundle and the saved document); the gate's corrections
 * setting is read from each arm row (`gate.corrections`; absent means off).
 *
 * Pairs: the two arms are two runs with their own ledgers; one ON and one OFF myco-gate row per
 * (taskId, fixtureSha256, faultClass), with the same instruction hash, planner and output
 * ceiling (the R2 pairing rule).
 */
import {
  type BenchmarkArmRow,
  checkBenchmark,
  EVIDENCE_PLANNERS,
  type Rate,
} from "../benchmark/check.ts";
import type { BenchmarkGradeRow } from "../benchmark/grade/row.ts";
import { bindToTaskSet } from "../benchmark/taskset-binding.ts";
import { wilson } from "../foundry/stats.ts";

/** The pre-registered stages (#526 §7.2.1). */
export const AB_STAGES = {
  0: { pairs: 30, effectClaim: false },
  1: { pairs: 100, effectClaim: true },
} as const;
export type AbStage = keyof typeof AB_STAGES;
/** One-sided significance level for Stage 1. */
export const AB_ALPHA = 0.05;

export interface AbResult {
  /** True when the ledgers are consistent, the pairs are complete and no gate halted the run. */
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly stage: AbStage;
  /** True when a false DONE was accepted in either arm: an integrity incident, not data. */
  readonly halted: boolean;
  readonly pairs: number;
  /** Both arms verified / ON only / OFF only / neither. */
  readonly table: {
    readonly both: number;
    readonly onOnly: number;
    readonly offOnly: number;
    readonly neither: number;
  };
  readonly onSuccess: Rate;
  readonly offSuccess: Rate;
  /** False DONEs accepted per arm (accepted DONE the grader does not pass). Must be 0. */
  readonly falseDoneAccepted: { readonly on: number; readonly off: number };
  /** One-sided exact sign test on the discordant pairs (H1: ON better). 1 with none. */
  readonly signTestOneSidedP: number;
  /** ON success rate minus OFF success rate, with its Newcombe (method 10) 95% interval. */
  readonly difference: {
    readonly estimate: number | null;
    readonly ci95: readonly [number, number] | null;
  };
  /**
   * Stage 0: always `not-claimed`. Stage 1: `on-better` only when the run is ok and p < alpha;
   * otherwise `no-evidence-of-effect` (and `none` when the run is not ok).
   */
  readonly effect: "not-claimed" | "on-better" | "no-evidence-of-effect" | "none";
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(k, n - k); i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

/** One-sided exact sign test: P(X >= onOnly) for X ~ Binomial(onOnly + offOnly, 1/2). */
export function signTestOneSided(onOnly: number, offOnly: number): number {
  const n = onOnly + offOnly;
  if (n === 0) return 1;
  let p = 0;
  for (let i = onOnly; i <= n; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, p);
}

/**
 * Newcombe (1998) method 10: the 95% interval for a difference of paired proportions, built
 * from the Wilson intervals of the two margins and the phi correlation of the 2x2 table.
 * `a` both, `b` ON only, `c` OFF only, `d` neither. Null with no pairs.
 */
export function newcombePairedCi(
  a: number,
  b: number,
  c: number,
  d: number,
): readonly [number, number] | null {
  const n = a + b + c + d;
  if (n === 0) return null;
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const [l1, u1] = wilson(a + b, n) as readonly [number, number];
  const [l2, u2] = wilson(a + c, n) as readonly [number, number];
  const denom = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  const phi = denom === 0 ? 0 : (a * d - b * c) / denom;
  const delta = p1 - p2;
  const lower =
    delta -
    Math.sqrt(Math.max(0, (p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2));
  const upper =
    delta +
    Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2));
  return [Math.max(-1, lower), Math.min(1, upper)];
}

const corrections = (r: BenchmarkArmRow) => (r.gate?.corrections === "on" ? "on" : "off");
const pairKey = (r: BenchmarkArmRow) => `${r.taskId}|${r.fixtureSha256}|${r.faultClass}`;

/** One arm of the A/B: its own run's arm ledger and grade ledger. */
export interface AbArm {
  readonly arm: readonly unknown[];
  readonly grades: readonly unknown[];
}

/**
 * Analyse the A/B. The two arms are two runs, each with its own ledgers: ON rows cannot be
 * told from OFF rows by a field alone (an unregistrable or refused row never called the gate,
 * so it records no corrections setting), so the arm is the ledger it came from. Every row of
 * the ON ledger whose gate was called must say `corrections: "on"`, and no OFF row may.
 */
export function checkCorrectionsAb(
  input: { readonly on: AbArm; readonly off: AbArm },
  opts: { readonly stage: AbStage; readonly evidence?: boolean },
): AbResult {
  const { pairs: wantPairs, effectClaim } = AB_STAGES[opts.stage];
  const errors: string[] = [];

  const arms = (["on", "off"] as const).map((side) => {
    const name = side === "on" ? "ON" : "OFF";
    const rows = input[side].arm as readonly BenchmarkArmRow[];
    const unreg = rows.filter((r) => r.gate?.unregistrable === true).length;
    // The shared ledger check per arm: schema, the grade join, hashes, the split, and in
    // Stage 1 the exact fc-v1 binding (not run with `evidence`: it would refuse every
    // corrections-ON row, by its R1 rule).
    const shared = checkBenchmark(input[side].arm, input[side].grades, {
      expectTrials: { "myco-gate": wantPairs },
      expectUnregistrable: { "myco-gate": unreg },
      bindTaskSet: opts.stage === 1,
    });
    errors.push(...shared.errors.map((e) => `corrections-${name} ledger: ${e}`));
    if (opts.stage === 0 && rows.length > 0) {
      const binding = bindToTaskSet(rows, { exactMultiset: false });
      errors.push(...binding.errors.map((e) => `corrections-${name} task set: ${e}`));
    }
    if (rows.some((r) => r.arm !== "myco-gate"))
      errors.push(
        `corrections-${name}: the A/B compares the gate with itself, every row is myco-gate`,
      );
    const wrong = rows.filter((r) =>
      side === "on" ? r.gate?.called === true && corrections(r) !== "on" : corrections(r) === "on",
    );
    if (wrong.length > 0)
      errors.push(
        `corrections-${name}: ${wrong.length} row(s) ran with corrections ${side === "on" ? "off" : "on"} (${wrong[0]?.trialKey})`,
      );
    if (opts.evidence === true) {
      const unproven = rows.filter((r) => !EVIDENCE_PLANNERS.has(r.plannerModelId));
      if (unproven.length > 0)
        errors.push(
          `corrections-${name}: ${unproven.length} row(s) without evidence provenance: dry-run rows are never evidence`,
        );
    }
    const grades = new Map(
      (input[side].grades as readonly BenchmarkGradeRow[]).map((g) => [g.trialKey, g] as const),
    );
    const by = new Map<string, BenchmarkArmRow>();
    for (const r of rows) {
      if (by.has(pairKey(r))) errors.push(`corrections-${name}: two rows for task ${r.taskId}`);
      by.set(pairKey(r), r);
    }
    const verified = (r: BenchmarkArmRow) =>
      r.accepted && grades.get(r.trialKey)?.status === "pass";
    const falseDone = rows.filter(
      (r) => r.accepted && grades.get(r.trialKey)?.status !== "pass",
    ).length;
    return { by, verified, falseDone };
  });
  const [onArm, offArm] = arms as [(typeof arms)[number], (typeof arms)[number]];

  let both = 0;
  let onOnly = 0;
  let offOnly = 0;
  let neither = 0;
  let paired = 0;
  for (const [k, a] of onArm.by) {
    const b = offArm.by.get(k);
    if (b === undefined) {
      errors.push(`corrections-ON ${a.trialKey} has no OFF pair`);
      continue;
    }
    if (a.instructionSha256 !== b.instructionSha256)
      errors.push(`pair ${a.taskId}: the two arms were given different instructions`);
    if (a.plannerModelId !== b.plannerModelId || a.outputCeiling !== b.outputCeiling)
      errors.push(`pair ${a.taskId}: the two arms ran different model settings`);
    paired++;
    const x = onArm.verified(a);
    const y = offArm.verified(b);
    if (x && y) both++;
    else if (x) onOnly++;
    else if (y) offOnly++;
    else neither++;
  }
  for (const [k, b] of offArm.by)
    if (!onArm.by.has(k)) errors.push(`corrections-OFF ${b.trialKey} has no ON pair`);
  if (paired !== wantPairs)
    errors.push(`${paired} pairs, Stage ${opts.stage} is pre-registered at ${wantPairs}`);

  // The integrity gate: a false DONE accepted in either arm halts the run.
  const falseOn = onArm.falseDone;
  const falseOff = offArm.falseDone;
  const halted = falseOn > 0 || falseOff > 0;
  if (halted)
    errors.push(
      `INTEGRITY INCIDENT: false DONE accepted (corrections ON ${falseOn}, OFF ${falseOff}): the run halts and is reported, never counted`,
    );

  const p = signTestOneSided(onOnly, offOnly);
  const ok = errors.length === 0;
  const rate = (k: number, n: number): Rate => ({
    numerator: k,
    denominator: n,
    wilson95: wilson(k, n),
  });
  return {
    ok,
    errors,
    stage: opts.stage,
    halted,
    pairs: paired,
    table: { both, onOnly, offOnly, neither },
    onSuccess: rate(both + onOnly, paired),
    offSuccess: rate(both + offOnly, paired),
    falseDoneAccepted: { on: falseOn, off: falseOff },
    signTestOneSidedP: p,
    difference: {
      estimate: paired === 0 ? null : (onOnly - offOnly) / paired,
      ci95: newcombePairedCi(both, onOnly, offOnly, neither),
    },
    effect: !ok
      ? "none"
      : !effectClaim
        ? "not-claimed"
        : p < AB_ALPHA
          ? "on-better"
          : "no-evidence-of-effect",
  };
}
