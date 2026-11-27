/**
 * Track R analysis under pre-registration r-v1 (capability-spec-2 §R; capability-spec §§1, 3).
 *
 * What it decides, in the pre-registered fixed sequence:
 *  1. **Prerequisite property.** Every derived-oracle verdict in every R trial came from an
 *     R5-certified oracle, and every uncertified oracle shows as refused (`SELFTEST_FAILED`)
 *     in the replay refusal log. One uncertified verify fails the bar.
 *  2. **Primary.** Exact one-sided McNemar (sign test on discordant tasks), `hcu+shell+R`
 *     better than `hcu+shell` on VERIFIED, p ≤ alpha with at least `minDiscordant` discordant
 *     tasks. Tested only when (1) held.
 *  - **Guardrails.** Zero derived-gate false accepts (a derived verdict `verified` on a trial
 *    the grader graded `fail` or `ungradable`), with n and the one-sided 95% upper bound
 *    (capability-spec-2 §1.2); and a planted-marker scan of the pack that finds nothing. The
 *    spec's scan also covers recordings, workflows and oracles, which no pack carries yet;
 *    that gap is a pending lead ruling in the prereg, so it blocks the bar (below).
 *  - **Lead rulings.** While the prereg lists any `leadRulingPending` value, nothing is
 *    reported as shown: `barShown` is false, every comparison's `shown` is false, and the
 *    reading starts `LEAD_RULING_PENDING`. The statistics are still computed, as numbers only.
 *  - **Secondary, reported only.** `hcu+shell+R` vs `C1` (when the C1 arm ran), per-arm
 *    verified rates with Wilson 95% intervals, steps / wall time / cost per verified task over
 *    ALL trials, the share of R trials that used a workflow, and the R5 pass rate with its count.
 *
 * **The grader decides.** VERIFIED on these gate-less rows is a `done` claim the independent
 * grader (`src/benchmark/grade/`) graded `pass`, read from its grade rows. The derived oracle's
 * verdict and the replay's own report never decide a trial: they enter only the prerequisite
 * and the false-accept guardrail. This module imports nothing from `src/recording/` except the
 * planted-marker scanner, nothing from the gate, and nothing from the grader.
 *
 * **Refusals (codes only).** The pack is refused, with no numbers, when its pre-registration
 * hash, task set or manifest does not match the committed ones; when the arms are not exactly
 * fr-v1 once per task; when a row's instruction or fixture hash, planner, step budget or run
 * position differs from the pre-registration; when a grade row is missing, extra or bound to
 * other bytes; when a workflow came from an undeclared recording; and, with `evidence`, when
 * any planner or demonstration is simulated (capability-spec §3.5). A trial or grade row that
 * carries a `simulated` field other than exactly `false` is refused `ROW_SIMULATED`, with or
 * without `evidence`.
 */
import { assertClean } from "../recording/scrub.ts";
import { canonicalSha256, sha256Hex } from "./canonical.ts";

export const R_PREREG_SCHEMA = "myco.capability.prereg/1";
export const R_PACK_SCHEMA = "myco.capability.r-pack/1";
export const R_TRIAL_SCHEMA = "myco.capability.r-trial/1";
export const GRADE_ROW_SCHEMA = "myco.benchmark.grade-row/1";
export const R_ARM = "hcu+shell+R";
export const R_ARMS = [R_ARM, "hcu+shell", "C1"] as const;
export type RArm = (typeof R_ARMS)[number];
const SIMULATED_PREFIX = "simulated:";
export const SIMULATED_LABEL = "SIMULATED: plumbing only, never evidence (capability-spec §3.5)";
export const NOT_EVIDENCE_LABEL =
  "NOT EVIDENCE: analysed without --evidence, so the bar is not decided";
export const LEAD_RULING_PENDING = "LEAD_RULING_PENDING";
const pendingText = (n: number) =>
  `${LEAD_RULING_PENDING}: ${n} pre-registered value(s) await the lead's ruling, so no result is reported`;

export const REFUSAL_CODES = [
  "PREREG_SHAPE",
  "PREREG_HASH_MISMATCH",
  "MANIFEST_SHAPE",
  "MANIFEST_HASH_MISMATCH",
  "PACK_SHAPE",
  "PACK_TASK_SET_MISMATCH",
  "DEMONSTRATIONS_INCOMPLETE",
  "DEMONSTRATION_SIMULATED",
  "TRIAL_SHAPE",
  "ROW_SIMULATED",
  "TRIAL_KEY_DUPLICATE",
  "ARM_INCOMPLETE",
  "TASK_UNKNOWN",
  "TASK_HASH_MISMATCH",
  "PLANNER_MISMATCH",
  "PLANNER_MIXED",
  "SIMULATED_PLANNER",
  "STEP_BUDGET_MISMATCH",
  "SCHEDULE_MISMATCH",
  "DERIVED_ON_BASE_ARM",
  "RECORDING_UNDECLARED",
  "GRADE_SHAPE",
  "GRADE_MISSING",
  "GRADE_UNKNOWN_TRIAL",
  "GRADE_MISMATCH",
] as const;
export type RRefusalCode = (typeof REFUSAL_CODES)[number];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const isHex64 = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isNullableNonNeg = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const exactKeys = (o: Obj, keys: readonly string[]) => {
  const have = Object.keys(o).sort();
  const want = [...keys].sort();
  return have.length === want.length && have.every((k, i) => k === want[i]);
};

/** The prereg fields this analysis reads. Everything else in the file is hashed, not parsed. */
interface PreregView {
  readonly taskSetVersion: string;
  readonly manifestSha256: string;
  readonly assignmentSeed: string;
  readonly stepBudget: number;
  readonly modelId: string;
  readonly graderVersion: string;
  readonly alpha: number;
  readonly minDiscordant: number;
  readonly families: readonly string[];
  /** Values still awaiting the lead's ruling. Required (an absent list is a shape error). */
  readonly leadRulingPending: readonly string[];
}

function readPrereg(p: unknown): PreregView | undefined {
  if (!isObj(p) || p.schema !== R_PREREG_SCHEMA || p.track !== "R" || p.version !== "r-v1")
    return undefined;
  const ts = p.taskSet;
  const seeds = p.seeds;
  const bar = p.bar;
  const grader = p.grader;
  const demo = p.demonstration;
  if (!isObj(ts) || !isObj(seeds) || !isObj(bar) || !isObj(grader) || !isObj(demo))
    return undefined;
  const primary = Array.isArray(bar.sequence)
    ? (bar.sequence as unknown[]).find((c) => isObj(c) && c.id === "R-primary")
    : undefined;
  if (!isObj(primary)) return undefined;
  const arms = p.arms;
  if (
    !isObj(arms) ||
    !isObj(arms.primary) ||
    arms.primary.capability !== R_ARM ||
    arms.primary.baseline !== "hcu+shell"
  )
    return undefined;
  const view = {
    taskSetVersion: ts.version,
    manifestSha256: ts.manifestSha256,
    assignmentSeed: seeds.assignment,
    stepBudget: p.stepBudget,
    modelId: p.modelId,
    graderVersion: grader.version,
    alpha: primary.alpha,
    minDiscordant: primary.minDiscordant,
    families: demo.families,
    leadRulingPending: p.leadRulingPending,
  };
  if (
    !isStr(view.taskSetVersion) ||
    !isHex64(view.manifestSha256) ||
    !isStr(view.assignmentSeed) ||
    !isNonNegInt(view.stepBudget) ||
    !isStr(view.modelId) ||
    !isStr(view.graderVersion) ||
    typeof view.alpha !== "number" ||
    !(view.alpha > 0 && view.alpha < 1) ||
    !isNonNegInt(view.minDiscordant) ||
    !Array.isArray(view.families) ||
    !view.families.every(isStr) ||
    !Array.isArray(view.leadRulingPending) ||
    !view.leadRulingPending.every(isStr)
  )
    return undefined;
  return view as PreregView;
}

interface TaskView {
  readonly taskId: string;
  readonly demonstrationFamily: string;
  readonly fixtureSha256: string;
  readonly instructionSha256: string;
}

function readManifestTasks(m: unknown, version: string): TaskView[] | undefined {
  if (!isObj(m) || m.taskSetVersion !== version || !Array.isArray(m.tasks)) return undefined;
  const out: TaskView[] = [];
  const seen = new Set<string>();
  for (const t of m.tasks as unknown[]) {
    if (
      !isObj(t) ||
      !isStr(t.taskId) ||
      !isStr(t.demonstrationFamily) ||
      !isHex64(t.fixtureSha256) ||
      !isHex64(t.instructionSha256) ||
      seen.has(t.taskId)
    )
      return undefined;
    seen.add(t.taskId);
    out.push({
      taskId: t.taskId,
      demonstrationFamily: t.demonstrationFamily,
      fixtureSha256: t.fixtureSha256,
      instructionSha256: t.instructionSha256,
    });
  }
  return out.length > 0 ? out : undefined;
}

export interface RPack {
  readonly schema: typeof R_PACK_SCHEMA;
  readonly preregHash: string;
  readonly preregCommit: string;
  readonly taskSetVersion: string;
  readonly manifestSha256: string;
  readonly demonstrations: readonly {
    readonly family: string;
    readonly recordingSha256: string;
    readonly simulated: boolean;
  }[];
}

const PACK_KEYS = [
  "schema",
  "preregHash",
  "preregCommit",
  "taskSetVersion",
  "manifestSha256",
  "demonstrations",
];

function isPack(p: unknown): p is RPack {
  if (!isObj(p) || !exactKeys(p, PACK_KEYS) || p.schema !== R_PACK_SCHEMA) return false;
  if (!isHex64(p.preregHash) || typeof p.preregCommit !== "string" || !HEX40.test(p.preregCommit))
    return false;
  if (!isStr(p.taskSetVersion) || !isHex64(p.manifestSha256) || !Array.isArray(p.demonstrations))
    return false;
  return (p.demonstrations as unknown[]).every(
    (d) =>
      isObj(d) &&
      exactKeys(d, ["family", "recordingSha256", "simulated"]) &&
      isStr(d.family) &&
      isHex64(d.recordingSha256) &&
      typeof d.simulated === "boolean",
  );
}

export const REPLAY_REFUSALS = ["SELFTEST_FAILED", "BINDING_REFUSED", "FIXTURE_MISMATCH"] as const;

export interface RInvocation {
  readonly workflowId: string;
  readonly recordingSha256: string;
  /** Whether R5's mutation self-test certified the bound derived oracle before any verdict. */
  readonly certified: boolean;
  /** The replay's refusal code, or null when it replayed. */
  readonly refusal: (typeof REPLAY_REFUSALS)[number] | null;
  /** The derived gate's verdict, or null when no gate ran. Never decides the trial. */
  readonly gateVerdict: "verified" | "refuted" | "uncertain" | null;
}

export interface RTrialRow {
  readonly schema: typeof R_TRIAL_SCHEMA;
  readonly trialKey: string;
  readonly taskId: string;
  readonly arm: RArm;
  /** 0-based position in the pre-registered run order. */
  readonly ordinal: number;
  readonly plannerModelId: string;
  readonly stepBudget: number;
  readonly instructionSha256: string;
  readonly fixtureSha256: string;
  readonly claim: "done" | "not-done" | "no-claim";
  readonly persistedSha256: string | null;
  readonly steps: number | null;
  readonly wallClockS: number | null;
  /** Token-derived ESTIMATE at frozen rates, never billed USD; null is unmeasured, never 0. */
  readonly costUsdEstimate: number | null;
  readonly cause: { readonly kind: "agent" | "oracle" | "harness"; readonly detail: string } | null;
  /** Workflow use on the R arm (`[]` when the agent never called it); null on base arms. */
  readonly derived: { readonly invocations: readonly RInvocation[] } | null;
}

const TRIAL_KEYS = [
  "schema",
  "trialKey",
  "taskId",
  "arm",
  "ordinal",
  "plannerModelId",
  "stepBudget",
  "instructionSha256",
  "fixtureSha256",
  "claim",
  "persistedSha256",
  "steps",
  "wallClockS",
  "costUsdEstimate",
  "cause",
  "derived",
];
const INVOCATION_KEYS = ["workflowId", "recordingSha256", "certified", "refusal", "gateVerdict"];

function isInvocation(v: unknown): v is RInvocation {
  if (!isObj(v) || !exactKeys(v, INVOCATION_KEYS)) return false;
  if (!isStr(v.workflowId) || !isHex64(v.recordingSha256) || typeof v.certified !== "boolean")
    return false;
  if (v.refusal !== null && !(REPLAY_REFUSALS as readonly unknown[]).includes(v.refusal))
    return false;
  if (
    v.gateVerdict !== null &&
    !["verified", "refuted", "uncertain"].includes(v.gateVerdict as string)
  )
    return false;
  // A refused replay builds no gate; a certified oracle is never refused for SELFTEST_FAILED.
  if (v.refusal !== null && v.gateVerdict !== null) return false;
  if (v.certified && v.refusal === "SELFTEST_FAILED") return false;
  return true;
}

function isTrial(v: unknown): v is RTrialRow {
  if (!isObj(v) || v.schema !== R_TRIAL_SCHEMA) return false;
  // `simulated: false` is the only value the field may carry (a true one is refused earlier).
  const keyed =
    exactKeys(v, TRIAL_KEYS) ||
    (v.simulated === false && exactKeys(v, [...TRIAL_KEYS, "simulated"]));
  if (!keyed) return false;
  if (!isStr(v.trialKey) || !isStr(v.taskId) || !(R_ARMS as readonly unknown[]).includes(v.arm))
    return false;
  if (!isNonNegInt(v.ordinal) || !isStr(v.plannerModelId) || !isNonNegInt(v.stepBudget))
    return false;
  if (!isHex64(v.instructionSha256) || !isHex64(v.fixtureSha256)) return false;
  if (!["done", "not-done", "no-claim"].includes(v.claim as string)) return false;
  if (v.persistedSha256 !== null && !isHex64(v.persistedSha256)) return false;
  if (v.steps !== null && !isNonNegInt(v.steps)) return false;
  if (!isNullableNonNeg(v.wallClockS) || !isNullableNonNeg(v.costUsdEstimate)) return false;
  if (
    v.cause !== null &&
    !(
      isObj(v.cause) &&
      exactKeys(v.cause, ["kind", "detail"]) &&
      ["agent", "oracle", "harness"].includes(v.cause.kind as string) &&
      typeof v.cause.detail === "string"
    )
  )
    return false;
  if (v.derived !== null) {
    if (!isObj(v.derived) || !exactKeys(v.derived, ["invocations"])) return false;
    if (!Array.isArray(v.derived.invocations) || !v.derived.invocations.every(isInvocation))
      return false;
  }
  return true;
}

interface GradeView {
  readonly trialKey: string;
  readonly taskId: string;
  readonly graderVersion: string;
  readonly status: "pass" | "fail" | "ungradable";
  readonly fixtureSha256: string;
  readonly persistedSha256: string | null;
}

function readGrade(v: unknown): GradeView | undefined {
  if (!isObj(v) || v.schema !== GRADE_ROW_SCHEMA) return undefined;
  if (!isStr(v.trialKey) || !isStr(v.taskId) || !isStr(v.graderVersion)) return undefined;
  if (!["pass", "fail", "ungradable"].includes(v.status as string)) return undefined;
  if (!isHex64(v.fixtureSha256)) return undefined;
  if (v.persistedSha256 !== null && !isHex64(v.persistedSha256)) return undefined;
  return v as unknown as GradeView;
}

// ---------------------------------------------------------------------------
// Run order (the assignment seed)
// ---------------------------------------------------------------------------

/** Deterministic uniform in [0, 1) from a tag: the first 32 bits of SHA-256. */
function unit(tag: string): number {
  return Number.parseInt(sha256Hex(tag).slice(0, 8), 16) / 4294967296;
}

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(unit(`${seed}:${i}`) * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const ARM_ORDERS: readonly (readonly RArm[])[] = [
  ["hcu+shell+R", "hcu+shell", "C1"],
  ["hcu+shell+R", "C1", "hcu+shell"],
  ["hcu+shell", "hcu+shell+R", "C1"],
  ["hcu+shell", "C1", "hcu+shell+R"],
  ["C1", "hcu+shell+R", "hcu+shell"],
  ["C1", "hcu+shell", "hcu+shell+R"],
];

/**
 * The pre-registered run order: tasks in a seeded shuffle, each task's three arm trials back
 * to back (the capability-spec §1.3 interleaving, for three arms), with the six arm orders
 * balanced across tasks (each used `ceil(n/6)` times at most) and assigned by a second
 * seeded shuffle. Returns `taskId|arm -> ordinal`. A C1 arm that does not run leaves its
 * ordinals unused; the other arms keep theirs.
 */
export function rV1Schedule(seed: string, taskIds: readonly string[]): Map<string, number> {
  const tasks = shuffled(taskIds, `${seed}:tasks`);
  const pool: (readonly RArm[])[] = [];
  while (pool.length < tasks.length) pool.push(...ARM_ORDERS);
  const orders = shuffled(pool.slice(0, tasks.length), `${seed}:arm-orders`);
  const out = new Map<string, number>();
  tasks.forEach((taskId, i) => {
    (orders[i] as readonly RArm[]).forEach((arm, j) => {
      out.set(`${taskId}|${arm}`, i * R_ARMS.length + j);
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Exact one-sided McNemar: P(X ≥ b) for X ~ Binomial(b + c, 1/2). 1 when there is no discord. */
export function mcnemarOneSided(b: number, c: number): number {
  const d = b + c;
  if (d === 0) return 1;
  let p = 0;
  for (let k = b; k <= d; k++) p += choose(d, k);
  return Math.min(1, p / 2 ** d);
}

/** Wilson 95% interval, or null when n = 0. */
export function wilson95(successes: number, n: number): readonly [number, number] | null {
  if (n === 0) return null;
  const z = 1.959963984540054;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** One-sided 95% upper bound on a rate with zero events in n trials (Clopper-Pearson). */
export const zeroEventUpper95 = (n: number): number | null => (n > 0 ? 1 - 0.05 ** (1 / n) : null);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface RAnalysisInput {
  /** The committed prereg.json, parsed. */
  readonly prereg: unknown;
  /** The committed fr-v1 manifest, parsed. */
  readonly manifest: unknown;
  readonly pack: unknown;
  readonly trials: readonly unknown[];
  readonly grades: readonly unknown[];
  /** Ask for evidence: simulated planners or demonstrations are then refused outright. */
  readonly evidence: boolean;
  /** Extra exact-substring markers for the planted-marker scan. */
  readonly markers?: readonly string[];
}

export interface ArmRate {
  readonly arm: RArm;
  readonly verified: number;
  readonly trials: number;
  readonly wilson95: readonly [number, number] | null;
}

export interface Comparison {
  readonly capability: RArm;
  readonly baseline: RArm;
  /** Tasks only the capability arm verified. */
  readonly capabilityOnly: number;
  /** Tasks only the baseline verified. */
  readonly baselineOnly: number;
  readonly both: number;
  readonly neither: number;
  readonly discordant: number;
  readonly pOneSided: number;
  readonly shown: boolean;
  readonly reading: string;
}

export type RAnalysis =
  | { readonly status: "refused"; readonly codes: readonly RRefusalCode[] }
  | {
      readonly status: "analysed";
      readonly preregHash: string;
      readonly evidence: boolean;
      readonly label: string | null;
      /** How many pre-registered values await the lead's ruling; any blocks every "shown". */
      readonly leadRulingPending: number;
      readonly prerequisite: {
        readonly held: boolean;
        readonly uncertifiedVerdicts: number;
        readonly uncertifiedNotRefused: number;
      };
      readonly guardrails: {
        readonly derivedFalseAccepts: number;
        readonly rTrials: number;
        readonly zeroEventUpper95: number | null;
        readonly markerScan: { readonly clean: boolean; readonly finding: string | null };
      };
      /** Null when the prerequisite failed (fixed sequence: the primary is then not tested). */
      readonly primary: Comparison | null;
      readonly secondary: {
        readonly vsC1: Comparison | null;
        readonly rates: readonly ArmRate[];
        readonly perVerified: Readonly<
          Record<
            string,
            {
              readonly steps: number | null;
              readonly wallClockS: number | null;
              readonly costUsdEstimate: number | null;
            }
          >
        >;
        readonly workflowShare: { readonly used: number; readonly rTrials: number };
        readonly r5PassRate: { readonly certified: number; readonly invocations: number };
      };
      readonly barShown: boolean;
      readonly reading: string;
    };

/** A row is simulated unless its `simulated` field is absent or exactly `false`. */
const claimsSimulated = (row: unknown): boolean =>
  isObj(row) && Object.hasOwn(row, "simulated") && row.simulated !== false;

const refused = (codes: Iterable<RRefusalCode>): RAnalysis => ({
  status: "refused",
  codes: [...new Set(codes)].sort(),
});

function compare(
  capability: RArm,
  baseline: RArm,
  verified: ReadonlyMap<string, boolean>,
  taskIds: readonly string[],
  alpha: number,
  minDiscordant: number,
): Comparison {
  let b = 0;
  let c = 0;
  let both = 0;
  let neither = 0;
  for (const t of taskIds) {
    const x = verified.get(`${t}|${capability}`) === true;
    const y = verified.get(`${t}|${baseline}`) === true;
    if (x && !y) b++;
    else if (!x && y) c++;
    else if (x && y) both++;
    else neither++;
  }
  const d = b + c;
  const p = mcnemarOneSided(b, c);
  const shown = d >= minDiscordant && p <= alpha;
  const reading = shown
    ? `shown: ${capability} better than ${baseline} (p = ${p.toFixed(4)}, ${b} vs ${c} discordant)`
    : d < minDiscordant
      ? `not shown: underpowered at n = ${taskIds.length} (${d} discordant, fewer than ${minDiscordant})`
      : `not shown: p = ${p.toFixed(4)} > ${alpha} (${b} vs ${c} discordant)`;
  return {
    capability,
    baseline,
    capabilityOnly: b,
    baselineOnly: c,
    both,
    neither,
    discordant: d,
    pOneSided: p,
    shown,
    reading,
  };
}

/** Analyse one track-R pack under the committed r-v1 pre-registration. */
export function analyseRPack(input: RAnalysisInput): RAnalysis {
  const prereg = readPrereg(input.prereg);
  if (!prereg) return refused(["PREREG_SHAPE"]);
  const preregHash = canonicalSha256(input.prereg);

  const tasks = readManifestTasks(input.manifest, prereg.taskSetVersion);
  if (!tasks) return refused(["MANIFEST_SHAPE"]);
  if (canonicalSha256(input.manifest) !== prereg.manifestSha256)
    return refused(["MANIFEST_HASH_MISMATCH"]);

  if (!isPack(input.pack)) return refused(["PACK_SHAPE"]);
  const pack = input.pack;
  const codes = new Set<RRefusalCode>();
  if (pack.preregHash !== preregHash) codes.add("PREREG_HASH_MISMATCH");
  if (
    pack.taskSetVersion !== prereg.taskSetVersion ||
    pack.manifestSha256 !== prereg.manifestSha256
  )
    codes.add("PACK_TASK_SET_MISMATCH");
  const demoFamilies = pack.demonstrations.map((d) => d.family).sort();
  const wantFamilies = [...prereg.families].sort();
  if (
    demoFamilies.length !== wantFamilies.length ||
    demoFamilies.some((f, i) => f !== wantFamilies[i])
  )
    codes.add("DEMONSTRATIONS_INCOMPLETE");
  const anySimDemo = pack.demonstrations.some((d) => d.simulated);
  if (input.evidence && anySimDemo) codes.add("DEMONSTRATION_SIMULATED");
  const declaredRecordings = new Set(pack.demonstrations.map((d) => d.recordingSha256));

  // Trials.
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const schedule = rV1Schedule(
    prereg.assignmentSeed,
    tasks.map((t) => t.taskId),
  );
  const trials: RTrialRow[] = [];
  const keys = new Set<string>();
  const perArm = new Map<RArm, Map<string, number>>(R_ARMS.map((a) => [a, new Map()]));
  for (const row of input.trials) {
    if (claimsSimulated(row)) {
      codes.add("ROW_SIMULATED");
      continue;
    }
    if (!isTrial(row)) {
      codes.add("TRIAL_SHAPE");
      continue;
    }
    if (keys.has(row.trialKey)) codes.add("TRIAL_KEY_DUPLICATE");
    keys.add(row.trialKey);
    trials.push(row);
    const counts = perArm.get(row.arm) as Map<string, number>;
    counts.set(row.taskId, (counts.get(row.taskId) ?? 0) + 1);
    const task = taskById.get(row.taskId);
    if (!task) {
      codes.add("TASK_UNKNOWN");
      continue;
    }
    if (
      row.instructionSha256 !== task.instructionSha256 ||
      row.fixtureSha256 !== task.fixtureSha256
    )
      codes.add("TASK_HASH_MISMATCH");
    if (row.stepBudget !== prereg.stepBudget) codes.add("STEP_BUDGET_MISMATCH");
    if (schedule.get(`${row.taskId}|${row.arm}`) !== row.ordinal) codes.add("SCHEDULE_MISMATCH");
    if (row.arm === R_ARM) {
      if (row.derived === null) codes.add("TRIAL_SHAPE");
      else
        for (const inv of row.derived.invocations)
          if (!declaredRecordings.has(inv.recordingSha256)) codes.add("RECORDING_UNDECLARED");
    } else if (row.derived !== null) codes.add("DERIVED_ON_BASE_ARM");
  }
  // Arms: R and hcu+shell exactly fr-v1 once each; C1 either absent or exactly fr-v1 once each.
  for (const arm of R_ARMS) {
    const counts = perArm.get(arm) as Map<string, number>;
    if (arm === "C1" && counts.size === 0) continue;
    const exact =
      counts.size === tasks.length &&
      tasks.every((t) => counts.get(t.taskId) === 1) &&
      [...counts.keys()].every((k) => taskById.has(k));
    if (!exact) codes.add("ARM_INCOMPLETE");
  }
  // Planners: one model id; simulated planners never count.
  const planners = new Set(trials.map((t) => t.plannerModelId));
  const simulated = [...planners].filter((p) => p.startsWith(SIMULATED_PREFIX));
  if (simulated.length > 0 && simulated.length < planners.size) codes.add("PLANNER_MIXED");
  if (simulated.length > 0 && input.evidence) codes.add("SIMULATED_PLANNER");
  if (simulated.length === 0 && [...planners].some((p) => p !== prereg.modelId))
    codes.add("PLANNER_MISMATCH");

  // Grades: exactly one per trial, bound to the same task, fixture and captured bytes.
  const gradeByKey = new Map<string, GradeView>();
  for (const g of input.grades) {
    if (claimsSimulated(g)) {
      codes.add("ROW_SIMULATED");
      continue;
    }
    const grade = readGrade(g);
    if (!grade) {
      codes.add("GRADE_SHAPE");
      continue;
    }
    if (gradeByKey.has(grade.trialKey)) codes.add("GRADE_SHAPE");
    gradeByKey.set(grade.trialKey, grade);
    if (!keys.has(grade.trialKey)) codes.add("GRADE_UNKNOWN_TRIAL");
  }
  for (const t of trials) {
    const g = gradeByKey.get(t.trialKey);
    if (!g) {
      codes.add("GRADE_MISSING");
      continue;
    }
    if (
      g.taskId !== t.taskId ||
      g.graderVersion !== prereg.graderVersion ||
      g.fixtureSha256 !== t.fixtureSha256 ||
      g.persistedSha256 !== t.persistedSha256
    )
      codes.add("GRADE_MISMATCH");
  }
  if (codes.size > 0) return refused(codes);

  // Verified (gate-less rows): a done claim the independent grader graded pass.
  const status = (t: RTrialRow) => (gradeByKey.get(t.trialKey) as GradeView).status;
  const verified = new Map<string, boolean>();
  for (const t of trials)
    verified.set(`${t.taskId}|${t.arm}`, t.claim === "done" && status(t) === "pass");

  // Prerequisite property and the false-accept guardrail (R arm only).
  const rTrials = trials.filter((t) => t.arm === R_ARM);
  let uncertifiedVerdicts = 0;
  let uncertifiedNotRefused = 0;
  let falseAccepts = 0;
  let used = 0;
  let invocations = 0;
  let certified = 0;
  for (const t of rTrials) {
    const invs = t.derived?.invocations ?? [];
    if (invs.length > 0) used++;
    let derivedVerified = false;
    for (const inv of invs) {
      invocations++;
      if (inv.certified) certified++;
      if (!inv.certified && inv.gateVerdict !== null) uncertifiedVerdicts++;
      if (!inv.certified && inv.refusal !== "SELFTEST_FAILED") uncertifiedNotRefused++;
      if (inv.gateVerdict === "verified") derivedVerified = true;
    }
    if (derivedVerified && status(t) !== "pass") falseAccepts++;
  }
  const prerequisiteHeld = uncertifiedVerdicts === 0 && uncertifiedNotRefused === 0;

  // Planted-marker scan over everything the pack carries.
  let markerFinding: string | null = null;
  try {
    assertClean({ pack, trials: input.trials, grades: input.grades }, input.markers ?? []);
  } catch (e) {
    markerFinding = e instanceof Error ? e.message : "marker";
  }

  const taskIds = tasks.map((t) => t.taskId);
  const primary = prerequisiteHeld
    ? compare(R_ARM, "hcu+shell", verified, taskIds, prereg.alpha, prereg.minDiscordant)
    : null;
  const c1Ran = (perArm.get("C1") as Map<string, number>).size > 0;
  const vsC1 = c1Ran
    ? compare(R_ARM, "C1", verified, taskIds, prereg.alpha, prereg.minDiscordant)
    : null;

  const rates: ArmRate[] = [];
  const perVerified: Record<
    string,
    { steps: number | null; wallClockS: number | null; costUsdEstimate: number | null }
  > = {};
  for (const arm of R_ARMS) {
    const rows = trials.filter((t) => t.arm === arm);
    if (rows.length === 0) continue;
    const v = rows.filter((t) => verified.get(`${t.taskId}|${arm}`)).length;
    rates.push({ arm, verified: v, trials: rows.length, wilson95: wilson95(v, rows.length) });
    const ratio = (pick: (t: RTrialRow) => number | null): number | null => {
      if (v === 0 || rows.some((t) => pick(t) === null)) return null;
      return rows.reduce((s, t) => s + (pick(t) as number), 0) / v;
    };
    perVerified[arm] = {
      steps: ratio((t) => t.steps),
      wallClockS: ratio((t) => t.wallClockS),
      costUsdEstimate: ratio((t) => t.costUsdEstimate),
    };
  }

  const simulatedPack = simulated.length > 0 || anySimDemo;
  const isEvidence = input.evidence && !simulatedPack;
  const label = simulatedPack ? SIMULATED_LABEL : input.evidence ? null : NOT_EVIDENCE_LABEL;
  const pending = prereg.leadRulingPending.length;
  // What keeps a computed comparison from being a result: never "shown" while any applies.
  const blockers = [label, pending > 0 ? pendingText(pending) : null].filter(
    (b): b is string => b !== null,
  );
  const withheld = (c: Comparison | null): Comparison | null =>
    c === null || blockers.length === 0
      ? c
      : {
          ...c,
          shown: false,
          reading: `${blockers.join("; ")}; computed, not a result: p = ${c.pOneSided.toFixed(4)}, ${c.capabilityOnly} vs ${c.baselineOnly} discordant`,
        };
  const markersClean = markerFinding === null;
  const barShown =
    isEvidence &&
    pending === 0 &&
    prerequisiteHeld &&
    falseAccepts === 0 &&
    markersClean &&
    primary?.shown === true;
  const primaryOut = withheld(primary);
  const breach = !prerequisiteHeld
    ? "not shown: prerequisite failed (an uncertified derived oracle verified or was not refused)"
    : falseAccepts > 0
      ? `not shown: ${falseAccepts} derived-gate false accept(s)`
      : !markersClean
        ? "not shown: planted-marker scan found a marker"
        : null;
  const reading =
    breach === null
      ? (primaryOut as Comparison).reading
      : blockers.length > 0
        ? `${blockers.join("; ")}; ${breach}`
        : breach;

  return {
    status: "analysed",
    preregHash,
    evidence: isEvidence,
    label,
    leadRulingPending: pending,
    prerequisite: { held: prerequisiteHeld, uncertifiedVerdicts, uncertifiedNotRefused },
    guardrails: {
      derivedFalseAccepts: falseAccepts,
      rTrials: rTrials.length,
      zeroEventUpper95: falseAccepts === 0 ? zeroEventUpper95(rTrials.length) : null,
      markerScan: { clean: markersClean, finding: markerFinding },
    },
    primary: primaryOut,
    secondary: {
      vsC1: withheld(vsC1),
      rates,
      perVerified,
      workflowShare: { used, rTrials: rTrials.length },
      r5PassRate: { certified, invocations },
    },
    barShown,
    reading,
  };
}
