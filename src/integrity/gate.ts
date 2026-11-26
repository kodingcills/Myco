/**
 * TIF-266 — the seam the TIF-265 gate calls.
 *
 * `Verdict` is the M1 three-valued type (`src/core/verify.ts`). The TIF-265 gate
 * (`src/gate/`) reads through `openForTrial` (see `src/gate/sealed.ts`); `gatedVerdict` and
 * `gateForTrial` are the same rules for a caller that runs a `SealedOracle` directly.
 *
 * Rules:
 * - Integrity failure is `uncertain` ("could not look"), never `refuted` and never
 *   `verified`. An oracle that throws is also `uncertain`.
 * - The gate never trusts the agent's run id to pick the receipt. The operator binds the
 *   gate to one trial (TIF-265's `myco-gate mcp --run … --task …`); that binding carries the
 *   trial's receipt, and a request naming any other run id is `uncertain`
 *   (`integrity:run-not-bound`). See `openForTrial`.
 * - Agent-facing reasons are codes only: `gateForTrial` returns `integrity:<code>` and a
 *   fixed oracle-threw reason, never a host path or error text (#484 N-b). `gatedVerdict`
 *   is operator-side and keeps the full reasons.
 * - The receipt is checked at runtime, not only by the TypeScript signature: the named
 *   audit opt-out (`AUDIT_WITHOUT_RECEIPT`), `null`, a non-object or a missing receipt
 *   passed by a cast is `receipt-missing`; an object that is not a well-formed receipt is
 *   `receipt-malformed` (TIF-274 prerequisite, #470 follow-ups N1 and N2). It is read once
 *   (`readReceipt`), and the checked snapshot is what opens the vault (#484 N-a).
 */

import type { Verdict } from "../core/verify.ts";
import {
  AUDIT_WITHOUT_RECEIPT,
  type IntegrityViolation,
  type SealReceipt,
  type VerdictInputs,
  type VerdictInputsResult,
  type VerdictVault,
} from "./vault.ts";

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

/**
 * Operator-side reasons: code, vault-relative path and detail. A violation's path can be
 * an absolute host path (an oracle source file, the vault dir), so these must not reach the
 * agent; use `integrityCodes` for agent-facing text.
 */
export function integrityReasons(violations: readonly IntegrityViolation[]): string[] {
  return violations.map(
    (v) => `${INTEGRITY_REASON_PREFIX}${v.code}${v.path ? ` ${v.path}` : ""}: ${v.detail}`,
  );
}

/** Agent-facing form: `integrity:<code>` only, deduplicated, in first-seen order. */
export function integrityCodes(violations: readonly IntegrityViolation[]): string[] {
  return [...new Set(violations.map((v) => `${INTEGRITY_REASON_PREFIX}${v.code}`))];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Validate `receipt` and snapshot it: each field is read exactly once, into a frozen plain
 * object, and that snapshot is what the caller passes on. A getter or Proxy that returns a
 * well-formed value to the check and another value later cannot pass the check (#484 N-a).
 * Never throws: a throwing getter or Proxy trap counts as malformed.
 */
export function readReceipt(
  receipt: unknown,
): { readonly receipt: SealReceipt } | { readonly problem: IntegrityViolation } {
  if (receipt === AUDIT_WITHOUT_RECEIPT)
    return {
      problem: {
        code: "receipt-missing",
        detail: "the audit opt-out is not a receipt: a gate always has the calling trial's receipt",
      },
    };
  if (receipt === null || receipt === undefined || typeof receipt !== "object")
    return {
      problem: {
        code: "receipt-missing",
        detail: "no seal receipt for this trial: pass the calling trial's receipt",
      },
    };
  let runId: unknown;
  let sealDigest: unknown;
  try {
    ({ runId, sealDigest } = receipt as { runId?: unknown; sealDigest?: unknown });
  } catch {
    return { problem: { code: "receipt-malformed", detail: "receipt could not be read" } };
  }
  if (typeof runId !== "string" || runId.length === 0)
    return {
      problem: { code: "receipt-malformed", detail: "receipt.runId is not a non-empty string" },
    };
  if (typeof sealDigest !== "string" || !SHA256_HEX.test(sealDigest))
    return {
      problem: {
        code: "receipt-malformed",
        detail: "receipt.sealDigest is not a sha256 hex digest",
      },
    };
  return { receipt: Object.freeze({ runId, sealDigest }) };
}

/** Why `receipt` is not a usable runtime receipt, or undefined when it is. Never throws. */
export function receiptProblem(receipt: unknown): IntegrityViolation | undefined {
  const read = readReceipt(receipt);
  return "problem" in read ? read.problem : undefined;
}

/**
 * Open the bound trial's checked inputs for an agent request. `requestedRunId` is the run
 * id the agent sent; the binding is the operator's. The vault is opened only for
 * `binding.runId`, and only when the request names exactly that run and the binding holds
 * a well-formed receipt; otherwise the result is a violation and nothing is read.
 */
export function openForTrial(
  vault: VerdictVault,
  binding: TrialBinding,
  requestedRunId: string,
): VerdictInputsResult {
  let runId: unknown;
  let receipt: unknown;
  try {
    runId = binding?.runId;
    receipt = binding?.receipt;
  } catch {
    runId = undefined;
  }
  if (typeof runId !== "string" || runId.length === 0)
    return {
      ok: false,
      violations: [{ code: "run-not-bound", detail: "the gate has no bound trial" }],
    };
  if (requestedRunId !== runId)
    return {
      ok: false,
      violations: [
        {
          code: "run-not-bound",
          detail: "this gate is bound to another trial; only the bound run id is checked",
        },
      ],
    };
  const read = readReceipt(receipt);
  if ("problem" in read) return { ok: false, violations: [read.problem] };
  return vault.openVerdictInputs(runId, read.receipt);
}

function runOracle(opened: VerdictInputsResult, oracle: SealedOracle): Verdict {
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
 * The verdict for one run: integrity first, then the oracle on the checked bytes.
 * Operator-side: its reasons carry `integrityReasons` (which can name absolute host paths)
 * and the oracle's error message, so they must not reach the agent; use `gateForTrial` for an
 * agent request. The receipt is required and must be the one the harness kept since sealing
 * *this* run; a receipt for any other run fails `receipt-mismatch`. `AUDIT_WITHOUT_RECEIPT`
 * or a malformed receipt passed by a cast is refused at runtime (`receipt-missing` /
 * `receipt-malformed`).
 */
export function gatedVerdict(
  vault: VerdictVault,
  runId: string,
  receipt: SealReceipt,
  oracle: SealedOracle,
): Verdict {
  const read = readReceipt(receipt);
  if ("problem" in read) return { status: "uncertain", reasons: integrityReasons([read.problem]) };
  return runOracle(vault.openVerdictInputs(runId, read.receipt), oracle);
}

/** Operator-side diagnostics for `gateForTrial`. They never change the verdict. */
export interface GateForTrialOptions {
  /** The full violations (codes, paths, details) behind an integrity `uncertain`. */
  readonly onIntegrity?: (violations: readonly IntegrityViolation[]) => void;
  /** What the oracle threw. */
  readonly onOracleError?: (error: unknown) => void;
}

/** The fixed agent-facing reason for an oracle that threw: no message, no path. */
export const ORACLE_THREW_REASON = "could not look: oracle threw";

/**
 * The gate's entry point for an agent request, for a caller with a `SealedOracle`. Any run
 * id other than the bound trial's is `uncertain` without opening the vault, so an agent
 * cannot point the gate at an earlier honest run. See `openForTrial`.
 *
 * Agent-facing: an integrity failure's reasons are `integrityCodes` only (`integrity:<code>`)
 * and an oracle that throws gives the fixed `ORACLE_THREW_REASON`, so no host path or error
 * text reaches the agent (#484 N-b). The full details go to the operator through `opts`.
 */
export function gateForTrial(
  vault: VerdictVault,
  binding: TrialBinding,
  requestedRunId: string,
  oracle: SealedOracle,
  opts: GateForTrialOptions = {},
): Verdict {
  const report = (fn: () => void) => {
    try {
      fn();
    } catch {
      // Diagnostics never change a verdict.
    }
  };
  const opened = openForTrial(vault, binding, requestedRunId);
  if (!opened.ok) {
    const { violations } = opened;
    report(() => opts.onIntegrity?.(violations));
    return { status: "uncertain", reasons: integrityCodes(violations) };
  }
  try {
    return oracle(opened.inputs);
  } catch (e) {
    report(() => opts.onOracleError?.(e));
    return { status: "uncertain", reasons: [ORACLE_THREW_REASON] };
  }
}
