import { randomUUID } from "node:crypto";
import type { AppAdapter } from "./adapter.ts";
import { type RunRecord, stepFromRecord, writeRunEvidence } from "./evidence.ts";
import { PersistedStateReadError, readCsvSpreadsheet } from "./filepersist.ts";
import type { Program } from "./program.ts";
import { type RunOutcome, runProgram } from "./runner.ts";
import type { PersistedState, TaskIntent, Verdict, Verifier } from "./verify.ts";

export interface FaultInjector {
  name: string;
  /** Runs before the trial starts. May mutate the fake app environment. */
  beforeTrial?(ctx: FaultContext): void;
  /** Runs right before the save step is dispatched. */
  beforeSave?(ctx: FaultContext): void;
  /** Runs after the program finishes, before the verifier reads persisted state. */
  afterProgram?(ctx: FaultContext): void;
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
  uncertain: number;
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
  const uncertain = results.filter((r) => r.verdict?.status === "uncertain").length;
  const recovered = results.filter(
    (r) =>
      !r.programCompleted &&
      r.verdict?.status !== "verified" &&
      r.verdict?.status !== "uncertain" &&
      !r.falseSuccess,
  ).length;
  return {
    trials: config.trials,
    succeeded,
    verified,
    uncertain,
    falseSuccesses,
    recovered,
    results,
  };
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

  fault.afterProgram?.(ctx);

  let persisted: PersistedState;
  let verdict: Verdict | undefined;
  try {
    persisted = readCsvSpreadsheet(filePath);
  } catch (error) {
    // ADR-0002: could not look is `uncertain`, never an empty-state refute
    const detail =
      error instanceof PersistedStateReadError
        ? error.message
        : `unexpected error reading ${filePath}`;
    verdict = {
      status: "uncertain",
      reasons: [`could not look: persisted state unreadable — ${detail}`],
    };
    persisted = { kind: "csv", filePath, cells: {} };
  }
  if (verdict === undefined) {
    verdict = config.verifier.verify(persisted, intent);
  }
  const resolvedVerdict: Verdict = verdict;
  const couldNotLook = resolvedVerdict.status === "uncertain";
  const groundTruthSatisfied = couldNotLook ? false : config.family.satisfiedBy(persisted, params);
  const falseSuccess = resolvedVerdict.status === "verified" && !groundTruthSatisfied;

  if (config.runsDir) {
    const record: RunRecord = {
      runId: randomUUID(),
      taskId: intent.taskId,
      taskParams: params,
      startedAt: new Date().toISOString(),
      steps: outcome.steps.map(stepFromRecord),
      guardFailure: outcome.guardFailure,
      verdict: resolvedVerdict,
    };
    writeRunEvidence(config.runsDir, record, {
      outcome: outcome.completed ? "completed" : "guardFailure",
      verdict: resolvedVerdict,
      finalSummary: falseSuccess
        ? "FALSE SUCCESS: verifier verified but ground truth unsatisfied"
        : `verdict=${resolvedVerdict.status}`,
    });
  }

  return {
    trialIndex,
    fault: fault.name,
    programCompleted: outcome.completed,
    verdict: resolvedVerdict,
    groundTruthSatisfied,
    falseSuccess,
  };
}
