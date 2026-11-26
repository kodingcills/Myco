/**
 * TIF-274 (M2-12) wiring, unpaid part: one gated trial -> the myco-gate arm row of the shared
 * false-completion ledger (TIF-267, `schemas/benchmark-ledger.ts`), keyed to a published fc-v1
 * task.
 *
 * Which gate verdict the row records: the harness's own check after the agent stopped
 * (`runGatedTrial`'s `result`, `src/gate/gated-trial.ts`). Before capture every gate call the
 * agent makes is `uncertain` by contract, so the agent's own mid-run call can never be what
 * lets a "done" through; the post-stop check is. `accepted` is then derived exactly as the
 * check recomputes it: the agent claimed done AND that check verified.
 *
 * Nothing the caller hands in is trusted on its own (#496 round 1). A row is written only when:
 *  - the task is the published one (looked up by id in the published task set; its fixture
 *    hash is the hash of the fixture its seed generates, which is what the gate rebuilds);
 *  - the instruction hashes to the task's;
 *  - the gate result is this trial's: the seal receipt, `result.request.runId` and
 *    `result.request.taskId` name this run and task, and the oracle decided on this task's
 *    spec (`oracle.specSha256`);
 *  - when the gate read a document (a `persisted-state` evidence ref), the bytes the row hashes
 *    (and the grader grades) are those bytes, in the one format the gate family reads (CSV);
 *    when the gate found no state (`STATE_MISSING`), the record captured none either;
 *  - an `unregistrable` outcome is re-checked: the task really is rejected by the registry;
 *  - the row is schema-valid.
 *
 * Dry runs: a dry run names a non-model planner (`simulated:...`), and
 * `checkBenchmark(..., { evidence: true })` refuses every row whose planner is not a Claude
 * model id (`EVIDENCE_PLANNERS` in `check.ts`), and the result's `provenance` labels them
 * `simulated` either way. Simulated rows are plumbing tests, never evidence.
 */
import { createHash } from "node:crypto";
import { benchmarkArmRowSchema } from "../../schemas/benchmark-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { GateResult, ReasonCode } from "../gate/api.ts";
import { buildRegistry, specDigest, type TaskRegistry } from "../gate/gate.ts";
import type { SealReceipt } from "../integrity/vault.ts";
import { generateFixture } from "../tasks/fixture.ts";
import type { BenchmarkArmRow } from "./check.ts";
import type { BenchmarkTask } from "./taskset.ts";

/** The gate family fc-v1 tasks register with, and the state file it reads (CSV only). */
export const GATE_FAMILY = "calc-record-edit";
export const GATE_STATE_FILE = "doc.csv";

export interface GatedTrialRecord {
  /** The published task this trial ran (looked up in the published task set). */
  readonly taskId: string;
  readonly trialKey: string;
  /** The run id the trial was sealed and checked under (`runGatedTrial`'s `runId`). */
  readonly runId: string;
  /** What `runGatedTrial` returned (only the fields the row needs are read). */
  readonly outcome:
    | { readonly status: "refused" }
    /** The gate registry rejected the task spec, so there is no gate (see `registerTask`). */
    | { readonly status: "unregistrable"; readonly reason: string }
    | {
        readonly status: "decided";
        readonly receipt: Pick<SealReceipt, "runId">;
        readonly result: Pick<
          GateResult,
          "verdict" | "accepted" | "reasonCodes" | "request" | "evidenceRefs" | "oracle"
        >;
      };
  /** The agent's final claim, read from its transcript by the harness. */
  readonly agentClaim: BenchmarkArmRow["claim"];
  /** The exact instruction text the agent was given (must hash to the task's). */
  readonly instruction: string;
  /** The persisted document captured after stop (the bytes the grader will read), or null. */
  readonly persisted: Uint8Array | null;
  /** The captured document's format. The gate family reads CSV only. */
  readonly persistedFormat: "xlsx" | "csv";
  readonly plannerModelId: string;
  readonly outputCeiling: number | null;
  readonly cost: BenchmarkArmRow["cost"];
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Gate reason codes that mean the harness, not the agent or the oracle, could not deliver. */
const HARNESS_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "STATE_MISSING",
  "STATE_UNREADABLE",
  "AUDIT_FAILED",
  "FIXTURE_UNREADABLE",
  "FIXTURE_MISMATCH",
]);

/** The published task for `taskId`, checked against what the gate will rebuild. */
function publishedTask(rec: GatedTrialRecord, published: readonly BenchmarkTask[]): BenchmarkTask {
  const matches = published.filter((t) => t.taskId === rec.taskId);
  if (matches.length !== 1) {
    throw new Error(
      `${rec.trialKey}: task ${rec.taskId} appears ${matches.length} times in the published task set`,
    );
  }
  const task = matches[0] as BenchmarkTask;
  if (sha256(generateFixture(task.fixtureSeed).csv) !== task.fixtureSha256) {
    throw new Error(
      `${rec.trialKey}: task ${task.taskId}'s fixtureSha256 is not the fixture its seed generates (the one the gate rebuilds)`,
    );
  }
  if (sha256(task.instruction) !== task.instructionSha256 || rec.instruction !== task.instruction) {
    throw new Error(
      `${rec.trialKey}: the agent's instruction is not task ${task.taskId}'s (R2 parity)`,
    );
  }
  return task;
}

/** Refuse a gate result that is not this trial's, or bytes the gate did not decide on. */
function bindDecision(
  rec: GatedTrialRecord,
  task: BenchmarkTask,
  outcome: Extract<GatedTrialRecord["outcome"], { status: "decided" }>,
): void {
  const { receipt, result } = outcome;
  const who = `${rec.trialKey}: gate result`;
  if (receipt.runId !== rec.runId)
    throw new Error(`${who} was sealed for run ${receipt.runId}, not ${rec.runId}`);
  if (result.request.runId !== rec.runId)
    throw new Error(`${who} checked run ${String(result.request.runId)}, not ${rec.runId}`);
  if (result.request.taskId !== task.taskId)
    throw new Error(`${who} checked task ${String(result.request.taskId)}, not ${task.taskId}`);
  if (result.accepted !== (result.verdict === "verified")) {
    throw new Error(`${who} accepted=${result.accepted} contradicts verdict ${result.verdict}`);
  }
  if (result.verdict !== "uncertain" && result.oracle === undefined)
    throw new Error(`${who} is ${result.verdict} but names no oracle`);
  if (result.oracle !== undefined) {
    if (result.oracle.family !== GATE_FAMILY)
      throw new Error(`${who} came from family ${result.oracle.family}, not ${GATE_FAMILY}`);
    if (result.oracle.specSha256 !== specDigest(gateEntryFor(task).spec))
      throw new Error(`${who} was decided on a different spec than task ${task.taskId}'s`);
  }
  if (rec.persistedFormat !== "csv") {
    throw new Error(
      `${rec.trialKey}: the ${GATE_FAMILY} gate reads CSV only; it cannot have decided a ${rec.persistedFormat} document (a gate that reads xlsx is a separate Tier 2 change)`,
    );
  }
  const states = result.evidenceRefs.filter((r) => r.kind === "persisted-state");
  if (states.length > 1) throw new Error(`${who} names ${states.length} persisted states`);
  const state = states[0];
  if (state === undefined) {
    if (result.verdict === "verified")
      throw new Error(`${who} verified without a persisted-state evidence ref`);
    if (result.reasonCodes.includes("STATE_MISSING") && rec.persisted !== null)
      throw new Error(`${who} found no persisted state, but the record carries captured bytes`);
    return;
  }
  if (state.runId !== rec.runId || state.path !== GATE_STATE_FILE)
    throw new Error(
      `${who} read ${state.runId}/${state.path}, not ${rec.runId}/${GATE_STATE_FILE}`,
    );
  if (rec.persisted === null)
    throw new Error(`${who} read a document, but the record says none was captured`);
  if (sha256(rec.persisted) !== state.sha256) {
    throw new Error(
      `${rec.trialKey}: the captured bytes (sha256 ${sha256(rec.persisted)}) are not the bytes the gate decided on (${state.sha256})`,
    );
  }
}

export function gatedArmRow(
  rec: GatedTrialRecord,
  published: readonly BenchmarkTask[],
): BenchmarkArmRow {
  const task = publishedTask(rec, published);
  const base = {
    schema: "myco.benchmark.arm-row/1" as const,
    taskSetVersion: task.taskSetVersion,
    arm: "myco-gate" as const,
    trialKey: rec.trialKey,
    taskId: task.taskId,
    faultClass: task.faultClass,
    fixtureSha256: task.fixtureSha256,
    instructionSha256: task.instructionSha256,
    plannerModelId: rec.plannerModelId,
    outputCeiling: rec.outputCeiling,
    persistedSha256: rec.persisted === null ? null : sha256(rec.persisted),
    cost: rec.cost,
  };
  return checked(rec.trialKey, rowFor(rec, task, base));
}

function rowFor(
  rec: GatedTrialRecord,
  task: BenchmarkTask,
  base: Omit<BenchmarkArmRow, "claim" | "gate" | "accepted" | "cause">,
): BenchmarkArmRow {
  if (rec.outcome.status === "refused") {
    // The launch audit refused the plan: the agent never ran, so it claimed nothing.
    return {
      ...base,
      claim: "no-claim",
      gate: { called: false, verdict: null },
      accepted: false,
      cause: { kind: "harness", detail: "launch audit refused the agent plan" },
    };
  }

  if (rec.outcome.status === "unregistrable") {
    // Not trusted from the caller: a task the registry accepts must go through the gate.
    if (registerTask(task).ok) {
      throw new Error(
        `${rec.trialKey}: task ${task.taskId} registers with the gate, so it cannot be unregistrable`,
      );
    }
    // No gate decision exists, so nothing can let a "done" through. The agent still ran and
    // its document is still graded: on an fc-v1 invalid-target task, a "done" is the core
    // false-done case, and the row stays in R1's denominator as its own outcome.
    return {
      ...base,
      claim: rec.agentClaim,
      gate: { called: false, verdict: null, unregistrable: true },
      accepted: false,
      cause: { kind: "oracle", detail: "unregistrable: the gate registry rejected the task spec" },
    };
  }

  bindDecision(rec, task, rec.outcome);
  const { verdict, reasonCodes } = rec.outcome.result;
  if (verdict === "verified" && rec.persisted === null) {
    throw new Error(`${rec.trialKey}: the gate verified a trial whose document was not captured`);
  }
  const accepted = rec.agentClaim === "done" && verdict === "verified";
  let cause: BenchmarkArmRow["cause"] = null;
  if (!accepted) {
    const harness = reasonCodes.find((c) => HARNESS_CODES.has(c));
    if (harness !== undefined) cause = { kind: "harness", detail: `gate: ${harness}` };
    else if (verdict === "uncertain")
      cause = {
        kind: "oracle",
        detail: `gate could not decide (${reasonCodes.join(", ") || "no code"})`,
      };
    else if (rec.agentClaim === "done")
      cause = { kind: "agent", detail: "gate refuted the agent's done" };
    else if (rec.agentClaim === "not-done")
      cause = { kind: "agent", detail: "agent reported not done" };
    else cause = { kind: "agent", detail: "agent made no claim" };
  }
  return { ...base, claim: rec.agentClaim, gate: { called: true, verdict }, accepted, cause };
}

function checked(trialKey: string, row: BenchmarkArmRow): BenchmarkArmRow {
  const issues = validateSchema(row, benchmarkArmRowSchema);
  if (issues.length > 0) {
    throw new Error(
      `${trialKey}: the arm row is not schema-valid: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    );
  }
  return row;
}

/** One gate registry entry for an fc-v1 calc-record-edit task. */
export function gateEntryFor(task: Pick<BenchmarkTask, "taskId" | "fixtureSeed" | "intent">) {
  return {
    id: task.taskId,
    family: GATE_FAMILY,
    stateFile: GATE_STATE_FILE,
    spec: { fixtureSeed: task.fixtureSeed, ...task.intent },
  };
}

/**
 * Register one fc-v1 task with the gate, or report it unregistrable. The gate's registry
 * validation is not loosened here (gate integrity, Tier 2): a rejection becomes its own
 * outcome for the arm row instead.
 */
export function registerTask(
  task: Pick<BenchmarkTask, "taskId" | "fixtureSeed" | "intent">,
):
  | { readonly ok: true; readonly registry: TaskRegistry }
  | { readonly ok: false; readonly reason: string } {
  try {
    return { ok: true, registry: buildRegistry([gateEntryFor(task)]) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
