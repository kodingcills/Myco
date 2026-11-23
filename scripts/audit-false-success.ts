// biome-ignore-all lint/suspicious/noConsole: CLI audit report goes to stdout.
/**
 * The 0-false-success audit for a recorded C1 arm (TIF-219).
 *
 * "Zero false successes" is a claim about a NUMBER, and it means two different
 * things depending on how it was obtained:
 *
 *   - OBSERVED: no row was scored as a success while the document said
 *     otherwise. This is what `falseSuccess === false` on every row asserts.
 *   - BOUNDED: the independent audit ran on the rows that could have produced a
 *     false success, and found none. A bound is a statement about the population
 *     the audit covered; an observation is a statement about the scorer only.
 *
 * The audit in `c1-judge.ts:35` only runs when `verdict.status === "verified"`
 * (`c1-trial.ts:91`). So an arm with zero verified rows has zero audited rows,
 * and "0 false successes" there is observed and UNBOUNDED - it does not
 * extrapolate to what would happen if the arm had succeeded more often.
 *
 * This script computes which case a corpus is in, from the corpus, so the claim
 * is reproducible rather than asserted in prose.
 *
 * Usage: node --import tsx scripts/audit-false-success.ts <accounting.json> [--json]
 */
import { readFileSync } from "node:fs";
import type { BaselineRow } from "../src/baseline/index.ts";

export interface FalseSuccessAudit {
  rows: number;
  verified: number;
  refuted: number;
  uncertain: number;
  /** Rows whose independent value was actually read. */
  audited: number;
  /** Rows counted as a false success (success scored, document disagreed). */
  falseSuccesses: number;
  /** Rows where the audit never ran, so no claim is supported either way. */
  unaudited: number;
  /** True when at least one row was audited, i.e. the bound is non-empty. */
  bounded: boolean;
  /** What the corpus supports, in one sentence. */
  verdict: string;
}

export function auditFalseSuccess(
  ledger: Record<string, { row?: BaselineRow }>,
): FalseSuccessAudit {
  const rows = Object.values(ledger).flatMap((e) => (e.row ? [e.row] : []));
  const verified = rows.filter((r) => r.verdict === "verified").length;
  const refuted = rows.filter((r) => r.verdict === "refuted").length;
  const uncertain = rows.filter((r) => r.verdict === "uncertain").length;
  const audited = rows.filter((r) => r.audited === true).length;
  const falseSuccesses = rows.filter((r) => r.falseSuccess === true).length;
  const unaudited = rows.length - audited;
  const bounded = audited > 0;
  const verdict = bounded
    ? `${falseSuccesses} false success(es) in ${audited} audited row(s) of ${rows.length}; the bound covers the audited population only`
    : `0 false successes OBSERVED across ${rows.length} row(s), but 0 audited: no row reached a success verdict, so the independent audit never ran and NO BOUND is supported by this corpus`;
  return {
    rows: rows.length,
    verified,
    refuted,
    uncertain,
    audited,
    falseSuccesses,
    unaudited,
    bounded,
    verdict,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: audit-false-success.ts <accounting.json> [--json]");
  const ledger = (
    JSON.parse(readFileSync(path, "utf8")) as { c1: Record<string, { row?: BaselineRow }> }
  ).c1;
  const audit = auditFalseSuccess(ledger);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(audit, null, 2));
  } else {
    console.log(`false-success audit - ${path}`);
    console.log(
      `  rows        : ${audit.rows} (verified ${audit.verified}, refuted ${audit.refuted}, uncertain ${audit.uncertain})`,
    );
    console.log(`  audited     : ${audit.audited} of ${audit.rows} (unaudited ${audit.unaudited})`);
    console.log(`  falseSuccess: ${audit.falseSuccesses} true`);
    console.log(`  bounded?    : ${audit.bounded}`);
    console.log(`  VERDICT: ${audit.verdict}`);
  }
}
