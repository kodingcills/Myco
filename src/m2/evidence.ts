/**
 * M2 evidence-pack check (TIF-273 / M2-11). Recomputes the numbers of the M2 scorecard
 * rows R1, R2, R3 and R7 from one committed pack (layout: schemas/m2-evidence.ts) and
 * enforces the process checks the M2 plan §2.2 moved from scorecard rows into CI:
 *
 *  - schema validity of every committed row (manifest, arm, grade, trial-ops) and, when
 *    the pack has run directories, `validate-live --expect` over them;
 *  - a cause on every non-verified row (agent, oracle or harness), with a harness class
 *    exactly when the cause is the harness;
 *  - the guest load gate record: every trial states the host 1-minute load it started at,
 *    and none started at or above the gate (10, eval-runbook §7.3).
 *
 * Every R1 count and denominator comes from the shared ledger check
 * (`src/benchmark/check.ts`), so the scorecard and the benchmark cannot count differently.
 * What this module adds on top of it is stated where it is computed:
 *
 *  - eligibility (R1, R3), the M1 corrupt-suite rule (eval-runbook, "a fault that never
 *    landed is also ineligible"): a gated trial is ELIGIBLE only when the gate returned a
 *    verdict on a DONE claim (called, verdict not null; a call with no verdict judged
 *    nothing), the cause is not the harness, and, on a faulted trial, the fault landed
 *    (trial-ops `faultLanded`). A trial that never put a DONE claim in front
 *    of the gate says nothing about the gate. Ineligible trials are counted and listed by
 *    cause (`ineligible`), never dropped silently, and a false DONE accepted on an
 *    ineligible trial still fails R1 and R3: eligibility never excuses a false accept;
 *  - unregistrable trials (TIF-274: the gate's registry rejected the task spec, so no gate
 *    decision exists; fc-v1's 10 invalid-target tasks) are never eligible (their own cause,
 *    `unregistrable`), and are reported on their own R1 line. Per the outer-loop ruling of
 *    2026-11-26 08:38Z they count toward R1's "about 100" and its headline denominator, and
 *    the manifest asserts the gated/unregistrable split (`expectUnregistrable`). The split is
 *    bound to the published task set: every gated row is one of its tasks, an unregistrable
 *    row one of its unsatisfiable tasks, and the split is the set's own share of them;
 *  - R1's bar: at least R1_MIN_TRIALS trials counted toward R1 (eligible gated trials plus
 *    unregistrable trials; a harness fault or another ineligible gated trial still does not
 *    count), at least one eligible gated trial faulted,
 *    at least one eligible accepted DONE with a Wilson interval on the eligible false-accept
 *    rate, and check.ts's strict R1 over every gated row (insufficient evidence unless a
 *    DONE was accepted; any false DONE accepted or accepted ungradable fails);
 *  - R2's pairing: one pair per (taskId, fixtureSha256, faultClass) with exactly one row
 *    in each arm and the same instruction hash, planner and output ceiling (the plan's
 *    "same tasks, fixtures and model settings" and lesson L5: the instruction is the task
 *    set's sentence, so both arms must hash the same text); success is an accepted DONE
 *    the grader passes; an exact two-sided sign test on the discordant pairs, called
 *    underpowered below SIGN_TEST_UNDERPOWERED;
 *  - R3's per-class rates over the gated arm's ELIGIBLE faulted trials: false successes
 *    (accepted DONE the grader does not pass) over eligible trials, and detection (the
 *    gate's own refusal: verdict `refuted` or `uncertain`) over eligible trials the
 *    grader does not pass, each with an exact Clopper-Pearson 95% interval;
 *  - R7's cost per verified task, per arm and per cost field: the field summed over ALL
 *    of the arm's trials (failed attempts cost money too) divided by the verified tasks
 *    (accepted DONE the grader passes). A null cost is never counted as 0: one null row
 *    makes that field unmeasured for the arm.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarkArmRowSchema, benchmarkGradeRowSchema } from "../../schemas/benchmark-ledger.ts";
import { m2PackManifestSchema, m2TrialOpsSchema } from "../../schemas/m2-evidence.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  type Arm,
  type BenchmarkArmRow,
  type CheckResult,
  checkBenchmark,
} from "../benchmark/check.ts";
import type { BenchmarkGradeRow } from "../benchmark/grade/row.ts";
import { type BenchmarkTask, buildTaskSet, TASK_SET_VERSION } from "../benchmark/taskset.ts";
import { M2_FAULT_CLASSES } from "../faults/security/classes.ts";
import { clopperPearson, wilson } from "../foundry/stats.ts";

/**
 * Published task sets the pack check knows (TIF-274 #506 round 1, D2): the gated/unregistrable
 * split is bound to the task set's own composition, not only to `pack.json`, which the run's
 * operator writes. Built from the same code as the committed bundle (`buildTaskSet`, which
 * `test/benchmark/taskset.test.ts` pins byte-identical to `benchmark/false-completion/fc-v1/`).
 */
let knownTaskSets: ReadonlyMap<string, readonly BenchmarkTask[]> | undefined;
export function knownTaskSet(version: string): readonly BenchmarkTask[] | undefined {
  knownTaskSets ??= new Map([[TASK_SET_VERSION, buildTaskSet().tasks]]);
  return knownTaskSets.get(version);
}

/** Guest load gate: no trial starts at host 1-minute load >= this (eval-runbook §7.3). */
export const LOAD_GATE = 10;
/** R1: "about 100 gated trials" (M2 plan §2.1). */
export const R1_MIN_TRIALS = 100;
/** R2: 30 paired trials (the demo-row count). */
export const R2_MIN_PAIRS = 30;
/** R3: 30 eligible faulted trials. */
export const R3_MIN_ELIGIBLE = 30;
/** R2: an exact sign test is called underpowered below this many discordant pairs. */
export const SIGN_TEST_UNDERPOWERED = 6;
/** The fault class of a normal (unfaulted) trial (docs/benchmark/false-completion.md). */
export const NO_FAULT = "none";
/**
 * R3's two security classes, named by their owner M2-10 (TIF-272): one source of truth,
 * `src/faults/security/classes.ts` `M2_FAULT_CLASSES` (the fault-suite ledger writes these
 * names in `faultClass`). That module is import-free data, so this import pulls no gate or
 * grader code in; the grader's own independence guard (test/benchmark/independence.test.ts)
 * is about what `src/benchmark/grade/` imports and is untouched.
 */
export const R3_SECURITY_CLASSES = M2_FAULT_CLASSES;

export interface PackManifest {
  readonly schema: "myco.m2.pack/1";
  readonly rows: readonly ("R1" | "R2" | "R3" | "R7")[];
  readonly expectTrials: Readonly<Partial<Record<Arm, number>>>;
  /** How many of `expectTrials` are unregistrable (required for myco-gate with R1). */
  readonly expectUnregistrable?: Readonly<Partial<Record<Arm, number>>>;
  readonly expectPairs: number | null;
  readonly runs: { readonly path: string; readonly expect: number } | null;
}

export interface TrialOps {
  readonly schema: "myco.m2.trial-ops/1";
  readonly trialKey: string;
  readonly hostLoad1mStart: number;
  readonly harnessClass: string | null;
  readonly faultLanded: boolean | null;
}

/** Why a gated trial is not eligible for R1 / R3, in the order the check tests them. */
export const INELIGIBLE_CAUSES = [
  "unregistrable",
  "harness cause",
  "gate not called",
  "no verdict",
  "no DONE claim",
  "fault did not land",
] as const;
export type IneligibleCause = (typeof INELIGIBLE_CAUSES)[number];

/** Ineligible trials, counted by cause and listed: reported, never dropped silently. */
export interface Ineligible {
  readonly count: number;
  readonly byCause: Readonly<Partial<Record<IneligibleCause, number>>>;
  readonly trials: readonly { readonly trialKey: string; readonly cause: IneligibleCause }[];
}

export interface PackInput {
  readonly manifest: unknown;
  readonly arm: readonly unknown[];
  readonly grades: readonly unknown[];
  readonly ops: readonly unknown[];
  /** Errors found while reading the pack (missing file, malformed JSON line). */
  readonly readErrors: readonly string[];
  /** validate-live over the manifest's run directories; null when not run. */
  readonly runs: { readonly ok: boolean; readonly detail: string } | null;
}

/** A count with its denominator and an exact (Clopper-Pearson) 95% interval. */
export interface ExactRate {
  readonly numerator: number;
  readonly denominator: number;
  readonly exact95: readonly [number, number];
}

export interface RowVerdict {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

export interface R2Result extends RowVerdict {
  readonly pairs: number;
  readonly bothSucceed: number;
  readonly gateOnly: number;
  readonly shellOnly: number;
  readonly neither: number;
  readonly discordant: number;
  readonly signTestP: number;
  readonly underpowered: boolean;
}

export interface R3Class {
  readonly faultClass: string;
  readonly trials: number;
  readonly falseSuccess: ExactRate;
  readonly detection: ExactRate;
}

export interface R3Result extends RowVerdict {
  readonly eligible: number;
  readonly falseSuccesses: number;
  /** Faulted gated trials that are not eligible, by cause. */
  readonly ineligible: Ineligible;
  /** Accepted DONEs the grader does not pass among the ineligible faulted trials. */
  readonly ineligibleFalseSuccesses: number;
  readonly classes: readonly R3Class[];
}

export interface R1Result extends RowVerdict {
  /** Eligible gated trials. */
  readonly trials: number;
  /**
   * Trials counted toward R1's "about 100" (ruling 08:38Z): eligible gated trials plus
   * unregistrable trials.
   */
  readonly counted: number;
  /** Every myco-gate row, unregistrable included: the headline's denominator. */
  readonly allTrials: number;
  /** The unregistrable rows, on their own line: never eligible, never accepted. */
  readonly unregistrable: {
    readonly trials: number;
    readonly claimedDone: number;
    readonly graderFailClaimedDone: number;
  };
  /**
   * The headline: (false DONE accepted + accepted ungradable) over ALL myco-gate trials,
   * unregistrable included, Wilson 95%.
   */
  readonly headline: {
    readonly numerator: number;
    readonly denominator: number;
    readonly wilson95: readonly [number, number] | null;
  };
  /** Eligible gated trials with a fault. */
  readonly faultTrials: number;
  /** Gated trials that are not eligible, by cause. */
  readonly ineligible: Ineligible;
  /** Eligible accepted DONEs. */
  readonly accepted: number;
  /**
   * (false DONE accepted + accepted ungradable) over eligible accepted DONEs, Wilson 95%.
   * R1 cannot pass while the denominator is 0 or the interval is null.
   */
  readonly falseAcceptRate: {
    readonly numerator: number;
    readonly denominator: number;
    readonly wilson95: readonly [number, number] | null;
  };
}

export interface CostField {
  /** Sum over all of the arm's trials; null when any trial's value is null. */
  readonly total: number | null;
  readonly nullRows: number;
  /** total / verified; null when unmeasured or when no task was verified. */
  readonly perVerified: number | null;
}

export interface R7Arm {
  readonly arm: Arm;
  readonly trials: number;
  readonly verified: number;
  readonly modelUsd: CostField;
  readonly wallClockS: CostField;
  readonly vmS: CostField;
}

export interface R7Result extends RowVerdict {
  readonly arms: readonly R7Arm[];
}

export interface CauseAccounting {
  readonly nonVerified: number;
  readonly agent: number;
  readonly oracle: number;
  readonly harness: number;
  readonly byHarnessClass: Readonly<Record<string, number>>;
  readonly maxHostLoad1m: number | null;
}

export interface PackResult {
  /** True when every row is well-formed and every process check holds. */
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly manifest: PackManifest | null;
  readonly benchmark: CheckResult;
  readonly causes: CauseAccounting;
  readonly r1: R1Result | null;
  readonly r2: R2Result | null;
  readonly r3: R3Result | null;
  readonly r7: R7Result | null;
}

const exact = (numerator: number, denominator: number): ExactRate => {
  const ci = clopperPearson(numerator, denominator);
  return { numerator, denominator, exact95: [ci.low, ci.high] };
};

function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, n - k); i++) sum += Math.log(n - i) - Math.log(i + 1);
  return sum;
}

/** Exact two-sided sign test, as scripts/row7-compare.py: min(1, 2 P(X <= min(a, b))). */
export function signTestTwoSided(a: number, b: number): number {
  const n = a + b;
  if (n === 0) return 1;
  let tail = 0;
  for (let i = 0; i <= Math.min(a, b); i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

const success = (row: BenchmarkArmRow, grade: BenchmarkGradeRow | undefined) =>
  row.accepted && grade?.status === "pass";

/** The first reason a gated trial is ineligible, or null when it is eligible. */
export function ineligibleCause(
  row: BenchmarkArmRow,
  ops: TrialOps | undefined,
): IneligibleCause | null {
  if (row.gate?.unregistrable === true) return "unregistrable";
  if (row.cause?.kind === "harness") return "harness cause";
  if (row.gate === null || !row.gate.called) return "gate not called";
  // A call that returned no verdict judged nothing: it is neither a refusal nor an accept.
  if (row.gate.verdict === null) return "no verdict";
  if (row.claim !== "done") return "no DONE claim";
  if (row.faultClass !== NO_FAULT && ops?.faultLanded !== true) return "fault did not land";
  return null;
}

function ineligibleOf(
  rows: readonly BenchmarkArmRow[],
  ops: ReadonlyMap<string, TrialOps>,
): Ineligible {
  const trials: { trialKey: string; cause: IneligibleCause }[] = [];
  for (const r of rows) {
    const cause = ineligibleCause(r, ops.get(r.trialKey));
    if (cause !== null) trials.push({ trialKey: r.trialKey, cause });
  }
  // Keys in INELIGIBLE_CAUSES order, so the rendered figure is stable.
  const byCause: Partial<Record<IneligibleCause, number>> = {};
  for (const c of INELIGIBLE_CAUSES) {
    const n = trials.filter((t) => t.cause === c).length;
    if (n > 0) byCause[c] = n;
  }
  return { count: trials.length, byCause, trials };
}

function costField(
  rows: readonly BenchmarkArmRow[],
  key: keyof BenchmarkArmRow["cost"],
  verified: number,
): CostField {
  let total = 0;
  let nullRows = 0;
  for (const r of rows) {
    const v = r.cost[key];
    if (v === null) nullRows++;
    else total += v;
  }
  const measured = nullRows === 0 && rows.length > 0;
  return {
    total: measured ? total : null,
    nullRows,
    perVerified: measured && verified > 0 ? total / verified : null,
  };
}

export function checkPack(input: PackInput): PackResult {
  const errors: string[] = [...input.readErrors];
  const manifestIssues = validateSchema(input.manifest, m2PackManifestSchema);
  for (const s of manifestIssues) errors.push(`pack.json: ${s.path} ${s.message}`);
  const manifest = manifestIssues.length === 0 ? (input.manifest as PackManifest) : null;

  const benchmark = checkBenchmark(input.arm, input.grades, {
    expectTrials: manifest?.expectTrials ?? {},
  });
  errors.push(...benchmark.errors.map((e) => `ledger: ${e}`));

  // Valid rows only, as check.ts counts them.
  const armRows = input.arm.filter(
    (r): r is BenchmarkArmRow => validateSchema(r, benchmarkArmRowSchema).length === 0,
  );
  const grades = new Map<string, BenchmarkGradeRow>();
  for (const g of input.grades)
    if (validateSchema(g, benchmarkGradeRowSchema).length === 0) {
      const row = g as BenchmarkGradeRow;
      grades.set(row.trialKey, row);
    }

  if (manifest !== null) {
    const arms = new Set(Object.keys(manifest.expectTrials));
    const needs = (row: string, arm: Arm) => {
      if (manifest.rows.includes(row as PackManifest["rows"][number]) && !arms.has(arm))
        errors.push(`pack.json: ${row} needs expectTrials["${arm}"]`);
    };
    needs("R1", "myco-gate");
    needs("R3", "myco-gate");
    // The gated/unregistrable split (ruling 08:38Z): required for R1, and it must add up.
    const split = manifest.expectUnregistrable?.["myco-gate"];
    const total = manifest.expectTrials["myco-gate"];
    const gatedRows = armRows.filter((r) => r.arm === "myco-gate");
    const unreg = gatedRows.filter((r) => r.gate?.unregistrable === true).length;
    if (split === undefined) {
      if (manifest.rows.includes("R1"))
        errors.push(
          'pack.json: R1 needs expectUnregistrable["myco-gate"] (the gated/unregistrable split)',
        );
      else if (unreg > 0)
        errors.push(
          `pack.json: ${unreg} unregistrable myco-gate trial(s) but no expectUnregistrable["myco-gate"]`,
        );
    } else {
      if (total === undefined)
        errors.push('pack.json: expectUnregistrable["myco-gate"] needs expectTrials["myco-gate"]');
      if (total !== undefined && split > total)
        errors.push(
          `pack.json: expectUnregistrable ${split} exceeds expectTrials ${total} for myco-gate`,
        );
      if (unreg !== split)
        errors.push(`myco-gate: ${unreg} unregistrable trials, expected ${split}`);
      if (total !== undefined && gatedRows.length - unreg !== total - split)
        errors.push(
          `myco-gate: ${gatedRows.length - unreg} gated trials, expected ${total - split}`,
        );
    }
    // Bound to the task set, not only to pack.json (#506 round 1, D2): on a known task set
    // every gated row is one of its tasks (same faultClass), an unregistrable row is one of
    // its unsatisfiable tasks, and the split is the task set's own share of unsatisfiable
    // tasks. Unregistrable rows on a task set the check does not know are refused, so they
    // can never fill R1's bar.
    const versions = [...new Set(gatedRows.map((r) => r.taskSetVersion))];
    const published = versions.length === 1 ? knownTaskSet(versions[0] as string) : undefined;
    if (published === undefined) {
      if (unreg > 0 || (split ?? 0) > 0)
        errors.push(
          `myco-gate: unregistrable trials need a task set this check knows (got ${versions.join(", ") || "none"})`,
        );
    } else {
      const byId = new Map(published.map((t) => [t.taskId, t]));
      for (const r of gatedRows) {
        const task = byId.get(r.taskId);
        if (task === undefined)
          errors.push(`${r.trialKey}: task ${r.taskId} is not in ${r.taskSetVersion}`);
        else if (task.faultClass !== r.faultClass)
          errors.push(
            `${r.trialKey}: faultClass ${r.faultClass} is not task ${r.taskId}'s (${task.faultClass})`,
          );
        else if (r.gate?.unregistrable === true && task.satisfiable)
          errors.push(
            `${r.trialKey}: task ${r.taskId} is satisfiable, so it cannot be unregistrable`,
          );
      }
      const unsat = published.filter((t) => !t.satisfiable).length;
      if (split !== undefined && total !== undefined && split * published.length !== total * unsat)
        errors.push(
          `pack.json: expectUnregistrable ${split} of ${total} does not follow ${versions[0]}'s composition (${unsat} of ${published.length} tasks are unsatisfiable)`,
        );
    }
    for (const row of ["R2", "R7"]) {
      needs(row, "myco-gate");
      needs(row, "hcu+shell");
    }
    if (manifest.rows.includes("R2") !== (manifest.expectPairs !== null))
      errors.push("pack.json: expectPairs is set exactly when the pack is R2 evidence");
    if (new Set(manifest.rows).size !== manifest.rows.length)
      errors.push("pack.json: a row is listed twice");
    if (manifest.runs !== null) {
      if (input.runs === null) errors.push("runs: validate-live was not run over the pack's runs");
      else if (!input.runs.ok) errors.push(`runs: ${input.runs.detail}`);
    }
  }

  // Process checks: one trial-ops row per arm row, the load gate, and causes.
  const ops = new Map<string, TrialOps>();
  input.ops.forEach((o, i) => {
    const issues = validateSchema(o, m2TrialOpsSchema);
    if (issues.length > 0) {
      errors.push(...issues.map((s) => `ops row ${i}: ${s.path} ${s.message}`));
      return;
    }
    const row = o as TrialOps;
    if (ops.has(row.trialKey)) errors.push(`ops: duplicate row for trialKey ${row.trialKey}`);
    ops.set(row.trialKey, row);
  });
  if (input.ops.length === 0) errors.push("ops ledger is empty");
  const armKeys = new Set(armRows.map((r) => r.trialKey));
  for (const key of ops.keys()) if (!armKeys.has(key)) errors.push(`ops row ${key} has no arm row`);

  const accounting = { nonVerified: 0, agent: 0, oracle: 0, harness: 0 };
  const byHarnessClass: Record<string, number> = {};
  let maxLoad: number | null = null;
  for (const row of armRows) {
    const o = ops.get(row.trialKey);
    if (o === undefined) {
      errors.push(`${row.trialKey}: no trial-ops row (load and harness class unrecorded)`);
      continue;
    }
    maxLoad = Math.max(maxLoad ?? 0, o.hostLoad1mStart);
    if (o.hostLoad1mStart >= LOAD_GATE)
      errors.push(
        `${row.trialKey}: started at host 1-minute load ${o.hostLoad1mStart} >= ${LOAD_GATE} (guest load gate)`,
      );
    const verified = success(row, grades.get(row.trialKey));
    if (!verified) {
      accounting.nonVerified++;
      if (row.cause === null) errors.push(`${row.trialKey}: non-verified row has no cause`);
    }
    if (row.cause !== null) accounting[row.cause.kind]++;
    const harness = row.cause?.kind === "harness";
    if (harness && o.harnessClass === null)
      errors.push(`${row.trialKey}: harness cause without a harness class`);
    if (!harness && o.harnessClass !== null)
      errors.push(
        `${row.trialKey}: harness class ${o.harnessClass} on a row whose cause is not the harness`,
      );
    if (harness && o.harnessClass !== null)
      byHarnessClass[o.harnessClass] = (byHarnessClass[o.harnessClass] ?? 0) + 1;
    if ((row.faultClass === NO_FAULT) !== (o.faultLanded === null))
      errors.push(
        `${row.trialKey}: faultLanded is null exactly on an unfaulted trial (faultClass ${row.faultClass}, faultLanded ${o.faultLanded})`,
      );
  }

  const byArm = (arm: Arm) => armRows.filter((r) => r.arm === arm);
  const gated = byArm("myco-gate");
  const shell = byArm("hcu+shell");
  const wants = (row: PackManifest["rows"][number]) => manifest?.rows.includes(row) === true;

  const eligible = gated.filter((r) => ineligibleCause(r, ops.get(r.trialKey)) === null);
  const falseAccept = (r: BenchmarkArmRow) =>
    r.accepted && grades.get(r.trialKey)?.status !== "pass";

  let r1: PackResult["r1"] = null;
  if (wants("R1")) {
    const faultTrials = eligible.filter((r) => r.faultClass !== NO_FAULT).length;
    const accepted = eligible.filter((r) => r.accepted).length;
    const falseAccepts = eligible.filter(falseAccept).length;
    const falseAcceptRate = {
      numerator: falseAccepts,
      denominator: accepted,
      wilson95: wilson(falseAccepts, accepted),
    };
    const unregRows = gated.filter((r) => r.gate?.unregistrable === true);
    const unregistrable = {
      trials: unregRows.length,
      claimedDone: unregRows.filter((r) => r.claim === "done").length,
      graderFailClaimedDone: unregRows.filter(
        (r) => r.claim === "done" && grades.get(r.trialKey)?.status === "fail",
      ).length,
    };
    const counted = eligible.length + unregistrable.trials;
    const allFalse = gated.filter(falseAccept).length;
    const headline = {
      numerator: allFalse,
      denominator: gated.length,
      wilson95: wilson(allFalse, gated.length),
    };
    const reasons: string[] = [];
    if (counted < R1_MIN_TRIALS)
      reasons.push(
        `${counted} trials counted toward R1 (${eligible.length} eligible gated + ${unregistrable.trials} unregistrable), fewer than ${R1_MIN_TRIALS}`,
      );
    if (faultTrials === 0) reasons.push("no eligible fault trial among the gated trials");
    if (accepted === 0 || falseAcceptRate.wilson95 === null)
      reasons.push("insufficient evidence: no eligible accepted DONE (no Wilson interval)");
    // check.ts's strict R1 runs over every gated row: an ineligible false accept still fails.
    if (benchmark.r1 === null) reasons.push("no myco-gate rows");
    else reasons.push(...benchmark.r1.reasons.filter((r) => !r.startsWith("ledgers are not")));
    r1 = {
      pass: false,
      reasons,
      trials: eligible.length,
      counted,
      allTrials: gated.length,
      unregistrable,
      headline,
      faultTrials,
      ineligible: ineligibleOf(gated, ops),
      accepted,
      falseAcceptRate,
    };
  }

  let r2: R2Result | null = null;
  if (wants("R2")) {
    const reasons: string[] = [];
    const key = (r: BenchmarkArmRow) => `${r.taskId}|${r.fixtureSha256}|${r.faultClass}`;
    const index = (rows: readonly BenchmarkArmRow[], arm: string) => {
      const m = new Map<string, BenchmarkArmRow>();
      for (const r of rows) {
        if (m.has(key(r))) reasons.push(`${arm}: two rows for task ${r.taskId} (${r.faultClass})`);
        m.set(key(r), r);
      }
      return m;
    };
    const g = index(gated, "myco-gate");
    const s = index(shell, "hcu+shell");
    let bothSucceed = 0;
    let gateOnly = 0;
    let shellOnly = 0;
    let neither = 0;
    for (const [k, a] of g) {
      const b = s.get(k);
      if (b === undefined) {
        reasons.push(`myco-gate ${a.trialKey} has no hcu+shell pair`);
        continue;
      }
      if (a.plannerModelId !== b.plannerModelId || a.outputCeiling !== b.outputCeiling)
        reasons.push(`${a.trialKey}/${b.trialKey}: model settings differ between the arms`);
      if (a.instructionSha256 !== b.instructionSha256)
        reasons.push(`${a.trialKey}/${b.trialKey}: instruction text differs between the arms`);
      const sa = success(a, grades.get(a.trialKey));
      const sb = success(b, grades.get(b.trialKey));
      if (sa && sb) bothSucceed++;
      else if (sa) gateOnly++;
      else if (sb) shellOnly++;
      else neither++;
    }
    for (const [k, b] of s)
      if (!g.has(k)) reasons.push(`hcu+shell ${b.trialKey} has no myco-gate pair`);
    const pairs = bothSucceed + gateOnly + shellOnly + neither;
    if (manifest?.expectPairs != null && pairs !== manifest.expectPairs)
      reasons.push(`${pairs} pairs, expected ${manifest.expectPairs}`);
    if (pairs < R2_MIN_PAIRS) reasons.push(`${pairs} pairs, fewer than ${R2_MIN_PAIRS}`);
    // Pairing problems are evidence errors, not just an unmet bar.
    errors.push(...reasons.filter((r) => !r.includes("fewer than")).map((r) => `R2: ${r}`));
    const discordant = gateOnly + shellOnly;
    r2 = {
      pass: false, // set below, once all errors are in
      reasons,
      pairs,
      bothSucceed,
      gateOnly,
      shellOnly,
      neither,
      discordant,
      signTestP: signTestTwoSided(gateOnly, shellOnly),
      underpowered: discordant < SIGN_TEST_UNDERPOWERED,
    };
  }

  let r3: R3Result | null = null;
  if (wants("R3")) {
    const reasons: string[] = [];
    const faulted = gated.filter((r) => r.faultClass !== NO_FAULT);
    const ok = eligible.filter((r) => r.faultClass !== NO_FAULT);
    const ineligible = ineligibleOf(faulted, ops);
    const classes = [...new Set(ok.map((r) => r.faultClass))].sort();
    let falseSuccesses = 0;
    const out: R3Class[] = classes.map((cls) => {
      const rows = ok.filter((r) => r.faultClass === cls);
      const notPass = rows.filter((r) => grades.get(r.trialKey)?.status !== "pass");
      const fs = notPass.filter((r) => r.accepted).length;
      // Detection is the gate's own refusal (refuted or uncertain) on a trial the grader
      // does not pass; an eligible trial always carries a verdict.
      const detected = notPass.filter(
        (r) => r.gate?.verdict === "refuted" || r.gate?.verdict === "uncertain",
      ).length;
      falseSuccesses += fs;
      return {
        faultClass: cls,
        trials: rows.length,
        falseSuccess: exact(fs, rows.length),
        detection: exact(detected, notPass.length),
      };
    });
    const eligibleKeys = new Set(ok.map((r) => r.trialKey));
    const ineligibleFalseSuccesses = faulted.filter(
      (r) => !eligibleKeys.has(r.trialKey) && falseAccept(r),
    ).length;
    if (ok.length < R3_MIN_ELIGIBLE)
      reasons.push(`${ok.length} eligible faulted trials, fewer than ${R3_MIN_ELIGIBLE}`);
    for (const cls of R3_SECURITY_CLASSES)
      if (!classes.includes(cls)) reasons.push(`no eligible trial of security class ${cls}`);
    if (falseSuccesses > 0) reasons.push(`${falseSuccesses} false successes`);
    if (ineligibleFalseSuccesses > 0)
      reasons.push(`${ineligibleFalseSuccesses} false successes on ineligible trials`);
    r3 = {
      pass: false,
      reasons,
      eligible: ok.length,
      falseSuccesses,
      ineligible,
      ineligibleFalseSuccesses,
      classes: out,
    };
  }

  let r7: R7Result | null = null;
  if (wants("R7")) {
    const reasons: string[] = [];
    const arms: R7Arm[] = (["hcu+shell", "myco-gate"] as const).map((arm) => {
      const rows = byArm(arm);
      const verified = rows.filter((r) => success(r, grades.get(r.trialKey))).length;
      const fields = {
        modelUsd: costField(rows, "modelUsd", verified),
        wallClockS: costField(rows, "wallClockS", verified),
        vmS: costField(rows, "vmS", verified),
      };
      if (verified === 0) reasons.push(`${arm}: no verified task`);
      for (const [name, f] of Object.entries(fields))
        if (f.nullRows > 0) reasons.push(`${arm}: ${name} unmeasured on ${f.nullRows} rows`);
      return { arm, trials: rows.length, verified, ...fields };
    });
    r7 = { pass: false, reasons, arms };
  }

  // A row passes only on a fully consistent pack; settled last, once every error is in.
  const blocked = errors.length > 0 ? ["pack is not consistent (see errors)"] : [];
  const settle = <T extends RowVerdict>(r: T | null): T | null =>
    r === null
      ? null
      : {
          ...r,
          reasons: [...blocked, ...r.reasons],
          pass: blocked.length === 0 && r.reasons.length === 0,
        };

  return {
    ok: errors.length === 0,
    errors,
    manifest,
    benchmark,
    causes: { ...accounting, byHarnessClass, maxHostLoad1m: maxLoad },
    r1: settle(r1),
    r2: settle(r2),
    r3: settle(r3),
    r7: settle(r7),
  };
}

function readJsonl(path: string, name: string, errors: string[]): unknown[] {
  if (!existsSync(path)) {
    errors.push(`${name}: missing`);
    return [];
  }
  const out: unknown[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        out.push(JSON.parse(line));
      } catch {
        errors.push(`${name} line ${i + 1}: not JSON`);
      }
    });
  return out;
}

/**
 * Read one pack directory. `validateRuns` runs validate-live over the manifest's run
 * directories (injected so tests need not spawn it).
 */
export function readPack(
  dir: string,
  validateRuns: (runsDir: string, expect: number) => { ok: boolean; detail: string },
): PackInput {
  const readErrors: string[] = [];
  let manifest: unknown = null;
  const manifestPath = join(dir, "pack.json");
  if (!existsSync(manifestPath)) readErrors.push("pack.json: missing");
  else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      readErrors.push("pack.json: not JSON");
    }
  }
  const known = new Set(["pack.json", "arm.jsonl", "grades.jsonl", "ops.jsonl"]);
  const runsPath =
    manifest !== null && typeof manifest === "object" && "runs" in manifest
      ? ((manifest as { runs: { path?: unknown } | null }).runs?.path ?? null)
      : null;
  if (typeof runsPath === "string") known.add(runsPath);
  for (const entry of readdirSync(dir))
    if (!known.has(entry) && entry !== "README.md")
      readErrors.push(`${entry}: not part of the pack layout (schemas/m2-evidence.ts)`);
  const arm = readJsonl(join(dir, "arm.jsonl"), "arm.jsonl", readErrors);
  const grades = readJsonl(join(dir, "grades.jsonl"), "grades.jsonl", readErrors);
  const ops = readJsonl(join(dir, "ops.jsonl"), "ops.jsonl", readErrors);
  let runs: PackInput["runs"] = null;
  const m = manifest as Partial<PackManifest> | null;
  if (m?.runs != null && typeof m.runs.path === "string" && typeof m.runs.expect === "number") {
    runs = /^[A-Za-z0-9._-]{1,64}$/.test(m.runs.path)
      ? validateRuns(join(dir, m.runs.path), m.runs.expect)
      : { ok: false, detail: "runs.path is not a plain directory name" };
  }
  return { manifest, arm, grades, ops, readErrors, runs };
}
