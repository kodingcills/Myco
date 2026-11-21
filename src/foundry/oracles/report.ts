import type { commitment } from "../hidden-split/index.ts";
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
  readonly hiddenSplitVersion: number;
  readonly commitmentRoot: string;
  readonly fixtureHash: string;
}
export function scoreReport(
  results: readonly ReportTrial[],
  selfTestPassed: boolean,
  trustedCommitment: ReturnType<typeof commitment>,
) {
  const versions = new Set(results.map((r) => r.hiddenSplitVersion));
  const roots = new Set(results.map((r) => r.commitmentRoot));
  if (
    versions.size !== 1 ||
    results.some(
      (r) =>
        r.hiddenSplitVersion !== trustedCommitment.hiddenSplitVersion ||
        r.commitmentRoot !== trustedCommitment.rootHash,
    ) ||
    roots.size !== 1 ||
    results.some(
      (r) =>
        !Number.isSafeInteger(r.hiddenSplitVersion) ||
        r.hiddenSplitVersion < 0 ||
        !/^[a-f0-9]{64}$/.test(r.commitmentRoot),
    )
  )
    throw new Error("Mixed or invalid hidden split versions or commitments");
  const summary = summarise(results.map((r) => r.result));
  const decided = summary.verified + summary.refuted;
  const corrupted = results.filter((r) => r.faultClass !== null);
  const normal = results.filter((r) => r.faultClass === null);
  const knownNormal = normal.filter((r) => r.result.verdict !== "uncertain");
  const reliabilityReasons: string[] = [];
  // At most 5% of normal trials may be unknown.
  if (!normal.length || (normal.length - knownNormal.length) / normal.length > 0.05)
    reliabilityReasons.push("Unknown rate exceeds 5%");
  if (knownNormal.length < 100) reliabilityReasons.push("Fewer than 100 known normal trials");
  if (new Set(knownNormal.map((r) => r.seed)).size < 3)
    reliabilityReasons.push("Fewer than three seeds");
  if (
    knownNormal.some((r) => !trustedCommitment.perFixtureHash.includes(r.fixtureHash)) ||
    knownNormal.length === 0
  )
    reliabilityReasons.push("Normal trials must use the hidden split");
  const zeroReasons: string[] = [];
  if (corrupted.length < 30) zeroReasons.push("Fewer than 30 corrupted trials");
  if (!selfTestPassed) zeroReasons.push("Verifier self-test did not pass");
  if (corrupted.some((r) => r.result.falseSuccess || r.result.verdict === "uncertain"))
    zeroReasons.push("False success or unknown corrupted trial");
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
    hiddenSplitVersion: results[0]!.hiddenSplitVersion,
    commitmentRoot: results[0]!.commitmentRoot,
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
      canClaimReliability: {
        allowed: reliabilityReasons.length === 0,
        reasons: reliabilityReasons,
      },
      canClaimZeroFalseSuccess: {
        allowed: zeroReasons.length === 0,
        reasons: zeroReasons,
        exactUpper95:
          corrupted.length &&
          corrupted.every((r) => !r.result.falseSuccess && r.result.verdict !== "uncertain")
            ? 1 - 0.05 ** (1 / corrupted.length)
            : null,
      },
    },
  };
}
