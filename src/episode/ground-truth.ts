/**
 * Ground truth for an episode: the INDEPENDENT grader's result (`src/benchmark/grade`), never
 * the gate's. The grader gets bytes and the public intent only (the published task's fixture
 * file, the captured document, the intent and column types); nothing the gate computed is
 * passed. This module is the only part of the episode writer that imports the grader, and
 * nothing the gate imports reaches it.
 */
import { type ColumnType, grade } from "../benchmark/grade/grade.ts";
import type { EpisodeGroundTruth } from "./types.ts";

export interface CalcRecordEditGradeInput {
  /** The published fixture bytes (e.g. `benchmark/false-completion/<v>/fixtures/<sha>.csv`). */
  readonly fixtureCsv: Uint8Array;
  readonly fixtureSha256: string;
  readonly intent: { readonly rowKey: string; readonly column: string; readonly newValue: string };
  readonly columnTypes: Readonly<Record<string, ColumnType>>;
  readonly persistedFormat: "csv" | "xlsx";
}

/** A `groundTruth` callback for `runGatedTrialWithEpisode` on a calc-record-edit task. */
export function gradeCalcRecordEdit(
  input: CalcRecordEditGradeInput,
): (persisted: Uint8Array | null) => EpisodeGroundTruth {
  return (persisted) => {
    const result = grade({
      fixtureCsv: input.fixtureCsv,
      fixtureSha256: input.fixtureSha256,
      persisted: persisted === null ? null : { format: input.persistedFormat, bytes: persisted },
      intent: input.intent,
      columnTypes: input.columnTypes,
    });
    return {
      source: "independent-grader",
      graderVersion: result.graderVersion,
      status: result.status,
      targetSatisfied: result.targetSatisfied,
      mismatchCount: result.mismatchCount,
      fixtureSha256: result.fixtureSha256,
      persistedSha256: result.persistedSha256,
    };
  };
}
