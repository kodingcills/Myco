/**
 * TIF-266 — the seam the TIF-265 gate calls.
 *
 * `Verdict` is the M1 three-valued type (`src/core/verify.ts`). When TIF-265 lands its own
 * gate verdict type, this function maps onto it; until then the M1 type is the contract.
 *
 * Rule: integrity failure is `uncertain` ("could not look"), never `refuted` and never
 * `verified`. An oracle that throws is also `uncertain`.
 */

import type { Verdict } from "../core/verify.ts";
import type { IntegrityViolation, SealReceipt, VerdictInputs, VerdictVault } from "./vault.ts";

/** An oracle over vault inputs only. It must not read any path itself. */
export type SealedOracle = (inputs: VerdictInputs) => Verdict;

export const INTEGRITY_REASON_PREFIX = "integrity:";

export function integrityReasons(violations: readonly IntegrityViolation[]): string[] {
  return violations.map(
    (v) => `${INTEGRITY_REASON_PREFIX}${v.code}${v.path ? ` ${v.path}` : ""}: ${v.detail}`,
  );
}

/**
 * The gate's verdict for one run: integrity first, then the oracle on the checked bytes.
 * `receipt` is the digest the harness kept in memory since seal time; pass it whenever the
 * gate runs in the harness process.
 */
export function gatedVerdict(
  vault: VerdictVault,
  runId: string,
  receipt: SealReceipt | undefined,
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
