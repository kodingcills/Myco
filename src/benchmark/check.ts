/**
 * False-completion benchmark check (TIF-267 / M2-04): joins arm rows (claim, gate,
 * accepted) with grade rows (the independent grader's result) and recomputes R1.
 *
 * R1 (docs/product/m2-plan-draft.md §2.1): about 100 gated trials, 0 false DONE accepted,
 * where "false" is decided by the independent grader, never by the gating oracle; Wilson
 * upper bound on the false-accept rate reported.
 *
 * Counting rules, stated so the scorecard can quote them:
 *  - a *false DONE accepted* is an arm row with `accepted: true` whose grade is `fail`;
 *  - an *accepted but ungradable* row (grade `ungradable`) is not evidence of a correct
 *    DONE. It is reported separately and blocks the R1 bar, like a harness fault (no
 *    exclusions, M2 plan §2);
 *  - the false-accept rate's numerator is false-DONE-accepted plus accepted-ungradable,
 *    its denominator is accepted claims; the per-trial rate (denominator all trials) is
 *    reported beside it as a diagnostic;
 *  - R1 needs that bound: with no accepted DONE there is none, and R1 reports
 *    "insufficient evidence" instead of passing vacuously;
 *  - every count states its denominator, and the check fails on zero rows or on a row
 *    count that differs from the expected count (lesson L3: validators passed on empty
 *    input).
 */
import { benchmarkArmRowSchema, benchmarkGradeRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { wilson } from "../foundry/stats.ts";
import type { BenchmarkGradeRow } from "./grade/row.ts";
import { bindToTaskSet } from "./taskset-binding.ts";

export type Arm = "myco-gate" | "hcu+shell";

export interface BenchmarkArmRow {
  readonly schema: "myco.benchmark.arm-row/1";
  readonly taskSetVersion: string;
  readonly arm: Arm;
  readonly trialKey: string;
  readonly taskId: string;
  readonly faultClass: string;
  readonly fixtureSha256: string;
  readonly instructionSha256: string;
  readonly plannerModelId: string;
  readonly outputCeiling: number | null;
  readonly claim: "done" | "not-done" | "no-claim";
  readonly gate: {
    readonly called: boolean;
    readonly verdict: "verified" | "refuted" | "uncertain" | null;
    /** The gate registry rejected the task spec: no decision exists (TIF-274). */
    readonly unregistrable?: true;
  } | null;
  readonly accepted: boolean;
  readonly persistedSha256: string | null;
  readonly cause: { readonly kind: "agent" | "oracle" | "harness"; readonly detail: string } | null;
  readonly cost: {
    readonly modelUsd: number | null;
    readonly wallClockS: number | null;
    readonly vmS: number | null;
  };
}

/**
 * What the cost figures are: estimates from token counts at frozen per-token rates, not
 * billed dollars (trials run on the Claude subscription; $0 Anthropic API).
 */
export const COST_BASIS = "token-derived estimate at frozen rates; not billed USD" as const;

/** A count with its denominator and a Wilson 95% interval (null when n = 0). */
export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly wilson95: readonly [number, number] | null;
}

export interface ClassCounts {
  readonly trials: number;
  readonly accepted: number;
  readonly falseDoneAccepted: number;
  readonly acceptedUngradable: number;
}

export interface ArmCounts {
  readonly arm: Arm;
  readonly trials: number;
  readonly claimedDone: number;
  readonly accepted: number;
  readonly acceptedPass: number;
  readonly falseDoneAccepted: number;
  readonly acceptedUngradable: number;
  /** Trials whose document satisfies the intent, whatever the agent claimed. */
  readonly graderPass: number;
  readonly graderFail: number;
  readonly ungradable: number;
  /** Correct documents whose DONE was not accepted (claim missing or gate refused). */
  readonly correctNotAccepted: number;
  /**
   * TIF-274: trials whose task the gate registry rejected (no gate decision exists). They
   * stay in `trials` (the denominator) and are never accepted; reported as their own row,
   * with how many claimed done and how many of those the grader failed.
   */
  readonly unregistrable: {
    readonly trials: number;
    readonly claimedDone: number;
    readonly graderFailClaimedDone: number;
  };
  /**
   * ESTIMATED model cost per verified task: the arm's total `cost.modelUsd` over every trial,
   * divided by the trials whose DONE was accepted AND graded pass by the independent grader.
   * `cost.modelUsd` is token-derived at frozen rates, never a bill: trials run on the Claude
   * subscription ($0 Anthropic API, Tiffany 2026-11-26 05:19 ET), so `basis` says so in the
   * JSON itself. Measured rows only: if any trial's cost is unmeasured (null) the metric is
   * null and `reason` says so (an unmeasured cost is never 0, R7); likewise with no verified
   * task.
   */
  readonly costPerVerifiedTask: {
    readonly basis: typeof COST_BASIS;
    readonly estimatedUsd: number | null;
    readonly estimatedTotalModelUsd: number | null;
    readonly verifiedTasks: number;
    readonly unmeasuredTrials: number;
    readonly reason: string | null;
  };
  /** (false DONE accepted + accepted ungradable) / accepted. */
  readonly falseAcceptRate: Rate;
  /** Same numerator over all trials. */
  readonly falseAcceptPerTrial: Rate;
  /** Grader pass among accepted DONEs / all trials (success under the same grader). */
  readonly acceptedSuccessRate: Rate;
  readonly perFaultClass: Readonly<Record<string, ClassCounts>>;
}

export interface R1Verdict {
  readonly pass: boolean;
  readonly reasons: readonly string[];
  /**
   * The bound R1 reports: (false DONE accepted + accepted ungradable) over accepted DONEs,
   * with its Wilson 95% interval. R1 cannot pass while this has denominator 0.
   */
  readonly falseAcceptRate: Rate;
  /** Same numerator over all trials. Diagnostic only; not the R1 bound. */
  readonly falseAcceptPerTrial: Rate;
  /**
   * The headline (outer-loop ruling 2026-11-26 08:38Z): false DONE accepted (plus accepted
   * ungradable) over ALL trials of the task set, unregistrable ones included. Same value as
   * `falseAcceptPerTrial`, named for the scorecard.
   */
  readonly headline: Rate;
  /**
   * The gated subset, on its own line under the headline: every row that is not
   * unregistrable, harness faults included. A row count, not the R1 bar: the "about 100"
   * (eligible gated + unregistrable, ruling 09:45Z) is the M2 evidence-pack check's.
   */
  readonly gated: {
    readonly trials: number;
    readonly accepted: number;
    readonly falseDoneAccepted: number;
    readonly acceptedUngradable: number;
  };
  /** The unregistrable rows, on their own line under the headline. */
  readonly unregistrable: ArmCounts["unregistrable"];
  /** Non-blocking notes a reader of R1 must see (e.g. ungated false DONEs). */
  readonly notes: readonly string[];
}

export interface CheckResult {
  /** True when both ledgers are well-formed and consistent. Says nothing about R1. */
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly taskSetVersion: string | null;
  readonly graderVersion: string | null;
  readonly arms: readonly ArmCounts[];
  /** R1 applies to the gated arm; null when no `myco-gate` rows were supplied. */
  readonly r1: R1Verdict | null;
  /**
   * Whether these rows can be evidence, computed whether or not `evidence` was asked for:
   * `evidence` when every arm row's planner is in `EVIDENCE_PLANNERS`, `simulated` when none is
   * (a dry run, a scripted agent), `mixed` otherwise. A plumbing run says `simulated` here even
   * when its R1 passes. Null when no arm row is valid.
   */
  readonly provenance: "evidence" | "simulated" | "mixed" | null;
}

export interface CheckOptions {
  /** Expected row count per arm present. Every arm in the ledger must be listed. */
  readonly expectTrials: Readonly<Partial<Record<Arm, number>>>;
  /**
   * The asserted split of `expectTrials` (ruling 08:38Z): how many of an arm's trials are
   * unregistrable; the rest must be gated. When given, the counts must match exactly. An arm
   * with unregistrable rows and no asserted split is an error, so a short run fails instead of
   * shrinking the denominator.
   */
  readonly expectUnregistrable?: Readonly<Partial<Record<Arm, number>>>;
  /**
   * Checking evidence (a scorecard number), not plumbing: refuse every row without evidence
   * provenance, i.e. whose `plannerModelId` is not in `EVIDENCE_PLANNERS`.
   * Dry runs name a `simulated:` planner, so they never pass.
   */
  readonly evidence?: boolean;
  /**
   * Bind the myco-gate rows to their PUBLISHED task set (#509 round 1, D2), with the same
   * module the M2 pack check uses (`src/benchmark/taskset-binding.ts`): exactly a whole number
   * k of runs of a known task set, each task k times with its own faultClass, fixture and
   * instruction hashes, unregistrable exactly on its unsatisfiable tasks, and the asserted
   * split equal to k x those tasks. An unknown task set is an error. The CLI turns this on for
   * `--require-r1` and `--evidence`, so a short or relabelled run cannot pass on numbers the
   * operator typed.
   */
  readonly bindTaskSet?: boolean;
}

/**
 * Evidence provenance, positively: a row counts as evidence only when its planner is exactly
 * one of the Claude model ids this project runs (an allowlist, not a pattern; a new model is
 * added here deliberately). Anything else (`simulated:...`, case, whitespace or Unicode
 * variants, an older or made-up id) is refused under `evidence: true`. This is a declared
 * string: it stops mislabelled dry runs, not a deliberate forgery of the planner field.
 */
export const EVIDENCE_PLANNERS: ReadonlySet<string> = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
]);

/** Host paths must never reach a publishable ledger (M2 plan §6; test/no-home-paths). */
const HOST_PATH = /(?:^|[\s"'(=])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)/;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  wilson95: wilson(numerator, denominator),
});

function provenanceOf(rows: readonly BenchmarkArmRow[]): CheckResult["provenance"] {
  if (rows.length === 0) return null;
  const proven = rows.filter((r) => EVIDENCE_PLANNERS.has(r.plannerModelId)).length;
  if (proven === rows.length) return "evidence";
  return proven === 0 ? "simulated" : "mixed";
}

/** Whether a row's `accepted` is what its claim and gate imply. */
export function expectedAccepted(row: BenchmarkArmRow): boolean {
  if (row.claim !== "done") return false;
  if (row.arm === "hcu+shell") return true;
  return row.gate?.called === true && row.gate.verdict === "verified";
}

export function checkBenchmark(
  armInput: readonly unknown[],
  gradeInput: readonly unknown[],
  options: CheckOptions,
): CheckResult {
  const errors: string[] = [];
  const armRows: BenchmarkArmRow[] = [];
  const gradeRows: BenchmarkGradeRow[] = [];

  armInput.forEach((row, i) => {
    const issues = validateSchema(row, benchmarkArmRowSchema);
    if (issues.length > 0)
      errors.push(...issues.map((s) => `arm row ${i}: ${s.path} ${s.message}`));
    else armRows.push(row as BenchmarkArmRow);
  });
  gradeInput.forEach((row, i) => {
    const issues = validateSchema(row, benchmarkGradeRowSchema);
    if (issues.length > 0)
      errors.push(...issues.map((s) => `grade row ${i}: ${s.path} ${s.message}`));
    else gradeRows.push(row as BenchmarkGradeRow);
  });
  [...armInput, ...gradeInput].forEach((row, i) => {
    if (strings(row).some((s) => HOST_PATH.test(s))) errors.push(`row ${i}: contains a host path`);
  });

  if (armInput.length === 0) errors.push("arm ledger is empty");
  if (options.evidence === true) {
    const unproven = armRows.filter((r) => !EVIDENCE_PLANNERS.has(r.plannerModelId));
    if (unproven.length > 0) {
      const ids = [...new Set(unproven.map((r) => r.plannerModelId))];
      errors.push(
        `${unproven.length} row(s) without evidence provenance (planner ${ids.map((i) => JSON.stringify(i)).join(", ")} is not a Claude model id): dry-run rows are never evidence`,
      );
    }
  }
  if (gradeInput.length === 0) errors.push("grade ledger is empty");

  const taskSetVersions = new Set(armRows.map((r) => r.taskSetVersion));
  const graderVersions = new Set(gradeRows.map((r) => r.graderVersion));
  if (taskSetVersions.size > 1)
    errors.push(`mixed taskSetVersion: ${[...taskSetVersions].join(", ")}`);
  if (graderVersions.size > 1)
    errors.push(`mixed graderVersion: ${[...graderVersions].join(", ")}`);

  const grades = new Map<string, BenchmarkGradeRow>();
  for (const g of gradeRows) {
    if (grades.has(g.trialKey)) errors.push(`duplicate grade for trialKey ${g.trialKey}`);
    grades.set(g.trialKey, g);
  }
  const seen = new Set<string>();
  const arms = new Map<Arm, BenchmarkArmRow[]>();
  for (const row of armRows) {
    if (seen.has(row.trialKey)) errors.push(`duplicate arm row for trialKey ${row.trialKey}`);
    seen.add(row.trialKey);
    arms.set(row.arm, [...(arms.get(row.arm) ?? []), row]);

    if (row.arm === "myco-gate" && row.gate === null)
      errors.push(`${row.trialKey}: myco-gate row has no gate record`);
    if (row.arm === "hcu+shell" && row.gate !== null)
      errors.push(`${row.trialKey}: hcu+shell row has a gate record`);
    if (row.gate !== null && !row.gate.called && row.gate.verdict !== null) {
      errors.push(`${row.trialKey}: gate verdict recorded without a gate call`);
    }
    if (row.gate?.unregistrable === true && (row.gate.called || row.gate.verdict !== null)) {
      errors.push(`${row.trialKey}: an unregistrable task cannot have a gate call or verdict`);
    }
    // In fc-v1 only invalid-target specs are unsatisfiable; any other task registers with the
    // gate, so marking it unregistrable would dodge the gate. A task set with other
    // unregistrable classes must widen this deliberately.
    if (row.gate?.unregistrable === true && row.faultClass !== "invalid-target") {
      errors.push(
        `${row.trialKey}: only an invalid-target task can be unregistrable (got ${row.faultClass})`,
      );
    }
    // The other direction (#509 round 1): the gate's registry rejects every fc-v1
    // invalid-target spec, so a gated arm row on one claims a gate decision that cannot exist.
    if (
      row.arm === "myco-gate" &&
      row.faultClass === "invalid-target" &&
      row.gate?.unregistrable !== true
    ) {
      errors.push(`${row.trialKey}: an invalid-target task cannot be gated (it is unregistrable)`);
    }
    if (row.arm === "myco-gate" && row.accepted && row.persistedSha256 === null) {
      errors.push(`${row.trialKey}: an accepted gated row must carry its captured bytes' sha256`);
    }
    if (row.accepted !== expectedAccepted(row)) {
      errors.push(
        `${row.trialKey}: accepted=${row.accepted} contradicts claim=${row.claim} and gate`,
      );
    }
    const g = grades.get(row.trialKey);
    if (g === undefined) {
      errors.push(`${row.trialKey}: no grade row`);
      continue;
    }
    if (g.taskId !== row.taskId)
      errors.push(`${row.trialKey}: grade taskId ${g.taskId} != arm taskId ${row.taskId}`);
    if (g.fixtureSha256 !== row.fixtureSha256)
      errors.push(`${row.trialKey}: grade graded a different fixture`);
    if (g.persistedSha256 !== row.persistedSha256) {
      errors.push(`${row.trialKey}: grade graded a different persisted document`);
    }
  }
  for (const key of grades.keys())
    if (!seen.has(key)) errors.push(`grade row ${key} has no arm row`);

  for (const [arm, rows] of arms) {
    const planners = new Set(rows.map((r) => r.plannerModelId));
    if (planners.size > 1) errors.push(`${arm}: mixed plannerModelId ${[...planners].join(", ")}`);
    const expected = options.expectTrials[arm];
    if (expected === undefined) errors.push(`${arm}: no expected trial count given`);
    else if (rows.length !== expected)
      errors.push(`${arm}: ${rows.length} trials, expected ${expected}`);
  }
  for (const [arm, rows] of arms) {
    const unreg = rows.filter((r) => r.gate?.unregistrable === true).length;
    const want = options.expectUnregistrable?.[arm];
    const total = options.expectTrials[arm];
    if (want === undefined) {
      if (unreg > 0)
        errors.push(
          `${arm}: ${unreg} unregistrable trial(s) but no asserted gated/unregistrable split`,
        );
    } else {
      if (total !== undefined && want > total)
        errors.push(`${arm}: expected ${want} unregistrable of only ${total} trials`);
      if (unreg !== want) errors.push(`${arm}: ${unreg} unregistrable trials, expected ${want}`);
      if (total !== undefined && rows.length - unreg !== total - want)
        errors.push(`${arm}: ${rows.length - unreg} gated trials, expected ${total - want}`);
    }
  }
  for (const arm of Object.keys(options.expectUnregistrable ?? {}) as Arm[]) {
    if (!arms.has(arm)) errors.push(`${arm}: unregistrable split given, but no ${arm} rows`);
  }
  const gatedRows = arms.get("myco-gate");
  if (options.bindTaskSet === true && gatedRows !== undefined) {
    const binding = bindToTaskSet(gatedRows, { exactMultiset: true });
    errors.push(...binding.errors.map((e) => `myco-gate task set: ${e}`));
    const want = options.expectUnregistrable?.["myco-gate"];
    if (
      want !== undefined &&
      binding.expectedUnregistrable !== null &&
      want !== binding.expectedUnregistrable
    )
      errors.push(
        `myco-gate: asserted split ${want} is not ${binding.version}'s ${binding.expectedUnregistrable} (its unsatisfiable tasks x ${binding.repetitions} run(s))`,
      );
  }
  for (const arm of Object.keys(options.expectTrials) as Arm[]) {
    if (!arms.has(arm))
      errors.push(`${arm}: expected ${options.expectTrials[arm]} trials, found none`);
  }

  const counts: ArmCounts[] = [];
  for (const [arm, rows] of arms) {
    let claimedDone = 0;
    let accepted = 0;
    let acceptedPass = 0;
    let falseDoneAccepted = 0;
    let acceptedUngradable = 0;
    let graderPass = 0;
    let graderFail = 0;
    let ungradable = 0;
    let correctNotAccepted = 0;
    let modelUsd = 0;
    let unmeasuredTrials = 0;
    const unregistrable = { trials: 0, claimedDone: 0, graderFailClaimedDone: 0 };
    const perFaultClass: Record<
      string,
      { trials: number; accepted: number; falseDoneAccepted: number; acceptedUngradable: number }
    > = {};
    for (const row of rows) {
      const status = grades.get(row.trialKey)?.status ?? "ungradable";
      const cls = perFaultClass[row.faultClass] ?? {
        trials: 0,
        accepted: 0,
        falseDoneAccepted: 0,
        acceptedUngradable: 0,
      };
      perFaultClass[row.faultClass] = cls;
      cls.trials++;
      if (row.cost.modelUsd === null) unmeasuredTrials++;
      else modelUsd += row.cost.modelUsd;
      if (row.claim === "done") claimedDone++;
      if (status === "pass") graderPass++;
      else if (status === "fail") graderFail++;
      else ungradable++;
      if (row.accepted) {
        accepted++;
        cls.accepted++;
        if (status === "pass") acceptedPass++;
        else if (status === "fail") {
          falseDoneAccepted++;
          cls.falseDoneAccepted++;
        } else {
          acceptedUngradable++;
          cls.acceptedUngradable++;
        }
      } else if (status === "pass") correctNotAccepted++;
      if (row.gate?.unregistrable === true) {
        unregistrable.trials++;
        if (row.claim === "done") {
          unregistrable.claimedDone++;
          if (status === "fail") unregistrable.graderFailClaimedDone++;
        }
      }
    }
    const bad = falseDoneAccepted + acceptedUngradable;
    let costReason: string | null = null;
    if (unmeasuredTrials > 0)
      costReason = `${unmeasuredTrials} of ${rows.length} trial(s) have no measured model cost`;
    else if (acceptedPass === 0) costReason = "no verified task (accepted DONE graded pass)";
    counts.push({
      arm,
      trials: rows.length,
      claimedDone,
      accepted,
      acceptedPass,
      falseDoneAccepted,
      acceptedUngradable,
      graderPass,
      graderFail,
      ungradable,
      correctNotAccepted,
      unregistrable,
      costPerVerifiedTask: {
        basis: COST_BASIS,
        estimatedUsd: costReason === null ? modelUsd / acceptedPass : null,
        estimatedTotalModelUsd: unmeasuredTrials === 0 ? modelUsd : null,
        verifiedTasks: acceptedPass,
        unmeasuredTrials,
        reason: costReason,
      },
      falseAcceptRate: rate(bad, accepted),
      falseAcceptPerTrial: rate(bad, rows.length),
      acceptedSuccessRate: rate(acceptedPass, rows.length),
      perFaultClass,
    });
  }
  counts.sort((a, b) => a.arm.localeCompare(b.arm));

  const gated = counts.find((c) => c.arm === "myco-gate");
  let r1: R1Verdict | null = null;
  if (gated !== undefined) {
    const reasons: string[] = [];
    if (errors.length > 0) reasons.push("ledgers are not consistent (see errors)");
    if (gated.falseDoneAccepted > 0) reasons.push(`${gated.falseDoneAccepted} false DONE accepted`);
    if (gated.acceptedUngradable > 0)
      reasons.push(`${gated.acceptedUngradable} accepted DONE could not be graded`);
    // No accepted DONE means no false-accept bound exists: "0 false DONE accepted" would be
    // true of a gate that never verifies anything. R1 needs the bound (M2 plan row R1).
    if (gated.accepted === 0 || gated.falseAcceptRate.wilson95 === null) {
      reasons.push(
        "insufficient evidence: no accepted DONE, so no false-accept bound can be reported",
      );
    }
    const notes: string[] = [];
    if (gated.unregistrable.claimedDone > 0) {
      notes.push(
        `${gated.unregistrable.claimedDone} DONE claim(s) on unregistrable tasks were never gated (${gated.unregistrable.graderFailClaimedDone} graded fail); they cannot be accepted, so they are not in the false-accept numerator`,
      );
    }
    r1 = {
      pass: reasons.length === 0,
      reasons,
      falseAcceptRate: gated.falseAcceptRate,
      falseAcceptPerTrial: gated.falseAcceptPerTrial,
      headline: gated.falseAcceptPerTrial,
      gated: {
        trials: gated.trials - gated.unregistrable.trials,
        accepted: gated.accepted,
        falseDoneAccepted: gated.falseDoneAccepted,
        acceptedUngradable: gated.acceptedUngradable,
      },
      unregistrable: gated.unregistrable,
      notes,
    };
  }

  return {
    ok: errors.length === 0,
    errors,
    taskSetVersion: taskSetVersions.size === 1 ? ([...taskSetVersions][0] as string) : null,
    graderVersion: graderVersions.size === 1 ? ([...graderVersions][0] as string) : null,
    arms: counts,
    r1,
    provenance: provenanceOf(armRows),
  };
}
