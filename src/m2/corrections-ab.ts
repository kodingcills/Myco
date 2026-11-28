/**
 * The corrections ON/OFF A/B, analysed under the independent grader (TIF-274 / TIF-265 track B).
 * It compares the gate with the agent-safe corrections (#514) ON against the same gate with them
 * OFF, on paired tasks. This module is the ANALYSIS only; track E's runner (#524 follow-up) runs
 * the arms, owns the pre-registration file, and calls this.
 *
 * The lead's fixed design (recorded on #524, comment 7196445749), as code (change it here and
 * the tests fail, by design):
 *  - **Stage 0, plumbing:** 30 pairs. Its only purpose is to show the paired pipeline works.
 *    The effect claim is NULL whatever the numbers say (`effect: "not-claimed"`), and Stage-0
 *    rows are excluded from Stage 1 (a Stage-1 trial may not reuse a Stage-0 trial).
 *  - **Stage 1, confirmatory:** fc-v1, 100 pairs per arm (each arm exactly fc-v1, bound by
 *    `src/benchmark/taskset-binding.ts`). A ONE-SIDED exact sign test on the discordant pairs
 *    (H1: corrections ON succeed more often), alpha 0.05, reported with the discordant counts
 *    and a 95% confidence interval on the paired difference (Newcombe 1998, method 10).
 *    A miss reads "corrections not shown to help", never a fail.
 *  - **Gate misses:** any trial the gate VERIFIED that the independent grader fails, in either
 *    arm, halts the run as an INTEGRITY INCIDENT, with its own record (`integrityIncidents`),
 *    never counted as data.
 *  - **Identical arms:** the analysis refuses to run unless both arms ran identically apart
 *    from corrections: each arm bound to the same published tasks (so per pair the same
 *    instruction and fixture hashes), the same planner and output ceiling per pair, the same
 *    grader version, and the same recorded run configuration. The config must record retry
 *    budget, pacing, planner and output ceiling (`REQUIRED_CONFIG_KEYS`), state the planner and
 *    ceiling the rows actually ran, and differ between the arms only in `corrections`.
 *  - **Marked rows, fresh seeds:** every row carries `experiment: {id: "corrections-ab", stage,
 *    arm, seed}`, one seed per run. Stage 1 refuses any trial whose key or seed appears in the
 *    Stage-0 ledgers, so a reused trial cannot slip through under a new key.
 *  - **Stage 0's tasks** are exactly the pilot's 30 (`STAGE0_TASK_IDS`), each once.
 *  - **Simulated planners:** refused in Stage 1 outright (it is confirmatory), and in Stage 0
 *    when asked for evidence.
 *  - **Pre-registration:** the sha256 of the committed pre-registration file must equal the
 *    one the pack declares (required for Stage 1; checked for Stage 0 when given).
 *  - **Never R1 evidence:** both arms, the OFF arm included, are experiment-only. That is
 *    enforced, not only labelled: the `experiment` marker on every row makes
 *    `checkBenchmark(..., { evidence: true })` and the M2 pack check refuse the rows
 *    (`experimentRowsError` in `src/benchmark/check.ts`).
 *
 * Success is a verified task: an accepted DONE the independent grader passes. The grader never
 * sees corrections (its inputs are the bundle and the saved document).
 */
import {
  type BenchmarkArmRow,
  checkBenchmark,
  EVIDENCE_PLANNERS,
  type Rate,
} from "../benchmark/check.ts";
import type { BenchmarkGradeRow } from "../benchmark/grade/row.ts";
import { publishedTasks } from "../benchmark/published-tasks.ts";
import { TASK_SET_VERSION } from "../benchmark/task-types.ts";
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

/** How A/B rows may be used: never as R1 evidence, the OFF arm included. */
export const AB_EVIDENCE_USE = "experiment-only (never R1 evidence)" as const;

/** A gate miss: the gate VERIFIED a trial the independent grader does not pass. */
export interface IntegrityIncident {
  readonly arm: "on" | "off";
  readonly trialKey: string;
  readonly taskId: string;
  readonly accepted: boolean;
  readonly grade: "fail" | "ungradable" | "missing";
}

export interface AbResult {
  /** True when every precondition holds, the pairs are complete and no gate missed. */
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly stage: AbStage;
  readonly evidenceUse: typeof AB_EVIDENCE_USE;
  /** True when the gate missed in either arm: an integrity incident, not data. */
  readonly halted: boolean;
  readonly integrityIncidents: readonly IntegrityIncident[];
  readonly pairs: number;
  /** Both arms verified / ON only / OFF only / neither. */
  readonly table: {
    readonly both: number;
    readonly onOnly: number;
    readonly offOnly: number;
    readonly neither: number;
  };
  /** The discordant pairs the sign test uses (concordant ones carry no weight). */
  readonly discordant: {
    readonly onOnly: number;
    readonly offOnly: number;
    readonly total: number;
  };
  readonly onSuccess: Rate;
  readonly offSuccess: Rate;
  /** One-sided exact sign test on the discordant pairs (H1: ON better). 1 with none. */
  readonly signTestOneSidedP: number;
  /** ON success rate minus OFF success rate, with its Newcombe (method 10) 95% interval. */
  readonly difference: {
    readonly estimate: number | null;
    readonly ci95: readonly [number, number] | null;
  };
  /**
   * Stage 0: always `not-claimed`. Stage 1, when ok: `corrections-help` when p < alpha,
   * otherwise `corrections-not-shown-to-help` (a miss is never a fail). `none` when not ok.
   */
  readonly effect: "not-claimed" | "corrections-help" | "corrections-not-shown-to-help" | "none";
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
/**
 * Pairs are by task. Each arm is bound to the published task set (fixture, fault class and
 * instruction hashes are the task's own), so the task id fixes the rest (#547 round 1, V1/V8).
 */
const pairKey = (r: BenchmarkArmRow) => r.taskId;

/**
 * Stage 0's tasks: the pilot's 30, fc-v1's demo subset (the first 18 clean tasks and the first
 * 3 of each fault class, by task id; the same selection as #524's `PILOT_STRATA`), read from
 * the published bundle, not rebuilt from the task generators (#547 O1 follow-up).
 */
export const STAGE0_TASK_IDS: ReadonlySet<string> = new Set(
  (publishedTasks(TASK_SET_VERSION) ?? []).filter((t) => t.inDemo).map((t) => t.taskId),
);

/** The run-config keys the parity check requires present in both arms (#547 round 1, D3). */
export const REQUIRED_CONFIG_KEYS = [
  "retryBudget",
  "pacing",
  "plannerModelId",
  "outputCeiling",
] as const;

/** JSON with object keys sorted, so two configs compare by content, not key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** One arm of the A/B: its own run's arm ledger and grade ledger. */
export interface AbArm {
  readonly arm: readonly unknown[];
  readonly grades: readonly unknown[];
}

/** The inputs: the two arms, their run configs, Stage 0's ledgers (for Stage 1), the pre-registration. */
export interface AbInput {
  readonly on: AbArm;
  readonly off: AbArm;
  /**
   * Each arm's run configuration as the runner recorded it (retry budget, pacing, planner,
   * output ceiling, ...). Each names its own `corrections` ("on" / "off"); apart from that key
   * the two must be identical.
   */
  readonly runConfigs: {
    readonly on: Readonly<Record<string, unknown>>;
    readonly off: Readonly<Record<string, unknown>>;
  };
  /** Stage 1 only: the Stage-0 arm ledgers, so no Stage-1 trial reuses a Stage-0 one. */
  readonly stage0?: { readonly on: readonly unknown[]; readonly off: readonly unknown[] };
  /**
   * The pre-registration: the sha256 of the committed file and the one the pack declares.
   * Required for Stage 1.
   */
  readonly preregistration?: { readonly committedSha256: string; readonly declaredSha256: string };
}

/**
 * Analyse the A/B. The two arms are two runs, each with its own ledgers: ON rows cannot be
 * told from OFF rows by a field alone (an unregistrable or refused row never called the gate,
 * so it records no corrections setting), so the arm is the ledger it came from. Every row of
 * the ON ledger whose gate was called must say `corrections: "on"`, and no OFF row may.
 */
export function checkCorrectionsAb(
  input: AbInput,
  opts: { readonly stage: AbStage; readonly evidence?: boolean },
): AbResult {
  const { pairs: wantPairs, effectClaim } = AB_STAGES[opts.stage];
  const errors: string[] = [];

  // Identical arms apart from corrections: the runner's recorded run configs.
  const { on: cfgOn, off: cfgOff } = input.runConfigs;
  if (cfgOn.corrections !== "on") errors.push('the ON run config does not say corrections: "on"');
  if (cfgOff.corrections !== "off")
    errors.push('the OFF run config does not say corrections: "off"');
  for (const [name, cfg] of [
    ["ON", cfgOn],
    ["OFF", cfgOff],
  ] as const) {
    const missing = REQUIRED_CONFIG_KEYS.filter(
      (k) => !Object.hasOwn(cfg, k) || cfg[k] === undefined,
    );
    if (missing.length > 0)
      errors.push(`the ${name} run config does not record ${missing.join(", ")}`);
  }
  const { corrections: _a, ...restOn } = cfgOn;
  const { corrections: _b, ...restOff } = cfgOff;
  if (canonical(restOn) !== canonical(restOff)) {
    const keys = [...new Set([...Object.keys(restOn), ...Object.keys(restOff)])].filter(
      (k) => canonical(restOn[k]) !== canonical(restOff[k]),
    );
    errors.push(`the arms ran differently apart from corrections: ${keys.sort().join(", ")}`);
  }

  // The pre-registration: required for Stage 1, checked whenever given.
  const prereg = input.preregistration;
  if (prereg === undefined) {
    if (opts.stage === 1)
      errors.push("Stage 1 needs the pre-registration hash (committed and declared)");
  } else if (prereg.committedSha256 !== prereg.declaredSha256)
    errors.push("the pack's pre-registration hash is not the committed file's");

  // Stage-0 rows are excluded from Stage 1.
  if (opts.stage === 1) {
    if (input.stage0 === undefined)
      errors.push("Stage 1 needs the Stage-0 ledgers (to exclude their trials)");
    else {
      // A trial's identity is its key AND its run's seed: a Stage-0 trial re-ledgered under a
      // new key still carries its Stage-0 seed (#547 round 1, D2).
      const s0 = [...input.stage0.on, ...input.stage0.off] as BenchmarkArmRow[];
      const usedKeys = new Set(s0.map((r) => r.trialKey));
      const usedSeeds = new Set(
        s0.flatMap((r) => (r.experiment === undefined ? [] : [r.experiment.seed])),
      );
      if (s0.some((r) => r.experiment?.stage !== 0))
        errors.push("the Stage-0 ledgers hold rows not marked as Stage 0");
      const s1 = [...input.on.arm, ...input.off.arm] as BenchmarkArmRow[];
      const reused = s1.filter(
        (r) =>
          usedKeys.has(r.trialKey) ||
          (r.experiment !== undefined && usedSeeds.has(r.experiment.seed)),
      );
      if (reused.length > 0)
        errors.push(
          `${reused.length} Stage-1 trial(s) reuse Stage-0 trials (${reused[0]?.trialKey}): Stage-0 rows are excluded`,
        );
    }
  }

  const incidents: IntegrityIncident[] = [];
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
      // Stage 0 is exactly the pilot's 30 tasks, each once (#547 round 1, D6).
      const ids = rows.map((r) => r.taskId);
      const outside = ids.filter((id) => !STAGE0_TASK_IDS.has(id));
      const missing = [...STAGE0_TASK_IDS].filter((id) => !ids.includes(id));
      if (outside.length > 0 || missing.length > 0)
        errors.push(
          `corrections-${name}: Stage 0 is the pilot's ${STAGE0_TASK_IDS.size} tasks (${outside.length} outside, ${missing.length} missing)`,
        );
    }
    // Every row carries the experiment marker for this stage and arm, one seed per run
    // (#547 round 1, D1/D2): unmarked rows could pass as R1 evidence.
    const unmarked = rows.filter(
      (r) =>
        r.experiment === undefined ||
        r.experiment.stage !== opts.stage ||
        r.experiment.arm !== side,
    );
    if (unmarked.length > 0)
      errors.push(
        `corrections-${name}: ${unmarked.length} row(s) not marked as corrections-ab Stage ${opts.stage}, arm ${side} (${unmarked[0]?.trialKey})`,
      );
    const seeds = new Set(
      rows.flatMap((r) => (r.experiment === undefined ? [] : [r.experiment.seed])),
    );
    if (seeds.size > 1) errors.push(`corrections-${name}: one run, one seed (got ${seeds.size})`);
    // The recorded config states the planner and ceiling the rows ran (#547 round 1, D3).
    const cfg = side === "on" ? cfgOn : cfgOff;
    if (
      rows.some(
        (r) => r.plannerModelId !== cfg.plannerModelId || r.outputCeiling !== cfg.outputCeiling,
      )
    )
      errors.push(
        `corrections-${name}: rows ran another planner or output ceiling than the run config records`,
      );
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
    // Stage 1 is confirmatory: simulated planners are refused outright, flag or no flag
    // (#547 round 1, D5). Stage 0 refuses them only when asked for evidence.
    if (opts.stage === 1 || opts.evidence === true) {
      const unproven = rows.filter((r) => !EVIDENCE_PLANNERS.has(r.plannerModelId));
      if (unproven.length > 0)
        errors.push(
          `corrections-${name}: ${unproven.length} row(s) without evidence provenance: dry-run rows are never evidence${opts.stage === 1 ? " (Stage 1 is confirmatory)" : ""}`,
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
    // Gate misses: the gate verified, the independent grader does not pass.
    for (const r of rows) {
      const g = grades.get(r.trialKey)?.status;
      if (r.gate?.verdict === "verified" && g !== "pass")
        incidents.push({
          arm: side,
          trialKey: r.trialKey,
          taskId: r.taskId,
          accepted: r.accepted,
          grade: g ?? "missing",
        });
    }
    const graderVersions = new Set(
      (input[side].grades as readonly BenchmarkGradeRow[]).map((g) => g.graderVersion),
    );
    return { by, verified, graderVersions };
  });
  const [onArm, offArm] = arms as [(typeof arms)[number], (typeof arms)[number]];
  // One grader for both arms (#547 round 1, D4).
  const graders = new Set([...onArm.graderVersions, ...offArm.graderVersions]);
  if (graders.size > 1)
    errors.push(`the arms were graded by different graders: ${[...graders].sort().join(", ")}`);

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

  const halted = incidents.length > 0;
  if (halted) {
    const on = incidents.filter((i) => i.arm === "on").length;
    errors.push(
      `INTEGRITY INCIDENT: the gate verified ${incidents.length} trial(s) the grader fails (corrections ON ${on}, OFF ${incidents.length - on}): the run halts and is reported, never counted`,
    );
  }

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
    evidenceUse: AB_EVIDENCE_USE,
    halted,
    integrityIncidents: incidents,
    pairs: paired,
    table: { both, onOnly, offOnly, neither },
    discordant: { onOnly, offOnly, total: onOnly + offOnly },
    onSuccess: rate(both + onOnly, paired),
    offSuccess: rate(both + offOnly, paired),
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
          ? "corrections-help"
          : "corrections-not-shown-to-help",
  };
}
