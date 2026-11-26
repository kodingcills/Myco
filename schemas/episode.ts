import { REASON_CODES } from "../src/gate/api.ts";
import { HARNESS_CLASSES } from "./m2-evidence.ts";
import type { JsonSchema } from "./validate.ts";

/**
 * The canonical episode format, `myco.episode/1` (data capture track; docs/data/episode-format.md).
 *
 * One episode is one attempt at one task, saved after it ends: the task (by id and hashes),
 * the agent's ordered actions, what was observed (screenshots and structured state as
 * content-addressed files, never inline bytes), the gate's verdict and reason codes, the
 * ground truth (the INDEPENDENT grader's result, `src/benchmark/grade`; never the gate's),
 * the harness metadata and the provenance.
 *
 * Closed at every level (`additionalProperties: false`): an unknown field is refused, so a
 * writer cannot smuggle a path, a receipt or a ledger row in under a new name. There is no
 * free-form field for an environment, a launch plan, a vault path, a seal receipt, oracle
 * source, gate prose (`reasons`) or a Sai ledger row. A breaking change is a new version
 * (`myco.episode/2`); adding an enum value that old readers would refuse is also breaking.
 *
 * The schema alone is not the contract: `validateEpisode` (`src/episode/validate.ts`) also
 * checks the content id, the outcome/verdict/fault consistency, the simulated label, the
 * cost rule (null, never 0, for an unmeasured estimate), the ground-truth binding and the
 * cleanliness scan (planted markers, absolute paths, key-shaped strings, host identifiers).
 */
export const EPISODE_SCHEMA = "myco.episode/1" as const;
export const EPISODE_DATASET_SCHEMA = "myco.episode-dataset/1" as const;
export const EPISODE_STORE_SCHEMA = "myco.episode-store/1" as const;

/** What the cost figure is (mirrors `COST_BASIS` in `src/benchmark/check.ts`; a test pins it). */
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

/** Harness fault classes: the M2 plan's, plus the ones the episode writer itself can see. */
export const EPISODE_FAULT_CLASSES = [
  ...HARNESS_CLASSES,
  "transport-error",
  "capture-error",
  "gate-harness-code",
  "harness-error",
] as const;

export const MAX_ACTIONS = 1000;
export const MAX_OBSERVATIONS = 500;
export const MAX_TEXT = 4000;

const sha256Hex: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const nullableSha: JsonSchema = { anyOf: [sha256Hex, { type: "null" }] };
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
const text = (max: number): JsonSchema => ({ type: "string", maxLength: max });

function action(kind: string, props: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["seq", "atMs", "kind", ...Object.keys(props)],
    properties: { seq: nonNegInt, atMs: nullableNonNegInt, kind: { const: kind }, ...props },
  };
}

export const episodeActionSchema: JsonSchema = {
  oneOf: [
    action("click", {
      x: nonNegInt,
      y: nonNegInt,
      button: { type: "string", enum: ["left", "right", "middle"] },
    }),
    action("type", { text: { type: "string", minLength: 1, maxLength: MAX_TEXT } }),
    action("key", { keys: { type: "string", minLength: 1, maxLength: 64 } }),
    action("scroll", { dx: { type: "integer" }, dy: { type: "integer" } }),
    action("launch", { app: { type: "string", pattern: "^[A-Za-z0-9._ +-]{1,64}$" } }),
    action("wait", { ms: nonNegInt }),
    action("shell", { command: { type: "string", minLength: 1, maxLength: MAX_TEXT } }),
    action("gate-check", { claim: { type: "string", enum: ["done", "not-done", "no-claim"] } }),
    action("observe", {}),
  ],
};

const blobFile = (ext: string): JsonSchema => ({
  type: "string",
  pattern: `^blobs/[0-9a-f]{64}\\.${ext}$`,
});

export const episodeObservationSchema: JsonSchema = {
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
        sha256: sha256Hex,
        bytes: { type: "integer", minimum: 1 },
        file: blobFile("png"),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["seq", "afterAction", "kind", "label", "mediaType", "sha256", "bytes", "file"],
      properties: {
        seq: nonNegInt,
        afterAction: nullableNonNegInt,
        kind: { const: "state" },
        /** `persisted`: the saved document the gate and the grader read. */
        label: { type: "string", enum: ["persisted", "ui-tree", "app-state"] },
        mediaType: { type: "string", enum: ["text/csv", "application/json"] },
        sha256: sha256Hex,
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
        text: text(200),
      },
    },
  ],
};

const capture: JsonSchema = { type: "string", enum: ["recorded", "not-recorded"] };

export const episodeSchema: JsonSchema = {
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
    /** sha256 of the canonical JSON of the episode without this field (content address). */
    episodeId: sha256Hex,
    outcome: { type: "string", enum: [...EPISODE_OUTCOMES] },
    /** True for every row not produced by a real model on a real gated trial. */
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
        family: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
        taskSetVersion: {
          anyOf: [{ type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" }, { type: "null" }],
        },
        faultClass: { anyOf: [{ type: "string", pattern: "^[a-z0-9-]{1,64}$" }, { type: "null" }] },
        /** The instruction text the agent got (redacted), when the writer knows it. */
        instruction: { anyOf: [text(MAX_TEXT), { type: "null" }] },
        instructionSha256: nullableSha,
        fixtureSha256: nullableSha,
      },
    },
    actions: {
      type: "object",
      additionalProperties: false,
      required: ["capture", "truncated", "items"],
      properties: {
        /** `not-recorded`: this path does not see the agent's actions (items is empty). */
        capture,
        /** True when more than `MAX_ACTIONS` were seen and the tail was dropped. */
        truncated: { type: "boolean" },
        items: { type: "array", maxItems: MAX_ACTIONS, items: episodeActionSchema },
      },
    },
    observations: {
      type: "object",
      additionalProperties: false,
      required: ["capture", "withheld", "items"],
      properties: {
        capture,
        /** Observations dropped by the redaction rules (no redactor, refused, or unclean). */
        withheld: nonNegInt,
        items: { type: "array", maxItems: MAX_OBSERVATIONS, items: episodeObservationSchema },
      },
    },
    agentClaim: { type: "string", enum: ["done", "not-done", "no-claim"] },
    /** The gate's decision: verdict and codes only (gate prose is never captured). */
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
            /** Null when this path does not see the codes (the dry run reads arm rows). */
            reasonCodes: {
              anyOf: [
                {
                  type: "array",
                  maxItems: REASON_CODES.length,
                  items: { type: "string", enum: [...REASON_CODES] },
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
                    family: { type: "string", pattern: "^[a-z0-9-]{1,64}$" },
                    version: { type: "string", pattern: "^[A-Za-z0-9._-]{1,32}$" },
                    specSha256: sha256Hex,
                  },
                },
              ],
            },
          },
        },
      ],
    },
    /** The independent grader's result (`src/benchmark/grade`), never the gate's. */
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
            fixtureSha256: sha256Hex,
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
              enum: [
                "no-independent-grader",
                "harness-fault",
                "agent-never-ran",
                "document-withheld",
              ],
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
        /** Capability-track switches; null = not applicable to this run / not recorded. */
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
        /** An ESTIMATE from token counts; null = not measured, never 0. Never billed USD. */
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
        /**
         * The append-only attempt ledger's head when this attempt ended (#518's
         * `myco.m2.attempt-event/1` chain; lands with #518). Null when no ledger was kept.
         */
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
                headSha256: sha256Hex,
              },
            },
          ],
        },
        writer: { const: "myco.episode-writer/1" },
      },
    },
  },
};

export const episodeStoreSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "simulated"],
  properties: { schema: { const: EPISODE_STORE_SCHEMA }, simulated: { type: "boolean" } },
};

const countMap: JsonSchema = { type: "object", additionalProperties: true, properties: {} };

export const episodeDatasetManifestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "episodeSchema",
    "simulated",
    "filter",
    "counts",
    "files",
    "datasetSha256",
    "provenance",
  ],
  properties: {
    schema: { const: EPISODE_DATASET_SCHEMA },
    episodeSchema: { const: EPISODE_SCHEMA },
    simulated: { type: "boolean" },
    filter: {
      type: "object",
      additionalProperties: false,
      required: ["taskSetVersion", "arm", "outcome", "since", "until"],
      properties: {
        taskSetVersion: { anyOf: [{ type: "string", maxLength: 64 }, { type: "null" }] },
        arm: { anyOf: [{ type: "string", maxLength: 64 }, { type: "null" }] },
        outcome: { anyOf: [{ type: "string", enum: [...EPISODE_OUTCOMES] }, { type: "null" }] },
        since: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
        until: { anyOf: [{ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, { type: "null" }] },
      },
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["episodes", "blobs", "byOutcome", "byArm", "byTaskSet", "byFamily", "bySource"],
      properties: {
        episodes: nonNegInt,
        blobs: nonNegInt,
        byOutcome: countMap,
        byArm: countMap,
        byTaskSet: countMap,
        byFamily: countMap,
        bySource: countMap,
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256", "bytes"],
        properties: {
          path: {
            type: "string",
            pattern: "^(episodes/[0-9a-f]{64}\\.json|blobs/[0-9a-f]{64}\\.(png|csv|json))$",
          },
          sha256: sha256Hex,
          bytes: nonNegInt,
        },
      },
    },
    /** sha256 of the canonical JSON of `files`: one hash names the whole dataset. */
    datasetSha256: sha256Hex,
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["runs", "attemptLedgerHeads"],
      properties: {
        runs: nonNegInt,
        attemptLedgerHeads: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["events", "headSha256"],
            properties: { events: { type: "integer", minimum: 1 }, headSha256: sha256Hex },
          },
        },
      },
    },
  },
};
