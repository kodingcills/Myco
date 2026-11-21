/**
 * TIF-57 EF-004 — blind scoring.
 *
 * Order is the whole mechanism: read persisted state, produce the oracle verdict,
 * and only then attach the system-under-test's self-report. If the transcript were
 * consulted first, a grader could rationalise a refuted state verdict into a pass —
 * which is precisely the failure M1 exists to kill.
 *
 * This module is startable before EF-004 is unblocked because it is pure: it scores
 * bytes, a screen view, and a trace, and needs no VM.
 */

import { checkTrace } from "../guard.ts";
import { compositeVerdict, observeScreenClaims } from "../screen.ts";
import type {
  ActualState,
  FixtureManifest,
  FoundryTrialResult,
  GuardTraceEvent,
  ScreenView,
  TaskIntent,
} from "../types.ts";
import { oracleForApp, verifyFixture } from "./state.ts";

export interface TrialInput {
  /** Zero denotes a trial without injected faults. */
  readonly faultVersion?: number;
  readonly fixture: FixtureManifest;
  readonly intent: TaskIntent;
  /** What the app persisted after the run. */
  readonly actual: ActualState;
  /** What an agent could read on screen at the end. */
  readonly screen: ScreenView;
  /** The evidence stream the runtime emitted. */
  readonly trace: readonly GuardTraceEvent[];
  /** The system-under-test's own claim. Attached LAST (see below). */
  readonly selfReport: { readonly claimsSuccess: boolean; readonly text: string };
}

/**
 * Scores one trial. The self-report is read only after the state and screen verdicts
 * exist, and it can only ever turn a `verified` into a `falseSuccess=false` (it is the
 * one case where a claim of failure with a verified state deserves a note, not a reward).
 */
export function scoreTrial(input: TrialInput): FoundryTrialResult {
  // 1. Persisted state. Cannot see the screen or the transcript.
  const stateVerdict = verifyFixture(input.fixture, input.intent, input.actual);

  // 2. Screen. Cannot see parsed state.
  const claims = observeScreenClaims(input.fixture, input.screen);

  // 3. Trace guard. Can only refute a run, never pass one.
  const guard = checkTrace(input.fixture, input.trace, input.actual.files);

  // 4. Fold, then attach the transcript's claim.
  const composite = compositeVerdict(stateVerdict.status, claims);
  const verdict = composite.verdict;
  const falseSuccess = verdict !== "verified" && input.selfReport.claimsSuccess;

  const reasons: string[] = [...stateVerdict.reasons, ...composite.reasons];
  if (
    guard.status === "file-io-shortcut" ||
    guard.status === "unreconciled-change" ||
    guard.status === "not-launched"
  ) {
    reasons.push(`trace guard: ${guard.status} — ${guard.reasons.join("; ")}`);
    if (verdict === "verified") {
      reasons.push("result refused: the change cannot be explained by GUI acts");
    }
  }
  if (falseSuccess) {
    reasons.push(
      "FALSE SUCCESS: the agent claimed success; persisted state does not satisfy the intent",
    );
  }

  const refusedByGuard = verdict === "verified" && guard.status !== "clean";
  return {
    fixtureId: input.fixture.fixtureId,
    fixtureVersion: input.fixture.version,
    oracleVersion: oracleForApp(input.fixture.app).version,
    faultVersion: input.faultVersion ?? 0,
    verdict: refusedByGuard ? "refuted" : verdict,
    falseSuccess,
    stateChecks: stateVerdict.checks,
    screenClaims: claims ?? [],
    traceGuard: guard,
    reasons,
  };
}

/**
 * Aggregates trial results into the report block EF-004 requires. `falseSuccessRate`
 * is deliberately computed over *trials that produced a verdict* rather than over all
 * trials: hiding an unreadable trial in the denominator is the same disease as a UI
 * that reports "saved" without knowing.
 */
export interface ScoreSummary {
  readonly trials: number;
  readonly verified: number;
  readonly refuted: number;
  readonly uncertain: number;
  readonly falseSuccesses: number;
  readonly uiClaimMismatches: number;
  readonly guardRefusals: number;
  readonly version: {
    readonly fixtureVersions: readonly number[];
    readonly oracleVersions: readonly number[];
    readonly faultVersions: readonly number[];
  };
}

export function summarise(results: readonly FoundryTrialResult[]): ScoreSummary {
  if (results.some((r) => !Number.isInteger(r.faultVersion) || r.faultVersion < 0)) {
    throw new Error("A score requires a valid faultVersion");
  }
  const fixtureVersions = [...new Set(results.map((r) => r.fixtureVersion))].sort();
  const oracleVersions = [...new Set(results.map((r) => r.oracleVersion))].sort();
  const faultVersions = [...new Set(results.map((r) => r.faultVersion))].sort();
  return {
    trials: results.length,
    verified: results.filter((r) => r.verdict === "verified").length,
    refuted: results.filter((r) => r.verdict === "refuted").length,
    uncertain: results.filter((r) => r.verdict === "uncertain").length,
    falseSuccesses: results.filter((r) => r.falseSuccess).length,
    uiClaimMismatches: results.filter((r) => r.screenClaims.length > 0 && r.verdict === "verified")
      .length,
    guardRefusals: results.filter(
      (r) =>
        r.traceGuard.status === "file-io-shortcut" || r.traceGuard.status === "unreconciled-change",
    ).length,
    version: { fixtureVersions, oracleVersions, faultVersions },
  };
}

/** Ledger accounting uses persisted evidence, not the agent's claim, to establish failure. */
export function faultLedgerRow(
  result: FoundryTrialResult,
  fault: string,
  claimsSuccess: boolean,
  trialIndex: number,
) {
  const wrong = result.stateChecks.some((check) => check.passed === false);
  return {
    evalId: "foundry-faults",
    runId: `fault-${fault}-${trialIndex}`,
    trialIndex,
    corruptionClass: fault,
    actionKind: "save",
    state: result.verdict === "verified" ? "pass" : wrong ? "failure" : "uncertain",
    oracle:
      wrong && claimsSuccess
        ? "ground-truth:false"
        : result.verdict === "verified"
          ? "verifier:verified+ground-truth"
          : wrong
            ? "ground-truth:refuted"
            : "ground-truth:uncertain",
    refusalCode: null,
  };
}
