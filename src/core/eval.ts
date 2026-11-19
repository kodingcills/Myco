import { randomUUID } from "node:crypto";
import type { AppAdapter } from "./adapter.ts";
import {
  type LedgerRow,
  type RunRecord,
  type ScoredVerdict,
  stepFromRecord,
  type TraceEvent,
  writeLedgerRows,
  writeRunEvidence,
} from "./evidence.ts";
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
  /**
   * M1-012 / ADR-0008: fraction of trials whose intent was satisfied
   * according to host-side ground truth — never conflated with check pass rate.
   */
  successRate: number;
  /** Fraction of verdict checks passed across all scored trials. */
  checkPassRate: number;
  /** Ledger accounting for the emitted conformance ledger, when runsDir is set. */
  ledger?: {
    evalId: string;
    rows: number;
    pass: number;
    refusal: number;
    failure: number;
    gap: number;
    uncertain: number;
    unaccounted: number;
  };
}

export interface EvalConfig {
  adapterFor: (trialIndex: number) => AppAdapter;
  verifier: Verifier;
  family: TaskFamily;
  faults: FaultInjector[];
  trials: number;
  filePathFor: (trialIndex: number) => string;
  runsDir?: string;
  /** Stable eval identifier for run directories and the ledger; defaults to a UUID. */
  evalId?: string;
}

/** Wrap a verifier verdict as a single-check scored verdict. */
function scoreVerdict(verdict: Verdict, oracleName: string): ScoredVerdict {
  if (verdict.status === "verified") {
    return {
      status: "verified",
      checks: [
        {
          name: oracleName,
          passed: true,
          reason: verdict.reasons.join("; "),
          partial_score: { score: 1, weight: 1, description: oracleName },
        },
      ],
      score: 1,
      reasons: verdict.reasons,
    };
  }
  if (verdict.status === "refuted") {
    return {
      status: "refuted",
      checks: [
        {
          name: oracleName,
          passed: false,
          reason: verdict.reasons.join("; "),
          partial_score: { score: 0, weight: 1, description: oracleName },
        },
      ],
      score: 0,
      reasons: verdict.reasons,
    };
  }
  // ADR-0002: could-not-look is never collapsed into pass or fail
  return {
    status: "uncertain",
    checks: [
      {
        name: oracleName,
        passed: null,
        reason: verdict.reasons.join("; "),
        partial_score: { score: 0, weight: 1, description: oracleName },
      },
    ],
    score: 0,
    reasons: verdict.reasons,
  };
}

function countCheckPasses(scored: ScoredVerdict): number {
  return scored.checks.filter((check) => check.passed === true).length;
}

function countChecks(scored: ScoredVerdict): number {
  return scored.checks.length;
}

/**
 * Ledger state for a trial. `gap` is reserved for trials where neither the
 * program nor the verifier could exercise the action kind at all (e.g. the
 * adapter was already dead before the first action) — it is never counted
 * as a pass (ADR-0007).
 */
function ledgerStateFor(
  programCompleted: boolean,
  verdict: Verdict,
  groundTruthSatisfied: boolean,
  falseSuccess: boolean,
): LedgerRow["state"] {
  if (verdict.status === "uncertain") return "uncertain";
  if (falseSuccess) return "failure";
  if (verdict.status === "verified" && groundTruthSatisfied) return "pass";
  if (!programCompleted && verdict.status === "refuted") return "refusal";
  if (verdict.status === "refuted") return "failure";
  if (!programCompleted) return "gap";
  return "failure";
}

function refusalCodeFor(state: LedgerRow["state"], verdict: Verdict): string | null {
  if (state !== "refusal") return null;
  const reason = verdict.reasons[0] ?? "refused";
  return `guard:${reason.slice(0, 80)}`;
}

export async function runEvaluation(config: EvalConfig): Promise<EvalSummary> {
  const evalId = config.evalId ?? randomUUID();
  const results: TrialResult[] = [];
  const ledgerRows: LedgerRow[] = [];
  const scoredVerdicts: ScoredVerdict[] = [];

  for (let trial = 0; trial < config.trials; trial++) {
    const result = await runTrial(config, trial, evalId, ledgerRows, scoredVerdicts);
    results.push(result.trialResult);
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
  const intentSatisfied = results.filter((r) => r.groundTruthSatisfied).length;
  const checkPasses = scoredVerdicts.reduce((sum, v) => sum + countCheckPasses(v), 0);
  const totalChecks = scoredVerdicts.reduce((sum, v) => sum + countChecks(v), 0);

  const summary: EvalSummary = {
    trials: config.trials,
    succeeded,
    verified,
    uncertain,
    falseSuccesses,
    recovered,
    results,
    successRate: config.trials > 0 ? intentSatisfied / config.trials : 0,
    checkPassRate: totalChecks > 0 ? checkPasses / totalChecks : 0,
  };

  if (config.runsDir) {
    const counts = { pass: 0, refusal: 0, failure: 0, gap: 0, uncertain: 0 };
    for (const row of ledgerRows) {
      counts[row.state] += 1;
    }
    summary.ledger = {
      evalId,
      rows: ledgerRows.length,
      pass: counts.pass,
      refusal: counts.refusal,
      failure: counts.failure,
      gap: counts.gap,
      uncertain: counts.uncertain,
      unaccounted:
        ledgerRows.length -
        (counts.pass + counts.refusal + counts.failure + counts.gap + counts.uncertain),
    };
    writeLedgerRows(config.runsDir, evalId, ledgerRows);
  }

  return summary;
}

async function runTrial(
  config: EvalConfig,
  trialIndex: number,
  evalId: string,
  ledgerRows: LedgerRow[],
  scoredVerdicts: ScoredVerdict[],
): Promise<{ trialResult: TrialResult }> {
  const params = { trial: trialIndex };
  const intent = config.family.intentFor(params);
  const filePath = config.filePathFor(trialIndex);
  const fault = config.faults[trialIndex % config.faults.length];
  if (!fault) throw new Error(`no fault for trial ${trialIndex}`);

  const adapter = config.adapterFor(trialIndex);
  const ctx: FaultContext = { adapter, taskParams: params, trialIndex };
  const traceEvents: TraceEvent[] = [];
  if (fault.beforeTrial) {
    fault.beforeTrial(ctx);
    traceEvents.push({
      type: "fault-injection",
      timestamp: new Date().toISOString(),
      fault: fault.name,
      detail: "beforeTrial",
    });
  }

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
      traceEvents.push({
        type: "fault-injection",
        timestamp: new Date().toISOString(),
        fault: fault.name,
        detail: "beforeSave",
      });
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
    const scored = scoreVerdict(resolvedVerdict, `${config.family.taskId}:intent-check`);
    scoredVerdicts.push(scored);
    const record: RunRecord = {
      runId: randomUUID(),
      taskId: intent.taskId,
      taskParams: params,
      startedAt: new Date().toISOString(),
      steps: outcome.steps.map(stepFromRecord),
      guardFailure: outcome.guardFailure,
      verdict: scored,
      unresolvedState: couldNotLook ? "persisted state unreadable" : undefined,
    };
    writeRunEvidence(config.runsDir, record, traceEvents);

    // One ledger row per (trial, corruption-class, action-kind): the program's
    // action kinds exercised in this trial, with verdict as the oracle.
    const actionKinds = new Set(
      outcome.steps.map((s) => String((s.action as Record<string, unknown>).kind)),
    );
    if (actionKinds.size === 0) {
      // the adapter died before the first action landed — a genuine gap
      actionKinds.add("none");
    }
    const state = ledgerStateFor(
      outcome.completed,
      resolvedVerdict,
      groundTruthSatisfied,
      falseSuccess,
    );
    const refusalCode = refusalCodeFor(state, resolvedVerdict);
    for (const actionKind of actionKinds) {
      ledgerRows.push({
        evalId,
        runId: record.runId,
        trialIndex,
        corruptionClass: fault.name,
        actionKind,
        state,
        oracle: falseSuccess
          ? "ground-truth:false"
          : groundTruthSatisfied && resolvedVerdict.status === "verified"
            ? "verifier:verified+ground-truth"
            : `verifier:${resolvedVerdict.status}`,
        refusalCode,
        detail: falseSuccess
          ? "FALSE SUCCESS: verifier verified but ground truth unsatisfied"
          : `verdict=${resolvedVerdict.status}`,
      });
    }
  }

  return {
    trialResult: {
      trialIndex,
      fault: fault.name,
      programCompleted: outcome.completed,
      verdict: resolvedVerdict,
      groundTruthSatisfied,
      falseSuccess,
    },
  };
}
