import { randomUUID } from "node:crypto";
import type { AppAdapter } from "./adapter.ts";
import { type RunRecord, stepFromRecord, writeRunEvidence } from "./evidence.ts";
import { readCsvSpreadsheet } from "./filepersist.ts";
import type { Program } from "./program.ts";
import { type RunOutcome, runProgram } from "./runner.ts";
import type { PersistedState, TaskIntent, Verdict, Verifier } from "./verify.ts";

export interface FaultInjector {
  name: string;
  /** Runs before the trial starts. May mutate the fake app environment. */
  beforeTrial?(ctx: FaultContext): void;
  /** Runs right before the save step is dispatched. */
  beforeSave?(ctx: FaultContext): void;
}

export interface FaultContext {
  adapter: AppAdapter;
  taskParams: Record<string, unknown>;
  trialIndex: number;
}

export interface TaskFamily {
  taskId: string;
  intentFor(params: Record<string, unknown>): TaskIntent;
  programFor(adapter: AppAdapter, params: Record<string, unknown>): Program;
  /** Ground truth computed independently from params and the persisted file. */
  satisfiedBy(persisted: PersistedState, params: Record<string, unknown>): boolean;
}

export interface TrialResult {
  trialIndex: number;
  fault: string;
  programCompleted: boolean;
  verdict?: Verdict;
  groundTruthSatisfied: boolean;
  falseSuccess: boolean;
}

export interface EvalSummary {
  trials: number;
  succeeded: number;
  verified: number;
  falseSuccesses: number;
  recovered: number;
  results: TrialResult[];
}

export interface EvalConfig {
  adapterFor: (trialIndex: number) => AppAdapter;
  verifier: Verifier;
  family: TaskFamily;
  faults: FaultInjector[];
  trials: number;
  filePathFor: (trialIndex: number) => string;
  runsDir?: string;
}

export async function runEvaluation(config: EvalConfig): Promise<EvalSummary> {
  const results: TrialResult[] = [];
  for (let trial = 0; trial < config.trials; trial++) {
    results.push(await runTrial(config, trial));
  }
  const succeeded = results.filter((r) => r.programCompleted).length;
  const verified = results.filter((r) => r.verdict?.status === "verified").length;
  const falseSuccesses = results.filter((r) => r.falseSuccess).length;
  const recovered = results.filter(
    (r) => !r.programCompleted && r.verdict?.status !== "verified" && !r.falseSuccess,
  ).length;
  return { trials: config.trials, succeeded, verified, falseSuccesses, recovered, results };
}

async function runTrial(config: EvalConfig, trialIndex: number): Promise<TrialResult> {
  const params = { trial: trialIndex };
  const intent = config.family.intentFor(params);
  const filePath = config.filePathFor(trialIndex);
  const fault = config.faults[trialIndex % config.faults.length];
  if (!fault) throw new Error(`no fault for trial ${trialIndex}`);

  const adapter = config.adapterFor(trialIndex);
  const ctx: FaultContext = { adapter, taskParams: params, trialIndex };
  fault.beforeTrial?.(ctx);

  const program = config.family.programFor(adapter, params);
  const saveStepIndex = program.steps.findIndex((s) => s.isSave === true);
  let outcome: RunOutcome;
  try {
    if (saveStepIndex >= 0 && fault.beforeSave) {
      const pre = await runProgram(adapter, {
        name: `${program.name}#pre-save`,
        steps: program.steps.slice(0, saveStepIndex),
      });
      fault.beforeSave(ctx);
      const post = await runProgram(adapter, {
        name: `${program.name}#post-save`,
        steps: program.steps.slice(saveStepIndex),
      });
      outcome = {
        program: program.name,
        completed: pre.completed && post.completed,
        steps: [...pre.steps, ...post.steps],
        guardFailure: pre.guardFailure ?? post.guardFailure,
        finalState: post.finalState ?? pre.finalState,
      };
    } else {
      outcome = await runProgram(adapter, program);
    }
  } catch (error) {
    // an adapter that died mid-run is an interrupted trial, not a harness crash
    outcome = {
      program: program.name,
      completed: false,
      steps: [],
      guardFailure: {
        step: -1,
        phase: "precondition",
        predicateName: "adapter-available",
        observed: error instanceof Error ? error.message : String(error),
        reason: `adapter unusable during trial ${trialIndex}`,
      },
      finalState: null,
    };
  }

  let persisted: PersistedState;
  try {
    persisted = readCsvSpreadsheet(filePath);
  } catch {
    persisted = { kind: "csv", filePath, cells: {} };
  }
  const verdict = config.verifier.verify(persisted, intent);
  const groundTruthSatisfied = config.family.satisfiedBy(persisted, params);
  const falseSuccess = verdict.status === "verified" && !groundTruthSatisfied;

  if (config.runsDir) {
    const record: RunRecord = {
      runId: randomUUID(),
      taskId: intent.taskId,
      taskParams: params,
      startedAt: new Date().toISOString(),
      steps: outcome.steps.map(stepFromRecord),
      guardFailure: outcome.guardFailure,
      verdict,
    };
    writeRunEvidence(config.runsDir, record, {
      outcome: outcome.completed ? "completed" : "guardFailure",
      verdict,
      finalSummary: falseSuccess
        ? "FALSE SUCCESS: verifier verified but ground truth unsatisfied"
        : `verdict=${verdict.status}`,
    });
  }

  return {
    trialIndex,
    fault: fault.name,
    programCompleted: outcome.completed,
    verdict,
    groundTruthSatisfied,
    falseSuccess,
  };
}
