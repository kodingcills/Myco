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
 * Dry runs: a row whose `plannerModelId` starts with `simulated:` is simulated, and
 * `checkBenchmark(..., { evidence: true })` refuses it. Simulated rows are plumbing tests,
 * never evidence.
 */
import { createHash } from "node:crypto";
import type { ReasonCode } from "../gate/api.ts";
import type { GatedTrialOutcome } from "../gate/gated-trial.ts";
import type { BenchmarkArmRow } from "./check.ts";
import type { BenchmarkTask } from "./taskset.ts";

export const SIMULATED_PREFIX = "simulated:";

export interface GatedTrialRecord {
  readonly task: Pick<
    BenchmarkTask,
    "taskSetVersion" | "taskId" | "faultClass" | "fixtureSha256" | "instructionSha256"
  >;
  readonly trialKey: string;
  /** What `runGatedTrial` returned (only the fields the row needs are read). */
  readonly outcome:
    | Pick<Extract<GatedTrialOutcome, { status: "refused" }>, "status">
    | {
        readonly status: "decided";
        readonly result: Pick<
          Extract<GatedTrialOutcome, { status: "decided" }>["result"],
          "verdict" | "accepted" | "reasonCodes"
        >;
      };
  /** The agent's final claim, read from its transcript by the harness. */
  readonly agentClaim: BenchmarkArmRow["claim"];
  /** The exact instruction text the agent was given (must hash to the task's). */
  readonly instruction: string;
  /** The persisted document captured after stop (the bytes the grader will read), or null. */
  readonly persisted: Uint8Array | null;
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

export function gatedArmRow(rec: GatedTrialRecord): BenchmarkArmRow {
  if (sha256(rec.instruction) !== rec.task.instructionSha256) {
    throw new Error(
      `${rec.trialKey}: the agent's instruction is not task ${rec.task.taskId}'s (R2 parity)`,
    );
  }
  const base = {
    schema: "myco.benchmark.arm-row/1" as const,
    taskSetVersion: rec.task.taskSetVersion,
    arm: "myco-gate" as const,
    trialKey: rec.trialKey,
    taskId: rec.task.taskId,
    faultClass: rec.task.faultClass,
    fixtureSha256: rec.task.fixtureSha256,
    instructionSha256: rec.task.instructionSha256,
    plannerModelId: rec.plannerModelId,
    outputCeiling: rec.outputCeiling,
    persistedSha256: rec.persisted === null ? null : sha256(rec.persisted),
    cost: rec.cost,
  };

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

  const { verdict, accepted: gateAccepted, reasonCodes } = rec.outcome.result;
  if (gateAccepted !== (verdict === "verified")) {
    throw new Error(
      `${rec.trialKey}: gate result accepted=${gateAccepted} contradicts verdict ${verdict}`,
    );
  }
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

export function isSimulated(row: Pick<BenchmarkArmRow, "plannerModelId">): boolean {
  return row.plannerModelId.startsWith(SIMULATED_PREFIX);
}
