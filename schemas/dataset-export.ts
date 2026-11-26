import type { JsonSchema } from "./validate.ts";

/**
 * Exported dataset (track U, docs/product/linux-scale.md §6). An export is one directory:
 *
 *  - `records.jsonl`  one `myco.dataset.record/1` per exported run, sorted by `trialKey`;
 *  - `manifest.json`  `myco.dataset.manifest/1`: counts, per-record digests, file digests;
 *  - `schema.json`    these two schemas, so a consumer can validate without this repo.
 *
 * Only runs the gate verified AND the independent grader graded `pass` are positives.
 * Refuted runs the grader graded `fail` are exported only when the operator asks, and only
 * labelled `negative`. A dataset is never evidence for a scorecard row (`evidence: false`).
 * The exporter is `src/dataset/export.ts`.
 */

const sha256: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const safeId: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$",
};
const isoTime: JsonSchema = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
};
const relPath: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$",
};
const code: JsonSchema = { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" };

export const DATASET_RECORD_SCHEMA_ID = "myco.dataset.record/1";
export const DATASET_MANIFEST_SCHEMA_ID = "myco.dataset.manifest/1";

export const datasetRecordSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "label",
    "trialKey",
    "taskId",
    "runId",
    "family",
    "instruction",
    "steps",
    "claim",
    "verdict",
    "grade",
    "persisted",
    "provenance",
    "hashes",
  ],
  properties: {
    schema: { const: DATASET_RECORD_SCHEMA_ID },
    /** `positive`: gate verified + grader pass + claimed done. `negative`: gate refuted + grader fail. */
    label: { type: "string", enum: ["positive", "negative"] },
    trialKey: safeId,
    taskId: safeId,
    runId: safeId,
    family: safeId,
    /** The instruction text the agent was given (never oracle internals). */
    instruction: { type: "string", minLength: 1, maxLength: 4000 },
    steps: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "action", "observation"],
        properties: {
          index: { type: "integer", minimum: 0 },
          action: {
            type: "object",
            additionalProperties: false,
            required: ["tool", "input"],
            properties: {
              tool: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" },
              input: { type: "object" },
            },
          },
          observation: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "text"],
                properties: {
                  kind: { const: "text" },
                  text: { type: "string", maxLength: 20000 },
                },
              },
            ],
          },
        },
      },
    },
    claim: {
      type: "object",
      additionalProperties: false,
      required: ["done", "text"],
      properties: { done: { type: "boolean" }, text: { type: "string", maxLength: 4000 } },
    },
    /** The gate's answer, codes only (the human-readable reasons are never exported). */
    verdict: {
      type: "object",
      additionalProperties: false,
      required: ["apiVersion", "source", "verdict", "accepted", "reasonCodes"],
      properties: {
        apiVersion: { const: "myco.gate/v1" },
        /** `myco-gate`: the real gate. `mock-gate`: a scripted stand-in (simulated runs only). */
        source: { type: "string", enum: ["myco-gate", "mock-gate"] },
        verdict: { type: "string", enum: ["verified", "refuted"] },
        accepted: { type: "boolean" },
        reasonCodes: { type: "array", maxItems: 20, items: code },
      },
    },
    grade: {
      type: "object",
      additionalProperties: false,
      required: ["graderVersion", "status", "fixtureSha256", "persistedSha256", "mismatchCount"],
      properties: {
        graderVersion: { type: "string", pattern: "^[a-z0-9-]+/[0-9]+$" },
        status: { type: "string", enum: ["pass", "fail"] },
        fixtureSha256: sha256,
        persistedSha256: sha256,
        mismatchCount: { type: "integer", minimum: 0 },
      },
    },
    persisted: {
      type: "object",
      additionalProperties: false,
      required: ["path", "format", "sha256", "size"],
      properties: {
        path: relPath,
        format: { type: "string", enum: ["csv", "xlsx"] },
        sha256,
        size: { type: "integer", minimum: 0 },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: [
        "backend",
        "isolation",
        "networkEnforced",
        "image",
        "plannerModelId",
        "simulated",
        "harness",
        "startedAt",
        "finishedAt",
      ],
      properties: {
        backend: safeId,
        isolation: { type: "string", enum: ["process", "container", "microvm"] },
        /** True only when the backend itself enforced "no network". */
        networkEnforced: { type: "boolean" },
        image: safeId,
        /** The model that planned the run; null for a scripted agent (then `simulated` is true). */
        plannerModelId: { anyOf: [safeId, { type: "null" }] },
        simulated: { type: "boolean" },
        harness: safeId,
        startedAt: isoTime,
        finishedAt: isoTime,
      },
    },
    hashes: {
      type: "object",
      additionalProperties: false,
      required: ["instructionSha256", "transcriptSha256", "persistedSha256"],
      properties: {
        instructionSha256: sha256,
        /** sha256 of the canonical JSON of `{steps, claim}`. */
        transcriptSha256: sha256,
        persistedSha256: sha256,
      },
    },
  },
};

export const datasetManifestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "exporter",
    "createdAt",
    "evidence",
    "negativesIncluded",
    "counts",
    "records",
    "files",
  ],
  properties: {
    schema: { const: DATASET_MANIFEST_SCHEMA_ID },
    exporter: { type: "string", pattern: "^[a-z0-9-]+/[0-9]+$" },
    createdAt: isoTime,
    /** A dataset is never scorecard evidence. */
    evidence: { const: false },
    negativesIncluded: { type: "boolean" },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["candidates", "records", "positive", "negative", "simulated", "excluded"],
      properties: {
        candidates: { type: "integer", minimum: 0 },
        records: { type: "integer", minimum: 0 },
        positive: { type: "integer", minimum: 0 },
        negative: { type: "integer", minimum: 0 },
        simulated: { type: "integer", minimum: 0 },
        /** Excluded candidates by exclusion code (counts only; integers checked by the exporter). */
        excluded: { type: "object" },
      },
    },
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["trialKey", "label", "simulated", "sha256"],
        properties: {
          trialKey: safeId,
          label: { type: "string", enum: ["positive", "negative"] },
          simulated: { type: "boolean" },
          /** sha256 of the record's line in records.jsonl (without the newline). */
          sha256,
        },
      },
    },
    files: {
      type: "object",
      additionalProperties: false,
      required: ["records.jsonl", "schema.json"],
      properties: { "records.jsonl": sha256, "schema.json": sha256 },
    },
  },
};
