/**
 * Capability track I: the pre-registered analysis (capability spec §2 I, §1.4, §1.5, §3).
 *
 * Input: a pack of graded trial rows for the two primary arms, `C1+I` and `C1`, on fc-v1
 * (k = 1). Output: whether each bar component is shown, with the numbers, in the fixed
 * sequence; a component that is not shown blocks the later one. "Not shown" is always
 * reported as such, with the reason, never rounded to a win.
 *
 * - **Verified task** (§1.1, gate-less rows): the agent claimed done AND the independent
 *   grader graded the captured document `pass`. `ungradable` is never verified; a `pass`
 *   without a done claim is "correct, not claimed". The gate's verdict is not an input.
 * - **Bar 1:** exact one-sided McNemar on verified over the 90 satisfiable tasks, `C1+I`
 *   better, p <= 0.05 with at least 5 discordant tasks.
 * - **Bar 2** (only if 1 is shown): steps per verified task (total steps over ALL
 *   satisfiable trials / verified tasks); the one-sided 95% upper bound of the paired
 *   bootstrap ratio `C1+I`/`C1` (10,000 resamples over tasks, the pre-registered seed) is
 *   below 1.0.
 * - **Guardrails:** false DONEs on the 10 invalid-target tasks no higher in `C1+I`; any
 *   tool-output scan breach voids the run.
 * - **Refusals** (the whole result is "not shown"): a pack hash that is not the committed
 *   pre-registration's, a row that is not exactly `simulated: false` (absent, `"false"` or
 *   `true` are all refused: fail closed) or has a non-model planner (§3 item 5), a planner
 *   other than the pre-registered model, a malformed row, a step count over the budget, or a
 *   task/arm cell that is missing or duplicated (no exclusions: every trial stays in the
 *   denominator).
 * - **Lead ruling pending:** while the pre-registration's `leadRulingPending` is non-empty
 *   (or not a list of strings), the status is `LEAD_RULING_PENDING` and no bar component is
 *   ever shown, whatever the pack says. A proposed bar is never reported as met.
 *
 * Pure: no file system, no gate, no grader. The CLI (`scripts/capability-i-analysis.ts`)
 * loads the files and the committed pre-registration.
 */
import {
  I_BASELINE_ARM,
  I_CAPABILITY_ARM,
  type IArm,
  type IPrereg,
  seededUniforms,
} from "./prereg.ts";

export const I_PACK_SCHEMA = "myco.capability.i-pack/1" as const;

export interface ITrialRow {
  readonly arm: IArm;
  readonly taskId: string;
  readonly simulated: boolean;
  readonly plannerModelId: string;
  readonly claim: "done" | "not-done" | "no-claim";
  /** The independent grader's grade; null if the trial was never graded. */
  readonly grade: "pass" | "fail" | "ungradable" | null;
  /** Agent tool calls of any kind; null when unmeasured. */
  readonly steps: number | null;
  /** The per-row scan of recorded tool outputs found a fixture value, host path or digest. */
  readonly toolOutputBreach: boolean;
}

export interface IPack {
  readonly schema: typeof I_PACK_SCHEMA;
  readonly preregSha256: string;
  readonly preregCommit: string;
  readonly rows: readonly ITrialRow[];
}

/** The fc-v1 task facts the analysis needs, read from the frozen tasks.jsonl. */
export interface ITaskFact {
  readonly taskId: string;
  readonly satisfiable: boolean;
  readonly faultClass: string;
}

export const verified = (r: Pick<ITrialRow, "claim" | "grade">): boolean =>
  r.claim === "done" && r.grade === "pass";

export const falseDone = (r: Pick<ITrialRow, "claim" | "grade">): boolean =>
  r.claim === "done" && (r.grade === "fail" || r.grade === "ungradable");

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

/** log C(n, k), exact enough for n <= a few thousand. */
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/**
 * Exact one-sided McNemar p-value (sign test on discordant tasks): P(X >= favouring) for
 * X ~ Binomial(favouring + against, 1/2). 1 when there are no discordant tasks.
 */
export function mcnemarOneSidedP(favouring: number, against: number): number {
  if (!Number.isInteger(favouring) || !Number.isInteger(against) || favouring < 0 || against < 0)
    throw new Error("discordant counts must be non-negative integers");
  const d = favouring + against;
  if (d === 0) return 1;
  let p = 0;
  for (let k = favouring; k <= d; k++) p += Math.exp(logChoose(d, k) - d * Math.LN2);
  return Math.min(1, p);
}

/** Wilson 95% interval for k of n (§1.4: every count has its denominator and interval). */
export function wilson95(k: number, n: number): { readonly lo: number; readonly hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.959963984540054;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { lo: Math.max(0, mid - half), hi: Math.min(1, mid + half) };
}

export interface PairedTask {
  readonly taskId: string;
  readonly cap: { readonly verified: boolean; readonly steps: number };
  readonly base: { readonly verified: boolean; readonly steps: number };
}

/** Steps per verified task for one arm over a list of tasks; Infinity when none verified. */
function stepsPerVerified(tasks: readonly PairedTask[], arm: "cap" | "base"): number {
  let steps = 0;
  let v = 0;
  for (const t of tasks) {
    steps += t[arm].steps;
    if (t[arm].verified) v++;
  }
  return v === 0 ? Number.POSITIVE_INFINITY : steps / v;
}

/**
 * The paired-bootstrap one-sided 95% upper bound of steps-per-verified(cap) /
 * steps-per-verified(base): `resamples` resamples of the tasks with replacement, drawn from
 * the seeded stream; percentile method, the ceil(0.95 * B)-th smallest ratio. A resample in
 * which either arm verifies nothing has ratio +Infinity (it can never help the capability).
 */
export function bootstrapRatioUpper95(
  tasks: readonly PairedTask[],
  seed: string,
  resamples: number,
): { readonly point: number; readonly upper95: number } {
  if (tasks.length === 0) throw new Error("no tasks to resample");
  const ratio = (ts: readonly PairedTask[]) => {
    const c = stepsPerVerified(ts, "cap");
    const b = stepsPerVerified(ts, "base");
    return Number.isFinite(c) && Number.isFinite(b) && b > 0 ? c / b : Number.POSITIVE_INFINITY;
  };
  const u = seededUniforms(seed);
  const n = tasks.length;
  const ratios: number[] = [];
  const sample: PairedTask[] = new Array(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) sample[i] = tasks[Math.floor(u() * n)] as PairedTask;
    ratios.push(ratio(sample));
  }
  ratios.sort((a, b) => a - b);
  return { point: ratio(tasks), upper95: ratios[Math.ceil(0.95 * resamples) - 1] as number };
}

// ---------------------------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------------------------

export interface ArmSummary {
  readonly trials: number;
  readonly verified: number;
  readonly verifiedWilson95: { readonly lo: number; readonly hi: number };
  readonly falseDone: number;
  readonly stepsPerVerified: number | null;
}

export type ComponentResult =
  | {
      readonly id: 1;
      readonly shown: boolean;
      readonly discordant: number;
      readonly favouring: number;
      readonly against: number;
      readonly p: number;
      readonly reason: string | null;
    }
  | {
      readonly id: 2;
      readonly shown: boolean;
      readonly point: number | null;
      readonly upper95: number | null;
      readonly reason: string | null;
    };

export const LEAD_RULING_PENDING = "LEAD_RULING_PENDING" as const;
export type IStatus = "shown" | "not-shown" | typeof LEAD_RULING_PENDING;

export interface IAnalysis {
  readonly schema: "myco.capability.i-analysis/1";
  readonly preregSha256: string;
  /**
   * `LEAD_RULING_PENDING` whenever the pre-registration has a pending lead ruling (it wins
   * over everything else); otherwise `shown` exactly when `barShown`.
   */
  readonly status: IStatus;
  /** The pre-registration's pending lead rulings, copied so the output names them. */
  readonly leadRulingPending: readonly string[];
  /**
   * True only when every bar component is shown, no guardrail or refusal applies, and no
   * lead ruling is pending.
   */
  readonly barShown: boolean;
  /** Refusals and guardrail breaches: any entry makes the whole bar "not shown". */
  readonly refusals: readonly string[];
  readonly components: readonly ComponentResult[];
  readonly satisfiable: { readonly cap: ArmSummary; readonly base: ArmSummary };
  readonly invalidTarget: { readonly capFalseDone: number; readonly baseFalseDone: number };
}

function summarize(rows: readonly ITrialRow[]): ArmSummary {
  const v = rows.filter(verified).length;
  const steps = rows.map((r) => r.steps);
  const measured = steps.every((s): s is number => s !== null);
  const total = measured ? (steps as number[]).reduce((a, b) => a + b, 0) : null;
  return {
    trials: rows.length,
    verified: v,
    verifiedWilson95: wilson95(v, rows.length),
    falseDone: rows.filter(falseDone).length,
    stepsPerVerified: total === null || v === 0 ? null : total / v,
  };
}

export interface IAnalysisContext {
  readonly prereg: IPrereg;
  /** The committed pre-registration's hash (`loadIPrereg`). */
  readonly preregSha256: string;
  readonly tasks: readonly ITaskFact[];
  /**
   * The pre-registration hash as committed at `pack.preregCommit`, or null if that commit
   * does not hold it (the CLI reads `git show <commit>:<prereg.json>`).
   */
  readonly preregHashAtCommit: (commit: string) => string | null;
}

const CLAIMS: readonly unknown[] = ["done", "not-done", "no-claim"];
const GRADES: readonly unknown[] = ["pass", "fail", "ungradable", null];

/** The first field of a pack row that does not have its declared type, or null. */
export function rowShapeProblem(r: unknown): string | null {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return "row is not an object";
  const o = r as Record<string, unknown>;
  if (typeof o.taskId !== "string") return "taskId is not a string";
  if (typeof o.arm !== "string") return "arm is not a string";
  if (typeof o.plannerModelId !== "string") return "plannerModelId is not a string";
  if (!CLAIMS.includes(o.claim)) return "claim is not done, not-done or no-claim";
  if (!GRADES.includes(o.grade)) return "grade is not pass, fail, ungradable or null";
  if (o.steps !== null && typeof o.steps !== "number") return "steps is not a number or null";
  if (typeof o.toolOutputBreach !== "boolean") return "toolOutputBreach is not a boolean";
  return null;
}

/** The pending lead rulings; a field that is not a list of strings counts as pending. */
export function pendingLeadRulings(prereg: Pick<IPrereg, "leadRulingPending">): string[] {
  const l: unknown = prereg.leadRulingPending;
  if (!Array.isArray(l) || !l.every((x) => typeof x === "string"))
    return ["leadRulingPending is not a list of strings"];
  return [...l];
}

export function analyzeIPack(pack: IPack, ctx: IAnalysisContext): IAnalysis {
  const refusals: string[] = [];
  const p = ctx.prereg;
  const pending = pendingLeadRulings(p);
  if (pack.schema !== I_PACK_SCHEMA) refusals.push(`pack schema is not ${I_PACK_SCHEMA}`);
  if (pack.preregSha256 !== ctx.preregSha256)
    refusals.push("pack pre-registration hash does not match the committed pre-registration");
  else if (
    !/^[0-9a-f]{7,40}$/.test(pack.preregCommit ?? "") ||
    ctx.preregHashAtCommit(pack.preregCommit) !== ctx.preregSha256
  )
    refusals.push("pack's pre-registration commit does not hold this pre-registration");

  const facts = new Map(ctx.tasks.map((t) => [t.taskId, t]));
  const cells = new Map<string, ITrialRow>();
  const rows: readonly ITrialRow[] = Array.isArray(pack.rows) ? pack.rows : [];
  if (!Array.isArray(pack.rows)) refusals.push("pack rows is not a list");
  for (const [i, r] of rows.entries()) {
    const shape = rowShapeProblem(r);
    if (shape !== null) {
      refusals.push(`row ${i}: malformed (${shape})`);
      continue;
    }
    if (r.simulated !== false || !r.plannerModelId.startsWith("claude-"))
      refusals.push(`${r.taskId}/${r.arm}: simulated row, never evidence`);
    else if (r.plannerModelId !== p.modelId)
      refusals.push(`${r.taskId}/${r.arm}: planner is not the pre-registered model`);
    if (r.arm !== I_CAPABILITY_ARM && r.arm !== I_BASELINE_ARM)
      refusals.push(`${r.taskId}: arm ${String(r.arm)} is not a primary arm`);
    if (!facts.has(r.taskId)) refusals.push(`${r.taskId}: not an fc-v1 task`);
    if (r.steps !== null && (!Number.isInteger(r.steps) || r.steps < 0 || r.steps > p.stepBudget))
      refusals.push(`${r.taskId}/${r.arm}: steps outside [0, ${p.stepBudget}]`);
    if (r.toolOutputBreach)
      refusals.push(`${r.taskId}/${r.arm}: tool-output scan breach (the run is void)`);
    const key = `${r.taskId}\u0000${r.arm}`;
    if (cells.has(key)) refusals.push(`${r.taskId}/${r.arm}: duplicate trial`);
    cells.set(key, r);
  }
  for (const t of ctx.tasks)
    for (const arm of [I_CAPABILITY_ARM, I_BASELINE_ARM])
      if (!cells.has(`${t.taskId}\u0000${arm}`))
        refusals.push(`${t.taskId}/${arm}: missing trial (no exclusions)`);
  const sat = ctx.tasks.filter((t) => t.satisfiable);
  const inv = ctx.tasks.filter((t) => !t.satisfiable);
  if (sat.length !== p.taskSet.satisfiable || inv.length !== p.taskSet.invalidTarget)
    refusals.push("task facts do not split 90 satisfiable / 10 invalid-target");

  const rowsOf = (ts: readonly ITaskFact[], arm: IArm) =>
    ts.map((t) => cells.get(`${t.taskId}\u0000${arm}`)).filter((r): r is ITrialRow => !!r);
  const capSat = rowsOf(sat, I_CAPABILITY_ARM);
  const baseSat = rowsOf(sat, I_BASELINE_ARM);
  const capFalseDone = rowsOf(inv, I_CAPABILITY_ARM).filter(falseDone).length;
  const baseFalseDone = rowsOf(inv, I_BASELINE_ARM).filter(falseDone).length;
  if (capFalseDone > baseFalseDone)
    refusals.push(
      `guardrail: ${capFalseDone} false DONEs on invalid-target tasks in C1+I vs ${baseFalseDone} in C1`,
    );

  // Bar 1: exact one-sided McNemar on verified, satisfiable tasks.
  let favouring = 0;
  let against = 0;
  for (const t of sat) {
    const c = cells.get(`${t.taskId}\u0000${I_CAPABILITY_ARM}`);
    const b = cells.get(`${t.taskId}\u0000${I_BASELINE_ARM}`);
    if (!c || !b) continue;
    if (verified(c) && !verified(b)) favouring++;
    if (!verified(c) && verified(b)) against++;
  }
  const b1 = p.bar[0] as IPrereg["bar"][number];
  const discordant = favouring + against;
  const pValue = mcnemarOneSidedP(favouring, against);
  const b1Reason =
    refusals.length > 0
      ? "refused (see refusals)"
      : pending.length > 0
        ? LEAD_RULING_PENDING
        : discordant < (b1.minDiscordant ?? 5)
          ? `underpowered at n: ${discordant} discordant tasks`
          : pValue > b1.alpha
            ? `p = ${pValue.toFixed(4)} > ${b1.alpha}`
            : null;
  const c1: ComponentResult = {
    id: 1,
    shown: b1Reason === null,
    discordant,
    favouring,
    against,
    p: pValue,
    reason: b1Reason,
  };

  // Bar 2: only if bar 1 is shown.
  const b2 = p.bar[1] as IPrereg["bar"][number];
  let c2: ComponentResult;
  if (!c1.shown)
    c2 = { id: 2, shown: false, point: null, upper95: null, reason: "bar 1 not shown" };
  else {
    const paired: PairedTask[] = [];
    let unmeasured = false;
    for (const t of sat) {
      const c = cells.get(`${t.taskId}\u0000${I_CAPABILITY_ARM}`) as ITrialRow;
      const b = cells.get(`${t.taskId}\u0000${I_BASELINE_ARM}`) as ITrialRow;
      if (c.steps === null || b.steps === null) unmeasured = true;
      paired.push({
        taskId: t.taskId,
        cap: { verified: verified(c), steps: c.steps ?? 0 },
        base: { verified: verified(b), steps: b.steps ?? 0 },
      });
    }
    if (unmeasured)
      c2 = { id: 2, shown: false, point: null, upper95: null, reason: "steps unmeasured" };
    else {
      const { point, upper95 } = bootstrapRatioUpper95(
        paired,
        p.seeds.bootstrap,
        b2.resamples ?? 10_000,
      );
      const threshold = b2.threshold ?? 1;
      c2 = {
        id: 2,
        shown: upper95 < threshold,
        point,
        upper95,
        reason: upper95 < threshold ? null : `upper bound ${upper95.toFixed(4)} >= ${threshold}`,
      };
    }
  }

  const barShown = pending.length === 0 && refusals.length === 0 && c1.shown && c2.shown;
  return {
    schema: "myco.capability.i-analysis/1",
    preregSha256: ctx.preregSha256,
    status: pending.length > 0 ? LEAD_RULING_PENDING : barShown ? "shown" : "not-shown",
    leadRulingPending: pending,
    barShown,
    refusals,
    components: [c1, c2],
    satisfiable: { cap: summarize(capSat), base: summarize(baseSat) },
    invalidTarget: { capFalseDone, baseFalseDone },
  };
}
