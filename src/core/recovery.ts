/**
 * Recovery ladder (M1-011 / TIF-15, ADR-0006): re-observe → retry from the
 * known-good point → relaunch-and-resume for reversible operations → abort
 * with `uncertain` and the full trace. Recovery NEVER produces a verdict:
 * rungs only return a `RunOutcome`, and the caller's independent verifier
 * (ADR-0002) is the sole source of success. A lying verifier therefore
 * yields its own verdict; the ladder cannot fabricate one.
 *
 * Lives in core, not integration, because every rung operates on core
 * abstractions only (AppAdapter, Program, RunOutcome). Guest specifics
 * (relaunch, is-intent-satisfied, reversibility) are injected as hooks, so
 * the ladder is host-testable against the fake app and re-used by the live
 * trial path (src/integration/trial.ts).
 */

import type { AppAdapter } from "./adapter.ts";
import type { TraceEvent } from "./evidence.ts";
import type { Program } from "./program.ts";
import { type RunOutcome, type RunProgramOptions, runProgram } from "./runner.ts";

/** Recovery rungs, in ADR-0006 order. */
export type RecoveryRung = "re-observe" | "retry" | "relaunch";

/** One recovery attempt, emitted as an ADR-0007 `recovery` trace event. */
export interface RecoveryAttempt {
  rung: RecoveryRung;
  /** Why this rung was taken (e.g. "intent already satisfied"). */
  why: string;
  /** stateVersion the attempt resumed from (the known-good version). */
  stateVersion: number;
  /** Verbatim event name for the trace line, e.g. "re-observe:already-satisfied". */
  event: string;
}

export interface RecoveryHooks {
  /**
   * Cheap read-only intent check (re-observe rung): returns true when the
   * task's intent is already satisfied in the app's current state — e.g. the
   * UNO readback already shows the expected cell value AND the file was
   * persisted. Must not mutate anything.
   */
  intentSatisfied(): Promise<boolean>;
  /**
   * Relaunch the app (relaunch rung): bring the app back up at the state the
   * known-good point describes (for calc-record-edit: reopen the fixture).
   * Returns false when relaunch is impossible (relaunching does not count as
   * success and recovery falls through to abort).
   */
  relaunch(): Promise<boolean>;
}

export interface RecoveryOptions {
  /** Max retry attempts of the failed step from the known-good point. */
  maxRetries?: number;
  /**
   * Whether the operation is still reversible at the failure point — false
   * once a save has been dispatched (the edit is on disk; redoing the edit
   * could double-apply or mask a partial save). When false, the relaunch
   * rung is skipped: abort with `uncertain`, never silently redo.
   */
  isReversible(): boolean;
}

export interface RecoveryResult {
  /** Outcome whose steps/known-good point reflect ALL attempts (old + new). */
  outcome: RunOutcome;
  /** Every recovery attempt, in order — emitted as trace events by callers. */
  attempts: RecoveryAttempt[];
  /**
   * True when rung (a) found the intent already satisfied: the program is
   * considered done (idempotent resume, no retry). The caller still MUST
   * run the verifier — this flag is evidence, not a verdict.
   */
  alreadySatisfied: boolean;
}

/**
 * Run the ADR-0006 ladder against a failed `RunOutcome`.
 *
 * The returned `RunOutcome.steps` concatenates the original run's steps with
 * the resume run's (a resume re-executes steps after the known-good point,
 * so the union is the full executed-program evidence). When no rung applies
 * or every rung fails, the original outcome is returned unchanged.
 */
export async function runRecovery(
  adapter: AppAdapter,
  program: Program,
  failed: RunOutcome,
  hooks: RecoveryHooks,
  options: RecoveryOptions,
): Promise<RecoveryResult> {
  const attempts: RecoveryAttempt[] = [];
  const maxRetries = options.maxRetries ?? 2;
  const knownGoodStep = failed.lastGoodStep ?? -1;
  const knownGoodStateVersion = failed.lastGoodStateVersion ?? 0;

  // ---- Rung (a): re-observe. Idempotent resume — no retry. ----------------
  try {
    if (await hooks.intentSatisfied()) {
      attempts.push({
        rung: "re-observe",
        why: "intent already satisfied",
        stateVersion: knownGoodStateVersion,
        event: "re-observe:already-satisfied",
      });
      return { outcome: { ...failed, completed: true }, attempts, alreadySatisfied: true };
    }
  } catch {
    // Could not look: fall through to retry — never guess satisfied.
    attempts.push({
      rung: "re-observe",
      why: "intent check failed (could not look)",
      stateVersion: knownGoodStateVersion,
      event: "re-observe:check-failed",
    });
  }

  // ---- Rung (b): retry the failed step(s) from the known-good point. ------
  let latest = failed;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const resume: RunProgramOptions = { startStep: knownGoodStep + 1 };
    let retried: RunOutcome;
    try {
      retried = await runProgram(adapter, program, resume);
    } catch (error) {
      // runProgram's own observe threw before any step: adapter still dead.
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        rung: "retry",
        why: `retry attempt ${attempt} failed: ${message}`,
        stateVersion: knownGoodStateVersion,
        event: `retry:${attempt}-failed`,
      });
      continue;
    }
    latest = mergeOutcomes(failed, retried, knownGoodStep);
    if (retried.completed) {
      attempts.push({
        rung: "retry",
        why: `retry attempt ${attempt} completed from step ${knownGoodStep + 1}`,
        stateVersion: knownGoodStateVersion,
        event: `retry:${attempt}-completed`,
      });
      return { outcome: latest, attempts, alreadySatisfied: false };
    }
    attempts.push({
      rung: "retry",
      why: `retry attempt ${attempt} failed: ${retried.guardFailure?.reason ?? "unknown"}`,
      stateVersion: knownGoodStateVersion,
      event: `retry:${attempt}-failed`,
    });
    // A retry that already satisfied the intent mid-way: check once more
    // before burning the remaining attempts (cheap, read-only).
    try {
      if (await hooks.intentSatisfied()) {
        attempts.push({
          rung: "re-observe",
          why: "intent already satisfied after retry",
          stateVersion: retried.lastGoodStateVersion ?? knownGoodStateVersion,
          event: "re-observe:already-satisfied",
        });
        return { outcome: { ...latest, completed: true }, attempts, alreadySatisfied: true };
      }
    } catch {
      // could not look — continue
    }
  }

  // ---- Rung (c): app dead → relaunch and resume. --------------------------
  if (options.isReversible()) {
    let relaunched = false;
    try {
      relaunched = await hooks.relaunch();
    } catch {
      relaunched = false;
    }
    if (relaunched) {
      attempts.push({
        rung: "relaunch",
        why: `app relaunched; resuming from step ${knownGoodStep + 1}`,
        stateVersion: knownGoodStateVersion,
        event: "relaunch:resumed",
      });
      try {
        const resumed = await runProgram(adapter, program, { startStep: knownGoodStep + 1 });
        latest = mergeOutcomes(failed, resumed, knownGoodStep);
        if (resumed.completed) {
          attempts.push({
            rung: "relaunch",
            why: "resumed run completed",
            stateVersion: knownGoodStateVersion,
            event: "relaunch:completed",
          });
          return { outcome: latest, attempts, alreadySatisfied: false };
        }
        attempts.push({
          rung: "relaunch",
          why: `resumed run failed: ${resumed.guardFailure?.reason ?? "unknown"}`,
          stateVersion: knownGoodStateVersion,
          event: "relaunch:failed",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({
          rung: "relaunch",
          why: `resumed run failed: ${message}`,
          stateVersion: knownGoodStateVersion,
          event: "relaunch:failed",
        });
      }
    } else {
      attempts.push({
        rung: "relaunch",
        why: "relaunch failed",
        stateVersion: knownGoodStateVersion,
        event: "relaunch:failed",
      });
    }
  } else {
    attempts.push({
      rung: "relaunch",
      why: "not reversible (save already dispatched): no silent redo",
      stateVersion: knownGoodStateVersion,
      event: "relaunch:skipped-not-reversible",
    });
  }

  // ---- Rung (d): abort with uncertain — the caller records the full trace.
  return { outcome: latest, attempts, alreadySatisfied: false };
}

/**
 * Merge a resume run into the original outcome: the original's steps up to
 * the known-good point are kept; the resume run's records continue after
 * them. (Both runs use absolute step indices, so records align directly.)
 */
function mergeOutcomes(
  original: RunOutcome,
  resumed: RunOutcome,
  knownGoodStep: number,
): RunOutcome {
  const keptSteps = original.steps.filter((s) => s.step <= knownGoodStep);
  return {
    program: original.program,
    completed: resumed.completed,
    steps: [...keptSteps, ...resumed.steps],
    guardFailure: resumed.completed ? undefined : resumed.guardFailure,
    finalState: resumed.finalState,
    lastGoodStep: resumed.lastGoodStep,
    lastGoodStateVersion: resumed.lastGoodStateVersion,
  };
}

/** Render recovery attempts as ADR-0007 `recovery` trace events. */
export function recoveryTraceEvents(attempts: RecoveryAttempt[]): TraceEvent[] {
  return attempts.map((a) => ({
    type: "recovery" as const,
    timestamp: new Date().toISOString(),
    event: a.event,
    stateVersion: a.stateVersion,
  }));
}
