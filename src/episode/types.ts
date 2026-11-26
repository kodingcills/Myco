/**
 * TypeScript shape of `myco.episode/1` (schemas/episode.ts is the closed JSON Schema; the two
 * are kept in step by `test/episode/schema.test.ts`, which round-trips every variant).
 */
import type {
  EPISODE_COST_BASIS,
  EPISODE_FAULT_CLASSES,
  EPISODE_OUTCOMES,
  EPISODE_SCHEMA,
  EPISODE_SOURCES,
} from "../../schemas/episode.ts";
import type { ReasonCode } from "../gate/api.ts";

export type EpisodeOutcome = (typeof EPISODE_OUTCOMES)[number];
export type EpisodeSource = (typeof EPISODE_SOURCES)[number];
export type EpisodeFaultClass = (typeof EPISODE_FAULT_CLASSES)[number];
export type AgentClaim = "done" | "not-done" | "no-claim";

interface ActionBase {
  readonly seq: number;
  /** Milliseconds since the attempt started, or null when the writer has no clock. */
  readonly atMs: number | null;
}

export type EpisodeAction = ActionBase &
  (
    | {
        readonly kind: "click";
        readonly x: number;
        readonly y: number;
        readonly button: "left" | "right" | "middle";
      }
    | { readonly kind: "type"; readonly text: string }
    | { readonly kind: "key"; readonly keys: string }
    | { readonly kind: "scroll"; readonly dx: number; readonly dy: number }
    | { readonly kind: "launch"; readonly app: string }
    | { readonly kind: "wait"; readonly ms: number }
    | { readonly kind: "shell"; readonly command: string }
    | { readonly kind: "gate-check"; readonly claim: AgentClaim }
    | { readonly kind: "observe" }
  );

/** An action as a recorder takes it: the recorder assigns `seq`. */
export type ActionInput = EpisodeAction extends infer A
  ? A extends EpisodeAction
    ? Omit<A, "seq" | "atMs"> & { readonly atMs?: number | null }
    : never
  : never;

interface ObservationBase {
  readonly seq: number;
  /** Index of the action this observation follows, or null (before any action / at end). */
  readonly afterAction: number | null;
}

export type EpisodeObservation = ObservationBase &
  (
    | {
        readonly kind: "screenshot";
        readonly mediaType: "image/png";
        readonly sha256: string;
        readonly bytes: number;
        readonly file: string;
      }
    | {
        readonly kind: "state";
        readonly label: "persisted" | "ui-tree" | "app-state";
        readonly mediaType: "text/csv" | "application/json";
        readonly sha256: string;
        readonly bytes: number;
        readonly file: string;
      }
    | { readonly kind: "ui-status"; readonly text: string }
  );

export interface EpisodeGate {
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly accepted: boolean;
  readonly reasonCodes: readonly ReasonCode[] | null;
  readonly oracle: {
    readonly family: string;
    readonly version: string;
    readonly specSha256: string;
  } | null;
}

export type EpisodeGroundTruth =
  | {
      readonly source: "independent-grader";
      readonly graderVersion: string;
      readonly status: "pass" | "fail" | "ungradable";
      readonly targetSatisfied: boolean | null;
      readonly mismatchCount: number;
      readonly fixtureSha256: string;
      readonly persistedSha256: string | null;
    }
  | {
      readonly source: "none";
      readonly reason:
        | "no-independent-grader"
        | "harness-fault"
        | "agent-never-ran"
        /** The captured document was withheld as unclean, so no grade can be bound to it. */
        | "document-withheld";
    };

export interface EpisodeHarness {
  readonly arm: string;
  readonly plannerModelId: string | null;
  readonly outputCeiling: number | null;
  readonly corrections: "on" | "off";
  readonly flags: {
    readonly policy: boolean | null;
    readonly handoff: boolean | null;
    readonly assisted: boolean | null;
  };
  readonly timing: {
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly wallClockS: number | null;
    readonly vmS: number | null;
  };
  readonly cost: {
    readonly basis: typeof EPISODE_COST_BASIS;
    readonly estimateUsd: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
  readonly fault: { readonly class: EpisodeFaultClass; readonly code: string | null } | null;
}

export interface AttemptLedgerRef {
  readonly schema: "myco.m2.attempt-event/1";
  readonly events: number;
  readonly headSha256: string;
}

export interface EpisodeProvenance {
  readonly source: EpisodeSource;
  readonly runId: string;
  readonly trialKey: string | null;
  readonly attemptLedger: AttemptLedgerRef | null;
  readonly writer: "myco.episode-writer/1";
}

export interface EpisodeTask {
  readonly id: string;
  readonly family: string;
  readonly taskSetVersion: string | null;
  readonly faultClass: string | null;
  readonly instruction: string | null;
  readonly instructionSha256: string | null;
  readonly fixtureSha256: string | null;
}

export interface Episode {
  readonly schema: typeof EPISODE_SCHEMA;
  readonly episodeId: string;
  readonly outcome: EpisodeOutcome;
  readonly simulated: boolean;
  readonly task: EpisodeTask;
  readonly actions: {
    readonly capture: "recorded" | "not-recorded";
    readonly truncated: boolean;
    readonly items: readonly EpisodeAction[];
  };
  readonly observations: {
    readonly capture: "recorded" | "not-recorded";
    readonly withheld: number;
    readonly items: readonly EpisodeObservation[];
  };
  readonly agentClaim: AgentClaim;
  readonly gate: EpisodeGate | null;
  readonly groundTruth: EpisodeGroundTruth;
  readonly harness: EpisodeHarness;
  readonly provenance: EpisodeProvenance;
}

/** Blob bytes keyed by the file path the episode names (`blobs/<sha256>.<ext>`). */
export type EpisodeBlobs = ReadonlyMap<string, Uint8Array>;
