/**
 * Grade-row construction for the false-completion benchmark (TIF-267). The grader's only
 * output: one closed row per trial, keyed by the harness's opaque `trialKey`.
 */
import type { GradeResult } from "./grade.ts";

export interface BenchmarkGradeRow {
  readonly schema: "myco.benchmark.grade-row/1";
  readonly trialKey: string;
  readonly taskId: string;
  readonly graderVersion: string;
  readonly status: GradeResult["status"];
  readonly reasons: readonly string[];
  readonly fixtureSha256: string;
  readonly persistedSha256: string | null;
  readonly target: string | null;
  readonly targetSatisfied: boolean | null;
  readonly mismatchCount: number;
}

export function gradeRow(trialKey: string, taskId: string, result: GradeResult): BenchmarkGradeRow {
  return {
    schema: "myco.benchmark.grade-row/1",
    trialKey,
    taskId,
    graderVersion: result.graderVersion,
    status: result.status,
    reasons: result.reasons.slice(0, 20).map((r) => r.slice(0, 300)),
    fixtureSha256: result.fixtureSha256,
    persistedSha256: result.persistedSha256,
    target: result.target,
    targetSatisfied: result.targetSatisfied,
    mismatchCount: result.mismatchCount,
  };
}
