// biome-ignore-all lint/suspicious/noConsole: CLI replay report goes to stdout.
/**
 * Offline replay of recorded C1 arm rows.
 *
 * Non-VM: this re-derives each row's verdict from its recorded transcript,
 * driver state and observation, then asserts it matches what the live run
 * scored. It exists because the scoring path was only ever exercised on the
 * guest, so a regression in judge()/falseSuccess()/sumUsage() could not be
 * caught without spending a VM slot to discover it.
 *
 * Run: node --import tsx scripts/replay-arm-rows.ts <rows-dir> [--json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BaselineRow,
  falseSuccess,
  judge,
  type Observation,
  sumUsage,
} from "../src/baseline/index.ts";

/** The observation a verdict reason implies. Kept in one place so a new reason
 * makes this fail loudly rather than silently skipping the row. */
function observationFor(reason: string, row: BaselineRow): Observation {
  switch (reason) {
    case "persisted-mismatch":
      // The mismatch case is only reachable with a persisted observation whose
      // actual differs; the recorded row carries the expected value, so any
      // differing actual reproduces the same verdict.
      return { kind: "persisted", actual: `${row.expected}-differed`, expected: row.expected };
    case "persisted-match":
      return { kind: "persisted", actual: row.expected, expected: row.expected };
    case "modified":
    case "dialog":
    case "driver-action":
    case "step-budget":
    case "unavailable":
      return { kind: reason };
    case "driver-unreachable":
      // NOT a fixpoint on its own: judge() reports this reason from its
      // driverReady guard, which fires BEFORE the observation is consulted, so
      // any observation kind reproduces it as long as the driver is unreachable.
      // replayRow therefore also forces sessionIdentityMatches:false for this
      // reason - the two must change together, and removing either silently
      // breaks reproduction for this branch.
      return { kind: "unavailable" };
    default:
      throw new Error(`unmapped verdictReason ${JSON.stringify(reason)}; add it to observationFor`);
  }
}

export interface ReplayResult {
  index: number;
  recorded: string;
  replayed: string;
  reasonRecorded: string;
  reasonReplayed: string;
  matched: boolean;
  costDelta: number;
}

/**
 * Replay one row.
 *
 * The observation is reconstructed FROM the recorded reason, so the status
 * match alone would be circular - of course judge() returns "refuted" if it is
 * handed a refuting observation. The load-bearing assertions are therefore:
 *
 *   - reasonMatch: judge() returns the SAME reason string the row recorded.
 *     This is a real check: it pins the mapping from observation kind to
 *     reported reason, so renaming a reason, reordering the switch, or changing
 *     which branch a kind falls into fails here without a VM.
 *   - falseSuccess reproduced from the replayed status.
 *   - cost recomputed from the raw usage records, delta 0.
 *
 * It is a regression harness for the scoring functions, not an independent
 * judge of the run: it cannot tell you the live observation was right, only
 * that the same inputs still produce the same answers.
 */
export function replayRow(row: BaselineRow): ReplayResult {
  const driver =
    row.verdictReason === "driver-unreachable"
      ? { ...row.driver, sessionIdentityMatches: false }
      : row.driver;
  const replayed = judge(row.transcript, driver, observationFor(row.verdictReason, row));
  const reasonReplayed = replayed.reasons[0] ?? "unavailable";
  // falseSuccess must also reproduce: it is the property the milestone rests on.
  const fsReplayed = falseSuccess(replayed.status, row.independentValuePresent);
  const costReplayed = sumUsage(row.usage).cost;
  return {
    index: row.index,
    recorded: row.verdict,
    replayed: replayed.status,
    reasonRecorded: row.verdictReason,
    reasonReplayed,
    matched:
      replayed.status === row.verdict &&
      reasonReplayed === row.verdictReason &&
      fsReplayed === row.falseSuccess,
    costDelta: Number((costReplayed - row.cost).toFixed(6)),
  };
}

/**
 * Row-file order: numeric where both names parse, lexical otherwise. Exported so
 * the test drives the real comparator rather than a copy of it - a copy passes
 * even if this function stops being used.
 */
export function compareRowFiles(a: string, b: string): number {
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
  return na - nb;
}

export function replayDirectory(directory: string): ReplayResult[] {
  const files = readdirSync(directory)
    .filter((f) => f.endsWith(".json"))
    .sort(compareRowFiles);
  return files.map((f) =>
    replayRow(JSON.parse(readFileSync(join(directory, f), "utf8")) as BaselineRow),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2];
  if (!directory) throw new Error("usage: replay-arm-rows.ts <rows-dir> [--json]");
  const results = replayDirectory(directory);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const mark = r.matched ? "OK  " : "FAIL";
      console.log(
        `${mark} idx=${r.index} recorded=${r.recorded}/${r.reasonRecorded} replayed=${r.replayed}/${r.reasonReplayed} costDelta=${r.costDelta}`,
      );
    }
    const bad = results.filter((r) => !r.matched);
    const drift = results.filter((r) => r.costDelta !== 0);
    console.log(`\n${results.length - bad.length}/${results.length} reproduced`);
    if (drift.length > 0) {
      // Recomputed cost disagreeing with the recorded cost is a real finding:
      // the usage records and the stored total have diverged, so the stored
      // figure would misreport spend. It was previously printed and ignored.
      console.log(`cost drift in ${drift.length} row(s):`);
      for (const d of drift) console.log(`  idx=${d.index} costDelta=${d.costDelta}`);
    }
    if (bad.length > 0 || drift.length > 0) process.exitCode = 1;
  }
}
