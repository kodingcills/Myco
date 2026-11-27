/**
 * TIF-268 - how the `hcu+shell` planner classes a headless Claude Code call. It halts on every
 * class except an explicit per-trial list (`PER_TRIAL_CLASSES`), so a class added later can only
 * stop the run, never slip through as a per-trial failure (round 2, verifier D1).
 *
 * ONE CLASSIFIER (round 4; lead rulings 03:58Z and 05:39Z). This module holds no vocabulary,
 * no whitespace fold and no structured-class table of its own: every decision is the myco-gate
 * arm's merged classifier (#598 + #607), imported from `src/pilot/claude-cli.ts`, the
 * dependency-free module `src/pilot/claude-transport.ts` re-exports it from (the very same
 * functions, pinned by `test/pilot/claude-cli.test.ts`), so this arm does not load the pilot
 * runner, which reaches Myco's gate and the benchmark grader.
 *  - A call that did not complete normally: `classOfUncleanRun` (no result event: stdout and
 *    stderr, so quota wording on plain stdout halts; an error result: its text, `errors[]` and
 *    stderr; an unmapped structured error falls back to the text, #607 B2).
 *  - A clean call with no valid decision: `classOfClaimlessCleanResult` on its text AND stderr
 *    (#606 S1), with Unicode whitespace, format characters and hyphen variants folded (#606 S2,
 *    #607 F-A), the usage-limit vocabulary including "You've hit your limit" (#607 B1) and the
 *    narrow, numberless billing and auth phrases (#607 L1). A valid decision plays the part the
 *    myco-gate arm's `DONE` / `NOT DONE` claim line plays: it is never reclassified
 *    (`planner.ts`).
 *
 * Lead ruling 2026-11-27 02:18Z (on #597 and #598): the subscription's own quota wording stops
 * the run at once with its own code (exit 7), no retry, no attempt spent, reported to the lead.
 * Only a transient 429 / 529 / overloaded backs off, bounded.
 */

import {
  apiKeySourceProblem,
  classOfClaimlessCleanResult,
  classOfUncleanRun,
} from "../../pilot/claude-cli.ts";
import type { PilotHarnessClass } from "../../pilot/ledger.ts";

/** Every class the shared classifier can name for a planner call. */
export type SubscriptionFaultClass = PilotHarnessClass;

/** The only classes that are a per-trial failure; every other class halts the run. */
export const PER_TRIAL_CLASSES: ReadonlySet<SubscriptionFaultClass> = new Set([
  "error-result",
  "transport-error",
]);

/**
 * The class of a call that did NOT complete normally, or null when it completed normally (a
 * clean result: its text is the agent's). `result` is the last result event (null when there
 * is none); `stdout` is the raw stdout, parseable or not.
 */
export function failedCallClass(
  messages: readonly Record<string, unknown>[],
  result: Record<string, unknown> | null,
  stderr: string,
  stdout: string,
  code: number | null,
): SubscriptionFaultClass | null {
  return classOfUncleanRun(messages, result, stdout, stderr, code);
}

/**
 * The fault class of a clean call with NO valid decision, from its text and stderr together,
 * or null when it is the agent's turn. Never called for a call with a valid decision.
 */
export function undecidedCleanCallClass(
  text: string,
  stderr: string,
): SubscriptionFaultClass | null {
  return classOfClaimlessCleanResult(`${text}\n${stderr}`);
}

/**
 * The myco-gate arm's `apiKeySourceProblem`: any message naming an `apiKeySource` other than
 * `none` means the CLI is billing an API key, whatever the call's outcome.
 */
export function reportsApiKeySource(messages: readonly Record<string, unknown>[]): boolean {
  return apiKeySourceProblem(messages) !== null;
}
