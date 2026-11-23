// biome-ignore-all lint/suspicious/noConsole: CLI report goes to stdout.
/**
 * Build the C1 arm's final-denominator report from its ledger and rows.
 *
 * Reads only files on disk: no VM, no API calls, so the report can be produced
 * the moment the sweep ends and re-produced by anyone auditing the numbers.
 *
 * The point of generating rather than writing this by hand is the denominator.
 * A pass rate is only meaningful next to the count of trials that produced a
 * row and the reasons the others did not, and every figure here is derived from
 * the ledger rather than retyped from a summary.
 *
 * Usage: node --import tsx scripts/c1-arm-report.ts <arm-dir> [--json]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaselineRow } from "../src/baseline/index.ts";

interface Entry {
  status: "scored" | "omitted" | "reserved";
  micros: number;
  reason?: string;
  row?: BaselineRow;
}

export interface ArmReport {
  directory: string;
  trialsInManifest: number;
  scored: number;
  omitted: number;
  reserved: number;
  /** Committed spend: every ledger entry, not just scored rows. */
  committedUsd: number;
  scoredUsd: number;
  omittedUsd: number;
  reservedUsd: number;
  verdicts: Record<string, number>;
  reasons: Record<string, number>;
  /** The property the milestone rests on; must be zero for scorable rows. */
  falseSuccesses: number;
  falseSuccessUnknown: number;
  exclusionReasons: Record<string, number>;
  /** Rate over rows actually produced, never over the manifest size. */
  refutedRate: number | null;
  verifiedRate: number | null;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function buildReport(directory: string): ArmReport {
  const ledger = (
    JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8")) as {
      c1: Record<string, Entry>;
    }
  ).c1;
  const entries = Object.values(ledger);
  const rows = entries.flatMap((e) => (e.row ? [e.row] : []));
  const sum = (xs: Entry[]) => xs.reduce((t, e) => t + (e.micros ?? 0), 0) / 1_000_000;
  const scored = entries.filter((e) => e.status === "scored");
  const omitted = entries.filter((e) => e.status === "omitted");
  const reserved = entries.filter((e) => e.status === "reserved");
  const n = rows.length;
  const refuted = rows.filter((r) => r.verdict === "refuted").length;
  const verified = rows.filter((r) => r.verdict === "verified").length;
  // A row counts as a false success only when the judge said so with a known
  // independent value; null means the audit never ran, which is not a pass.
  const fsTrue = rows.filter((r) => r.falseSuccess === true).length;
  const fsUnknown = rows.filter((r) => r.falseSuccess === null).length;
  return {
    directory,
    trialsInManifest: Object.keys(ledger).length,
    scored: scored.length,
    omitted: omitted.length,
    reserved: reserved.length,
    committedUsd: sum(entries),
    scoredUsd: sum(scored),
    omittedUsd: sum(omitted),
    reservedUsd: sum(reserved),
    verdicts: tally(rows.map((r) => r.verdict)),
    reasons: tally(rows.map((r) => r.verdictReason)),
    falseSuccesses: fsTrue,
    falseSuccessUnknown: fsUnknown,
    exclusionReasons: tally(omitted.map((e) => e.reason ?? "unspecified")),
    refutedRate: n > 0 ? refuted / n : null,
    verifiedRate: n > 0 ? verified / n : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2];
  if (!directory) throw new Error("usage: c1-arm-report.ts <arm-dir> [--json]");
  if (!existsSync(join(directory, "accounting.json")))
    throw new Error(`no accounting.json in ${directory}`);
  const r = buildReport(directory);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const rowFiles = existsSync(join(directory, "trials", "c1"))
      ? readdirSync(join(directory, "trials", "c1")).length
      : 0;
    console.log(`C1 arm report - ${r.directory}`);
    console.log(`  trials in manifest : ${r.trialsInManifest}   row files: ${rowFiles}`);
    console.log(
      `  denominator        : ${r.scored} scored, ${r.omitted} omitted, ${r.reserved} reserved`,
    );
    console.log(
      `  exclusions         : ${
        Object.entries(r.exclusionReasons)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "none"
      }`,
    );
    console.log(
      `  rate over produced : refuted ${(r.refutedRate ?? 0).toFixed(3)}, verified ${(r.verifiedRate ?? 0).toFixed(3)} (n=${r.scored})`,
    );
    console.log(`  verdicts           : ${JSON.stringify(r.verdicts)}`);
    console.log(`  reasons            : ${JSON.stringify(r.reasons)}`);
    console.log(
      `  falseSuccess       : ${r.falseSuccesses} true, ${r.falseSuccessUnknown} unknown`,
    );
    console.log(
      `  spend committed    : $${r.committedUsd.toFixed(4)} (scored $${r.scoredUsd.toFixed(4)} + omitted $${r.omittedUsd.toFixed(4)} + reserved $${r.reservedUsd.toFixed(4)})`,
    );
  }
}
