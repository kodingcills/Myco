import type { ActResult, AppAdapter } from "./adapter.ts";
import {
  type Action,
  AmbiguousTargetError,
  type ProgramAction,
  type TargetRef,
} from "./adapter.ts";
import type { GuardFailure, PredicateResult, Program, StepRecord } from "./program.ts";
import type { AppState } from "./state.ts";

export interface RunOutcome {
  program: string;
  completed: boolean;
  steps: StepRecord[];
  guardFailure?: GuardFailure;
  finalState: AppState | null;
  /**
   * Known-good point (ADR-0006): index of the last step whose postconditions
   * all held — the resume point for recovery. -1 means "before any step"
   * (only the initial observation held); null means never observed.
   */
  lastGoodStep: number | null;
  /** stateVersion of the state the known-good point was established on. */
  lastGoodStateVersion: number | null;
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
export interface RunProgramOptions {
  /**
   * Resume after this step index (recovery): steps 0..startStep are assumed
   * already executed — their actions are not re-dispatched and their records
   * are not re-created. Default: full run from step 0.
   */
  startStep?: number;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function runProgram(
  adapter: AppAdapter,
  program: Program,
  options: RunProgramOptions = {},
): Promise<RunOutcome> {
  const steps: StepRecord[] = [];
  let state = await adapter.observe();
  // Known-good point (ADR-0006): starts at the initial observation; advanced
  // to (step, stateVersion) each time a step's postconditions all hold.
  let lastGoodStep = -1;
  let lastGoodStateVersion = state.stateVersion;
  const startStep = options.startStep ?? 0;
  for (let i = startStep; i < program.steps.length; i++) {
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
        lastGoodStep,
        lastGoodStateVersion,
      };
    }

    let actResult: ActResult;
    try {
      actResult = await adapter.act(resolveAction(step.action, adapter));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: GuardFailure = {
        step: i,
        phase: "precondition",
        predicateName: `act:${String(describeAction(step.action).kind)}`,
        observed: message,
        reason: `action dispatch failed on step ${i}: ${message}`,
      };
      return {
        program: program.name,
        completed: false,
        steps,
        guardFailure: failure,
        finalState: state,
        lastGoodStep,
        lastGoodStateVersion,
      };
    }
    if (actResult.outcome === "failed") {
      const failure: GuardFailure = {
        step: i,
        phase: "precondition",
        predicateName: `act:${String(describeAction(step.action).kind)}`,
        observed: actResult.details,
        reason: `action dispatch failed on step ${i}: ${actResult.details}`,
      };
      return {
        program: program.name,
        completed: false,
        steps,
        guardFailure: failure,
        finalState: state,
        lastGoodStep,
        lastGoodStateVersion,
      };
    }

    // A mid-program app death (killed process, lost window) surfaces here as a
    // throwing observe(). It must become a structured guard failure carrying
    // the steps already executed — otherwise the evidence cannot distinguish
    // "died after the edit" from "never launched", which is exactly the
    // distinction recovery and the corrupted-trial audit depend on.
    try {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: GuardFailure = {
        step: i,
        phase: "postcondition",
        predicateName: "observe-after-action",
        observed: message,
        reason: `app became unobservable after step ${i}: ${message}`,
      };
      return {
        program: program.name,
        completed: false,
        steps,
        guardFailure: failure,
        finalState: state,
        lastGoodStep,
        lastGoodStateVersion,
      };
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
    if (!failedPost) {
      // All postconditions held: this is the new known-good point (ADR-0006).
      lastGoodStep = i;
      lastGoodStateVersion = state.stateVersion;
    }
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
        lastGoodStep,
        lastGoodStateVersion,
      };
    }
  }

  return {
    program: program.name,
    completed: true,
    steps,
    finalState: state,
    lastGoodStep,
    lastGoodStateVersion,
  };
}

function resolveAction(action: ProgramAction, adapter: AppAdapter): Action {
  const resolve = (ref: TargetRef): string => {
    if (typeof ref === "string") return ref;
    const issued = adapter.issueRef?.(ref.nodeId);
    if (issued === null || issued === undefined) {
      throw new AmbiguousTargetError(ref.nodeId, 0);
    }
    return issued;
  };
  switch (action.kind) {
    case "click":
    case "typeText":
    case "setValue":
      return { ...action, ref: resolve(action.ref) };
    default:
      return action;
  }
}
