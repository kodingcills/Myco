/**
 * Track J, pre-registration j-v1: the frozen analysis script.
 *
 * This file is named, with its SHA-256, in `docs/product/capability-prereg/j-v1/prereg.json`
 * (capability spec §3 item 1). It imports nothing but `node:crypto`, so that hash pins the
 * whole computation: a change to any line here is a change to the pre-registration, which
 * after the first run means a new version (`j-v2`), never an edit.
 *
 * What it computes (capability spec §2 J and §1.5), on paired rows over fc-v1's 90
 * satisfiable tasks, k trials per task per arm (k = 2 by the lead's ruling of 2026-11-27
 * 05:39Z; k = 1 is the spec's default and the ruling's fallback):
 *
 * 1. **Verified rate non-inferior.** The one-sided 95% upper bound of
 *    (`hcu+shell` rate − `hcu+shell+J` rate), Newcombe's paired score interval (1998,
 *    method 10, with z for one-sided 95%) over the tasks · k (task, repeat) pairs, is below
 *    the margin.
 * 2. **Wall time per verified task.** Paired bootstrap over tasks (each task carrying all its
 *    repeats): the one-sided 95% upper bound of J/baseline is below 1.0.
 * 3. **Steps per verified task.** The same resamples: the upper bound of J/baseline is below
 *    1.0.
 *
 * The components are tested in that fixed sequence at alpha 0.05 each: a later one is tested
 * only if every earlier one is shown. The bar is "shown" only when all three are shown and
 * nothing blocks (a lead ruling pending, a simulated row, a planner mismatch, a guardrail
 * breach, a failed parity check). It refuses to compute at all when the pack's
 * pre-registration hash does not match, the pack does not record the commit the
 * pre-registration was frozen in, a row is malformed, or the design is not exactly the
 * pre-registered one (every scheduled trial once, with the task and arm the seeded schedule
 * put at its position).
 *
 * Parity (spec §1.3, §1.5): every row records its instruction text's SHA-256, its fixture's
 * SHA-256, its step budget and its output ceiling. All trials of one task, in both arms, must
 * share the instruction and fixture hashes, and every row's step budget and output ceiling
 * must be the pre-registered ones; otherwise the bar is not shown (`PARITY_MISMATCH`).
 *
 * The output is an analysis report for people; it is never shown to an agent.
 */

import { createHash } from "node:crypto";

export const J_V1_ANALYSIS = "myco.capability.j-v1.analysis/1" as const;
export const J_V1_TRIAL_SCHEMA = "myco.capability.j-v1.trial/1" as const;
export const J_V1_PREREG_SCHEMA = "myco.capability.prereg/1" as const;
export const J_BASELINE_ARM = "hcu+shell" as const;
export const J_CAPABILITY_ARM = "hcu+shell+J" as const;
export type JArm = typeof J_BASELINE_ARM | typeof J_CAPABILITY_ARM;

/** z for a one-sided 95% bound (the 95th percentile of the standard normal). */
export const Z_ONE_SIDED_95 = 1.6448536269514722;
/** z for a two-sided 95% interval, used only for the per-arm Wilson intervals (§1.4). */
export const Z_TWO_SIDED_95 = 1.959963984540054;

const BAR_SEQUENCE = [
  { id: "verified-rate-non-inferiority", test: "newcombe-paired-score-upper" },
  { id: "wall-time-per-verified", test: "paired-bootstrap-ratio-upper" },
  { id: "steps-per-verified", test: "paired-bootstrap-ratio-upper" },
] as const;
export type BarComponentId = (typeof BAR_SEQUENCE)[number]["id"];

const MODEL_ID = /^claude-[a-z0-9.-]+$/;

// ---------------------------------------------------------------------------------------
// Canonical JSON and the pre-registration hash.

/** JSON with object keys sorted by UTF-16 code unit, no whitespace; undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("canonicalJson: non-finite number");
  return JSON.stringify(value);
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The pre-registration hash: SHA-256 over the canonical JSON of prereg.json (§3 item 1). */
export function preregHash(prereg: unknown): string {
  return sha256(canonicalJson(prereg));
}

// ---------------------------------------------------------------------------------------
// The pre-registered random stream.

/** mulberry32, seeded with the first four bytes (big-endian) of SHA-256(seed). */
export function seededUniform(seed: string): () => number {
  let a = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------
// The pre-registration, as this script reads it.

export interface JV1Prereg {
  readonly schema: typeof J_V1_PREREG_SCHEMA;
  readonly track: "J";
  readonly version: "j-v1";
  readonly leadRulingPending: readonly string[];
  readonly modelId: string;
  readonly stepBudget: number;
  /** The planner's output ceiling (max output tokens per turn), the same in both arms. */
  readonly outputCeiling: number;
  /** k: trials per task per arm (lead ruling 2026-11-27 05:39Z: 2). */
  readonly runsPerTaskPerArm: number;
  readonly arms: {
    readonly baseline: typeof J_BASELINE_ARM;
    readonly capability: typeof J_CAPABILITY_ARM;
  };
  readonly taskSet: { readonly taskIds: readonly string[] };
  readonly seeds: { readonly assignment: string; readonly bootstrap: string };
  readonly bar: {
    readonly alphaOneSided: number;
    readonly sequence: readonly {
      readonly id: BarComponentId;
      readonly test: string;
      readonly confidenceOneSided: number;
      readonly marginPoints?: number;
      readonly resamples?: number;
      readonly threshold?: number;
    }[];
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems with the pre-registration's fields this script depends on. Empty when usable. */
export function preregProblems(raw: unknown): string[] {
  const p: string[] = [];
  if (!isObj(raw)) return ["PREREG_NOT_OBJECT"];
  if (raw.schema !== J_V1_PREREG_SCHEMA) p.push("PREREG_SCHEMA");
  if (raw.track !== "J" || raw.version !== "j-v1") p.push("PREREG_TRACK_VERSION");
  if (
    !Array.isArray(raw.leadRulingPending) ||
    raw.leadRulingPending.some((x) => typeof x !== "string")
  )
    p.push("PREREG_LEAD_RULING_PENDING_FIELD");
  if (typeof raw.modelId !== "string" || !MODEL_ID.test(raw.modelId)) p.push("PREREG_MODEL_ID");
  if (!Number.isSafeInteger(raw.stepBudget) || (raw.stepBudget as number) < 1)
    p.push("PREREG_STEP_BUDGET");
  if (!Number.isSafeInteger(raw.outputCeiling) || (raw.outputCeiling as number) < 1)
    p.push("PREREG_OUTPUT_CEILING");
  if (raw.runsPerTaskPerArm !== 1 && raw.runsPerTaskPerArm !== 2) p.push("PREREG_RUNS_PER_TASK");
  if (
    !isObj(raw.arms) ||
    raw.arms.baseline !== J_BASELINE_ARM ||
    raw.arms.capability !== J_CAPABILITY_ARM
  )
    p.push("PREREG_ARMS");
  const ids = isObj(raw.taskSet) ? raw.taskSet.taskIds : undefined;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((x) => typeof x !== "string" || x.length === 0) ||
    new Set(ids).size !== ids.length
  )
    p.push("PREREG_TASK_IDS");
  if (
    !isObj(raw.seeds) ||
    typeof raw.seeds.assignment !== "string" ||
    typeof raw.seeds.bootstrap !== "string" ||
    raw.seeds.assignment.length < 16 ||
    raw.seeds.bootstrap.length < 16 ||
    raw.seeds.assignment === raw.seeds.bootstrap
  )
    p.push("PREREG_SEEDS");
  const bar = raw.bar;
  if (!isObj(bar) || bar.alphaOneSided !== 0.05 || !Array.isArray(bar.sequence)) {
    p.push("PREREG_BAR");
    return p;
  }
  const seq = bar.sequence as unknown[];
  if (seq.length !== BAR_SEQUENCE.length) p.push("PREREG_BAR_SEQUENCE");
  BAR_SEQUENCE.forEach((want, i) => {
    const c = seq[i];
    if (!isObj(c) || c.id !== want.id || c.test !== want.test || c.confidenceOneSided !== 0.95) {
      p.push(`PREREG_BAR_COMPONENT_${i + 1}`);
      return;
    }
    if (i === 0) {
      const m = c.marginPoints;
      if (typeof m !== "number" || !(m > 0 && m < 100)) p.push("PREREG_MARGIN");
    } else if (
      !Number.isSafeInteger(c.resamples) ||
      (c.resamples as number) < 1000 ||
      c.threshold !== 1
    )
      p.push(`PREREG_BAR_COMPONENT_${i + 1}`);
  });
  if (isObj(seq[1]) && isObj(seq[2]) && seq[1].resamples !== seq[2].resamples)
    p.push("PREREG_RESAMPLES_DIFFER");
  return p;
}

// ---------------------------------------------------------------------------------------
// The pre-registered trial order.

export interface JScheduledTrial {
  readonly seq: number;
  readonly taskId: string;
  readonly arm: JArm;
  /** Which repeat of this (task, arm) this trial is, 1..k. */
  readonly rep: number;
}

/**
 * The seeded, interleaved order of (task, arm, repeat) trials (§1.3), k repeats per task per
 * arm. From the assignment seed: the first draw picks the arm that opens (below 0.5:
 * `hcu+shell`); the tasks, sorted by id, are then shuffled (Fisher-Yates, from the last
 * position down). Each task's 2k trials run as one block. Task position t starts with the
 * opener when t is even and with the other arm when t is odd; within the block, repeat r runs
 * (first, second) when r is even and (second, first) when r is odd. At k = 2 every task is
 * one ABBA block, alternating ABBA / BAAB over task positions. The trial at index i of task
 * position t has seq = 2k·t + i, and repeat r of each arm is rep r + 1.
 */
export function jV1Schedule(
  prereg: Pick<JV1Prereg, "taskSet" | "seeds" | "runsPerTaskPerArm">,
): readonly JScheduledTrial[] {
  const k = prereg.runsPerTaskPerArm;
  const rand = seededUniform(prereg.seeds.assignment);
  const opener: JArm = rand() < 0.5 ? J_BASELINE_ARM : J_CAPABILITY_ARM;
  const other: JArm = opener === J_BASELINE_ARM ? J_CAPABILITY_ARM : J_BASELINE_ARM;
  const tasks = [...prereg.taskSet.taskIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [tasks[i], tasks[j]] = [tasks[j] as string, tasks[i] as string];
  }
  const out: JScheduledTrial[] = [];
  tasks.forEach((taskId, t) => {
    const [first, second]: [JArm, JArm] = t % 2 === 0 ? [opener, other] : [other, opener];
    for (let r = 0; r < k; r++) {
      const pair: [JArm, JArm] = r % 2 === 0 ? [first, second] : [second, first];
      const base = 2 * k * t + 2 * r;
      out.push(
        { seq: base, taskId, arm: pair[0], rep: r + 1 },
        { seq: base + 1, taskId, arm: pair[1], rep: r + 1 },
      );
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// Analysis rows.

/** One trial, as the analysis reads it. Built by the harness from the arm's own record. */
export interface JTrialRow {
  readonly schema: typeof J_V1_TRIAL_SCHEMA;
  readonly taskId: string;
  readonly arm: JArm;
  /** The trial's position in the pre-registered schedule. */
  readonly seq: number;
  readonly plannerModelId: string;
  /** True when the planner is not a model id (scripted, dry run): never evidence. */
  readonly simulated: boolean;
  readonly claim: "done" | "not-done" | "no-claim";
  /** The independent grader's status on the captured persisted bytes; null if never graded. */
  readonly grade: "pass" | "fail" | "ungradable" | null;
  /** Agent tool calls of every kind (GUI, shell, capability); capped by the step budget. */
  readonly steps: number;
  /** Agent wall time, launch to stop, harness clock (reset, capture and grading excluded). */
  readonly wallMs: number;
  /** A harness fault code (e.g. an action without a route record); null when none. */
  readonly harnessFault: string | null;
  /** A route or shell access resolved outside the boundary: the trial is void (`uncertain`). */
  readonly boundaryBreach: boolean;
  /** Parity (§1.3): SHA-256 of the instruction text the agent was given. */
  readonly instructionSha256: string;
  /** Parity (§1.3): SHA-256 of the task's fixture as deployed for this trial. */
  readonly fixtureSha256: string;
  /** Parity (§1.3): the step budget this trial ran under. */
  readonly stepBudget: number;
  /** Parity (§1.3): the planner output ceiling this trial ran under. */
  readonly outputCeiling: number;
}

const ROW_KEYS = [
  "arm",
  "boundaryBreach",
  "claim",
  "fixtureSha256",
  "grade",
  "harnessFault",
  "instructionSha256",
  "outputCeiling",
  "plannerModelId",
  "schema",
  "seq",
  "simulated",
  "stepBudget",
  "steps",
  "taskId",
  "wallMs",
].join(",");
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const CLAIMS: ReadonlySet<unknown> = new Set(["done", "not-done", "no-claim"]);
const GRADES: ReadonlySet<unknown> = new Set(["pass", "fail", "ungradable", null]);

function rowProblem(r: unknown, stepBudget: number): string | null {
  if (!isObj(r)) return "not an object";
  if (Object.keys(r).sort().join(",") !== ROW_KEYS) return "unexpected or missing fields";
  if (r.schema !== J_V1_TRIAL_SCHEMA) return "wrong schema";
  if (r.arm !== J_BASELINE_ARM && r.arm !== J_CAPABILITY_ARM) return "unknown arm";
  if (typeof r.taskId !== "string") return "no task id";
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 0) return "bad seq";
  if (typeof r.plannerModelId !== "string") return "no planner id";
  if (typeof r.simulated !== "boolean") return "no simulated flag";
  if (r.simulated !== !MODEL_ID.test(r.plannerModelId))
    return "simulated flag disagrees with the planner id";
  if (!CLAIMS.has(r.claim)) return "bad claim";
  if (!GRADES.has(r.grade)) return "bad grade";
  if (!Number.isSafeInteger(r.steps) || (r.steps as number) < 0) return "bad steps";
  if ((r.steps as number) > stepBudget) return "steps over the step budget";
  if (typeof r.wallMs !== "number" || !Number.isFinite(r.wallMs) || r.wallMs < 0)
    return "bad wallMs";
  if (
    r.harnessFault !== null &&
    (typeof r.harnessFault !== "string" || r.harnessFault.length === 0)
  )
    return "bad harnessFault";
  if (typeof r.boundaryBreach !== "boolean") return "bad boundaryBreach";
  if (typeof r.instructionSha256 !== "string" || !SHA256_HEX.test(r.instructionSha256))
    return "bad instructionSha256";
  if (typeof r.fixtureSha256 !== "string" || !SHA256_HEX.test(r.fixtureSha256))
    return "bad fixtureSha256";
  if (!Number.isSafeInteger(r.stepBudget) || (r.stepBudget as number) < 1) return "bad stepBudget";
  if (!Number.isSafeInteger(r.outputCeiling) || (r.outputCeiling as number) < 1)
    return "bad outputCeiling";
  return null;
}

/**
 * Verified (§1.1, gate-less rows): a done claim the grader graded `pass`. A harness-faulted
 * or boundary-voided trial is never verified; it stays in the denominator.
 */
export function isVerified(r: JTrialRow): boolean {
  return r.claim === "done" && r.grade === "pass" && r.harnessFault === null && !r.boundaryBreach;
}

// ---------------------------------------------------------------------------------------
// Statistics.

/** Wilson score interval for x of n at the given z. Null when n is 0. */
export function wilsonInterval(x: number, n: number, z: number): readonly [number, number] | null {
  if (n === 0) return null;
  const p = x / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * The upper bound of p1 − p2 for paired proportions, Newcombe (1998) method 10, at z.
 * `a` both succeed, `b` only arm 1, `c` only arm 2, `d` neither. With z = Z_ONE_SIDED_95 it
 * is the one-sided 95% upper bound.
 */
export function newcombePairedUpper(a: number, b: number, c: number, d: number, z: number): number {
  const n = a + b + c + d;
  if (n === 0) throw new Error("newcombePairedUpper: no pairs");
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const [, u1] = wilsonInterval(a + b, n, z) as readonly [number, number];
  const [l2] = wilsonInterval(a + c, n, z) as readonly [number, number];
  const denom = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  const phi = denom === 0 ? 0 : (a * d - b * c) / denom;
  const upper =
    p1 -
    p2 +
    Math.sqrt(Math.max(0, (u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2));
  return Math.min(1, upper);
}

/**
 * Per task, summed over its k repeats in each arm: verified trials and the two ratio metrics.
 * The bootstrap resamples tasks (clusters), so a task's repeats always travel together.
 */
interface Pair {
  readonly vB: number;
  readonly vJ: number;
  readonly wallB: number;
  readonly wallJ: number;
  readonly stepsB: number;
  readonly stepsJ: number;
}

/** J/baseline of (total over all trials / verified trials); +Infinity when either has none. */
function ratio(totJ: number, verJ: number, totB: number, verB: number): number {
  if (verJ === 0 || verB === 0) return Number.POSITIVE_INFINITY;
  return totJ / verJ / (totB / verB);
}

/**
 * Paired bootstrap over tasks. Each resample draws n task indices with replacement
 * (index = floor(u · n), u from the bootstrap seed's stream, the tasks in the pre-registration's
 * task-id order), and the SAME indices give both the wall-time and the step ratio. A resample
 * in which either arm has no verified task scores +Infinity (it counts against J). The
 * one-sided 95% upper bound is the sorted ratios' element at index ceil(0.95 · R) − 1.
 */
export function bootstrapUpperBounds(
  pairs: readonly Pair[],
  seed: string,
  resamples: number,
): { readonly wall: number; readonly steps: number } {
  const rand = seededUniform(seed);
  const n = pairs.length;
  const wall = new Float64Array(resamples);
  const steps = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let vB = 0;
    let vJ = 0;
    let wB = 0;
    let wJ = 0;
    let sB = 0;
    let sJ = 0;
    for (let i = 0; i < n; i++) {
      const q = pairs[Math.floor(rand() * n)] as Pair;
      vB += q.vB;
      vJ += q.vJ;
      wB += q.wallB;
      wJ += q.wallJ;
      sB += q.stepsB;
      sJ += q.stepsJ;
    }
    wall[r] = ratio(wJ, vJ, wB, vB);
    steps[r] = ratio(sJ, vJ, sB, vB);
  }
  wall.sort();
  steps.sort();
  const k = Math.ceil(0.95 * resamples) - 1;
  return { wall: wall[k] as number, steps: steps[k] as number };
}

// ---------------------------------------------------------------------------------------
// The analysis.

export interface ArmStats {
  readonly trials: number;
  readonly verified: number;
  readonly verifiedRate: number;
  /** Wilson 95% (two-sided) interval on the verified rate (§1.4). */
  readonly verifiedRateWilson95: readonly [number, number];
  readonly totalWallMs: number;
  readonly totalSteps: number;
  /** Null when the arm has no verified task. */
  readonly wallMsPerVerified: number | null;
  readonly stepsPerVerified: number | null;
  /** Done claim graded fail or ungradable (§1.4; reported, no threshold in spec J). */
  readonly falseDone: number;
  readonly harnessFaults: Readonly<Record<string, number>>;
  readonly boundaryBreaches: number;
  readonly ungraded: number;
}

export interface BarComponentResult {
  readonly id: BarComponentId;
  readonly status: "shown" | "not-shown" | "not-tested";
  /** Point estimate: baseline − J rate (component 1) or the J/baseline ratio (2, 3). */
  readonly estimate: number | null;
  /** The one-sided 95% upper bound; null when not tested. */
  readonly upperBound: number | null;
  /** Shown when upperBound < threshold (strictly); null when the pack was refused. */
  readonly threshold: number | null;
}

export interface JV1Result {
  readonly analysis: typeof J_V1_ANALYSIS;
  readonly preregHash: string;
  /** The commit the pack says its pre-registration was frozen in (§3 item 2); null if refused before it was read. */
  readonly preregCommit: string | null;
  readonly verdict: "shown" | "not-shown";
  /** True when the numbers were computed; false when the pack was refused outright. */
  readonly computed: boolean;
  /** Codes, each with detail after a colon. Empty only when the verdict is shown. */
  readonly reasons: readonly string[];
  /** Paired (task, repeat) trials: tasks · k. */
  readonly n: number | null;
  readonly tasks: number | null;
  /** Over (task, repeat) pairs: a both verified, b baseline only, c J only, d neither. */
  readonly table: {
    readonly a: number;
    readonly b: number;
    readonly c: number;
    readonly d: number;
  } | null;
  readonly discordant: number | null;
  readonly arms: { readonly baseline: ArmStats; readonly capability: ArmStats } | null;
  readonly bar: readonly BarComponentResult[];
}

export interface JV1Input {
  /** The committed pre-registration, as parsed from prereg.json. */
  readonly prereg: unknown;
  /** The pre-registration hash the pack recorded (§3 item 2). */
  readonly packPreregHash: string;
  /**
   * The commit on `main` the pack says froze this pre-registration (§3 item 2): 40 lowercase
   * hex. This script checks its form only; that the commit holds this prereg.json is checked
   * by the pack tooling, which has git (this script imports node:crypto alone).
   */
  readonly packPreregCommit: string;
  readonly rows: readonly unknown[];
}

function refused(hash: string, commit: string | null, reasons: string[]): JV1Result {
  return {
    analysis: J_V1_ANALYSIS,
    preregHash: hash,
    preregCommit: commit,
    verdict: "not-shown",
    computed: false,
    reasons,
    n: null,
    tasks: null,
    table: null,
    discordant: null,
    arms: null,
    bar: BAR_SEQUENCE.map(({ id }) => ({
      id,
      status: "not-tested",
      estimate: null,
      upperBound: null,
      threshold: null,
    })),
  };
}

function armStats(rows: readonly JTrialRow[]): ArmStats {
  const verified = rows.filter(isVerified).length;
  const totalWallMs = rows.reduce((s, r) => s + r.wallMs, 0);
  const totalSteps = rows.reduce((s, r) => s + r.steps, 0);
  const harnessFaults: Record<string, number> = {};
  for (const r of rows)
    if (r.harnessFault !== null)
      harnessFaults[r.harnessFault] = (harnessFaults[r.harnessFault] ?? 0) + 1;
  return {
    trials: rows.length,
    verified,
    verifiedRate: verified / rows.length,
    verifiedRateWilson95: wilsonInterval(verified, rows.length, Z_TWO_SIDED_95) as readonly [
      number,
      number,
    ],
    totalWallMs,
    totalSteps,
    wallMsPerVerified: verified === 0 ? null : totalWallMs / verified,
    stepsPerVerified: verified === 0 ? null : totalSteps / verified,
    falseDone: rows.filter(
      (r) => r.claim === "done" && (r.grade === "fail" || r.grade === "ungradable"),
    ).length,
    harnessFaults,
    boundaryBreaches: rows.filter((r) => r.boundaryBreach).length,
    ungraded: rows.filter((r) => r.grade === null).length,
  };
}

/**
 * Parity checks (§1.3, §1.5 "a parity check failed"): per task, one instruction hash and one
 * fixture hash across both arms and every repeat; every row at the pre-registered step budget
 * and output ceiling. One `PARITY_MISMATCH` reason per kind of failure, with a count.
 */
function parityProblems(prereg: JV1Prereg, rows: readonly JTrialRow[]): string[] {
  const out: string[] = [];
  const byTask = new Map<string, JTrialRow[]>();
  for (const r of rows) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  const split = (field: "instructionSha256" | "fixtureSha256") =>
    [...byTask.values()].filter((rs) => new Set(rs.map((r) => r[field])).size !== 1).length;
  const instruction = split("instructionSha256");
  if (instruction > 0)
    out.push(`PARITY_MISMATCH: instructionSha256 differs within ${instruction} task(s)`);
  const fixture = split("fixtureSha256");
  if (fixture > 0) out.push(`PARITY_MISMATCH: fixtureSha256 differs within ${fixture} task(s)`);
  const budget = rows.filter((r) => r.stepBudget !== prereg.stepBudget).length;
  if (budget > 0)
    out.push(`PARITY_MISMATCH: stepBudget is not ${prereg.stepBudget} in ${budget} row(s)`);
  const ceiling = rows.filter((r) => r.outputCeiling !== prereg.outputCeiling).length;
  if (ceiling > 0)
    out.push(`PARITY_MISMATCH: outputCeiling is not ${prereg.outputCeiling} in ${ceiling} row(s)`);
  return out;
}

/** Judge a completed j-v1 pack against its pre-registered bar. */
export function analyzeJV1(input: JV1Input): JV1Result {
  const problems = preregProblems(input.prereg);
  let hash = "";
  try {
    hash = preregHash(input.prereg);
  } catch {
    problems.push("PREREG_NOT_CANONICAL");
  }
  if (problems.length > 0) return refused(hash, null, problems);
  if (input.packPreregHash !== hash)
    return refused(hash, null, [
      "PREREG_HASH_MISMATCH: the pack's pre-registration hash is not this pre-registration's",
    ]);
  if (typeof input.packPreregCommit !== "string" || !COMMIT_SHA.test(input.packPreregCommit))
    return refused(hash, null, [
      "PACK_FROZEN_COMMIT: the pack does not record the commit its pre-registration was frozen in",
    ]);
  const commit = input.packPreregCommit;
  const prereg = input.prereg as JV1Prereg;

  // Rows: well-formed, and exactly the pre-registered schedule: every seq once, each with the
  // task and arm the seeded schedule put there (which also fixes the trial's repeat number).
  const design: string[] = [];
  const rows: JTrialRow[] = [];
  input.rows.forEach((r, i) => {
    const why = rowProblem(r, prereg.stepBudget);
    if (why === null) rows.push(r as JTrialRow);
    else design.push(`ROW_INVALID: row ${i}: ${why}`);
  });
  const schedule = jV1Schedule(prereg);
  const known = new Set(prereg.taskSet.taskIds);
  const bySeq = new Map<number, JTrialRow>();
  for (const r of rows) {
    const want = schedule[r.seq];
    if (!known.has(r.taskId)) design.push(`DESIGN_UNKNOWN_TASK: ${r.taskId}`);
    else if (want === undefined) design.push(`DESIGN_UNKNOWN_SEQ: ${r.seq}`);
    else if (bySeq.has(r.seq)) design.push(`DESIGN_DUPLICATE: seq ${r.seq}`);
    else if (want.taskId !== r.taskId || want.arm !== r.arm)
      design.push(
        `DESIGN_ORDER: seq ${r.seq} ran ${r.taskId} ${r.arm}, scheduled ${want.taskId} ${want.arm}`,
      );
    else bySeq.set(r.seq, r);
  }
  for (const s of schedule)
    if (!bySeq.has(s.seq)) design.push(`DESIGN_MISSING: seq ${s.seq} (${s.taskId} ${s.arm})`);
  if (design.length > 0) return refused(hash, commit, design);
  const cell = new Map(
    schedule.map((s) => [`${s.taskId}\u0000${s.arm}\u0000${s.rep}`, bySeq.get(s.seq) as JTrialRow]),
  );
  const trial = (taskId: string, arm: JArm, rep: number) =>
    cell.get(`${taskId}\u0000${arm}\u0000${rep}`) as JTrialRow;

  // Blocking reasons that leave the numbers computable (useful for plumbing, never a "shown").
  const reasons: string[] = [];
  if (prereg.leadRulingPending.length > 0)
    reasons.push(`LEAD_RULING_PENDING: ${prereg.leadRulingPending.join(", ")}`);
  const simulated = rows.filter((r) => r.simulated).length;
  if (simulated > 0)
    reasons.push(`SIMULATED: ${simulated} row(s); simulated rows are never evidence`);
  const planners = [...new Set(rows.map((r) => r.plannerModelId))].sort();
  if (planners.length !== 1 || planners[0] !== prereg.modelId)
    reasons.push(`PLANNER_MISMATCH: ${planners.join(", ")}; pre-registered ${prereg.modelId}`);
  const breaches = rows.filter((r) => r.boundaryBreach).length;
  if (breaches > 0) reasons.push(`GUARDRAIL_BOUNDARY_BREACH: ${breaches} trial(s)`);
  reasons.push(...parityProblems(prereg, rows));

  const byArm = (arm: JArm) => rows.filter((r) => r.arm === arm);
  const baseline = armStats(byArm(J_BASELINE_ARM));
  const capability = armStats(byArm(J_CAPABILITY_ARM));

  // Component 1's pairs are (task, repeat): repeat r of the baseline with repeat r of J, so
  // n = tasks · k. The bootstrap's clusters are tasks, each summed over its repeats.
  const k = prereg.runsPerTaskPerArm;
  const table = { a: 0, b: 0, c: 0, d: 0 };
  const pairs: Pair[] = prereg.taskSet.taskIds.map((id) => {
    const q = { vB: 0, vJ: 0, wallB: 0, wallJ: 0, stepsB: 0, stepsJ: 0 };
    for (let rep = 1; rep <= k; rep++) {
      const b = trial(id, J_BASELINE_ARM, rep);
      const j = trial(id, J_CAPABILITY_ARM, rep);
      const vb = isVerified(b);
      const vj = isVerified(j);
      if (vb && vj) table.a++;
      else if (vb) table.b++;
      else if (vj) table.c++;
      else table.d++;
      q.vB += vb ? 1 : 0;
      q.vJ += vj ? 1 : 0;
      q.wallB += b.wallMs;
      q.wallJ += j.wallMs;
      q.stepsB += b.steps;
      q.stepsJ += j.steps;
    }
    return q;
  });
  const n = table.a + table.b + table.c + table.d;

  // Component 1: non-inferiority of the verified rate.
  const [c1, c2, c3] = prereg.bar.sequence as [
    JV1Prereg["bar"]["sequence"][number],
    JV1Prereg["bar"]["sequence"][number],
    JV1Prereg["bar"]["sequence"][number],
  ];
  const margin = (c1.marginPoints as number) / 100;
  const niUpper = newcombePairedUpper(table.a, table.b, table.c, table.d, Z_ONE_SIDED_95);
  const niShown = niUpper < margin;
  const bar: BarComponentResult[] = [
    {
      id: c1.id,
      status: niShown ? "shown" : "not-shown",
      estimate: (table.b - table.c) / n,
      upperBound: niUpper,
      threshold: margin,
    },
  ];

  // Components 2 and 3: the paired bootstrap, tested only behind a shown earlier component.
  const boot = niShown
    ? bootstrapUpperBounds(pairs, prereg.seeds.bootstrap, c2.resamples as number)
    : null;
  const pointWall = ratio(
    capability.totalWallMs,
    capability.verified,
    baseline.totalWallMs,
    baseline.verified,
  );
  const pointSteps = ratio(
    capability.totalSteps,
    capability.verified,
    baseline.totalSteps,
    baseline.verified,
  );
  const wallShown = boot !== null && boot.wall < (c2.threshold as number);
  bar.push({
    id: c2.id,
    status: boot === null ? "not-tested" : wallShown ? "shown" : "not-shown",
    estimate: Number.isFinite(pointWall) ? pointWall : null,
    upperBound: boot === null ? null : boot.wall,
    threshold: c2.threshold as number,
  });
  const stepsTested = boot !== null && wallShown;
  const stepsShown = stepsTested && boot.steps < (c3.threshold as number);
  bar.push({
    id: c3.id,
    status: !stepsTested ? "not-tested" : stepsShown ? "shown" : "not-shown",
    estimate: Number.isFinite(pointSteps) ? pointSteps : null,
    upperBound: stepsTested ? boot.steps : null,
    threshold: c3.threshold as number,
  });
  for (const c of bar)
    if (c.status !== "shown")
      reasons.push(`BAR_${c.status === "not-shown" ? "NOT_SHOWN" : "NOT_TESTED"}: ${c.id}`);

  return {
    analysis: J_V1_ANALYSIS,
    preregHash: hash,
    preregCommit: commit,
    verdict: reasons.length === 0 ? "shown" : "not-shown",
    computed: true,
    reasons,
    n,
    tasks: pairs.length,
    table,
    discordant: table.b + table.c,
    arms: { baseline, capability },
    bar,
  };
}
