/**
 * TIF-266 — the seam the TIF-265 gate calls.
 *
 * `Verdict` is the M1 three-valued type (`src/core/verify.ts`). When TIF-265 lands its own
 * gate verdict type, this function maps onto it; until then the M1 type is the contract.
 *
 * Rules:
 * - Integrity failure is `uncertain` ("could not look"), never `refuted` and never
 *   `verified`. An oracle that throws is also `uncertain`.
 * - The gate never trusts the agent's run id to pick the receipt. The operator binds the
 *   gate to one trial (TIF-265's `myco-gate mcp --run … --task …`); that binding carries the
 *   trial's receipt, and a request naming any other run id is `uncertain`
 *   (`integrity:run-not-bound`). See `gateForTrial`.
 */

import type { Verdict } from "../core/verify.ts";
import type { IntegrityViolation, SealReceipt, VerdictInputs, VerdictVault } from "./vault.ts";

/** An oracle over vault inputs only. It must not read any path itself. */
export type SealedOracle = (inputs: VerdictInputs) => Verdict;

export const INTEGRITY_REASON_PREFIX = "integrity:";

/**
 * What the operator pins when it starts the gate for one trial: the trial's run id and the
 * receipt `vault.seal` returned for it. The agent never supplies or sees either value
 * beyond the run id it was told.
 */
export interface TrialBinding {
  readonly runId: string;
  readonly receipt: SealReceipt;
}

export function integrityReasons(violations: readonly IntegrityViolation[]): string[] {
  return violations.map(
    (v) => `${INTEGRITY_REASON_PREFIX}${v.code}${v.path ? ` ${v.path}` : ""}: ${v.detail}`,
  );
}

/**
 * The verdict for one run: integrity first, then the oracle on the checked bytes. The
 * receipt is required and must be the one the harness kept since sealing *this* run; a
 * receipt for any other run fails `receipt-mismatch`.
 */
export function gatedVerdict(
  vault: VerdictVault,
  runId: string,
  receipt: SealReceipt,
  oracle: SealedOracle,
): Verdict {
  const opened = vault.openVerdictInputs(runId, receipt);
  if (!opened.ok) return { status: "uncertain", reasons: integrityReasons(opened.violations) };
  try {
    return oracle(opened.inputs);
  } catch (e) {
    return {
      status: "uncertain",
      reasons: [`could not look: oracle threw: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

/**
 * The gate's entry point for an agent request. `requestedRunId` is the run id the agent
 * sent; the binding is the operator's. Any run id other than the bound trial's is
 * `uncertain` without opening the vault, so an agent cannot point the gate at an earlier
 * honest run.
 */
export function gateForTrial(
  vault: VerdictVault,
  binding: TrialBinding,
  requestedRunId: string,
  oracle: SealedOracle,
): Verdict {
  if (requestedRunId !== binding.runId)
    return {
      status: "uncertain",
      reasons: integrityReasons([
        {
          code: "run-not-bound",
          detail: "this gate is bound to another trial; only the bound run id is checked",
        },
      ]),
    };
  return gatedVerdict(vault, binding.runId, binding.receipt, oracle);
}
