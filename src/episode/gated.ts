/**
 * Writer hook for the gated trial path (`runGatedTrial`, `src/gate/gated-trial.ts`): run the
 * trial exactly as before and save its episode, whatever it ended in.
 *
 * The gate is not touched: this wraps the call and the transport. The transport wrapper only
 * observes (it tees the capture to read the persisted document, and notes whether the agent
 * run or the capture threw); the gate's inputs, its binding and its verdict are unchanged,
 * and the episode is written AFTER the gate decided, from its result. An episode that cannot
 * be written never changes the trial's outcome: a refusal (unclean) is logged in the store by
 * code and returned; any other error while building or writing it (a store I/O error, a
 * throwing caller callback) is caught and returned as `{ status: "error" }` beside the outcome.
 *
 * Outcome labels:
 *  - the launch audit refused the plan: `launch-refused` (the agent never ran);
 *  - `runGatedTrial` threw: `harness-fault`, and the original error is re-thrown (an error
 *    saving the episode never replaces it). The class is `transport-error` when the
 *    transport's `runAgent` threw, `capture-error` when its `captureAfterStop` threw, and
 *    `harness-error` for any other throw (e.g. the vault refusing a captured file name);
 *  - the gate decided with a harness reason code (the codes `src/benchmark/gated-rows.ts`
 *    classes as harness): `harness-fault` / `gate-harness-code`, never an agent outcome;
 *  - the caller declares a harness fault (`harnessFault`, e.g. from its trial-ops row):
 *    `harness-fault` with that class;
 *  - otherwise the gate's verdict: `verified`, `refuted` or `uncertain` (labelled as such).
 *
 * Ground truth is the INDEPENDENT grader's (`groundTruth` callback, e.g. `gradeCalcRecordEdit`
 * in `ground-truth.ts`), handed the captured document only; the gate's result is never passed
 * to it. When the captured document was withheld as unclean, the grader is not called and
 * ground truth is `document-withheld`.
 */
import type { ReasonCode } from "../gate/api.ts";
import {
  type GatedTrialOptions,
  type GatedTrialOutcome,
  runGatedTrial,
} from "../gate/gated-trial.ts";
import type { EpisodeDraft } from "./build.ts";
import { EpisodeRecorder, type FrameRedactor } from "./recorder.ts";
import type { EpisodeStore, WriteResult } from "./store.ts";
import type {
  AgentClaim,
  AttemptLedgerRef,
  EpisodeFaultClass,
  EpisodeGroundTruth,
  EpisodeHarness,
  EpisodeTask,
} from "./types.ts";

/** Gate reason codes that mean the harness could not deliver (mirrors gated-rows' HARNESS_CODES). */
export const HARNESS_REASON_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "STATE_MISSING",
  "STATE_UNREADABLE",
  "AUDIT_FAILED",
  "FIXTURE_UNREADABLE",
  "FIXTURE_MISMATCH",
]);

export interface EpisodeCapture {
  readonly store: EpisodeStore;
  /** The task's public description (ids and hashes; the instruction text when known). */
  readonly task: Omit<EpisodeTask, "family">;
  readonly harness: Omit<EpisodeHarness, "corrections" | "fault" | "cost" | "flags" | "timing"> & {
    readonly cost?: Partial<Omit<EpisodeHarness["cost"], "basis">>;
    readonly flags?: Partial<EpisodeHarness["flags"]>;
    readonly timing?: Partial<EpisodeHarness["timing"]>;
  };
  readonly trialKey: string | null;
  readonly simulated: boolean;
  /** The agent's final claim, read by the harness after the agent stopped. */
  claim(): AgentClaim;
  /** The independent grader's result on the captured document (null bytes: none captured). */
  groundTruth?(persisted: Uint8Array | null): EpisodeGroundTruth;
  /** A harness fault the caller saw (its trial-ops row), if any. */
  readonly harnessFault?: { readonly class: EpisodeFaultClass; readonly code: string | null };
  /** The attempt ledger's head after this attempt's end event (lands with #518). */
  attemptLedger?(): AttemptLedgerRef | null;
  /** The recorder the transport records actions and frames into (one is made if absent). */
  readonly recorder?: EpisodeRecorder;
  readonly frameRedactor?: FrameRedactor;
  /** MIME type of the persisted state file (default text/csv). */
  readonly persistedMediaType?: "text/csv" | "application/json";
}

/** The store's result, or the error that kept the episode from being built or written. */
export type EpisodeSaveResult = WriteResult | { readonly status: "error"; readonly error: unknown };

export interface GatedTrialWithEpisode {
  readonly outcome: GatedTrialOutcome;
  readonly episode: EpisodeSaveResult;
}

export async function runGatedTrialWithEpisode(
  opts: GatedTrialOptions,
  capture: EpisodeCapture,
): Promise<GatedTrialWithEpisode> {
  const recorder =
    capture.recorder ??
    new EpisodeRecorder(capture.frameRedactor ? { frameRedactor: capture.frameRedactor } : {});
  const entry = opts.tasks.get(opts.taskId);
  const stateFile = entry?.stateFile;
  // Written from inside the transport wrapper (closures), so held in one object.
  const seen: {
    persisted: Uint8Array | null;
    persistedKept: boolean;
    agentRan: boolean;
    fault: { class: EpisodeFaultClass; code: string | null } | null;
  } = { persisted: null, persistedKept: false, agentRan: false, fault: null };
  const transport: GatedTrialOptions["transport"] = {
    async runAgent(plan, gate) {
      seen.agentRan = true;
      try {
        await opts.transport.runAgent(plan, gate);
      } catch (error) {
        seen.fault = { class: "transport-error", code: null };
        throw error;
      }
    },
    async captureAfterStop() {
      let input: Awaited<ReturnType<GatedTrialOptions["transport"]["captureAfterStop"]>>;
      try {
        input = await opts.transport.captureAfterStop();
      } catch (error) {
        seen.fault = { class: "capture-error", code: null };
        throw error;
      }
      const bytes = stateFile === undefined ? undefined : input[`persisted/${stateFile}`];
      if (bytes !== undefined) {
        seen.persisted = Uint8Array.from(bytes);
        seen.persistedKept = recorder.state(
          "persisted",
          capture.persistedMediaType ?? "text/csv",
          seen.persisted,
        );
      }
      return input;
    },
  };

  const family = entry?.family.id ?? "unknown";
  // Never throws: the trial's outcome (or its original error) must reach the caller whatever
  // happens to the episode. The draft is a thunk so a throwing callback is caught too.
  const save = (
    makeDraft: () => Pick<EpisodeDraft, "outcome" | "gate" | "groundTruth"> & {
      fault: EpisodeHarness["fault"];
      corrections: "on" | "off";
    },
  ): EpisodeSaveResult => {
    try {
      return write(makeDraft());
    } catch (error) {
      return { status: "error", error };
    }
  };
  const write = (
    draft: Pick<EpisodeDraft, "outcome" | "gate" | "groundTruth"> & {
      fault: EpisodeHarness["fault"];
      corrections: "on" | "off";
    },
  ): WriteResult => {
    const snap = recorder.snapshot();
    const { cost, flags, timing, ...harness } = capture.harness;
    return capture.store.record(
      {
        outcome: draft.outcome,
        simulated: capture.simulated,
        task: { ...capture.task, family },
        actions: snap.actions,
        observations: snap.observations,
        agentClaim: seen.agentRan ? capture.claim() : "no-claim",
        gate: draft.gate,
        groundTruth: draft.groundTruth,
        harness: {
          ...harness,
          corrections: draft.corrections,
          fault: draft.fault,
          ...(cost ? { cost } : {}),
          ...(flags ? { flags } : {}),
          ...(timing ? { timing } : {}),
        },
        provenance: {
          source: "gated-trial",
          runId: opts.runId,
          trialKey: capture.trialKey,
          attemptLedger: capture.attemptLedger?.() ?? null,
        },
      },
      snap.blobs,
    );
  };
  const correctionsSetting: "on" | "off" =
    entry !== undefined && opts.corrections?.families.includes(entry.family.id) ? "on" : "off";

  let outcome: GatedTrialOutcome;
  try {
    outcome = await runGatedTrial({ ...opts, transport });
  } catch (error) {
    // The harness could not finish the attempt: saved labelled, never as an agent outcome,
    // wherever the throw came from. `save` never throws, so `error` is what propagates.
    save(() => ({
      outcome: "harness-fault",
      gate: null,
      groundTruth: { source: "none", reason: "harness-fault" },
      fault: seen.fault ?? { class: "harness-error", code: null },
      corrections: correctionsSetting,
    }));
    throw error;
  }

  if (outcome.status === "refused") {
    return {
      outcome,
      episode: save(() => ({
        outcome: "launch-refused",
        gate: null,
        groundTruth: { source: "none", reason: "agent-never-ran" },
        fault: null,
        corrections: correctionsSetting,
      })),
    };
  }

  const { result } = outcome;
  const gate = {
    verdict: result.verdict,
    accepted: result.accepted,
    reasonCodes: [...result.reasonCodes],
    oracle: result.oracle
      ? {
          family: result.oracle.family,
          version: result.oracle.version,
          specSha256: result.oracle.specSha256,
        }
      : null,
  };
  const harnessCode = result.reasonCodes.find((c) => HARNESS_REASON_CODES.has(c));
  const declared =
    capture.harnessFault ??
    (harnessCode !== undefined ? { class: "gate-harness-code" as const, code: harnessCode } : null);
  if (declared !== null) {
    return {
      outcome,
      episode: save(() => ({
        outcome: "harness-fault",
        gate,
        groundTruth: { source: "none", reason: "harness-fault" },
        fault: declared,
        corrections: outcome.corrections,
      })),
    };
  }
  return {
    outcome,
    episode: save(() => ({
      outcome: result.verdict,
      gate,
      // A document withheld as unclean is not graded: the grade could not be bound to it.
      groundTruth:
        seen.persisted !== null && !seen.persistedKept
          ? { source: "none", reason: "document-withheld" }
          : (capture.groundTruth?.(seen.persisted) ?? {
              source: "none",
              reason: "no-independent-grader",
            }),
      fault: null,
      corrections: outcome.corrections,
    })),
  };
}
