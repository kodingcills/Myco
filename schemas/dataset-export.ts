import type { JsonSchema } from "./validate.ts";

/**
 * Exported dataset (track U, docs/product/linux-scale.md §6): a CONTAINER over canonical
 * `myco.episode/1` records (#538 §3, #542). An export is one directory:
 *
 *  - `episodes/<episodeId>.json`  each exported episode, canonical JSON, byte-identical to
 *                                 the episode the harness recorded (content-addressed);
 *  - `records.jsonl`  one `myco.dataset.record/3` per exported episode, sorted by episode id.
 *                     A record references its episode by id and digest and carries ONLY
 *                     track U's own fields: the label, the desktop backend facts and where
 *                     the capture was taken. Steps, verdict, grade, claim, provenance and
 *                     the simulated flag live in the episode, never here;
 *  - `blobs/<sha256>.csv`  the persisted document each exported episode graded, byte for
 *                     byte, named by its digest (the episode's `state`/`persisted`
 *                     observation references it; #542 requires it of a graded episode);
 *  - `manifest.json`  `myco.dataset.manifest/3`: counts, per-record digests, file and blob
 *                     digests;
 *  - `schema.json`    these two schemas plus the mirrored episode schema.
 *
 * Which manifest a consumer trusts: this one describes U's container; each episode inside
 * is a `myco.episode/1` record a consumer may re-validate with #542's `validateEpisode`
 * (blobs included). #542's own `myco-episodes export` (`myco.episode-dataset/1`) is a
 * separate, flat export of episodes; this container does not wrap or replace it.
 *
 * Only episodes the gate verified AND the independent grader graded `pass` are positives.
 * Refuted episodes the grader graded `fail` are exported only when the operator asks, and
 * only labelled `negative`. A dataset is never evidence for a scorecard row
 * (`evidence: false`). The exporter is `src/dataset/export.ts`.
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

export const DATASET_RECORD_SCHEMA_ID = "myco.dataset.record/3";
export const DATASET_MANIFEST_SCHEMA_ID = "myco.dataset.manifest/3";

export const datasetRecordSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "label", "episode", "desktop", "capture"],
  properties: {
    schema: { const: DATASET_RECORD_SCHEMA_ID },
    /** `positive`: gate verified + grader pass + claimed done. `negative`: gate refuted + grader fail. */
    label: { type: "string", enum: ["positive", "negative"] },
    /** The canonical episode this record selects. */
    episode: {
      type: "object",
      additionalProperties: false,
      required: ["schema", "id", "sha256", "file"],
      properties: {
        schema: { const: "myco.episode/1" },
        /** The episode's content address (`episodeId`). */
        id: sha256,
        /** sha256 of the episode file's bytes (canonical JSON plus a newline). */
        sha256,
        file: { type: "string", pattern: "^episodes/[0-9a-f]{64}\\.json$" },
      },
    },
    /** Track U's own fields: which desktop backend ran the attempt, and how isolated it was. */
    desktop: {
      type: "object",
      additionalProperties: false,
      required: ["backend", "isolation", "networkEnforced", "image"],
      properties: {
        backend: safeId,
        isolation: { type: "string", enum: ["process", "container", "microvm"] },
        /** True only when the backend itself enforced "no network". */
        networkEnforced: { type: "boolean" },
        image: safeId,
      },
    },
    /**
     * Where the persisted bytes were captured (desktop-relative). The digest is the episode's;
     * the bytes are `blobs/<digest>.csv`. CSV only (#542 stores a `text/csv` document).
     */
    capture: {
      type: "object",
      additionalProperties: false,
      required: ["path", "format", "size"],
      properties: {
        path: relPath,
        format: { const: "csv" },
        size: { type: "integer", minimum: 0 },
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
    "episodeFormat",
    "counts",
    "records",
    "files",
    "blobs",
  ],
  properties: {
    schema: { const: DATASET_MANIFEST_SCHEMA_ID },
    exporter: { type: "string", pattern: "^[a-z0-9-]+/[0-9]+$" },
    createdAt: isoTime,
    /** A dataset is never scorecard evidence. */
    evidence: { const: false },
    negativesIncluded: { type: "boolean" },
    /** The episode format the records reference, and the #542 head the mirror was taken from. */
    episodeFormat: {
      type: "object",
      additionalProperties: false,
      required: ["schema", "mirrorPinnedAt"],
      properties: {
        schema: { const: "myco.episode/1" },
        mirrorPinnedAt: { type: "string", pattern: "^[0-9a-f]{40}$" },
      },
    },
    counts: {
      type: "object",
      additionalProperties: false,
      required: ["candidates", "records", "positive", "negative", "simulated", "excluded"],
      properties: {
        candidates: { type: "integer", minimum: 0 },
        records: { type: "integer", minimum: 0 },
        positive: { type: "integer", minimum: 0 },
        negative: { type: "integer", minimum: 0 },
        /** Exported episodes labelled `simulated: true`. */
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
        required: ["episodeId", "label", "sha256"],
        properties: {
          episodeId: sha256,
          label: { type: "string", enum: ["positive", "negative"] },
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
    /** Every carried blob, sorted by file: the file is named by `sha256`, which it hashes to. */
    blobs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "sha256", "bytes"],
        properties: {
          file: { type: "string", pattern: "^blobs/[0-9a-f]{64}\\.csv$" },
          sha256,
          bytes: { type: "integer", minimum: 0 },
        },
      },
    },
  },
};
