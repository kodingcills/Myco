import type { ProgramAction } from "./adapter.ts";
import type { AppState } from "./state.ts";

export interface StatePredicate {
  name: string;
  check: (state: AppState) => boolean;
  describe: (state: AppState) => string;
}

export function predicate(
  name: string,
  check: (state: AppState) => boolean,
  describe: (state: AppState) => string,
): StatePredicate {
  return { name, check, describe };
}

export interface ProgramStep {
  action: ProgramAction;
  preconditions: StatePredicate[];
  postconditions: StatePredicate[];
  /** Marks the step whose side effect persists the work (e.g. save). */
  isSave?: boolean;
}

export interface Program {
  name: string;
  steps: ProgramStep[];
}

export interface PredicateResult {
  predicateName: string;
  passed: boolean;
  observed: string;
}

export interface StepRecord {
  step: number;
  action: ProgramAction;
  preconditionResults: PredicateResult[];
  postconditionResults: PredicateResult[];
  stateVersionBefore: number;
  stateVersionAfter: number;
}

export interface GuardFailure {
  step: number;
  phase: "precondition" | "postcondition";
  predicateName: string;
  observed: string;
  reason: string;
}
