/**
 * Pre-registered head-to-head decision rule (MVD-004 / TIF-59).
 *
 * This module implements `docs/product/mvd-preregistration.md` §4.1 mechanically.
 * It consumes Foundry-scored trials and returns the rule row that applies, the
 * paired counts behind it, and the exact sign test. It never scores a trial and
 * never reads a fixture: ground truth stays with the Evaluation Foundry.
 *
 * Two properties are deliberate:
 *  - A decision is refused unless every contributing row is `decisionEligible`
 *    (Foundry's trusted-ingest gate) and the pre-registered sample size is met.
 *  - The rule table is evaluated top to bottom, first match wins, exactly as
 *    written before any data existed. Changing the order here is a protocol
 *    change, not a refactor.
 *  - The ≥30-pair gate is applied before every row, including row 1. §4.1's
 *    preamble puts the sample size on every row, so this is the conservative
 *    reading: never decide on underpowered data. Rows 4 and 5 in the document
 *    also carry "hcu+shell has ≥1 false success"; the code reaches row 4 on ≥1
 *    discordant pair, which is the same condition whenever the comparator's
 *    false successes are the ones Myco avoided. The divergence is recorded here
 *    so a future reader does not "fix" the document to match the code.
 */

/**
 * Wilson score interval, 95%, two-sided. Returns null for n = 0.
 *
 * Kept local on purpose: `test/foundry/split.test.ts` forbids any `src/` file
 * outside the Foundry grader roots from importing them, so the decision rule
 * cannot reuse `src/foundry/oracles/report.ts` without weakening hidden-split
 * isolation. The formula is the same one; the isolation rule wins.
 */
export function wilson(successes: number, n: number): readonly [number, number] | null {
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    successes > n
  )
    throw new Error("wilson: invalid counts");
  if (n === 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

export type Verdict = "verified" | "refuted" | "uncertain";

export interface ScoredTrial {
  readonly armId: string;
  readonly taskId: string;
  /** `verify` or `no-verify`; the pre-registration forbids pooling them. */
  readonly promptVariant: string;
  readonly seed: number;
  /** `null` for a normal trial; a fault class for a refutable one. */
  readonly faultClass: string | null;
  readonly verdict: Verdict;
  /** The oracle says the intent was not satisfied while the arm claimed success. */
  readonly falseSuccess: boolean;
  /** Foundry's trusted-ingest gate. A false row cannot contribute to a decision. */
  readonly decisionEligible: boolean;
}

export interface DecisionInput {
  readonly trials: readonly ScoredTrial[];
  readonly mycoArmId?: string;
  readonly comparatorArmId?: string;
  readonly taskId?: string;
  readonly promptVariant?: string;
  /** Fraction of refutable comparator trials with a trace-recorded store read. */
  readonly comparatorChecksEveryTrial?: number;
  /** Comparator setup+cost divided by Myco's, on the same trials. */
  readonly comparatorCostRatio?: number;
  /** Pre-registered minimum refutable pairs per arm. */
  readonly minimumPairs?: number;
}

export type RuleRow =
  | "myco-has-a-false-success"
  | "A-stands"
  | "A-reduces-to-the-artifact"
  | "underpowered"
  | "no-change";

export interface Decision {
  readonly status: "decided" | "refused";
  readonly reason?:
    | "ineligible-rows"
    | "insufficient-pairs"
    | "missing-arm"
    | "duplicate-pair"
    | "invalid-input";
  readonly row?: RuleRow;
  readonly taskId: string;
  readonly promptVariant: string;
  readonly pairs: number;
  readonly mycoFalseSuccesses: number;
  readonly comparatorFalseSuccesses: number;
  /** Pairs where the comparator failed and Myco did not. */
  readonly discordantFavouringMyco: number;
  /** Pairs where Myco failed and the comparator did not. */
  readonly discordantFavouringComparator: number;
  readonly signTestP: number | null;
  readonly mycoFalseSuccessInterval: readonly [number, number] | null;
  readonly comparatorFalseSuccessInterval: readonly [number, number] | null;
  readonly ineligibleRows: number;
  readonly notes: readonly string[];
}

/**
 * Exact two-sided sign test over discordant pairs. `b` and `c` are the two
 * directions; ties are excluded by construction. Returns 1 when there are no
 * discordant pairs (no evidence either way).
 */
export function exactSignTest(b: number, c: number): number {
  if (!Number.isSafeInteger(b) || !Number.isSafeInteger(c) || b < 0 || c < 0)
    throw new Error("exactSignTest: invalid counts");
  const n = b + c;
  if (n === 0) return 1;
  const tail = Math.min(b, c);
  let cumulative = 0;
  let coefficient = 1;
  for (let k = 0; k <= tail; k += 1) {
    if (k > 0) coefficient = (coefficient * (n - k + 1)) / k;
    cumulative += coefficient;
  }
  return Math.min(1, (2 * cumulative) / 2 ** n);
}

export function evaluateDecision(input: DecisionInput): Decision {
  const mycoArmId = input.mycoArmId ?? "myco";
  const comparatorArmId = input.comparatorArmId ?? "hcu+shell";
  const taskId = input.taskId ?? "ef-t01b-add-four-items-noverify";
  const promptVariant = input.promptVariant ?? "no-verify";
  const minimumPairs = input.minimumPairs ?? 30;

  const checksEveryTrial = input.comparatorChecksEveryTrial;
  const costRatio = input.comparatorCostRatio;
  if (
    (checksEveryTrial !== undefined &&
      (!Number.isFinite(checksEveryTrial) || checksEveryTrial < 0 || checksEveryTrial > 1)) ||
    (costRatio !== undefined && (!Number.isFinite(costRatio) || costRatio <= 0))
  ) {
    return {
      status: "refused",
      reason: "invalid-input",
      taskId,
      promptVariant,
      pairs: 0,
      mycoFalseSuccesses: 0,
      comparatorFalseSuccesses: 0,
      discordantFavouringMyco: 0,
      discordantFavouringComparator: 0,
      signTestP: null,
      mycoFalseSuccessInterval: null,
      comparatorFalseSuccessInterval: null,
      ineligibleRows: 0,
      notes: [
        "comparatorChecksEveryTrial must be a finite fraction in [0,1] and comparatorCostRatio a finite number > 0.",
      ],
    };
  }

  const scoped = input.trials.filter(
    (trial) =>
      trial.taskId === taskId &&
      trial.promptVariant === promptVariant &&
      (trial.armId === mycoArmId || trial.armId === comparatorArmId),
  );
  const ineligibleRows = scoped.filter((trial) => !trial.decisionEligible).length;

  const myco = new Map<string, ScoredTrial>();
  const comparator = new Map<string, ScoredTrial>();
  let duplicatePairs = 0;
  for (const trial of scoped) {
    if (!trial.decisionEligible) continue;
    if (trial.faultClass === null) continue;
    const key = JSON.stringify([trial.seed, trial.faultClass]);
    const target = trial.armId === mycoArmId ? myco : comparator;
    if (target.has(key)) duplicatePairs += 1;
    target.set(key, trial);
  }

  const keys = [...myco.keys()].filter((key) => comparator.has(key));
  const pairs = keys.length;
  let mycoFalseSuccesses = 0;
  let comparatorFalseSuccesses = 0;
  let discordantFavouringMyco = 0;
  let discordantFavouringComparator = 0;
  for (const key of keys) {
    const mine = myco.get(key);
    const theirs = comparator.get(key);
    if (!mine || !theirs) continue;
    if (mine.falseSuccess) mycoFalseSuccesses += 1;
    if (theirs.falseSuccess) comparatorFalseSuccesses += 1;
    if (theirs.falseSuccess && !mine.falseSuccess) discordantFavouringMyco += 1;
    if (mine.falseSuccess && !theirs.falseSuccess) discordantFavouringComparator += 1;
  }

  const base = {
    taskId,
    promptVariant,
    pairs,
    mycoFalseSuccesses,
    comparatorFalseSuccesses,
    discordantFavouringMyco,
    discordantFavouringComparator,
    signTestP: exactSignTest(discordantFavouringMyco, discordantFavouringComparator),
    mycoFalseSuccessInterval: wilson(mycoFalseSuccesses, pairs),
    comparatorFalseSuccessInterval: wilson(comparatorFalseSuccesses, pairs),
    ineligibleRows,
  };

  if (duplicatePairs > 0) {
    return {
      ...base,
      status: "refused",
      reason: "duplicate-pair",
      notes: [
        `${duplicatePairs} duplicate (seed, fault) row(s) for one arm; a replayed or re-ingested trial must not silently overwrite another.`,
      ],
    };
  }
  if (ineligibleRows > 0) {
    return {
      ...base,
      status: "refused",
      reason: "ineligible-rows",
      notes: [
        `${ineligibleRows} scoped row(s) are not decision-eligible; Foundry's trusted ingest must bind them before this rule can run.`,
      ],
    };
  }
  if (pairs === 0) {
    return {
      ...base,
      status: "refused",
      reason: "missing-arm",
      notes: ["No paired refutable trials for both arms on this task and prompt variant."],
    };
  }
  if (pairs < minimumPairs) {
    return {
      ...base,
      status: "refused",
      reason: "insufficient-pairs",
      row: "underpowered",
      notes: [
        `${pairs} paired refutable trials; the pre-registration requires ${minimumPairs}. No wedge claim is made.`,
      ],
    };
  }

  const notes: string[] = [];

  if (mycoFalseSuccesses >= 1) {
    return {
      ...base,
      status: "decided",
      row: "myco-has-a-false-success",
      notes: ["Myco's own verdict has a hole: fix and re-run before any wedge claim."],
    };
  }
  if (discordantFavouringMyco >= 6) {
    return {
      ...base,
      status: "decided",
      row: "A-stands",
      notes: [
        `${discordantFavouringMyco} discordant pairs favour Myco (p=${base.signTestP?.toFixed(4)}); the independent verdict without agent discipline is the differentiator.`,
      ],
    };
  }
  if (
    comparatorFalseSuccesses === 0 &&
    checksEveryTrial !== undefined &&
    checksEveryTrial >= 0.95 &&
    costRatio !== undefined &&
    costRatio <= 1.5
  ) {
    return {
      ...base,
      status: "decided",
      row: "A-reduces-to-the-artifact",
      notes: [
        "The comparator also produced no false successes, checked the store in ≥95% of trials, and is within 1.5× on setup+cost. A's differentiation reduces to the durable artifact and recovery; re-open B-first or reframe A as CI for GUI.",
      ],
    };
  }
  if (comparatorFalseSuccesses >= 1) {
    return {
      ...base,
      status: "decided",
      row: "underpowered",
      notes: [
        `${discordantFavouringMyco} discordant pairs favour Myco; fewer than 6 means no superiority claim either way. Add trials.`,
      ],
    };
  }
  if (checksEveryTrial === undefined || costRatio === undefined) {
    notes.push(
      "Comparator checks-every-trial or cost ratio is unmeasured, so row 3 cannot be evaluated; no wedge change.",
    );
  }
  return { ...base, status: "decided", row: "no-change", notes };
}
