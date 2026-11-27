/**
 * Track M's graded row, `myco.skills.rep-row/1`: one per trial of the rep-v1 measurement,
 * built by the harness after the capture and the independent grader have run. This is the
 * non-VM piece the M arm needs to emit graded rows; the VM runner that produces the inputs is
 * a follow-up.
 *
 * "Verified" follows capability-spec §1.1 exactly:
 *  - TEST rows are gate-less (§2 M "Gate use": neither arm calls the gate in the test phase).
 *    Verified = the agent claimed done AND the grader graded the captured document `pass`.
 *    A test row that carries a gate verdict is refused.
 *  - LEARN rows are gated: the gate is called at the end of each learn trial because the store
 *    rule needs its verdict. Verified = done claim AND gate `verified` and accepted AND grader
 *    `pass`, on the same persisted bytes. A grader `pass` the gate did not verify is "correct,
 *    not accepted"; a gate `verified` the grader did not pass is never verified. Learn rows are
 *    never part of the bar.
 *
 * Only a verified learn row may carry a stored skill: learning reads grader-confirmed outcomes,
 * never the gate's verdict alone. `buildRepRow` refuses a row that claims a stored skill from
 * anything else, and the analysis re-checks every row (`repRowProblems`).
 *
 * Rows are experiment rows (`evidence: "never-r1"`), not `myco.benchmark.arm-row/1`. A row
 * whose planner is not a model id is simulated and never counts toward the bar.
 */

import type { BaseSurface, MArm } from "./m-prereg.ts";
import { isSimulatedPlanner } from "./record.ts";
import { GENESIS } from "./store.ts";

export const REP_ROW_SCHEMA = "myco.skills.rep-row/1";

export type RepPhase = "learn" | "test";
export type RepRowKind = "learn" | "repeat" | "similar";
export type Claim = "done" | "not-done" | "none";
export type RepOutcome =
  | "verified"
  | "correct-not-claimed"
  | "correct-not-accepted"
  | "false-done"
  | "ungraded"
  | "not-done"
  | "harness-fault";

export interface RepGate {
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly accepted: boolean;
  /** The persisted document the gate decided on. */
  readonly persistedSha256: string;
}

export interface RepGrade {
  readonly status: "pass" | "fail" | "ungradable";
  /** The persisted document the grader graded (the harness's capture). */
  readonly persistedSha256: string;
}

export interface RepRowInput {
  readonly phase: RepPhase;
  /** `learn` for the learn phase (which runs cold); `skills-on` or `cold` in the test phase. */
  readonly arm: MArm | "learn";
  readonly kind: RepRowKind;
  /** The test unit (test phase), or null (learn phase). */
  readonly unitId: string | null;
  readonly taskId: string;
  readonly instructionSha256: string;
  readonly fixtureSha256: string;
  /** Position in the pre-registered schedule for this phase. */
  readonly scheduleIndex: number;
  readonly runId: string;
  readonly preregHash: string;
  readonly preregCommit: string;
  readonly baseSurface: BaseSurface;
  readonly plannerModelId: string;
  readonly stepBudget: number;
  readonly steps: number;
  readonly wallMs: number | null;
  /** The store head the trial ran against: the frozen store (skills-on) or GENESIS (cold, learn). */
  readonly storeHead: string;
  readonly retrievedSkillIds: readonly string[];
  readonly claim: Claim;
  /** Learn phase only; must be null in the test phase. */
  readonly gate: RepGate | null;
  /** The grader's result on the capture, or null when the capture was not graded. */
  readonly grade: RepGrade | null;
  /** A harness fault code (the trial stays in the denominator), or null. */
  readonly harnessFault: string | null;
  /** The skill the store admitted from this trial (learn phase only), or null. */
  readonly admittedSkillId: string | null;
  /** Token-derived ESTIMATE in USD, or null when unknown. Never billed USD. */
  readonly estimatedUsd: number | null;
}

export interface RepRow extends RepRowInput {
  readonly schema: typeof REP_ROW_SCHEMA;
  readonly simulated: boolean;
  readonly verified: boolean;
  readonly outcome: RepOutcome;
  readonly evidence: "never-r1";
}

export class RepRowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RepRowError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The §1.1 outcome of a trial. Pure; the only place "verified" is decided. */
export function repOutcome(
  r: Pick<RepRowInput, "phase" | "claim" | "gate" | "grade" | "harnessFault">,
): RepOutcome {
  if (r.harnessFault !== null) return "harness-fault";
  const pass = r.grade?.status === "pass";
  const done = r.claim === "done";
  if (r.phase === "learn") {
    const gateOk =
      r.gate !== null &&
      r.gate.verdict === "verified" &&
      r.gate.accepted === true &&
      r.grade !== null &&
      r.gate.persistedSha256 === r.grade.persistedSha256;
    if (done && pass && gateOk) return "verified";
    if (done && pass) return "correct-not-accepted";
  } else if (done && pass) return "verified";
  if (pass) return "correct-not-claimed";
  if (done) return r.grade === null ? "ungraded" : "false-done";
  return "not-done";
}

/** Every rule a row breaks (codes). Empty for a well-formed row. */
export function repRowProblems(r: RepRowInput | RepRow): string[] {
  const out: string[] = [];
  const learn = r.phase === "learn";
  if (r.phase !== "learn" && r.phase !== "test") out.push("PHASE");
  if (learn ? r.arm !== "learn" || r.kind !== "learn" || r.unitId !== null : false)
    out.push("LEARN_SHAPE");
  if (
    !learn &&
    ((r.arm !== "skills-on" && r.arm !== "cold") ||
      (r.kind !== "repeat" && r.kind !== "similar") ||
      r.unitId === null)
  )
    out.push("TEST_SHAPE");
  if (!learn && r.gate !== null) out.push("TEST_ROW_GATED");
  if (learn && r.gate === null && r.harnessFault === null) out.push("LEARN_ROW_UNGATED");
  for (const [k, v] of [
    ["taskId", r.taskId],
    ["runId", r.runId],
  ] as const)
    if (typeof v !== "string" || !PLAIN.test(v)) out.push(`ID_${k}`);
  for (const [k, v] of [
    ["instructionSha256", r.instructionSha256],
    ["fixtureSha256", r.fixtureSha256],
    ["preregHash", r.preregHash],
    ["storeHead", r.storeHead],
  ] as const)
    if (typeof v !== "string" || !HEX64.test(v)) out.push(`HEX_${k}`);
  if (!HEX40.test(r.preregCommit ?? "")) out.push("HEX_preregCommit");
  if (!Number.isInteger(r.scheduleIndex) || r.scheduleIndex < 0) out.push("SCHEDULE_INDEX");
  if (!Number.isInteger(r.stepBudget) || r.stepBudget < 1) out.push("STEP_BUDGET");
  if (!Number.isInteger(r.steps) || r.steps < 0 || r.steps > r.stepBudget) out.push("STEPS");
  if (r.wallMs !== null && !(Number.isFinite(r.wallMs) && r.wallMs >= 0)) out.push("WALL");
  if (r.estimatedUsd !== null && !(Number.isFinite(r.estimatedUsd) && r.estimatedUsd >= 0))
    out.push("COST");
  if (!["done", "not-done", "none"].includes(r.claim)) out.push("CLAIM");
  if (r.grade !== null && !["pass", "fail", "ungradable"].includes(r.grade.status))
    out.push("GRADE");
  if (r.arm !== "skills-on" && r.retrievedSkillIds.length > 0) out.push("RETRIEVED_WITHOUT_STORE");
  if (r.arm !== "skills-on" && r.storeHead !== GENESIS) out.push("STORE_NOT_EMPTY");
  if (r.admittedSkillId !== null) {
    if (!learn) out.push("SKILL_OUTSIDE_LEARN");
    else if (repOutcome(r) !== "verified") out.push("SKILL_FROM_UNVERIFIED");
  }
  if ("schema" in r) {
    if (r.schema !== REP_ROW_SCHEMA) out.push("SCHEMA");
    if (r.evidence !== "never-r1") out.push("EVIDENCE");
    if (r.simulated !== isSimulatedPlanner(r.plannerModelId)) out.push("SIMULATED_FLAG");
    if (r.verified !== (repOutcome(r) === "verified")) out.push("VERIFIED_CONTRADICTS");
    if (r.outcome !== repOutcome(r)) out.push("OUTCOME_CONTRADICTS");
  }
  return out;
}

/** Build a row. Throws `RepRowError` (first code) for any input that breaks a rule. */
export function buildRepRow(input: RepRowInput): RepRow {
  const problems = repRowProblems(input);
  if (problems.length > 0) throw new RepRowError(problems[0] as string);
  const outcome = repOutcome(input);
  return {
    schema: REP_ROW_SCHEMA,
    ...input,
    retrievedSkillIds: [...input.retrievedSkillIds],
    simulated: isSimulatedPlanner(input.plannerModelId),
    verified: outcome === "verified",
    outcome,
    evidence: "never-r1",
  };
}
