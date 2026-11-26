/**
 * Assemble one episode from named fields, address it by content, and validate it. Nothing
 * is copied wholesale from a launch plan, a vault, a gate result or a ledger: each field is
 * picked by name (clean by construction), free text is redacted, then `validateEpisode`
 * refuses anything that is still not clean.
 */
import { EPISODE_COST_BASIS, EPISODE_SCHEMA } from "../../schemas/episode.ts";
import { currentHost, type HostFacts, redactText } from "./clean.ts";
import type { Episode, EpisodeBlobs, EpisodeHarness } from "./types.ts";
import { type EpisodeIssue, episodeIdOf, validateEpisode } from "./validate.ts";

export type EpisodeDraft = Omit<Episode, "schema" | "episodeId" | "provenance" | "harness"> & {
  readonly provenance: Omit<Episode["provenance"], "writer">;
  readonly harness: Omit<EpisodeHarness, "cost" | "flags" | "timing"> & {
    readonly cost?: Partial<Omit<EpisodeHarness["cost"], "basis">>;
    readonly flags?: Partial<EpisodeHarness["flags"]>;
    readonly timing?: Partial<EpisodeHarness["timing"]>;
  };
};

export type BuildResult =
  | { readonly ok: true; readonly episode: Episode; readonly blobs: EpisodeBlobs }
  | { readonly ok: false; readonly issues: readonly EpisodeIssue[] };

/** The empty capture: this path does not see actions or observations. */
export const NOT_RECORDED = {
  actions: { capture: "not-recorded", truncated: false, items: [] },
  observations: { capture: "not-recorded", withheld: 0, items: [] },
} as const;

export function buildEpisode(
  draft: EpisodeDraft,
  blobs: EpisodeBlobs = new Map(),
  host: HostFacts = currentHost(),
): BuildResult {
  const { harness } = draft;
  const body: Omit<Episode, "episodeId"> = {
    schema: EPISODE_SCHEMA,
    outcome: draft.outcome,
    simulated: draft.simulated,
    task: {
      id: draft.task.id,
      family: draft.task.family,
      taskSetVersion: draft.task.taskSetVersion,
      faultClass: draft.task.faultClass,
      instruction:
        draft.task.instruction === null ? null : redactText(draft.task.instruction, host),
      instructionSha256: draft.task.instructionSha256,
      fixtureSha256: draft.task.fixtureSha256,
    },
    actions: draft.actions,
    observations: draft.observations,
    agentClaim: draft.agentClaim,
    gate:
      draft.gate === null
        ? null
        : {
            verdict: draft.gate.verdict,
            accepted: draft.gate.accepted,
            reasonCodes: draft.gate.reasonCodes === null ? null : [...draft.gate.reasonCodes],
            oracle:
              draft.gate.oracle === null
                ? null
                : {
                    family: draft.gate.oracle.family,
                    version: draft.gate.oracle.version,
                    specSha256: draft.gate.oracle.specSha256,
                  },
          },
    groundTruth: draft.groundTruth,
    harness: {
      arm: harness.arm,
      plannerModelId: harness.plannerModelId,
      outputCeiling: harness.outputCeiling,
      corrections: harness.corrections,
      flags: {
        policy: harness.flags?.policy ?? null,
        handoff: harness.flags?.handoff ?? null,
        assisted: harness.flags?.assisted ?? null,
      },
      timing: {
        startedAt: harness.timing?.startedAt ?? null,
        endedAt: harness.timing?.endedAt ?? null,
        wallClockS: harness.timing?.wallClockS ?? null,
        vmS: harness.timing?.vmS ?? null,
      },
      // Null, never 0: an absent figure is unmeasured.
      cost: {
        basis: EPISODE_COST_BASIS,
        estimateUsd: harness.cost?.estimateUsd ?? null,
        inputTokens: harness.cost?.inputTokens ?? null,
        outputTokens: harness.cost?.outputTokens ?? null,
      },
      fault:
        harness.fault === null ? null : { class: harness.fault.class, code: harness.fault.code },
    },
    provenance: {
      source: draft.provenance.source,
      runId: draft.provenance.runId,
      trialKey: draft.provenance.trialKey,
      attemptLedger:
        draft.provenance.attemptLedger === null
          ? null
          : {
              schema: "myco.m2.attempt-event/1",
              events: draft.provenance.attemptLedger.events,
              headSha256: draft.provenance.attemptLedger.headSha256,
            },
      writer: "myco.episode-writer/1",
    },
  };
  const episode: Episode = { ...body, episodeId: episodeIdOf(body) };
  const issues = validateEpisode(episode, { blobs, host });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, episode, blobs };
}
