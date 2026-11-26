/**
 * The canonical per-attempt record, `myco.episode/1`, as track U's dataset export reads it.
 *
 * `myco.episode/1` is THE one per-attempt record (spec part 2, #538 §3; implemented by the
 * data-capture PR #542, `schemas/episode.ts`). Track U does not define a competing record:
 * its dataset (`src/dataset/export.ts`) is a container over episodes. Each exported record
 * references one episode by id and digest and carries only U's own fields (the label, the
 * desktop backend facts, the capture location).
 *
 * #542 is not merged, so this module MIRRORS the parts U needs, without importing #542:
 *  - `Episode`: the TypeScript shape (the fields the exporter reads are typed exactly);
 *  - `episodeMirrorSchema`: the closed JSON Schema, field for field, so an episode with a
 *    smuggled field (a gate `reasons`, an env dump, a path) is refused, not passed through;
 *  - `episodeIdOf`: the content address (sha256 of the canonical JSON without `episodeId`).
 * Pinned to #542 at `EPISODE_MIRROR_PINNED_AT` by test/dataset/episode-mirror.test.ts. One
 * deliberate loosening, because src/dataset may not import src/gate: `gate.reasonCodes`
 * items are code-shaped strings rather than the `REASON_CODES` enum. (The exporter still
 * requires the episode's codes to equal the raw gate result's, so a made-up code is never
 * exported as a positive.) Blob observations (`screenshot`, `state`) are refused by the
 * exporter for now (the container does not carry blobs yet).
 *
 * `draftEpisode` is the INTERIM stand-in for #542's episode writer (`buildEpisode` /
 * `EpisodeRecorder`): it assembles an episode from named fields only and addresses it by
 * content. It is used by the $0 desktop harness until #542 merges.
 *
 * TO FILE: switch to #542's `Episode` type, `episodeSchema`, `validateEpisode` and
 * `buildEpisode` once it merges, and delete this mirror.
 */
import { createHash } from "node:crypto";
import type { JsonSchema } from "../../schemas/validate.ts";

/** Head of #542 the mirror was taken from. */
export const EPISODE_MIRROR_PINNED_AT = "b50484690d22d9dbd34ea836678ed2ade1a7e9f7";

export const EPISODE_SCHEMA = "myco.episode/1" as const;
export const EPISODE_WRITER = "myco.episode-writer/1" as const;
export const EPISODE_COST_BASIS = "token-derived estimate at frozen rates; not billed USD" as const;
export const EPISODE_OUTCOMES = [
  "verified",
  "refuted",
  "uncertain",
  "harness-fault",
  "launch-refused",
  "unregistrable",
] as const;
export const EPISODE_SOURCES = [
  "gated-trial",
  "m2-dry-run",
  "demo-mock",
  "demo-multistep-mock",
] as const;
/** #542's fault classes (M2 harness classes plus the episode writer's own). */
export const EPISODE_FAULT_CLASSES = [
  "convert-deadline",
  "deploy-copy",
  "sshd",
  "timeout",
  "load",
  "transport-error",
  "capture-error",
  "gate-harness-code",
] as const;
export const EPISODE_MAX_TEXT = 4000;
export const EPISODE_MAX_ACTIONS = 1000;
export const EPISODE_MAX_OBSERVATIONS = 500;
export const EPISODE_MAX_STATUS_TEXT = 200;

export type AgentClaim = "done" | "not-done" | "no-claim";

/** An action without its position; `seq` and `atMs` are assigned when the episode is drafted. */
export type EpisodeActionBody =
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
  | { readonly kind: "observe" };

export type EpisodeAction = {
  readonly seq: number;
  readonly atMs: number | null;
} & EpisodeActionBody;

export type EpisodeObservation =
  | {
      readonly seq: number;
      readonly afterAction: number | null;
      readonly kind: "ui-status";
      readonly text: string;
    }
  | {
      readonly seq: number;
      readonly afterAction: number | null;
      readonly kind: "screenshot" | "state";
      readonly [field: string]: unknown;
    };

export interface EpisodeGate {
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[] | null;
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
      readonly reason: "no-independent-grader" | "harness-fault" | "agent-never-ran";
    };

export interface Episode {
  readonly schema: typeof EPISODE_SCHEMA;
  readonly episodeId: string;
  readonly outcome: (typeof EPISODE_OUTCOMES)[number];
  readonly simulated: boolean;
  readonly task: {
    readonly id: string;
    readonly family: string;
    readonly taskSetVersion: string | null;
    readonly faultClass: string | null;
    readonly instruction: string | null;
    readonly instructionSha256: string | null;
    readonly fixtureSha256: string | null;
  };
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
  readonly harness: {
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
    readonly fault: {
      readonly class: (typeof EPISODE_FAULT_CLASSES)[number];
      readonly code: string | null;
    } | null;
  };
  readonly provenance: {
    readonly source: (typeof EPISODE_SOURCES)[number];
    readonly runId: string;
    readonly trialKey: string | null;
    readonly attemptLedger: {
      readonly schema: "myco.m2.attempt-event/1";
      readonly events: number;
      readonly headSha256: string;
    } | null;
    readonly writer: typeof EPISODE_WRITER;
  };
}

// --- closed JSON Schema (mirrors #542 schemas/episode.ts at EPISODE_MIRROR_PINNED_AT) -----

const shaHex: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const nullableSha: JsonSchema = { anyOf: [shaHex, { type: "null" }] };
const id: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" };
const nullableId: JsonSchema = { anyOf: [id, { type: "null" }] };
const nonNegInt: JsonSchema = { type: "integer", minimum: 0 };
const nullableNonNegInt: JsonSchema = { anyOf: [nonNegInt, { type: "null" }] };
const nullableNonNeg: JsonSchema = { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] };
const nullableBool: JsonSchema = { anyOf: [{ type: "boolean" }, { type: "null" }] };
const isoTime: JsonSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$",
};
const nullableIso: JsonSchema = { anyOf: [isoTime, { type: "null" }] };
const capture: JsonSchema = { type: "string", enum: ["recorded", "not-recorded"] };
const slug: JsonSchema = { type: "string", pattern: "^[a-z0-9-]{1,64}$" };

function action(kind: string, props: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["seq", "atMs", "kind", ...Object.keys(props)],
    properties: { seq: nonNegInt, atMs: nullableNonNegInt, kind: { const: kind }, ...props },
  };
}

const blobFile = (ext: string): JsonSchema => ({
  type: "string",
  pattern: `^blobs/[0-9a-f]{64}\\.${ext}$`,
});

/** One action, any kind (closed per kind). */
export const episodeActionSchema: JsonSchema = {
  oneOf: [
    action("click", {
      x: nonNegInt,
      y: nonNegInt,
      button: { type: "string", enum: ["left", "right", "middle"] },
    }),
    action("type", { text: { type: "string", minLength: 1, maxLength: EPISODE_MAX_TEXT } }),
    action("key", { keys: { type: "string", minLength: 1, maxLength: 64 } }),
    action("scroll", { dx: { type: "integer" }, dy: { type: "integer" } }),
    action("launch", { app: { type: "string", pattern: "^[A-Za-z0-9._ +-]{1,64}$" } }),
    action("wait", { ms: nonNegInt }),
    action("shell", {
      command: { type: "string", minLength: 1, maxLength: EPISODE_MAX_TEXT },
    }),
    action("gate-check", {
      claim: { type: "string", enum: ["done", "not-done", "no-claim"] },
    }),
    action("observe", {}),
  ],
};

export const episodeMirrorSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "episodeId",
    "outcome",
    "simulated",
    "task",
    "actions",
    "observations",
    "agentClaim",
    "gate",
    "groundTruth",
    "harness",
    "provenance",
  ],
  properties: {
    schema: { const: EPISODE_SCHEMA },
    episodeId: shaHex,
    outcome: { type: "string", enum: [...EPISODE_OUTCOMES] },
    simulated: { type: "boolean" },
    task: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "family",
        "taskSetVersion",
        "faultClass",
        "instruction",
        "instructionSha256",
        "fixtureSha256",
      ],
      properties: {
        id,
        family: slug,
        taskSetVersion: {
          anyOf: [{ type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" }, { type: "null" }],
        },
        faultClass: { anyOf: [slug, { type: "null" }] },
        instruction: { anyOf: [{ type: "string", maxLength: EPISODE_MAX_TEXT }, { type: "null" }] },
        instructionSha256: nullableSha,
        fixtureSha256: nullableSha,
      },
    },
    actions: {
      type: "object",
      additionalProperties: false,
      required: ["capture", "truncated", "items"],
      properties: {
        capture,
        truncated: { type: "boolean" },
        items: {
          type: "array",
          maxItems: EPISODE_MAX_ACTIONS,
          items: episodeActionSchema,
        },
      },
    },
    observations: {
      type: "object",
      additionalProperties: false,
      required: ["capture", "withheld", "items"],
      properties: {
        capture,
        withheld: nonNegInt,
        items: {
          type: "array",
          maxItems: EPISODE_MAX_OBSERVATIONS,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["seq", "afterAction", "kind", "mediaType", "sha256", "bytes", "file"],
                properties: {
                  seq: nonNegInt,
                  afterAction: nullableNonNegInt,
                  kind: { const: "screenshot" },
                  mediaType: { const: "image/png" },
                  sha256: shaHex,
                  bytes: { type: "integer", minimum: 1 },
                  file: blobFile("png"),
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: [
                  "seq",
                  "afterAction",
                  "kind",
                  "label",
                  "mediaType",
                  "sha256",
                  "bytes",
                  "file",
                ],
                properties: {
                  seq: nonNegInt,
                  afterAction: nullableNonNegInt,
                  kind: { const: "state" },
                  label: { type: "string", enum: ["persisted", "ui-tree", "app-state"] },
                  mediaType: { type: "string", enum: ["text/csv", "application/json"] },
                  sha256: shaHex,
                  bytes: nonNegInt,
                  file: { anyOf: [blobFile("csv"), blobFile("json")] },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["seq", "afterAction", "kind", "text"],
                properties: {
                  seq: nonNegInt,
                  afterAction: nullableNonNegInt,
                  kind: { const: "ui-status" },
                  text: { type: "string", maxLength: EPISODE_MAX_STATUS_TEXT },
                },
              },
            ],
          },
        },
      },
    },
    agentClaim: { type: "string", enum: ["done", "not-done", "no-claim"] },
    gate: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "accepted", "reasonCodes", "oracle"],
          properties: {
            verdict: { type: "string", enum: ["verified", "refuted", "uncertain"] },
            accepted: { type: "boolean" },
            reasonCodes: {
              anyOf: [
                {
                  type: "array",
                  maxItems: 20,
                  items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
                },
                { type: "null" },
              ],
            },
            oracle: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["family", "version", "specSha256"],
                  properties: {
                    family: slug,
                    version: { type: "string", pattern: "^[A-Za-z0-9._-]{1,32}$" },
                    specSha256: shaHex,
                  },
                },
              ],
            },
          },
        },
      ],
    },
    groundTruth: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "source",
            "graderVersion",
            "status",
            "targetSatisfied",
            "mismatchCount",
            "fixtureSha256",
            "persistedSha256",
          ],
          properties: {
            source: { const: "independent-grader" },
            graderVersion: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,64}$" },
            status: { type: "string", enum: ["pass", "fail", "ungradable"] },
            targetSatisfied: nullableBool,
            mismatchCount: nonNegInt,
            fixtureSha256: shaHex,
            persistedSha256: nullableSha,
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "reason"],
          properties: {
            source: { const: "none" },
            reason: {
              type: "string",
              enum: ["no-independent-grader", "harness-fault", "agent-never-ran"],
            },
          },
        },
      ],
    },
    harness: {
      type: "object",
      additionalProperties: false,
      required: [
        "arm",
        "plannerModelId",
        "outputCeiling",
        "corrections",
        "flags",
        "timing",
        "cost",
        "fault",
      ],
      properties: {
        arm: { type: "string", pattern: "^[a-z0-9+._:-]{1,64}$" },
        plannerModelId: {
          anyOf: [{ type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" }, { type: "null" }],
        },
        outputCeiling: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
        corrections: { type: "string", enum: ["on", "off"] },
        flags: {
          type: "object",
          additionalProperties: false,
          required: ["policy", "handoff", "assisted"],
          properties: { policy: nullableBool, handoff: nullableBool, assisted: nullableBool },
        },
        timing: {
          type: "object",
          additionalProperties: false,
          required: ["startedAt", "endedAt", "wallClockS", "vmS"],
          properties: {
            startedAt: nullableIso,
            endedAt: nullableIso,
            wallClockS: nullableNonNeg,
            vmS: nullableNonNeg,
          },
        },
        cost: {
          type: "object",
          additionalProperties: false,
          required: ["basis", "estimateUsd", "inputTokens", "outputTokens"],
          properties: {
            basis: { const: EPISODE_COST_BASIS },
            estimateUsd: nullableNonNeg,
            inputTokens: nullableNonNegInt,
            outputTokens: nullableNonNegInt,
          },
        },
        fault: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["class", "code"],
              properties: {
                class: { type: "string", enum: [...EPISODE_FAULT_CLASSES] },
                code: {
                  anyOf: [{ type: "string", pattern: "^[A-Z0-9_]{1,64}$" }, { type: "null" }],
                },
              },
            },
          ],
        },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["source", "runId", "trialKey", "attemptLedger", "writer"],
      properties: {
        source: { type: "string", enum: [...EPISODE_SOURCES] },
        runId: id,
        trialKey: nullableId,
        attemptLedger: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["schema", "events", "headSha256"],
              properties: {
                schema: { const: "myco.m2.attempt-event/1" },
                events: { type: "integer", minimum: 1 },
                headSha256: shaHex,
              },
            },
          ],
        },
        writer: { const: EPISODE_WRITER },
      },
    },
  },
};

// --- content address ----------------------------------------------------------------------

/** Canonical JSON: sorted keys, no whitespace (the same rule as #542's `canonicalJson`). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

/** sha256 of the canonical JSON of the episode without `episodeId`. */
export function episodeIdOf(episode: Omit<Episode, "episodeId"> & { episodeId?: string }): string {
  const { episodeId: _ignored, ...rest } = episode;
  return sha256Hex(canonicalJson(rest));
}

// --- interim writer (stand-in for #542's buildEpisode) -----------------------------------

export interface EpisodeDraft {
  readonly outcome: Episode["outcome"];
  readonly simulated: boolean;
  readonly task: Episode["task"];
  readonly actions: readonly EpisodeActionBody[];
  readonly observations: ReadonlyArray<{
    readonly afterAction: number | null;
    readonly text: string;
  }>;
  /** Observations dropped because they did not fit (e.g. over the status-text limit). */
  readonly withheld: number;
  readonly agentClaim: AgentClaim;
  readonly gate: EpisodeGate | null;
  readonly groundTruth: EpisodeGroundTruth;
  readonly arm: string;
  readonly plannerModelId: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly source: Episode["provenance"]["source"];
  readonly runId: string;
  readonly trialKey: string | null;
}

/** Assembles an episode from named fields only (nothing copied wholesale) and addresses it. */
export function draftEpisode(d: EpisodeDraft): Episode {
  const body: Omit<Episode, "episodeId"> = {
    schema: EPISODE_SCHEMA,
    outcome: d.outcome,
    simulated: d.simulated,
    task: {
      id: d.task.id,
      family: d.task.family,
      taskSetVersion: d.task.taskSetVersion,
      faultClass: d.task.faultClass,
      instruction: d.task.instruction,
      instructionSha256: d.task.instructionSha256,
      fixtureSha256: d.task.fixtureSha256,
    },
    actions: {
      capture: "recorded",
      truncated: false,
      items: d.actions.map((a, seq) => ({ ...a, seq, atMs: null })),
    },
    observations: {
      capture: "recorded",
      withheld: d.withheld,
      items: d.observations.map((o, seq) => ({
        seq,
        afterAction: o.afterAction,
        kind: "ui-status" as const,
        text: o.text,
      })),
    },
    agentClaim: d.agentClaim,
    gate:
      d.gate === null
        ? null
        : {
            verdict: d.gate.verdict,
            accepted: d.gate.accepted,
            reasonCodes: d.gate.reasonCodes === null ? null : [...d.gate.reasonCodes],
            oracle: null,
          },
    groundTruth:
      d.groundTruth.source === "independent-grader"
        ? {
            source: "independent-grader",
            graderVersion: d.groundTruth.graderVersion,
            status: d.groundTruth.status,
            targetSatisfied: d.groundTruth.targetSatisfied,
            mismatchCount: d.groundTruth.mismatchCount,
            fixtureSha256: d.groundTruth.fixtureSha256,
            persistedSha256: d.groundTruth.persistedSha256,
          }
        : { source: "none", reason: d.groundTruth.reason },
    harness: {
      arm: d.arm,
      plannerModelId: d.plannerModelId,
      outputCeiling: null,
      corrections: "off",
      flags: { policy: null, handoff: null, assisted: null },
      timing: { startedAt: d.startedAt, endedAt: d.endedAt, wallClockS: null, vmS: null },
      cost: { basis: EPISODE_COST_BASIS, estimateUsd: null, inputTokens: null, outputTokens: null },
      fault: null,
    },
    provenance: {
      source: d.source,
      runId: d.runId,
      trialKey: d.trialKey,
      attemptLedger: null,
      writer: EPISODE_WRITER,
    },
  };
  return { ...body, episodeId: episodeIdOf(body) };
}
