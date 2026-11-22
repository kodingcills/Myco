/**
 * TIF-57 EF-004 — statistics for a Foundry score.
 *
 * Additive to M1-012/ADR-0007's evidence. A score report that says "0 false successes"
 * without an interval is not evidence; it is a number that would have been fetched by
 * almost any suite. This module computes the intervals the Foundry's own reporting
 * contract requires, from the trial counts, so no report can quietly omit them.
 *
 * All intervals are exact where exactness is affordable: Clopper–Pearson for a rate, and a
 * one-sided rule for "zero events in n" (1 − 0.05^(1/n)). Wilson is offered for comparison
 * because AndroidWorld reports Wilson 95% intervals and a reader may want to compare.
 *
 * Source for the thresholds: docs/research/benchmark-survey.md §7 (already on main), whose
 * §7.2 table is reproduced here as the `FALSE_SUCCESS_BOUNDS` constant so the contract and
 * the code cannot drift apart.
 */

export interface Interval {
  readonly low: number;
  readonly high: number;
}

/** Natural log of the binomial coefficient C(n, k), computed without factorials. */
function logChoose(n: number, k: number): number {
  const kk = Math.min(k, n - k);
  let sum = 0;
  for (let i = 0; i < kk; i++) sum += Math.log(n - i) - Math.log(i + 1);
  return sum;
}

/** P(X >= k) for X ~ Binomial(n, p). */
function binomialTail(n: number, k: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k <= n ? 1 : 0;
  let sum = 0;
  for (let i = k; i <= n; i++)
    sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p));
  return Math.min(1, sum);
}

/**
 * Bisection for a root of a monotone function. `increasing` says which way it moves, so the
 * lower bound (where the increasing tail crosses alpha/2) and the upper bound (the same
 * tail, decreasing) can share one implementation without a second predicate.
 */
function bisect(fn: (x: number) => number, increasing: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const value = fn(mid);
    const moveRight = increasing ? value < 0 : value > 0;
    if (moveRight) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Exact (Clopper–Pearson) interval for `successes` out of `trials` at 95%.
 * n = 0 yields [0, 1]: with no trials there is no information, and reporting a narrower
 * interval would be the statistical form of a false success.
 */
export function clopperPearson(successes: number, trials: number): Interval {
  if (trials <= 0) return { low: 0, high: 1 };
  const alpha = 0.05;
  // P(X >= k | p) is increasing in p. The lower bound is where it reaches alpha/2; the
  // upper bound is where P(X <= k) = 1 - P(X >= k+1) drops to alpha/2, which happens at
  // the same place P(X >= k+1) rises to 1 - alpha/2.
  const low =
    successes === 0 ? 0 : bisect((p) => binomialTail(trials, successes, p) - alpha / 2, true);
  const high =
    successes === trials
      ? 1
      : bisect((p) => binomialTail(trials, successes + 1, p) - (1 - alpha / 2), true);
  return { low, high };
}

/**
 * Wilson score interval, for comparison with AndroidWorld's reporting convention.
 * Returns a `[low, high]` tuple and throws on impossible counts, matching the shape
 * `oracles/report.ts` already exported — this module is the single implementation.
 */
export function wilson(successes: number, n: number): readonly [number, number] | null {
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    successes > n
  )
    throw new Error("Invalid counts");
  if (!n) return null;
  const z = 1.959963984540054;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/**
 * 95% upper bound on a false-success rate after observing ZERO in `trials`:
 * 1 − 0.05^(1/n). With n = 0 the bound is vacuous and reported as 1.
 *
 * For non-zero counts the exact upper bound is `clopperPearson(k, n).high`; this helper
 * exists because the suite's target state is zero and that case has a closed form worth
 * stating rather than bisecting.
 */
export function zeroEventUpperBound(trials: number): number {
  return trials <= 0 ? 1 : 1 - 0.05 ** (1 / trials);
}

/**
 * The trial counts below which a claim is weaker than it sounds. Reproduced from
 * docs/research/benchmark-survey.md §7.2 so a report can cite the table it is judged by.
 */
export const FALSE_SUCCESS_BOUNDS = [
  { trials: 10, upper95: 0.259 },
  { trials: 15, upper95: 0.181 },
  { trials: 30, upper95: 0.095 },
  { trials: 60, upper95: 0.049 },
  { trials: 100, upper95: 0.03 },
] as const;

/** The smallest corrupted-trial count that bounds a zero-cell below 10%. */
export const FALSE_SUCCESS_MIN_TRIALS = 30;

/** The smallest normal-trial count whose Clopper–Pearson lower bound clears 0.80 at 90% observed. */
export const RELIABILITY_MIN_TRIALS = 100;

export interface ScoreClaim {
  readonly trials: number;
  readonly verified: number;
  readonly reliability: number;
  readonly reliabilityInterval: Interval;
  readonly falseSuccesses: number;
  readonly falseSuccessUpper95: number;
  /** Sentences the report must print verbatim; empty means the claim is adequately powered. */
  readonly caveats: readonly string[];
}

/**
 * Turns counts into the claim the report may make, with the caveats it must carry.
 * This is deliberately opinionated: a suite that ran 10 trials gets a caveat telling the
 * reader the bound is 26%, not a pass/fail line.
 */
export function scoreClaim(trials: number, verified: number, falseSuccesses: number): ScoreClaim {
  const caveats: string[] = [];
  if (trials < RELIABILITY_MIN_TRIALS) {
    caveats.push(
      `underpowered: ${trials} normal trials give a 95% interval of ` +
        `[${clopperPearson(verified, trials).low.toFixed(3)}, ${clopperPearson(verified, trials).high.toFixed(3)}]; ` +
        `a CI lower bound of 0.80 at ~90% observed needs about ${RELIABILITY_MIN_TRIALS} trials`,
    );
  }
  if (falseSuccesses === 0 && trials < FALSE_SUCCESS_MIN_TRIALS) {
    caveats.push(
      `zero false successes in ${trials} trials bounds the true rate only below ` +
        `${(zeroEventUpperBound(trials) * 100).toFixed(1)}%; ${FALSE_SUCCESS_MIN_TRIALS} trials is the ` +
        "smallest count that bounds it below 10%",
    );
  }
  return {
    trials,
    verified,
    reliability: trials === 0 ? 0 : verified / trials,
    reliabilityInterval: clopperPearson(verified, trials),
    falseSuccesses,
    falseSuccessUpper95:
      falseSuccesses === 0
        ? zeroEventUpperBound(trials)
        : clopperPearson(falseSuccesses, trials).high,
    caveats,
  };
}
