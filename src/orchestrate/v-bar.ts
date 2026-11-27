/**
 * Capability track V (tier 2): the pre-registered measurement bar for recursive orchestration,
 * as code, so the bar `docs/product/capability-spec-2.md` §2 V states is the bar a pack is
 * judged by. Frozen by `docs/product/capability-prereg/v-v1/prereg.json`, which pins this
 * file's SHA-256 (and the CLI's, `scripts/orch-v-bar.ts`).
 *
 * Design (fixed before any run):
 * - Task set: orch-v1, pinned by `sha256(manifest.json)` in the pre-registration. Every task
 *   must appear exactly once per arm, with exactly its parts, or the pack is refused.
 * - Arms: `V` (planner plus gated workers on the `hcu+shell` surface), `H` (`hcu+shell`) and
 *   `C1`. Primary comparison `V` vs `H`; `V` vs `C1` is reported, never a bar component (the
 *   arms also differ by the shell channel: Part 1 §1.3 parity).
 * - Verified, per row kind (Part 1 §1.1, spec-2 §1.3): `V` rows are gated: a done claim, every
 *   part's gate verdict `verified`, and every part graded `pass` by the independent grader.
 *   `H` and `C1` rows are gate-less: a done claim and every part graded `pass`. `fail` and
 *   `ungradable` are never a pass.
 * - Fixed sequence: (1) control properties: any breach of the pre-registered limits, the
 *   unmetered rule, the kill switch or the ledger-failure halt voids the run; (2) exact
 *   one-sided McNemar (sign test on discordant tasks), `V` better than `H`, p <= alpha with at
 *   least `minDiscordant` discordant tasks.
 * - Guardrails: false done (a done claim with any part not `pass`) in `V` no higher than in
 *   either baseline, else not shown; any false VERIFIED in `V` (a part the gate verified that
 *   the grader did not pass) halts the run: void.
 * - Refusals (fail closed, never a result): a pre-registration hash mismatch, a simulated row
 *   or a planner that is not the pre-registered model id, an unknown or repeated cell, a part
 *   list that is not the task's, an unknown value, a `V` part without a gate verdict, a `V`
 *   row without its control record, and a worker-trial count that disagrees with the ledger.
 *
 * Limits are read from the pre-registration, never from a row, so a pack cannot loosen them.
 * This module only reads counts and records; it imports nothing from the gate or the grader.
 */
import { wilson } from "../foundry/stats.ts";

export const V_BAR = {
  track: "V",
  version: "v-v1",
  taskSet: "orch-v1",
  tasks: 60,
  alpha: 0.05,
  minDiscordant: 5,
  arms: ["V", "H", "C1"],
  primary: { treatment: "V", baseline: "H" },
  secondary: { treatment: "V", baseline: "C1" },
} as const;

export type VArm = (typeof V_BAR.arms)[number];
export type VGrade = "pass" | "fail" | "ungradable";
export type VGateVerdict = "verified" | "refuted" | "uncertain";
export type VClaim = "done" | "not-done" | "none";

const ARMS: readonly string[] = V_BAR.arms;
const GRADES: readonly string[] = ["pass", "fail", "ungradable"];
const VERDICTS: readonly string[] = ["verified", "refuted", "uncertain"];
const CLAIMS: readonly string[] = ["done", "not-done", "none"];

/** The orchestrator limits a `V` tree runs under, as pre-registered. */
export interface VLimits {
  readonly maxTotalTokens: number;
  readonly maxTokensPerWorker: number;
  readonly maxEstimatedCostMicroUsd: number;
  readonly maxWallMs: number;
  readonly maxDepth: number;
  readonly maxConcurrentDesktops: number;
  readonly maxSpawnsPerPlanner: number;
  readonly maxTotalSpawns: number;
}

/** The subset of the pre-registration the analysis reads. */
export interface VPrereg {
  readonly schema: string;
  readonly track: string;
  readonly version: string;
  readonly modelId: string;
  readonly taskSet: { readonly version: string; readonly tasks: number };
  readonly test: { readonly alpha: number; readonly minDiscordant: number };
  readonly limits: VLimits;
}

/**
 * What one `V` tree did, as observed host-side from its run record and ledger (never from the
 * planner). The control properties are checked against the pre-registered limits.
 */
export interface VTreeControls {
  readonly tokensUsed: number;
  /** Token-derived estimate; null when any usage was unmetered (never 0). */
  readonly costEstimateMicroUsd: number | null;
  readonly wallMs: number;
  readonly maxDepthObserved: number;
  readonly maxConcurrentObserved: number;
  readonly maxSpawnsByOnePlanner: number;
  readonly totalSpawns: number;
  readonly unmetered: boolean;
  readonly spawnsAdmittedAfterUnmetered: number;
  readonly killed: boolean;
  readonly spawnsAdmittedAfterKill: number;
  /** Null when the tree was not killed. */
  readonly killLatencyMs: number | null;
  readonly orphanedDesktops: number;
  readonly orphanedWorkerTrials: number;
  readonly openLedgerAttempts: number;
  readonly ledgerWriteFailed: boolean;
  readonly haltedOnLedgerFailure: boolean;
  /** Worker trials in the run record, and worker attempts in the attempt ledger. */
  readonly workerTrials: number;
  readonly ledgerWorkerAttempts: number;
}

export interface VBarPart {
  readonly partId: string;
  readonly grade: VGrade;
  /** Required on `V` rows (gated); ignored on `H` and `C1` rows. */
  readonly gateVerdict?: VGateVerdict;
}

export interface VBarRow {
  readonly arm: VArm;
  readonly taskId: string;
  readonly simulated: boolean;
  readonly modelId: string;
  readonly claim: VClaim;
  readonly parts: readonly VBarPart[];
  /** Token-derived estimate over the whole trial (workers included); null when unmetered. */
  readonly costEstimateMicroUsd: number | null;
  readonly wallMs: number;
  /** Required on `V` rows. */
  readonly controls?: VTreeControls;
}

export interface VBarPack {
  readonly preregHash: string;
  readonly rows: readonly VBarRow[];
}

export interface VBarInput {
  readonly prereg: VPrereg;
  /** SHA-256 over canonical JSON of the committed pre-registration. */
  readonly preregHash: string;
  /** The orch-v1 tasks: id -> its part ids, in order. */
  readonly tasks: ReadonlyMap<string, readonly string[]>;
  readonly pack: VBarPack;
}

export interface VArmSummary {
  readonly n: number;
  readonly verified: number;
  readonly rate: number;
  readonly interval: readonly [number, number] | null;
  readonly falseDone: number;
  /** Total estimate over ALL trials / verified; null if any trial is unmetered or none verified. */
  readonly costPerVerifiedMicroUsd: number | null;
  readonly wallMsPerVerified: number | null;
}

export interface VComparison {
  readonly treatmentOnly: number;
  readonly baselineOnly: number;
  readonly discordant: number;
  /** Exact one-sided p: P(X >= treatmentOnly), X ~ Binomial(discordant, 1/2). */
  readonly p: number;
}

export interface VBarResult {
  readonly decision: "shown" | "not-shown" | "void" | "refused";
  readonly reasons: readonly string[];
  readonly controlBreaches?: readonly { readonly taskId: string; readonly code: string }[];
  readonly falseVerified?: number;
  readonly arms?: Readonly<Record<VArm, VArmSummary>>;
  readonly primary?: VComparison;
  /** Reported only; never part of the decision. */
  readonly secondary?: VComparison;
  readonly killLatencyMsMax?: number | null;
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(k, n - k); i++) s += Math.log(n - i) - Math.log(i + 1);
  return s;
}

/** Exact one-sided sign test: P(X >= favouring) for X ~ Binomial(favouring + against, 1/2). */
export function mcnemarOneSidedP(favouring: number, against: number): number {
  const n = favouring + against;
  if (n === 0) return 1;
  let p = 0;
  for (let i = favouring; i <= n; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, p);
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Every control-property breach of one `V` tree against the pre-registered limits. */
export function controlBreaches(c: VTreeControls, limits: VLimits): string[] {
  const out: string[] = [];
  if (c.tokensUsed > limits.maxTotalTokens) out.push("BUDGET_TOKENS");
  if (c.costEstimateMicroUsd !== null && c.costEstimateMicroUsd > limits.maxEstimatedCostMicroUsd)
    out.push("BUDGET_COST");
  if (c.wallMs > limits.maxWallMs) out.push("BUDGET_WALL");
  if (c.maxDepthObserved > limits.maxDepth) out.push("DEPTH_CAP");
  if (c.maxConcurrentObserved > limits.maxConcurrentDesktops) out.push("CONCURRENCY_CAP");
  if (c.maxSpawnsByOnePlanner > limits.maxSpawnsPerPlanner) out.push("PLANNER_SPAWN_CAP");
  if (c.totalSpawns > limits.maxTotalSpawns) out.push("TOTAL_SPAWN_CAP");
  // Unmetered usage gives a null cost (never 0) and refuses every later spawn.
  if (c.unmetered && c.costEstimateMicroUsd !== null) out.push("UNMETERED_COST_NOT_NULL");
  if (!c.unmetered && c.costEstimateMicroUsd === null) out.push("UNMETERED_NOT_FLAGGED");
  if (c.unmetered && c.spawnsAdmittedAfterUnmetered > 0) out.push("UNMETERED_SPAWN_ADMITTED");
  // The kill switch refuses later spawns and latches, leaving nothing behind.
  if (c.killed && c.spawnsAdmittedAfterKill > 0) out.push("KILL_SPAWN_ADMITTED");
  if (c.orphanedDesktops > 0 || c.orphanedWorkerTrials > 0 || c.openLedgerAttempts > 0)
    out.push("ORPHANED_RESOURCE");
  // A ledger write failure halts the run.
  if (c.ledgerWriteFailed && !c.haltedOnLedgerFailure) out.push("LEDGER_FAILURE_NOT_HALTED");
  return out;
}

function controlsProblem(c: unknown): string | undefined {
  if (typeof c !== "object" || c === null) return "missing";
  const r = c as Record<string, unknown>;
  for (const k of [
    "tokensUsed",
    "maxDepthObserved",
    "maxConcurrentObserved",
    "maxSpawnsByOnePlanner",
    "totalSpawns",
    "spawnsAdmittedAfterUnmetered",
    "spawnsAdmittedAfterKill",
    "orphanedDesktops",
    "orphanedWorkerTrials",
    "openLedgerAttempts",
    "workerTrials",
    "ledgerWorkerAttempts",
  ])
    if (!isCount(r[k])) return k;
  if (!isNonNeg(r.wallMs)) return "wallMs";
  if (r.costEstimateMicroUsd !== null && !isNonNeg(r.costEstimateMicroUsd))
    return "costEstimateMicroUsd";
  if (r.killLatencyMs !== null && !isNonNeg(r.killLatencyMs)) return "killLatencyMs";
  for (const k of ["unmetered", "killed", "ledgerWriteFailed", "haltedOnLedgerFailure"])
    if (typeof r[k] !== "boolean") return k;
  return undefined;
}

function preregProblems(p: VPrereg): string[] {
  const out: string[] = [];
  if (p.track !== V_BAR.track || p.version !== V_BAR.version) out.push("PREREG_NOT_V_V1");
  if (p.taskSet?.version !== V_BAR.taskSet || p.taskSet?.tasks !== V_BAR.tasks)
    out.push("PREREG_TASK_SET_MISMATCH");
  if (p.test?.alpha !== V_BAR.alpha || p.test?.minDiscordant !== V_BAR.minDiscordant)
    out.push("PREREG_TEST_MISMATCH");
  if (typeof p.modelId !== "string" || p.modelId.length === 0) out.push("PREREG_MODEL_MISSING");
  const l = p.limits as unknown as Record<string, unknown> | undefined;
  for (const k of [
    "maxTotalTokens",
    "maxTokensPerWorker",
    "maxEstimatedCostMicroUsd",
    "maxWallMs",
    "maxDepth",
    "maxConcurrentDesktops",
    "maxSpawnsPerPlanner",
    "maxTotalSpawns",
  ])
    if (!(isCount(l?.[k]) && (l?.[k] as number) > 0)) out.push(`PREREG_LIMIT_INVALID:${k}`);
  return out;
}

function rowVerified(row: VBarRow): boolean {
  if (row.claim !== "done") return false;
  if (!row.parts.every((p) => p.grade === "pass")) return false;
  if (row.arm === "V") return row.parts.every((p) => p.gateVerdict === "verified");
  return true;
}

const rowFalseDone = (row: VBarRow) =>
  row.claim === "done" && !row.parts.every((p) => p.grade === "pass");

function compare(
  treatment: ReadonlyMap<string, boolean>,
  baseline: ReadonlyMap<string, boolean>,
): VComparison {
  let treatmentOnly = 0;
  let baselineOnly = 0;
  for (const [taskId, t] of treatment) {
    const b = baseline.get(taskId) === true;
    if (t && !b) treatmentOnly++;
    if (!t && b) baselineOnly++;
  }
  return {
    treatmentOnly,
    baselineOnly,
    discordant: treatmentOnly + baselineOnly,
    p: mcnemarOneSidedP(treatmentOnly, baselineOnly),
  };
}

function summarize(rows: readonly VBarRow[]): VArmSummary {
  const n = rows.length;
  const verified = rows.filter(rowVerified).length;
  const costs = rows.map((r) => r.costEstimateMicroUsd);
  const totalCost = costs.some((c) => c === null)
    ? null
    : costs.reduce((s: number, c) => s + (c as number), 0);
  const totalWall = rows.reduce((s, r) => s + r.wallMs, 0);
  return {
    n,
    verified,
    rate: n === 0 ? 0 : verified / n,
    interval: wilson(verified, n),
    falseDone: rows.filter(rowFalseDone).length,
    costPerVerifiedMicroUsd: totalCost === null || verified === 0 ? null : totalCost / verified,
    wallMsPerVerified: verified === 0 ? null : totalWall / verified,
  };
}

/** Structural refusals: the pack cannot be analysed at all. */
function packProblems(input: VBarInput): string[] {
  const { prereg, tasks, pack } = input;
  const out: string[] = [];
  if (pack.preregHash !== input.preregHash) out.push("PREREG_HASH_MISMATCH");
  if (tasks.size !== V_BAR.tasks) out.push("TASK_SET_SIZE");
  const seen = new Set<string>();
  for (const [i, row] of pack.rows.entries()) {
    const at = `rows[${i}]`;
    if (!ARMS.includes(row.arm)) {
      out.push(`UNKNOWN_ARM:${at}`);
      continue;
    }
    const expected = tasks.get(row.taskId);
    if (expected === undefined) {
      out.push(`UNKNOWN_TASK:${at}`);
      continue;
    }
    const cell = `${row.arm}|${row.taskId}`;
    if (seen.has(cell)) out.push(`DUPLICATE_CELL:${cell}`);
    seen.add(cell);
    if (row.simulated !== false) out.push(`SIMULATED_ROW:${cell}`);
    if (row.modelId !== prereg.modelId) out.push(`MODEL_MISMATCH:${cell}`);
    if (!CLAIMS.includes(row.claim)) out.push(`UNKNOWN_CLAIM:${cell}`);
    if (row.costEstimateMicroUsd !== null && !isNonNeg(row.costEstimateMicroUsd))
      out.push(`BAD_COST:${cell}`);
    if (!isNonNeg(row.wallMs)) out.push(`BAD_WALL:${cell}`);
    const ids = Array.isArray(row.parts) ? row.parts.map((p) => p?.partId) : [];
    if (ids.length !== expected.length || ids.some((id, k) => id !== expected[k]))
      out.push(`PARTS_MISMATCH:${cell}`);
    for (const part of Array.isArray(row.parts) ? row.parts : []) {
      if (!GRADES.includes(part?.grade)) out.push(`UNKNOWN_GRADE:${cell}`);
      if (row.arm === "V" && !VERDICTS.includes(part?.gateVerdict as string))
        out.push(`MISSING_GATE_VERDICT:${cell}`);
    }
    if (row.arm === "V") {
      const problem = controlsProblem(row.controls);
      if (problem !== undefined) out.push(`CONTROLS_INVALID:${cell}:${problem}`);
      else if (row.controls?.workerTrials !== row.controls?.ledgerWorkerAttempts)
        out.push(`LEDGER_WORKER_COUNT_MISMATCH:${cell}`);
    }
  }
  for (const arm of ARMS)
    for (const taskId of tasks.keys())
      if (!seen.has(`${arm}|${taskId}`)) out.push(`MISSING_CELL:${arm}|${taskId}`);
  return out;
}

export function analyseV(input: VBarInput): VBarResult {
  const refusals = [...preregProblems(input.prereg), ...packProblems(input)];
  if (refusals.length > 0) return { decision: "refused", reasons: refusals };

  const rows = input.pack.rows;
  const byArm = (arm: VArm) => rows.filter((r) => r.arm === arm);
  const vRows = byArm("V");

  // Component 1: control properties. Any breach voids the run.
  const breaches = vRows.flatMap((r) =>
    controlBreaches(r.controls as VTreeControls, input.prereg.limits).map((code) => ({
      taskId: r.taskId,
      code,
    })),
  );
  const falseVerified = vRows.reduce(
    (n, r) => n + r.parts.filter((p) => p.gateVerdict === "verified" && p.grade !== "pass").length,
    0,
  );
  const latencies = vRows
    .map((r) => r.controls?.killLatencyMs ?? null)
    .filter((v): v is number => v !== null);
  const killLatencyMsMax = latencies.length === 0 ? null : Math.max(...latencies);

  const arms = { V: summarize(vRows), H: summarize(byArm("H")), C1: summarize(byArm("C1")) };
  const verifiedMap = (arm: VArm) =>
    new Map(byArm(arm).map((r) => [r.taskId, rowVerified(r)] as const));
  const primary = compare(verifiedMap("V"), verifiedMap("H"));
  const secondary = compare(verifiedMap("V"), verifiedMap("C1"));
  const report = {
    controlBreaches: breaches,
    falseVerified,
    arms,
    primary,
    secondary,
    killLatencyMsMax,
  };

  const voids: string[] = [];
  if (breaches.length > 0) voids.push("CONTROL_PROPERTY_BREACHED");
  if (falseVerified > 0) voids.push("FALSE_VERIFIED_HALT");
  if (voids.length > 0) return { decision: "void", reasons: voids, ...report };

  // Component 2 (tested only because component 1 held), and the false-done guardrail.
  const reasons: string[] = [];
  if (arms.V.falseDone > arms.H.falseDone || arms.V.falseDone > arms.C1.falseDone)
    reasons.push("GUARDRAIL_FALSE_DONE");
  if (primary.discordant < input.prereg.test.minDiscordant)
    reasons.push(`UNDERPOWERED_AT_N:${V_BAR.tasks}:DISCORDANT:${primary.discordant}`);
  else if (primary.p > input.prereg.test.alpha) reasons.push("NOT_SIGNIFICANT");
  return { decision: reasons.length === 0 ? "shown" : "not-shown", reasons, ...report };
}
