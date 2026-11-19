import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GuardFailure, PredicateResult, StepRecord } from "./program.ts";
import type { Verdict } from "./verify.ts";

export interface RunRecord {
  runId: string;
  taskId: string;
  taskParams: Record<string, unknown>;
  startedAt: string;
  steps: EvidenceStep[];
  guardFailure?: GuardFailure;
  verdict?: Verdict;
  unresolvedState?: string;
}

export interface EvidenceStep {
  step: number;
  action: Record<string, unknown>;
  preconditionResults: PredicateResult[];
  postconditionResults: PredicateResult[];
  stateVersionBefore: number;
  stateVersionAfter: number;
}

export interface RunResult {
  runId: string;
  outcome: "completed" | "guardFailure";
  verdict?: Verdict;
  finalSummary: string;
}

export function stepFromRecord(record: StepRecord): EvidenceStep {
  return {
    step: record.step,
    action: record.action as Record<string, unknown>,
    preconditionResults: record.preconditionResults,
    postconditionResults: record.postconditionResults,
    stateVersionBefore: record.stateVersionBefore,
    stateVersionAfter: record.stateVersionAfter,
  };
}

export function writeRunEvidence(
  runsDir: string,
  record: RunRecord,
  result: { outcome: "completed" | "guardFailure"; verdict?: Verdict; finalSummary: string },
): string {
  const runDir = join(runsDir, record.runId);
  mkdirSync(runDir, { recursive: true });
  const tracePath = join(runDir, "trace.jsonl");
  for (const step of record.steps) {
    appendFileSync(tracePath, `${JSON.stringify({ type: "step", ...step })}\n`);
  }
  if (record.guardFailure) {
    appendFileSync(
      tracePath,
      `${JSON.stringify({ type: "guardFailure", ...record.guardFailure })}\n`,
    );
  }
  const resultPath = join(runDir, "result.json");
  mkdirSync(dirname(resultPath), { recursive: true });
  const resultJson: RunResult = {
    runId: record.runId,
    outcome: result.outcome,
    verdict: result.verdict,
    finalSummary: result.finalSummary,
  };
  writeFileSync(resultPath, `${JSON.stringify(resultJson, null, 2)}\n`);
  return runDir;
}
