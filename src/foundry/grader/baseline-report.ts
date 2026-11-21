import { armRegistry, escalations } from "../baseline/registry.ts";
import type { commitment } from "../hidden-split/index.ts";
import { scoreReport, wilson } from "../oracles/report.ts";
import type { runArm } from "./baseline-runner.ts";

type Row = ReturnType<typeof runArm>[number];
type Unknown = "unknown";
const unarmed = (row: Row) => row.faultClass !== null && row.faultEvent === null;
/** Completion excludes uncertain trials. Recovery is verified faulted trials with a recovery event divided by known faulted trials. Repeatability is the range of per-seed known completion rates, only with at least three known seeds. Unmeasured setup and economics remain unknown. */
export function metrics(rows: readonly Row[]) {
  const known = rows.filter((r) => r.result.verdict !== "uncertain" && !unarmed(r));
  const verified = known.filter((r) => r.result.verdict === "verified").length;
  const faulted = known.filter((r) => r.faultClass !== null);
  const bySeed = [...new Set(rows.map((r) => r.seed))]
    .sort((a, b) => a - b)
    .map((seed) => {
      const trials = known.filter((r) => r.seed === seed);
      return {
        seed,
        completion: trials.length
          ? trials.filter((r) => r.result.verdict === "verified").length / trials.length
          : ("unknown" as const),
      };
    });
  const rates = bySeed.map((r) => r.completion).filter((r): r is number => typeof r === "number");
  return {
    setup: {
      steps: "unknown" as Unknown,
      wallClock: "unknown" as Unknown,
      manualInterventions: "unknown" as Unknown,
    },
    completion: {
      verified,
      known: known.length,
      rate: known.length ? verified / known.length : ("unknown" as const),
      interval: wilson(verified, known.length),
    },
    recovery: faulted.length
      ? faulted.filter((r) => r.recovered && r.result.verdict === "verified").length /
        faulted.length
      : ("unknown" as const),
    repeatability: {
      bySeed,
      spread: rates.length >= 3 ? Math.max(...rates) - Math.min(...rates) : ("unknown" as const),
    },
    economics: {
      tokens: "unknown" as Unknown,
      cost: "unknown" as Unknown,
      plannerName: rows[0]?.plannerName ?? "unknown",
    },
  };
}
export function baselineReport(
  rows: readonly Row[],
  selfTestPassed: boolean,
  trustedCommitment: ReturnType<typeof commitment>,
) {
  const faultVersions = new Set(rows.map((r) => r.result.faultVersion).filter((v) => v !== 0));
  const otherVersions = new Set(
    rows.map((r) =>
      JSON.stringify([
        r.result.fixtureVersion,
        r.result.oracleVersion,
        r.hiddenSplitVersion,
        r.commitmentRoot,
      ]),
    ),
  );
  if (faultVersions.size > 1 || otherVersions.size > 1)
    throw new Error("Mixed versions or commitments");
  const groups = [...new Set(rows.map((r) => r.armId))].map((id) => ({
    id,
    rows: rows.filter((r) => r.armId === id),
  }));
  const schedules = new Set(
    groups.map((group) => {
      const keys = group.rows.map((row) =>
        JSON.stringify([
          row.fixtureHash,
          row.seed,
          row.faultClass,
          row.result.faultVersion,
          row.reportError,
        ]),
      );
      if (new Set(keys).size !== keys.length) throw new Error("Duplicate baseline trials");
      return JSON.stringify(keys.sort());
    }),
  );
  if (schedules.size > 1) throw new Error("Baseline arms require identical trial schedules");
  const arms = groups.map(({ id, rows: armRows }) => ({
    id,
    metrics: metrics(armRows),
    score: scoreReport(
      armRows.map((row) =>
        unarmed(row)
          ? {
              ...row,
              faultArmed: false,
              result: { ...row.result, verdict: "uncertain", falseSuccess: false },
            }
          : row,
      ),
      selfTestPassed,
      trustedCommitment,
      { allowUnfaulted: true },
    ),
  }));
  return { arms, couldNotRun: armRegistry, escalations };
}
