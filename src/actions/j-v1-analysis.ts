/**
 * Track J, pre-registration j-v1: the frozen analysis script.
 *
 * This file is named, with its SHA-256, in `docs/product/capability-prereg/j-v1/prereg.json`
 * (capability spec §3 item 1). It imports nothing but `node:crypto`, so that hash pins the
 * whole computation: a change to any line here is a change to the pre-registration, which
 * after the first run means a new version (`j-v2`), never an edit.
 *
 * What it computes (capability spec §2 J and §1.5), on paired rows over fc-v1's 90
 * satisfiable tasks, one trial per task per arm:
 *
 * 1. **Verified rate non-inferior.** The one-sided 95% upper bound of
 *    (`hcu+shell` rate − `hcu+shell+J` rate), Newcombe's paired score interval (1998,
 *    method 10, with z for one-sided 95%), is below the margin.
 * 2. **Wall time per verified task.** Paired bootstrap over tasks: the one-sided 95% upper
 *    bound of J/baseline is below 1.0.
 * 3. **Steps per verified task.** The same resamples: the upper bound of J/baseline is below
 *    1.0.
 *
 * The components are tested in that fixed sequence at alpha 0.05 each: a later one is tested
 * only if every earlier one is shown. The bar is "shown" only when all three are shown and
 * nothing blocks (a lead ruling pending, a simulated row, a planner mismatch, a guardrail
 * breach). It refuses to compute at all when the pack's pre-registration hash does not match,
 * a row is malformed, or the design is not exactly the pre-registered one (every task, both
 * arms, once each, in the pre-registered seeded order).
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
  readonly runsPerTaskPerArm: 1;
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
  if (raw.runsPerTaskPerArm !== 1) p.push("PREREG_RUNS_PER_TASK");
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
}

/**
 * The seeded, interleaved order of (task, arm) trials (§1.3). From the assignment seed: the
 * first draw picks the arm that opens (below 0.5: `hcu+shell`); the tasks, sorted by id,
 * are then shuffled (Fisher-Yates, from the last position down). The i-th task in that
 * order runs opener-then-other when i is even and other-then-opener when i is odd, so arms
 * alternate in ABBA blocks over consecutive task pairs. Trial i of task position t has
 * seq = 2t + i.
 */
export function jV1Schedule(
  prereg: Pick<JV1Prereg, "taskSet" | "seeds">,
): readonly JScheduledTrial[] {
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
    const pair: [JArm, JArm] = t % 2 === 0 ? [opener, other] : [other, opener];
    out.push({ seq: 2 * t, taskId, arm: pair[0] }, { seq: 2 * t + 1, taskId, arm: pair[1] });
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
}

const ROW_KEYS = [
  "arm",
  "boundaryBreach",
  "claim",
  "grade",
  "harnessFault",
  "plannerModelId",
  "schema",
  "seq",
  "simulated",
  "steps",
  "taskId",
  "wallMs",
].join(",");
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

/** Per task: both arms' trial (verified flag and the two ratio metrics). */
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
  readonly verdict: "shown" | "not-shown";
  /** True when the numbers were computed; false when the pack was refused outright. */
  readonly computed: boolean;
  /** Codes, each with detail after a colon. Empty only when the verdict is shown. */
  readonly reasons: readonly string[];
  readonly n: number | null;
  /** a both verified, b baseline only, c J only, d neither. */
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
  readonly rows: readonly unknown[];
}

function refused(hash: string, reasons: string[]): JV1Result {
  return {
    analysis: J_V1_ANALYSIS,
    preregHash: hash,
    verdict: "not-shown",
    computed: false,
    reasons,
    n: null,
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

/** Judge a completed j-v1 pack against its pre-registered bar. */
export function analyzeJV1(input: JV1Input): JV1Result {
  const problems = preregProblems(input.prereg);
  let hash = "";
  try {
    hash = preregHash(input.prereg);
  } catch {
    problems.push("PREREG_NOT_CANONICAL");
  }
  if (problems.length > 0) return refused(hash, problems);
  if (input.packPreregHash !== hash)
    return refused(hash, [
      "PREREG_HASH_MISMATCH: the pack's pre-registration hash is not this pre-registration's",
    ]);
  const prereg = input.prereg as JV1Prereg;

  // Rows: well-formed, the pre-registered tasks and arms, each once, in the pre-registered order.
  const design: string[] = [];
  const rows: JTrialRow[] = [];
  input.rows.forEach((r, i) => {
    const why = rowProblem(r, prereg.stepBudget);
    if (why === null) rows.push(r as JTrialRow);
    else design.push(`ROW_INVALID: row ${i}: ${why}`);
  });
  const schedule = jV1Schedule(prereg);
  const wantSeq = new Map(schedule.map((s) => [`${s.taskId}\u0000${s.arm}`, s.seq]));
  const seen = new Map<string, JTrialRow>();
  for (const r of rows) {
    const key = `${r.taskId}\u0000${r.arm}`;
    const want = wantSeq.get(key);
    if (want === undefined) design.push(`DESIGN_UNKNOWN_TASK: ${r.taskId}`);
    else if (seen.has(key)) design.push(`DESIGN_DUPLICATE: ${r.taskId} ${r.arm}`);
    else if (r.seq !== want)
      design.push(`DESIGN_ORDER: ${r.taskId} ${r.arm} ran at ${r.seq}, scheduled ${want}`);
    seen.set(key, r);
  }
  for (const s of schedule)
    if (!seen.has(`${s.taskId}\u0000${s.arm}`)) design.push(`DESIGN_MISSING: ${s.taskId} ${s.arm}`);
  if (design.length > 0) return refused(hash, design);

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

  const byArm = (arm: JArm) => rows.filter((r) => r.arm === arm);
  const baseline = armStats(byArm(J_BASELINE_ARM));
  const capability = armStats(byArm(J_CAPABILITY_ARM));

  const taskIds = prereg.taskSet.taskIds;
  const pairs: Pair[] = taskIds.map((id) => {
    const b = seen.get(`${id}\u0000${J_BASELINE_ARM}`) as JTrialRow;
    const j = seen.get(`${id}\u0000${J_CAPABILITY_ARM}`) as JTrialRow;
    return {
      vB: isVerified(b) ? 1 : 0,
      vJ: isVerified(j) ? 1 : 0,
      wallB: b.wallMs,
      wallJ: j.wallMs,
      stepsB: b.steps,
      stepsJ: j.steps,
    };
  });
  const table = { a: 0, b: 0, c: 0, d: 0 };
  for (const q of pairs) {
    if (q.vB && q.vJ) table.a++;
    else if (q.vB) table.b++;
    else if (q.vJ) table.c++;
    else table.d++;
  }
  const n = pairs.length;

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
    verdict: reasons.length === 0 ? "shown" : "not-shown",
    computed: true,
    reasons,
    n,
    table,
    discordant: table.b + table.c,
    arms: { baseline, capability },
    bar,
  };
}
