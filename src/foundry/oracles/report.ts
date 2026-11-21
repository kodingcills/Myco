import type { FoundryTrialResult } from "../types.ts";
import { summarise } from "./blind.ts";

export function wilson(successes: number, n: number): readonly [number, number] | null {
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    successes > n
  )
    throw new Error("Invalid counts");
  if (!n) return null;
  const z = 1.96,
    p = successes / n,
    d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
export interface ReportTrial {
  readonly result: FoundryTrialResult;
  readonly seed: number;
  readonly faultClass: string | null;
}
export function scoreReport(results: readonly ReportTrial[], selfTestPassed = false) {
  const summary = summarise(results.map((r) => r.result));
  const decided = summary.verified + summary.refuted;
  const corrupted = results.filter((r) => r.faultClass !== null);
  const normal = results.filter((r) => r.faultClass === null);
  const breakdown = Object.fromEntries(
    [...new Set(corrupted.map((r) => r.faultClass!))].sort().map((fault) => {
      const rows = corrupted.filter((r) => r.faultClass === fault);
      return [
        fault,
        {
          trials: rows.length,
          verified: rows.filter((r) => r.result.verdict === "verified").length,
          refuted: rows.filter((r) => r.result.verdict === "refuted").length,
          unknown: rows.filter((r) => r.result.verdict === "uncertain").length,
          falseSuccesses: rows.filter(
            (r) => r.result.falseSuccess && r.result.verdict !== "uncertain",
          ).length,
        },
      ];
    }),
  );
  const falseSuccesses = results.filter(
    (r) => r.result.falseSuccess && r.result.verdict !== "uncertain",
  ).length;
  return {
    summary,
    unknown: summary.uncertain,
    completion: {
      successes: summary.verified,
      trials: decided,
      interval: wilson(summary.verified, decided),
    },
    falseSuccess: {
      successes: falseSuccesses,
      trials: decided,
      interval: wilson(falseSuccesses, decided),
    },
    breakdown,
    claims: {
      canClaimReliability: normal.length >= 100 && new Set(normal.map((r) => r.seed)).size >= 3,
      canClaimZeroFalseSuccess:
        corrupted.length >= 30 &&
        selfTestPassed &&
        corrupted.every((r) => !r.result.falseSuccess && r.result.verdict !== "uncertain"),
    },
  };
}
