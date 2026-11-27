/**
 * Agent-written check labels (M2 capability track C). This module imports NOTHING: the ledger
 * checks (`src/benchmark/check.ts`, `src/m2/evidence.ts`) import it to refuse agent-written
 * signals as evidence, and they must not reach gate-side or sandbox code (the walk in
 * `test/benchmark/independence.test.ts`).
 *
 * An agent-written check is never the grader and never evidence. Every signal it produces
 * carries all three markers below; a ledger row that carries ANY of them, at any depth, is
 * refused by the evidence checks.
 */

export const AGENT_CHECK_SIGNAL_KIND = "myco.agent-check-signal/1" as const;
export const AGENT_CHECK_EVIDENCE_CLASS = "agent-written-advisory" as const;
export const AGENT_CHECK_SOURCE = "agent-written-check" as const;

/** Deeper than any ledger row; a value nested past this is treated as carrying a signal. */
const MAX_DEPTH = 32;

/**
 * Whether `value` carries an agent-written-check marker anywhere: an object whose `kind`,
 * `evidenceClass` or `source` is one of the markers. Cycle-safe; fails closed (true) on a
 * value too deep to scan.
 */
export function carriesAgentCheckSignal(value: unknown): boolean {
  const seen = new Set<object>();
  const scan = (v: unknown, depth: number): boolean => {
    if (v === null || typeof v !== "object") return false;
    if (depth > MAX_DEPTH) return true;
    if (seen.has(v)) return false;
    seen.add(v);
    // Arrays too: their elements are their values.
    const o = v as Record<string, unknown>;
    if (
      o.kind === AGENT_CHECK_SIGNAL_KIND ||
      o.evidenceClass === AGENT_CHECK_EVIDENCE_CLASS ||
      o.source === AGENT_CHECK_SOURCE
    )
      return true;
    return Object.values(o).some((x) => scan(x, depth + 1));
  };
  return scan(value, 0);
}

/**
 * The error an evidence check reports for rows that carry an agent-written-check signal, or
 * null. Applied to RAW input rows, before schema validation, so the refusal names the cause
 * whatever else is wrong with the row.
 */
export function agentCheckRowsError(rows: readonly unknown[], what: string): string | null {
  const marked = rows.flatMap((r, i) => (carriesAgentCheckSignal(r) ? [i] : []));
  if (marked.length === 0) return null;
  const shown = marked.slice(0, 5).join(", ");
  return `${marked.length} ${what} row(s) carry an agent-written check signal (row ${shown}${marked.length > 5 ? ", ..." : ""}): agent-written checks are advisory only, never evidence`;
}
