/**
 * TIF-58 EF-005 — paired arm comparison with the exact sign test.
 *
 * EF-005's acceptance requires two arms reported as a **paired per-trial table**, never as two
 * independent rates, and requires the "underpowered" statement when the arms do not disagree
 * enough to support any claim. `stats.ts` gives the intervals; this module does the pairing.
 *
 * The rule it enforces, from contract §6.1: at n = 30 a two-sided sign test needs 21
 * discordant trials all one way. A unanimous 6 gives p = 0.031; 5 of 5 gives 0.0625 and
 * proves nothing. Six scattered discordant trials out of 30 prove nothing either. The module
 * refuses to report a winner outside those bounds — which is the point, because a comparison
 * that always produces a winner is not a comparison.
 */

import { clopperPearson, type Interval } from "../stats.ts";

export interface PairedTrial {
  /** A stable trial key, e.g. the fixture id plus seed, used to pair the arms. */
  readonly key: string;
  /** Whether each arm's run verified on this trial. `null` = excluded (uncertain or void). */
  readonly leftVerified: boolean | null;
  readonly rightVerified: boolean | null;
}

export type Discordance = "left-only" | "right-only" | "both" | "neither";

export interface PairedRow {
  readonly key: string;
  readonly discordance: Discordance;
}

export interface PairedComparison {
  readonly rows: readonly PairedRow[];
  /** Trials where both arms produced a verdict; the only trials that carry information. */
  readonly paired: number;
  readonly excluded: number;
  readonly leftOnly: number;
  readonly rightOnly: number;
  /** Both arms verified on the same trial. */
  readonly both: number;
  readonly neither: number;
  /** Two-sided exact sign test p-value over the discordant trials. */
  readonly p: number;
  /** The smallest p reachable at this discordance; equal to `p` when the split is unanimous. */
  readonly unanimous: boolean;
  readonly verdict: "left" | "right" | "tie" | "underpowered";
  readonly leftRate: { readonly rate: number; readonly interval: Interval };
  readonly rightRate: { readonly rate: number; readonly interval: Interval };
  readonly statement: string;
}

/**
 * Exact two-sided sign test over discordant pairs: p = 2 * P(X <= min(a, b) | n, 0.5),
 * capped at 1. With `a` left-only and `b` right-only discordant trials, ties contribute
 * nothing — which is why a comparison where both arms agree is uninformative, not neutral.
 */
export function signTest(leftOnly: number, rightOnly: number): number {
  const n = leftOnly + rightOnly;
  if (n === 0) return 1;
  const k = Math.min(leftOnly, rightOnly);
  let tail = 0;
  let coefficient = 1;
  for (let i = 0; i <= k; i++) {
    // C(n, i) / 2^n, accumulated without factorials.
    tail += coefficient;
    coefficient = (coefficient * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Pair two arms' per-trial outcomes. A trial missing either arm's verdict is excluded. */
export function compareArms(
  trials: readonly PairedTrial[],
  labels: { readonly left: string; readonly right: string },
): PairedComparison {
  const keys = new Set<string>();
  for (const trial of trials) {
    if (keys.has(trial.key)) throw new Error(`duplicate trial key ${trial.key}`);
    keys.add(trial.key);
  }

  const rows: PairedRow[] = [];
  let leftOnly = 0;
  let rightOnly = 0;
  let both = 0;
  let neither = 0;
  let excluded = 0;
  for (const trial of trials) {
    const { leftVerified: l, rightVerified: r } = trial;
    if (l === null || r === null) {
      excluded += 1;
      continue;
    }
    if (l && r) {
      both += 1;
      rows.push({ key: trial.key, discordance: "both" });
    } else if (!l && !r) {
      neither += 1;
      rows.push({ key: trial.key, discordance: "neither" });
    } else if (l) {
      leftOnly += 1;
      rows.push({ key: trial.key, discordance: "left-only" });
    } else {
      rightOnly += 1;
      rows.push({ key: trial.key, discordance: "right-only" });
    }
  }

  const paired = both + neither + leftOnly + rightOnly;
  const p = signTest(leftOnly, rightOnly);
  const unanimous = leftOnly === 0 || rightOnly === 0;
  const leftRate = rate(leftOnly + both, paired);
  const rightRate = rate(rightOnly + both, paired);

  return {
    rows,
    paired,
    excluded,
    leftOnly,
    rightOnly,
    both,
    neither,
    p,
    unanimous,
    verdict: decide(p, paired, leftOnly, rightOnly),
    leftRate,
    rightRate,
    statement: explain({ labels, p, paired, leftOnly, rightOnly, unanimous }),
  };
}

function rate(successes: number, trials: number) {
  return {
    rate: trials === 0 ? 0 : successes / trials,
    interval: clopperPearson(successes, trials),
  };
}

function decide(
  p: number,
  paired: number,
  leftOnly: number,
  rightOnly: number,
): PairedComparison["verdict"] {
  if (paired === 0) return "underpowered";
  if (p >= 0.05) return "underpowered";
  return leftOnly > rightOnly ? "left" : "right";
}

function explain(input: {
  labels: { left: string; right: string };
  p: number;
  paired: number;
  leftOnly: number;
  rightOnly: number;
  unanimous: boolean;
}): string {
  const { labels, p, paired, leftOnly, rightOnly, unanimous } = input;
  if (paired === 0) return "no paired trials: nothing can be concluded";
  if (p >= 0.05) {
    const discordant = leftOnly + rightOnly;
    return (
      `underpowered at n=${paired}: ${discordant} discordant trial(s) ` +
      `(${labels.left} ${leftOnly}, ${labels.right} ${rightOnly}), sign test p=${p.toFixed(3)}. ` +
      "No winner is claimed."
    );
  }
  const winner = leftOnly > rightOnly ? labels.left : labels.right;
  return (
    `${winner} wins on the paired outcome: ${Math.max(leftOnly, rightOnly)} of ` +
    `${leftOnly + rightOnly} discordant trials, sign test p=${p.toFixed(3)}` +
    `${unanimous ? " (unanimous)" : ""}, over ${paired} paired trials.`
  );
}
