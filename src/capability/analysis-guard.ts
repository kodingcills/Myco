/**
 * The shared capability-analysis guard (GitHub #652, lead ruling 2026-11-27 06:21Z).
 *
 * Every pre-registered capability analysis (`docs/product/capability-prereg/<track>-v<k>/`,
 * capability spec §3) calls `guardCapabilityAnalysis` before it makes any decision, and may
 * report "shown" only when the guard says `mayShow`. The guard enforces three rules that
 * round-1 verifiers found broken, track by track, in separate analyses:
 *
 * 1. **Pending rulings.** Never "shown" while the pre-registration's pending list
 *    (`leadRulingPending`, or an equivalent: `leadRulingsPending`, `pendingRulings`,
 *    `pending`) is non-empty. A pre-registration with none of those lists, or with one that
 *    is not an array, fails closed as pending. Code `LEAD_RULING_PENDING`, exit code 3.
 * 2. **Simulated rows.** A row counts only when its `simulated` member is absent or exactly
 *    `false`. Any other value (`true`, the string `"true"`, `1`, `null`, an own `undefined`)
 *    marks the row simulated; a row that is not an object never counts either. Any such row
 *    blocks "shown". Code `SIMULATED` (spec §3 item 5: simulated rows are never evidence).
 * 3. **Pre-registration hash.** A pack is refused (nothing may be computed or decided) unless
 *    the hash it records equals the pre-registration's hash AND the pre-registration
 *    committed at the pack's frozen commit hashes to the same value (spec §3 item 2). The
 *    caller supplies both hashes (each track has its own canonical-JSON rule); the guard
 *    compares them, fail closed on anything that is not 64 lowercase hex. Code
 *    `PREREG_HASH_MISMATCH`, exit code 1.
 *
 * This module imports nothing (in particular nothing from `src/gate`: the grader-side
 * analysis never shares code with the gate), so a track's pre-registration pins it with one
 * SHA-256. Its output is an analysis report for people; it is never shown to an agent.
 */

export const CAPABILITY_ANALYSIS_GUARD = "myco.capability.analysis-guard/1" as const;
export const CAPABILITY_ANALYSIS_GUARD_PATH = "src/capability/analysis-guard.ts";

export const LEAD_RULING_PENDING = "LEAD_RULING_PENDING" as const;
export const SIMULATED = "SIMULATED" as const;
export const PREREG_HASH_MISMATCH = "PREREG_HASH_MISMATCH" as const;

/** Exit codes for an analysis command line: 0 no guard blocker, 1 refused, 3 rulings pending. */
export const GUARD_EXIT_OK = 0;
export const GUARD_EXIT_REFUSED = 1;
export const GUARD_EXIT_LEAD_RULING_PENDING = 3;

/** The pre-registration members that list what still awaits a lead ruling, in lookup order. */
export const PENDING_LIST_FIELDS = [
  "leadRulingPending",
  "leadRulingsPending",
  "pendingRulings",
  "pending",
] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function describePending(item: unknown): string {
  if (typeof item === "string") return item;
  if (isRecord(item) && typeof item.field === "string") return item.field;
  return JSON.stringify(item) ?? String(item);
}

/**
 * Everything the pre-registration still lists as pending, across every recognised pending
 * list. Fails closed: no list at all, or a list that is not an array, is itself pending.
 */
export function pendingRulings(prereg: unknown): string[] {
  if (!isRecord(prereg)) return ["PENDING_LIST_MISSING: the pre-registration is not an object"];
  const out: string[] = [];
  let found = false;
  for (const field of PENDING_LIST_FIELDS) {
    if (!Object.hasOwn(prereg, field)) continue;
    found = true;
    const list = prereg[field];
    if (!Array.isArray(list)) out.push(`PENDING_LIST_MALFORMED: ${field} is not a list`);
    else out.push(...list.map(describePending));
  }
  if (!found) out.push(`PENDING_LIST_MISSING: none of ${PENDING_LIST_FIELDS.join(", ")}`);
  return out;
}

/** Rule 2: a row counts only if it is an object whose `simulated` is absent or exactly false. */
export function rowCounts(row: unknown): boolean {
  if (!isRecord(row)) return false;
  return !Object.hasOwn(row, "simulated") || row.simulated === false;
}

/** One pack's hash evidence: what it recorded, and what its frozen commit's prereg hashes to. */
export interface GuardPack {
  /** The pre-registration hash the pack records. */
  readonly recordedHash: unknown;
  /** The hash of the pre-registration as committed at the pack's frozen commit; null if absent. */
  readonly committedHash: string | null;
}

export interface CapabilityGuardInput {
  /** The pre-registration being analysed, as parsed. */
  readonly prereg: unknown;
  /** Its pre-registration hash, computed by the track's canonical-JSON rule. */
  readonly preregHash: string;
  /** Every pack the analysis reads; at least one. */
  readonly packs: readonly GuardPack[];
  /** Every row the analysis would count, across all packs. */
  readonly rows: readonly unknown[];
}

export type GuardCode =
  | "OK"
  | typeof PREREG_HASH_MISMATCH
  | typeof LEAD_RULING_PENDING
  | typeof SIMULATED;

export interface CapabilityGuardResult {
  readonly guard: typeof CAPABILITY_ANALYSIS_GUARD;
  /** Rule 3 failed: the analysis must refuse the pack and compute nothing. */
  readonly refused: boolean;
  /** True only when no rule blocks: the only state in which an analysis may say "shown". */
  readonly mayShow: boolean;
  /** The most severe blocker: refused, then pending, then simulated. */
  readonly code: GuardCode;
  /** One reason per blocker, each starting with its code. Empty iff `mayShow`. */
  readonly reasons: readonly string[];
  readonly pending: readonly string[];
  /** Indices (into `rows`) of the rows that do not count under rule 2. */
  readonly simulatedRows: readonly number[];
  readonly exitCode: number;
}

/** Run the three rules. Pure; never throws. */
export function guardCapabilityAnalysis(input: CapabilityGuardInput): CapabilityGuardResult {
  const want = input.preregHash;
  const packs = Array.isArray(input.packs) ? input.packs : [];
  const hashProblems: string[] = [];
  if (typeof want !== "string" || !SHA256_HEX.test(want))
    hashProblems.push("the pre-registration hash is not sha256 hex");
  if (packs.length === 0) hashProblems.push("no pack records a pre-registration hash");
  packs.forEach((pack, i) => {
    if (pack?.recordedHash !== want)
      hashProblems.push(`pack ${i} records another pre-registration hash`);
    else if (pack.committedHash !== want)
      hashProblems.push(`pack ${i}'s frozen commit does not hold this pre-registration`);
  });
  if (hashProblems.length > 0)
    return Object.freeze({
      guard: CAPABILITY_ANALYSIS_GUARD,
      refused: true,
      mayShow: false,
      code: PREREG_HASH_MISMATCH,
      reasons: Object.freeze(hashProblems.map((p) => `${PREREG_HASH_MISMATCH}: ${p}`)),
      pending: Object.freeze([]),
      simulatedRows: Object.freeze([]),
      exitCode: GUARD_EXIT_REFUSED,
    });

  const reasons: string[] = [];
  const pending = pendingRulings(input.prereg);
  if (pending.length > 0) reasons.push(`${LEAD_RULING_PENDING}: ${pending.join(", ")}`);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const simulatedRows = rows.flatMap((r, i) => (rowCounts(r) ? [] : [i]));
  if (simulatedRows.length > 0)
    reasons.push(`${SIMULATED}: ${simulatedRows.length} row(s); simulated rows are never evidence`);
  const code: GuardCode =
    pending.length > 0 ? LEAD_RULING_PENDING : simulatedRows.length > 0 ? SIMULATED : "OK";
  return Object.freeze({
    guard: CAPABILITY_ANALYSIS_GUARD,
    refused: false,
    mayShow: reasons.length === 0,
    code,
    reasons: Object.freeze(reasons),
    pending: Object.freeze(pending),
    simulatedRows: Object.freeze(simulatedRows),
    exitCode: pending.length > 0 ? GUARD_EXIT_LEAD_RULING_PENDING : GUARD_EXIT_OK,
  });
}

/** The final verdict: "shown" only when the analysis computed "shown" and the guard allows it. */
export function guardedVerdict(
  guard: CapabilityGuardResult,
  computedShown: boolean,
): "shown" | "not-shown" {
  return guard.mayShow && !guard.refused && computedShown === true ? "shown" : "not-shown";
}
