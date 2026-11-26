/**
 * One targeted retry for multi-step tasks (TIF-270 / M2-07, scorecard R6).
 *
 * The trial loop, with every side effect injected so the same loop runs on the mock
 * transport (tests, `myco-gate demo --family calc-multi-step`) and, in M2-12, on the VM:
 *
 *  1. restore the guest document to checkpoint 0 (the pristine fixture, generated on the
 *     host) and let the agent work until it stops and claims done;
 *  2. capture the saved document into the evidence root (host side, after the agent
 *     stopped; the agent never writes there) and ask the gate, which is bound to this
 *     trial;
 *  3. if the gate accepts, the trial is verified. Otherwise, if a retry is left, restore
 *     the guest document to the LAST VERIFIED CHECKPOINT the gate reported (pristine + the
 *     first k steps, regenerated on the host; 0 when the gate reported none) and let the
 *     agent work once more from step k + 1, then capture and ask the gate again;
 *  4. the last gate result is the trial's verdict. There is never a third attempt.
 *
 * The checkpoint to restore comes from the gate's own `checkpoints.lastVerified`, which
 * the gate computes from the oracle's per-checkpoint verdicts; nothing the agent says
 * picks it. `retryBudget: 0` runs the same loop without the retry, which is R6's paired
 * no-retry arm.
 */
import type { GateResult } from "./api.ts";

export interface AttemptContext {
  /** 1 for the first attempt, 2 for the retry. */
  readonly attempt: 1 | 2;
  /** The checkpoint the guest document was restored to (0 = pristine fixture). */
  readonly fromCheckpoint: number;
  /** The gate result that caused this retry (absent on the first attempt). */
  readonly previous?: GateResult;
}

export interface MultiStepHarness {
  /** Write the host-generated checkpoint document (0 = pristine) into the guest. */
  restore(checkpoint: number): Promise<void>;
  /** Run the agent from the restored document until it stops; returns its claim. */
  runAgent(context: AttemptContext): Promise<{ readonly claim: string }>;
  /** After the agent stopped: copy the saved document into the trial's evidence location. */
  capture(attempt: 1 | 2): Promise<void>;
  /** Ask the gate bound to this trial. */
  checkGate(claim: string): Promise<GateResult>;
}

export interface AttemptRecord {
  readonly attempt: 1 | 2;
  readonly fromCheckpoint: number;
  readonly claim: string;
  readonly verdict: GateResult["verdict"];
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[];
  readonly checkpoints: GateResult["checkpoints"] | null;
  /** sha256 of the captured document the gate read (null if it read nothing). */
  readonly stateSha256: string | null;
}

export interface MultiStepTrialRecord {
  readonly retryBudget: 0 | 1;
  readonly attempts: readonly AttemptRecord[];
  /** The verdict of the last attempt. */
  readonly verdict: GateResult["verdict"];
  readonly accepted: boolean;
  /** True when the trial was accepted on the retry, i.e. the retry changed the outcome. */
  readonly repaired: boolean;
}

/** The checkpoint a retry starts from: the gate's last verified checkpoint, else 0. */
export function retryCheckpoint(result: GateResult): number {
  const last = result.checkpoints?.lastVerified;
  return typeof last === "number" && Number.isInteger(last) && last >= 0 ? last : 0;
}

function record(
  attempt: 1 | 2,
  fromCheckpoint: number,
  claim: string,
  result: GateResult,
): AttemptRecord {
  return {
    attempt,
    fromCheckpoint,
    claim,
    verdict: result.verdict,
    accepted: result.accepted,
    reasonCodes: [...result.reasonCodes],
    checkpoints: result.checkpoints ?? null,
    stateSha256: result.evidenceRefs[0]?.sha256 ?? null,
  };
}

export async function runMultiStepTrial(
  harness: MultiStepHarness,
  options: { readonly retryBudget: 0 | 1 },
): Promise<MultiStepTrialRecord> {
  const attempts: AttemptRecord[] = [];
  await harness.restore(0);
  const first = await harness.runAgent({ attempt: 1, fromCheckpoint: 0 });
  await harness.capture(1);
  let result = await harness.checkGate(first.claim);
  attempts.push(record(1, 0, first.claim, result));
  if (!result.accepted && options.retryBudget === 1) {
    const from = retryCheckpoint(result);
    await harness.restore(from);
    const second = await harness.runAgent({ attempt: 2, fromCheckpoint: from, previous: result });
    await harness.capture(2);
    result = await harness.checkGate(second.claim);
    attempts.push(record(2, from, second.claim, result));
  }
  return {
    retryBudget: options.retryBudget,
    attempts,
    verdict: result.verdict,
    accepted: result.accepted,
    repaired: result.accepted && attempts.length === 2,
  };
}
