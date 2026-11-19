import type { ActResult, AppAdapter } from "./adapter.ts";
import type { GuardFailure, PredicateResult, Program, StepRecord } from "./program.ts";
import type { AppState } from "./state.ts";

export interface RunOutcome {
  program: string;
  completed: boolean;
  steps: StepRecord[];
  guardFailure?: GuardFailure;
  finalState: AppState | null;
}

function evaluatePredicates(
  predicates: {
    name: string;
    check: (s: AppState) => boolean;
    describe: (s: AppState) => string;
  }[],
  state: AppState,
): PredicateResult[] {
  return predicates.map((p) => ({
    predicateName: p.name,
    passed: p.check(state),
    observed: p.describe(state),
  }));
}

function describeAction(action: unknown): Record<string, unknown> {
  const rec = action as Record<string, unknown>;
  switch (rec.kind) {
    case "waitFor":
      return { kind: "waitFor", timeoutMs: rec.timeoutMs };
    default:
      return rec;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function runProgram(adapter: AppAdapter, program: Program): Promise<RunOutcome> {
  const steps: StepRecord[] = [];
  let state = await adapter.observe();

  for (let i = 0; i < program.steps.length; i++) {
    const step = program.steps[i];
    if (!step) throw new Error(`missing step ${i}`);
    const stateVersionBefore = state.stateVersion;
    const preconditionResults = evaluatePredicates(step.preconditions, state);
    const failedPre = preconditionResults.find((r) => !r.passed);
    if (failedPre) {
      const failure: GuardFailure = {
        step: i,
        phase: "precondition",
        predicateName: failedPre.predicateName,
        observed: failedPre.observed,
        reason: `precondition "${failedPre.predicateName}" not met before step ${i}`,
      };
      return {
        program: program.name,
        completed: false,
        steps,
        guardFailure: failure,
        finalState: state,
      };
    }

    let actResult: ActResult;
    try {
      actResult = await adapter.act(step.action);
    } catch (error) {
      const failure: GuardFailure = {
        step: i,
        phase: "precondition",
        predicateName: `act:${String(describeAction(step.action).kind)}`,
        observed: error instanceof Error ? error.message : String(error),
        reason: `action dispatch failed on step ${i}: ${error instanceof Error ? error.message : String(error)}`,
      };
      return {
        program: program.name,
        completed: false,
        steps,
        guardFailure: failure,
        finalState: state,
      };
    }

    if (step.action.kind === "waitFor") {
      const deadline = Date.now() + step.action.timeoutMs;
      let after = await adapter.observe();
      while (!step.action.predicate(after) && Date.now() < deadline) {
        await delay(10);
        after = await adapter.observe();
      }
      state = after;
    } else {
      state = await adapter.observe();
    }

    const postconditionResults = evaluatePredicates(step.postconditions, state);
    const failedPost = postconditionResults.find((r) => !r.passed);
    steps.push({
      step: i,
      action: describeAction(step.action) as StepRecord["action"],
      preconditionResults,
      postconditionResults,
      stateVersionBefore,
      stateVersionAfter: actResult.stateVersionAfter,
    });
    if (failedPost) {
      const failure: GuardFailure = {
        step: i,
        phase: "postcondition",
        predicateName: failedPost.predicateName,
        observed: failedPost.observed,
        reason: `postcondition "${failedPost.predicateName}" not met after step ${i}`,
      };
      return {
        program: program.name,
        completed: false,
        steps,
        guardFailure: failure,
        finalState: state,
      };
    }
  }

  return { program: program.name, completed: true, steps, finalState: state };
}
