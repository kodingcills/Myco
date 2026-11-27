/**
 * Capability track P (tier 2): the analysis that pre-registration p-v1 freezes
 * (`docs/product/capability-prereg/p-v1/prereg.json`, Part 1 §3 of
 * `docs/product/capability-spec.md`). The bar is `docs/product/capability-spec-2.md` §P as
 * written:
 *
 * - Arms: `B+P` (the checkpointed family, per-step gate checkpoints, one retry from the last
 *   verified checkpoint) vs `B` (the same tasks, one gate check on the end state, no
 *   checkpoints, no retry). Both arms are gated rows. Same step budget.
 * - Task set: xa-v2 (40 tasks), pinned by `sha256(manifest.json)`. One scored trial per
 *   (task, arm); the unit is the task, paired across arms.
 * - Verified (Part 1 §1.1, gated rows): a done claim, the gate's end-state verdict `verified`
 *   (and, in `B+P`, the last checkpoint `verified`), and every step snapshot and the end
 *   state graded `pass` by the independent grader. A grader all-`pass` with a done claim that
 *   the gate did not verify is "correct, not accepted"; it is never verified.
 * - Bar, fixed sequence at alpha 0.05 one-sided:
 *   1. exact one-sided McNemar (sign test on the discordant tasks), `B+P` better than `B`,
 *      p <= 0.05 with at least 5 discordant tasks;
 *   2. only if 1 is shown: steps per verified task, paired bootstrap over tasks (10,000
 *      resamples, pre-registered seed), one-sided 95% upper bound of `B+P`/`B` below 1.0.
 * - Guardrail: zero gate false-verifieds over all `B+P` trials (gate end `verified` while any
 *   step or end grade is not `pass`); one fails the bar.
 * - Not shown (Part 1 §1.5): p > 0.05; fewer than 5 discordant ("underpowered at n"); a
 *   guardrail breached; a parity or assignment check failed.
 * - Refused (Part 1 §3 items 2 and 5): a pack whose pre-registration hash, task set or
 *   manifest digest does not match the committed pre-registration, or any simulated row (a
 *   planner that is not the pre-registered model id, or a row marked simulated).
 * - Incomplete: the record does not fill every (task, arm) cell exactly once with known
 *   values. Never a pass.
 *
 * Self-contained on purpose: the pre-registration pins this file's SHA-256, so it imports no
 * repo module whose change could alter the analysis without changing that digest. It reads
 * counts only; it imports nothing from the gate or the grader.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const P_PREREG_SCHEMA = "myco.capability-prereg/1" as const;
export const P_PACK_SCHEMA = "myco.cross-app.p-pack/1" as const;
export const P_PREREG_PATH = "docs/product/capability-prereg/p-v1/prereg.json";
export const P_PREREG_HASH_PATH = "docs/product/capability-prereg/p-v1/prereg.sha256";
export const P_ANALYSIS_MODULE = "src/benchmark/cross-app-prereg.ts";
export const P_ANALYSIS_SCRIPT = "scripts/cross-app-prereg.ts";

export const P_ARMS = ["B+P", "B"] as const;
export type PArm = (typeof P_ARMS)[number];
export type PGrade = "pass" | "fail" | "ungradable";
export type PVerdict = "verified" | "refuted" | "uncertain";

/** The fields of the pre-registration this analysis reads (the rest is for readers). */
export interface PPrereg {
  readonly schema: typeof P_PREREG_SCHEMA;
  readonly track: "P";
  readonly version: "p-v1";
  readonly taskSet: {
    readonly version: string;
    readonly tasks: number;
    readonly manifest: string;
    readonly manifestSha256: string;
    readonly taskIds: readonly string[];
  };
  readonly seeds: { readonly assignment: string; readonly bootstrap: string };
  readonly stepBudget: number;
  readonly retryBudget: { readonly "B+P": number; readonly B: number };
  readonly model: { readonly plannerModelId: string };
  readonly bar: {
    readonly alpha: number;
    readonly minDiscordant: number;
    readonly bootstrapResamples: number;
    readonly ratioUpperBoundBelow: number;
  };
  readonly analysis: {
    readonly module: string;
    readonly moduleSha256: string;
    readonly script: string;
    readonly scriptSha256: string;
  };
}

/** One scored trial of the pack (one per task per arm). */
export interface PTrial {
  readonly arm: PArm;
  readonly taskId: string;
  /** 0-based position in the run order; must follow the pre-registered schedule. */
  readonly ordinal: number;
  readonly plannerModelId: string;
  readonly simulated?: boolean;
  readonly instructionSha256: string;
  readonly stepBudget: number;
  readonly retryBudget: number;
  readonly doneClaim: boolean;
  /** The gate's end-state verdict (both arms are gated rows). */
  readonly gateEndVerdict: PVerdict;
  /** `B+P` only: the gate's verdict on the last checkpoint. */
  readonly lastCheckpointVerdict?: PVerdict;
  /** The independent grader's status for each step snapshot, in step order. */
  readonly stepGrades: readonly PGrade[];
  /** The independent grader's status for the end state. */
  readonly endGrade: PGrade;
  /** Agent tool calls of any kind, over all attempts of the trial. */
  readonly steps: number;
}

export interface PPack {
  readonly schema: typeof P_PACK_SCHEMA;
  readonly preregSha256: string;
  readonly preregCommit: string;
  readonly taskSetVersion: string;
  readonly manifestSha256: string;
  readonly trials: readonly PTrial[];
}

export interface PArmSummary {
  readonly n: number;
  readonly verified: number;
  readonly rate: number;
  readonly wilson95: readonly [number, number];
  readonly correctNotAccepted: number;
  readonly falseDone: number;
  /** Per step: snapshots graded `pass` over trials. */
  readonly stepPassRate: readonly number[];
  /** Trials whose first non-`pass` grade is at step k (1-based), or at the end state. */
  readonly firstFailure: Readonly<Record<string, number>>;
  readonly totalSteps: number;
  /** Total steps over ALL trials / verified trials; null when nothing was verified. */
  readonly stepsPerVerified: number | null;
}

export interface PResult {
  readonly decision: "shown" | "not-shown" | "refused" | "incomplete";
  /** Codes and short reasons; refusals and incompletes list every problem found. */
  readonly reasons: readonly string[];
  readonly evidenceUse: "experiment-only (never R1 evidence)";
  readonly arms?: { readonly "B+P": PArmSummary; readonly B: PArmSummary };
  /** Paired 2x2: both verified, `B+P` only, `B` only, neither. */
  readonly table?: {
    readonly both: number;
    readonly pOnly: number;
    readonly bOnly: number;
    readonly neither: number;
  };
  readonly discordant?: number;
  readonly mcnemarP?: number;
  readonly component1?: "shown" | "not-shown";
  readonly component2?: "shown" | "not-shown" | "not-tested";
  readonly ratioStepsPerVerified?: number | null;
  readonly ratioUpper95?: number | null;
  readonly falseVerified?: number;
  /** One-sided 95% upper bound on the false-verified rate when zero were observed in n. */
  readonly falseVerifiedUpper95?: number;
}

// ---------------------------------------------------------------- hashing

/** Canonical JSON: object keys sorted, no whitespace; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export const sha256Hex = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** The pre-registration hash: SHA-256 over the canonical JSON of the parsed prereg. */
export function preregHash(prereg: unknown): string {
  return sha256Hex(canonicalJson(prereg));
}

// ---------------------------------------------------------------- statistics

/** Natural log of C(n, k). */
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(k, n - k); i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

/**
 * Exact one-sided McNemar: P(X >= pOnly) for X ~ Binomial(pOnly + bOnly, 1/2), the sign test
 * on the discordant tasks. 1 with no discordant task.
 */
export function mcnemarOneSided(pOnly: number, bOnly: number): number {
  const n = pOnly + bOnly;
  if (n === 0) return 1;
  let p = 0;
  for (let i = pOnly; i <= n; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, p);
}

/** Wilson score 95% interval; [0, 1] with no trials. */
export function wilson95(x: number, n: number): readonly [number, number] {
  if (n <= 0) return [0, 1];
  const z = 1.959963984540054;
  const p = x / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** One-sided 95% upper bound on a rate after 0 events in n (Clopper-Pearson). */
export function zeroEventUpper95(n: number): number {
  return n <= 0 ? 1 : 1 - 0.05 ** (1 / n);
}

/** mulberry32, seeded from the first 4 bytes of sha256(seed): deterministic per seed. */
export function seededRandom(seed: string): () => number {
  let a = Number.parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per task, per arm: steps spent and whether the trial was verified. */
export interface PPairedCell {
  readonly pSteps: number;
  readonly pVerified: boolean;
  readonly bSteps: number;
  readonly bVerified: boolean;
}

/** (sum steps / verified) of `B+P` over the same of `B`; Infinity when either arm has 0 verified. */
export function stepsRatio(cells: readonly PPairedCell[]): number {
  let ps = 0;
  let pv = 0;
  let bs = 0;
  let bv = 0;
  for (const c of cells) {
    ps += c.pSteps;
    bs += c.bSteps;
    if (c.pVerified) pv++;
    if (c.bVerified) bv++;
  }
  if (pv === 0 || bv === 0 || bs === 0) return Number.POSITIVE_INFINITY;
  return ps / pv / (bs / bv);
}

/**
 * Paired bootstrap over tasks: `resamples` resamples of the cells with replacement, the ratio
 * on each; returns the one-sided 95% upper bound (the 95th percentile, nearest rank). A
 * resample where either arm verified nothing counts as Infinity (conservative).
 */
export function bootstrapRatioUpper95(
  cells: readonly PPairedCell[],
  resamples: number,
  seed: string,
): number {
  const rand = seededRandom(seed);
  const n = cells.length;
  const ratios: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample: PPairedCell[] = [];
    for (let i = 0; i < n; i++) sample.push(cells[Math.floor(rand() * n)] as PPairedCell);
    ratios.push(stepsRatio(sample));
  }
  ratios.sort((x, y) => x - y);
  return ratios[Math.max(0, Math.ceil(0.95 * resamples) - 1)] as number;
}

// ---------------------------------------------------------------- assignment

/**
 * The pre-registered run order: tasks shuffled by the assignment seed (Fisher-Yates), then
 * arms in ABBA blocks over consecutive tasks (`B+P`,`B` for even positions, `B`,`B+P` for odd),
 * so drift falls on both arms. Returns (arm, taskId) in run order; a trial's `ordinal` is its
 * index here.
 */
export function assignmentSchedule(
  taskIds: readonly string[],
  seed: string,
): { arm: PArm; taskId: string }[] {
  const order = [...taskIds];
  const rand = seededRandom(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as string, order[i] as string];
  }
  return order.flatMap((taskId, i) =>
    i % 2 === 0
      ? [
          { arm: "B+P" as const, taskId },
          { arm: "B" as const, taskId },
        ]
      : [
          { arm: "B" as const, taskId },
          { arm: "B+P" as const, taskId },
        ],
  );
}

// ---------------------------------------------------------------- trial rules

const GRADES: ReadonlySet<unknown> = new Set(["pass", "fail", "ungradable"]);
const VERDICTS: ReadonlySet<unknown> = new Set(["verified", "refuted", "uncertain"]);
const STEPS_PER_TASK = 3;

const allPass = (t: PTrial) => t.stepGrades.every((g) => g === "pass") && t.endGrade === "pass";

/** Part 1 §1.1, gated rows, with P's checkpoint clause. */
export function isVerified(t: PTrial): boolean {
  if (!t.doneClaim || t.gateEndVerdict !== "verified" || !allPass(t)) return false;
  return t.arm === "B" || t.lastCheckpointVerdict === "verified";
}

/** Gate end `verified` while the grader did not pass every snapshot and the end state. */
export function isFalseVerified(t: PTrial): boolean {
  return t.gateEndVerdict === "verified" && !allPass(t);
}

function summarize(trials: readonly PTrial[]): PArmSummary {
  const n = trials.length;
  const verified = trials.filter(isVerified).length;
  const correctNotAccepted = trials.filter(
    (t) => t.doneClaim && allPass(t) && !isVerified(t),
  ).length;
  const falseDone = trials.filter((t) => t.doneClaim && t.endGrade !== "pass").length;
  const stepPassRate = Array.from(
    { length: STEPS_PER_TASK },
    (_, k) => trials.filter((t) => t.stepGrades[k] === "pass").length / n,
  );
  const firstFailure: Record<string, number> = {};
  for (const t of trials) {
    const k = t.stepGrades.findIndex((g) => g !== "pass");
    const key = k >= 0 ? `step-${k + 1}` : t.endGrade !== "pass" ? "end" : undefined;
    if (key) firstFailure[key] = (firstFailure[key] ?? 0) + 1;
  }
  const totalSteps = trials.reduce((s, t) => s + t.steps, 0);
  return {
    n,
    verified,
    rate: verified / n,
    wilson95: wilson95(verified, n),
    correctNotAccepted,
    falseDone,
    stepPassRate,
    firstFailure,
    totalSteps,
    stepsPerVerified: verified === 0 ? null : totalSteps / verified,
  };
}

// ---------------------------------------------------------------- checks

/** Refusals (Part 1 §3 items 2 and 5): the pack is not analysed at all. */
function refusals(pack: PPack, prereg: PPrereg, committedHash: string): string[] {
  const out: string[] = [];
  if (pack.schema !== P_PACK_SCHEMA) out.push("PACK_SCHEMA");
  if (pack.preregSha256 !== committedHash) out.push("PREREG_HASH_MISMATCH");
  if (typeof pack.preregCommit !== "string" || !/^[0-9a-f]{40}$/.test(pack.preregCommit))
    out.push("PREREG_COMMIT_MISSING");
  if (pack.taskSetVersion !== prereg.taskSet.version) out.push("TASK_SET_MISMATCH");
  if (pack.manifestSha256 !== prereg.taskSet.manifestSha256) out.push("MANIFEST_MISMATCH");
  const trials = Array.isArray(pack.trials) ? pack.trials : [];
  for (const t of trials) {
    if (t.simulated === true || t.plannerModelId !== prereg.model.plannerModelId) {
      out.push("SIMULATED_ROW");
      break;
    }
  }
  return out;
}

/** Design problems: every (task, arm) cell exactly once, known values only. */
function designProblems(pack: PPack, prereg: PPrereg): string[] {
  const out: string[] = [];
  if (!Array.isArray(pack.trials)) return ["TRIALS_MISSING"];
  const known = new Set(prereg.taskSet.taskIds);
  const seen = new Map<string, number>();
  for (const t of pack.trials) {
    const id = `${String(t.arm)}:${String(t.taskId)}`;
    if (!(P_ARMS as readonly unknown[]).includes(t.arm)) {
      out.push(`UNKNOWN_ARM ${String(t.arm)}`);
      continue;
    }
    if (!known.has(t.taskId)) {
      out.push(`UNKNOWN_TASK ${id}`);
      continue;
    }
    if (typeof t.doneClaim !== "boolean") out.push(`DONE_CLAIM ${id}`);
    if (!VERDICTS.has(t.gateEndVerdict)) out.push(`GATE_VERDICT ${id}`);
    if (t.arm === "B+P" && !VERDICTS.has(t.lastCheckpointVerdict)) out.push(`CHECKPOINT ${id}`);
    if (!GRADES.has(t.endGrade)) out.push(`END_GRADE ${id}`);
    if (
      !Array.isArray(t.stepGrades) ||
      t.stepGrades.length !== STEPS_PER_TASK ||
      !t.stepGrades.every((g: unknown) => GRADES.has(g))
    )
      out.push(`STEP_GRADES ${id}`);
    if (!Number.isInteger(t.steps) || t.steps < 0) out.push(`STEPS ${id}`);
    if (!Number.isInteger(t.ordinal)) out.push(`ORDINAL ${id}`);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const arm of P_ARMS)
    for (const taskId of prereg.taskSet.taskIds) {
      const count = seen.get(`${arm}:${taskId}`) ?? 0;
      if (count !== 1) out.push(`CELL ${arm}:${taskId} ran ${count} times`);
    }
  return out;
}

/**
 * Parity and assignment (Part 1 §1.3): the same instruction per task in both arms, the
 * pre-registered step budget and retry budgets, no trial over its budget, and the run order
 * the assignment seed fixes. A failure is "not shown", never a pass.
 */
function parityProblems(pack: PPack, prereg: PPrereg): string[] {
  const out: string[] = [];
  const byTask = new Map<string, PTrial[]>();
  for (const t of pack.trials) byTask.set(t.taskId, [...(byTask.get(t.taskId) ?? []), t]);
  for (const [taskId, pair] of byTask) {
    if (new Set(pair.map((t) => t.instructionSha256)).size !== 1)
      out.push(`PARITY_INSTRUCTION ${taskId}`);
  }
  for (const t of pack.trials) {
    if (t.stepBudget !== prereg.stepBudget) out.push(`PARITY_STEP_BUDGET ${t.arm}:${t.taskId}`);
    if (t.steps > prereg.stepBudget) out.push(`OVER_BUDGET ${t.arm}:${t.taskId}`);
    if (t.retryBudget !== prereg.retryBudget[t.arm])
      out.push(`PARITY_RETRY_BUDGET ${t.arm}:${t.taskId}`);
  }
  const schedule = assignmentSchedule(prereg.taskSet.taskIds, prereg.seeds.assignment);
  for (const t of pack.trials) {
    const slot = schedule[t.ordinal];
    if (!slot || slot.arm !== t.arm || slot.taskId !== t.taskId)
      out.push(`ASSIGNMENT ${t.arm}:${t.taskId}`);
  }
  return out;
}

// ---------------------------------------------------------------- the committed prereg

export interface LoadedPPrereg {
  readonly prereg: PPrereg;
  /** Computed from the committed `prereg.json`, never read from a pack. */
  readonly hash: string;
  /** Every inconsistency between the prereg, its hash file and the committed files. */
  readonly problems: readonly string[];
}

/**
 * Load the committed pre-registration and check it against what it pins: its own hash file,
 * the task set manifest digest and task ids, and the analysis module and script digests.
 */
export function loadPPrereg(repoRoot: string): LoadedPPrereg {
  const read = (rel: string) => readFileSync(join(repoRoot, rel));
  const prereg = JSON.parse(read(P_PREREG_PATH).toString("utf8")) as PPrereg;
  const hash = preregHash(prereg);
  const problems: string[] = [];
  if (prereg.schema !== P_PREREG_SCHEMA) problems.push("PREREG_SCHEMA");
  const recorded = read(P_PREREG_HASH_PATH).toString("utf8").trim();
  if (recorded !== hash) problems.push("PREREG_HASH_FILE");
  const manifestPath = prereg.taskSet.manifest;
  if (sha256Hex(read(manifestPath)) !== prereg.taskSet.manifestSha256)
    problems.push("MANIFEST_SHA256");
  const tasksPath = join(dirname(manifestPath), "tasks.jsonl");
  const ids = read(tasksPath)
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { taskId: string; taskSetVersion: string }).taskId);
  if (canonicalJson(ids) !== canonicalJson(prereg.taskSet.taskIds)) problems.push("TASK_IDS");
  if (ids.length !== prereg.taskSet.tasks) problems.push("TASK_COUNT");
  if (prereg.analysis.module !== P_ANALYSIS_MODULE) problems.push("ANALYSIS_MODULE_PATH");
  if (prereg.analysis.script !== P_ANALYSIS_SCRIPT) problems.push("ANALYSIS_SCRIPT_PATH");
  if (sha256Hex(read(P_ANALYSIS_MODULE)) !== prereg.analysis.moduleSha256)
    problems.push("ANALYSIS_MODULE_SHA256");
  if (sha256Hex(read(P_ANALYSIS_SCRIPT)) !== prereg.analysis.scriptSha256)
    problems.push("ANALYSIS_SCRIPT_SHA256");
  return { prereg, hash, problems };
}

// ---------------------------------------------------------------- analysis

const EVIDENCE_USE = "experiment-only (never R1 evidence)" as const;

/**
 * Judge a pack against pre-registration p-v1. `committedHash` is the pre-registration hash of
 * the committed `prereg.json` (computed by the caller from the file, never taken from the
 * pack).
 */
export function analyzePPack(pack: PPack, prereg: PPrereg, committedHash: string): PResult {
  const refused = refusals(pack, prereg, committedHash);
  if (refused.length > 0)
    return { decision: "refused", reasons: refused, evidenceUse: EVIDENCE_USE };
  const design = designProblems(pack, prereg);
  if (design.length > 0)
    return { decision: "incomplete", reasons: design, evidenceUse: EVIDENCE_USE };

  const pTrials = pack.trials.filter((t) => t.arm === "B+P");
  const bTrials = pack.trials.filter((t) => t.arm === "B");
  const arms = { "B+P": summarize(pTrials), B: summarize(bTrials) };
  const bTrialOf = new Map(bTrials.map((t) => [t.taskId, t]));
  const cells: PPairedCell[] = pTrials.map((p) => {
    const b = bTrialOf.get(p.taskId) as PTrial;
    return { pSteps: p.steps, pVerified: isVerified(p), bSteps: b.steps, bVerified: isVerified(b) };
  });
  const table = { both: 0, pOnly: 0, bOnly: 0, neither: 0 };
  for (const c of cells) {
    if (c.pVerified && c.bVerified) table.both++;
    else if (c.pVerified) table.pOnly++;
    else if (c.bVerified) table.bOnly++;
    else table.neither++;
  }
  const discordant = table.pOnly + table.bOnly;
  const mcnemarP = mcnemarOneSided(table.pOnly, table.bOnly);
  const falseVerified = pTrials.filter(isFalseVerified).length;

  const reasons: string[] = [];
  const parity = parityProblems(pack, prereg);
  reasons.push(...parity);
  if (falseVerified > 0) reasons.push(`GUARDRAIL_FALSE_VERIFIED ${falseVerified}`);
  if (discordant < prereg.bar.minDiscordant)
    reasons.push(`UNDERPOWERED at n=${cells.length}: ${discordant} discordant`);
  if (!(mcnemarP <= prereg.bar.alpha)) reasons.push(`MCNEMAR_P ${mcnemarP.toFixed(4)}`);
  const component1 = reasons.length === 0 ? "shown" : "not-shown";

  let component2: "shown" | "not-shown" | "not-tested" = "not-tested";
  let ratioUpper95: number | null = null;
  const ratio = stepsRatio(cells);
  if (component1 === "shown") {
    ratioUpper95 = bootstrapRatioUpper95(
      cells,
      prereg.bar.bootstrapResamples,
      prereg.seeds.bootstrap,
    );
    component2 = ratioUpper95 < prereg.bar.ratioUpperBoundBelow ? "shown" : "not-shown";
    if (component2 === "not-shown") reasons.push(`RATIO_UPPER95 ${ratioUpper95}`);
  }
  return {
    decision: component1 === "shown" ? "shown" : "not-shown",
    reasons,
    evidenceUse: EVIDENCE_USE,
    arms,
    table,
    discordant,
    mcnemarP,
    component1,
    component2,
    ratioStepsPerVerified: Number.isFinite(ratio) ? ratio : null,
    ratioUpper95: ratioUpper95 !== null && Number.isFinite(ratioUpper95) ? ratioUpper95 : null,
    falseVerified,
    ...(falseVerified === 0 ? { falseVerifiedUpper95: zeroEventUpper95(pTrials.length) } : {}),
  };
}
