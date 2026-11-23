/**
 * TIF-148: turn the runs the viewer already has open into a `HeadToHeadReport`, so
 * `intake()` is reachable without a file drop or a `?compare=` URL.
 *
 * The `ArmSource` the app can construct is a Myco run directory, one per open run:
 * the viewer loads a run folder through `loaders.ts`, which pairs its `trace.jsonl`
 * with `result.json`, and `result.json` is exactly what `armFromMycoResult` reads.
 * No new plumbing is needed and nothing is fetched.
 *
 * Two consequences are stated in the view rather than hidden:
 *  - a Myco run's `result.json` does not record the agent's claim, so an arm built
 *    from it carries `falseSuccessKnown: false` and the report's provenance is
 *    `unknown`, never `live` (see `armFromMycoResult`);
 *  - one open run is a one-arm comparison. It is honest but thin; the table is the
 *    point once two or more runs are open.
 */

import type { HeadToHeadArm, HeadToHeadReport } from "./head-to-head.ts";
import { type ArmSource, intake, provenanceFor } from "./live-report.ts";

/** The part of an opened run this needs: its name and its parsed `result.json`. */
export interface OpenedRunLike {
  readonly key: string;
  readonly name: string;
  readonly data: { readonly result?: unknown };
}

/**
 * One opened run is one `myco-run-dir` source. `content` is the artifact's text.
 *
 * `armId` is the run's `key`, not its folder name: names are not unique — every pack
 * has a `trial-0` (m1-013, m1-014-corrupted, m1-014-supplement each hold one), and a
 * bare `result.json` + `trace.jsonl` pair is always named `result.json + trace.jsonl`.
 * Two such runs would collide as arm ids, so the head-to-head rows (and their React
 * keys) would be indistinguishable. `key` is the runId, or a UUID before the result
 * parses, so it is unique per open run. The folder name stays as the human `path` and
 * becomes the row's label.
 */
export function armSourcesFromRuns(runs: readonly OpenedRunLike[]): ArmSource[] {
  const sources: ArmSource[] = [];
  for (const run of runs) {
    if (run.data.result === undefined) continue;
    sources.push({
      armId: run.key,
      kind: "myco-run-dir",
      path: run.name,
      content: JSON.stringify(run.data.result),
    });
  }
  return sources;
}

/**
 * The report for the open runs, or `undefined` when no run carries a `result.json`
 * yet. Nothing is invented: a run with no verdict is refused by `intake` and named
 * in the notes, and every count here comes straight from the arms.
 */
export function reportFromRuns(
  runs: readonly OpenedRunLike[],
  generatedAt = new Date().toISOString(),
): HeadToHeadReport | undefined {
  const sources = armSourcesFromRuns(runs);
  if (sources.length === 0) return undefined;
  const { arms, pairRows, refused } = intake(sources);
  const verdicts = arms.flatMap((arm) => arm.trials);
  const verified = verdicts.filter((trial) => trial.verdict === "verified").length;
  const refuted = verdicts.filter((trial) => trial.verdict === "refuted").length;
  const uncertain = verdicts.filter((trial) => trial.verdict === "uncertain").length;
  const pairs: HeadToHeadArm[] = arms.map((arm) => ({
    armId: arm.armId,
    // The row shows the run's folder name; the id is the unique run key.
    label: arm.source,
    trials: arm.trials.map((trial) => ({
      verdict: trial.verdict,
      falseSuccess: trial.falseSuccess,
      falseSuccessKnown: trial.falseSuccessKnown,
    })),
  }));
  const armsWithKnownClaims = arms.filter((arm) =>
    arm.trials.every((trial) => trial.falseSuccessKnown),
  ).length;
  return {
    // Refused, not "decided": the viewer is not the pre-registered rule. The notes say
    // what this is, and no significance test is run over open runs.
    decision: {
      status: refused.length > 0 && arms.length === 0 ? "refused" : "decided",
      reason: refused.length > 0 ? `${refused.length} source(s) refused` : undefined,
      row: undefined,
      taskId: runs[0]?.name ?? "open runs",
      promptVariant: "not recorded",
      pairs: 0,
      mycoFalseSuccesses: 0,
      comparatorFalseSuccesses: 0,
      discordantFavouringMyco: 0,
      discordantFavouringComparator: 0,
      signTestP: null,
      mycoFalseSuccessInterval: null,
      comparatorFalseSuccessInterval: null,
      ineligibleRows: refused.length,
      notes: [
        `Arms are the ${arms.length} open run(s) that carry a result.json: ${verified} verified, ${refuted} failed, ${uncertain} unknown.`,
        ...(refused.length > 0
          ? [`Refused: ${refused.map((entry) => `${entry.source} (${entry.reason})`).join(", ")}`]
          : []),
        // Only claim the flags are recorded when there is at least one arm. With no arms
        // the comparison below is 0 < 0, which would assert it falsely.
        ...(arms.length === 0
          ? ["No arm could be read from the open runs, so there is nothing to compare."]
          : [
              armsWithKnownClaims < arms.length
                ? "A run's result.json does not record the agent's claim, so false success cannot be decided from it; those rows read `not recorded`."
                : "Every arm records its false-success flag.",
            ]),
      ],
      pairRows: pairRows.map((row) => ({
        seed: row.seed,
        faultClass: row.faultClass,
        mycoFalseSuccess: row.mycoFalseSuccess,
        comparatorFalseSuccess: row.comparatorFalseSuccess,
        claimKnown: row.claimKnown,
      })),
    },
    arms: pairs,
    provenance: {
      kind: provenanceFor(arms, pairRows),
      note: "Built from the runs open in this viewer; no artifacts were fetched.",
      arms: arms.map((arm) => ({
        armId: arm.armId,
        source: arm.source,
        live: arm.trials.every((trial) => trial.falseSuccessKnown),
      })),
    },
    generatedAt,
  };
}
