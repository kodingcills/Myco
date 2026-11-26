/**
 * `validateEpisode`: the whole `myco.episode/1` contract, failing closed. The closed schema,
 * then the rules a schema cannot say:
 *
 *  - ID_MISMATCH: `episodeId` is the sha256 of the canonical episode without it;
 *  - SEQ: actions and observations are numbered 0..n-1 in order, an observation follows an
 *    action that exists, and `not-recorded` means no items;
 *  - OUTCOME: `harness-fault` exactly when a fault is recorded; `verified`/`refuted`/
 *    `uncertain` exactly when the gate decided that verdict; `accepted` exactly when
 *    `verified`; no gate decision on `launch-refused` / `unregistrable`;
 *  - GROUND_TRUTH: a harness-faulted attempt carries no ground truth (it is not an agent
 *    outcome); a grade of a document (non-null `persistedSha256`) needs a `persisted` state
 *    observation with that hash in the episode (a withheld document cannot carry a grade:
 *    it is `document-withheld`, which needs a withheld observation and no persisted one);
 *    a grade with no document is `ungradable`;
 *  - SIMULATED: an episode is real (`simulated: false`) only from a gated trial whose planner
 *    is a Claude model id; every other row must say simulated;
 *  - COST: an estimate is token-derived, so a non-null `estimateUsd` needs both token counts
 *    (an unmeasured cost is null, never 0);
 *  - the cleanliness scan (`clean.ts`) over every string, and over every blob when given;
 *  - BLOB_*: every observation's file is present, hashes to its name and size, and no blob is
 *    unreferenced.
 */
import { createHash } from "node:crypto";
import { validateSchema } from "../../../../../schemas/validate.ts";
import { EPISODE_SCHEMA, episodeSchema } from "../../schemas/episode.ts";
import {
  blobIssues,
  type CleanIssueCode,
  cleanIssues,
  currentHost,
  type HostFacts,
} from "./clean.ts";
import type { Episode, EpisodeBlobs } from "./types.ts";

/**
 * Planner ids whose rows may be real (mirrors `EVIDENCE_PLANNERS` in `src/benchmark/check.ts`;
 * `test/episode/schema.test.ts` pins the two equal). Declared here so the episode writer stays
 * out of the benchmark check's import graph (which reaches the grader's row types).
 */
export const REAL_PLANNERS: ReadonlySet<string> = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
]);

export type EpisodeIssueCode =
  | "SCHEMA"
  | "ID_MISMATCH"
  | "SEQ"
  | "OUTCOME"
  | "GROUND_TRUTH"
  | "SIMULATED"
  | "COST"
  | "BLOB_MISSING"
  | "BLOB_HASH"
  | "BLOB_UNREFERENCED"
  | CleanIssueCode;

export interface EpisodeIssue {
  readonly code: EpisodeIssueCode;
  readonly path: string;
  readonly message: string;
}

/** JSON with object keys sorted and `undefined` dropped (the hash input and the file bytes). */
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

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function episodeIdOf(episode: Omit<Episode, "episodeId"> & { episodeId?: string }): string {
  const { episodeId: _ignored, ...rest } = episode;
  return sha256Hex(canonicalJson(rest));
}

export function validateEpisode(
  value: unknown,
  options: { readonly blobs?: EpisodeBlobs; readonly host?: HostFacts } = {},
): EpisodeIssue[] {
  const host = options.host ?? currentHost();
  const schemaIssues = validateSchema(value, episodeSchema);
  const clean = cleanIssues(value, host).map(
    (i): EpisodeIssue => ({ code: i.code, path: i.path, message: `refused: ${i.code}` }),
  );
  if (schemaIssues.length > 0) {
    return [
      ...schemaIssues.map(
        (s): EpisodeIssue => ({
          code: "SCHEMA",
          path: s.path,
          message: `${s.keyword}: ${s.message}`,
        }),
      ),
      ...clean,
    ];
  }
  const ep = value as Episode;
  const issues: EpisodeIssue[] = [...clean];
  const bad = (code: EpisodeIssueCode, path: string, message: string) =>
    issues.push({ code, path, message });

  if (ep.schema !== EPISODE_SCHEMA) bad("SCHEMA", "$.schema", "unknown schema version");
  if (episodeIdOf(ep) !== ep.episodeId)
    bad("ID_MISMATCH", "$.episodeId", "episodeId is not the hash of the episode's content");

  // SEQ
  ep.actions.items.forEach((a, i) => {
    if (a.seq !== i) bad("SEQ", `$.actions.items[${i}]`, `seq ${a.seq}, expected ${i}`);
  });
  ep.observations.items.forEach((o, i) => {
    if (o.seq !== i) bad("SEQ", `$.observations.items[${i}]`, `seq ${o.seq}, expected ${i}`);
    if (o.afterAction !== null && o.afterAction >= ep.actions.items.length)
      bad("SEQ", `$.observations.items[${i}]`, "follows an action that does not exist");
  });
  if (
    ep.actions.capture === "not-recorded" &&
    (ep.actions.items.length > 0 || ep.actions.truncated)
  )
    bad("SEQ", "$.actions", "not-recorded actions carry no items");
  if (
    ep.observations.capture === "not-recorded" &&
    (ep.observations.items.length > 0 || ep.observations.withheld > 0)
  )
    bad("SEQ", "$.observations", "not-recorded observations carry no items");

  // OUTCOME
  const fault = ep.harness.fault;
  if ((ep.outcome === "harness-fault") !== (fault !== null))
    bad(
      "OUTCOME",
      "$.outcome",
      "outcome is harness-fault exactly when a harness fault is recorded",
    );
  if (ep.outcome === "verified" || ep.outcome === "refuted" || ep.outcome === "uncertain") {
    if (ep.gate === null || ep.gate.verdict !== ep.outcome)
      bad("OUTCOME", "$.gate", `outcome ${ep.outcome} needs the gate's ${ep.outcome} verdict`);
  }
  if ((ep.outcome === "launch-refused" || ep.outcome === "unregistrable") && ep.gate !== null)
    bad("OUTCOME", "$.gate", `${ep.outcome} has no gate decision`);
  if (ep.gate !== null && ep.gate.accepted !== (ep.gate.verdict === "verified"))
    bad("OUTCOME", "$.gate.accepted", "accepted is true exactly when the verdict is verified");

  // GROUND_TRUTH
  const gt = ep.groundTruth;
  if (ep.outcome === "harness-fault" && !(gt.source === "none" && gt.reason === "harness-fault"))
    bad(
      "GROUND_TRUTH",
      "$.groundTruth",
      "a harness-faulted attempt is not graded as an agent outcome",
    );
  if (gt.source === "none" && gt.reason === "harness-fault" && ep.outcome !== "harness-fault")
    bad(
      "GROUND_TRUTH",
      "$.groundTruth",
      "ground truth says harness fault but the outcome does not",
    );
  if (
    gt.source === "none" &&
    gt.reason === "document-withheld" &&
    (ep.observations.withheld === 0 ||
      ep.observations.items.some((o) => o.kind === "state" && o.label === "persisted"))
  )
    bad(
      "GROUND_TRUTH",
      "$.groundTruth",
      "document-withheld needs a withheld observation and no captured persisted document",
    );
  if (gt.source === "independent-grader") {
    if (gt.persistedSha256 === null && gt.status !== "ungradable")
      bad("GROUND_TRUTH", "$.groundTruth.status", "a grade without a document is ungradable");
    const persisted = ep.observations.items.find(
      (o) => o.kind === "state" && o.label === "persisted",
    );
    // Bound both ways: a captured document must be the graded one, and a graded document must
    // be captured (a withheld one leaves no observation, so the grade would point at nothing).
    if (
      (persisted !== undefined &&
        persisted.kind === "state" &&
        persisted.sha256 !== gt.persistedSha256) ||
      (persisted === undefined && gt.persistedSha256 !== null)
    )
      bad(
        "GROUND_TRUTH",
        "$.groundTruth.persistedSha256",
        "the grade is not of the captured document",
      );
    if (ep.task.fixtureSha256 !== null && gt.fixtureSha256 !== ep.task.fixtureSha256)
      bad(
        "GROUND_TRUTH",
        "$.groundTruth.fixtureSha256",
        "the grade is not against the task's fixture",
      );
  }

  // SIMULATED
  if (!ep.simulated) {
    if (ep.provenance.source !== "gated-trial")
      bad("SIMULATED", "$.simulated", `a ${ep.provenance.source} episode is always simulated`);
    if (ep.harness.plannerModelId === null || !REAL_PLANNERS.has(ep.harness.plannerModelId))
      bad("SIMULATED", "$.simulated", "a real episode needs a Claude model planner id");
  }

  // COST
  const cost = ep.harness.cost;
  if (cost.estimateUsd !== null && (cost.inputTokens === null || cost.outputTokens === null))
    bad(
      "COST",
      "$.harness.cost",
      "a cost estimate is token-derived: unmeasured tokens mean null, never 0",
    );

  // BLOBS
  if (options.blobs !== undefined) {
    const referenced = new Set<string>();
    for (const [i, o] of ep.observations.items.entries()) {
      if (o.kind === "ui-status") continue;
      referenced.add(o.file);
      const bytes = options.blobs?.get(o.file);
      const at = `$.observations.items[${i}]`;
      if (bytes === undefined) {
        bad("BLOB_MISSING", at, `${o.file} is missing`);
        continue;
      }
      if (sha256Hex(bytes) !== o.sha256 || bytes.length !== o.bytes || !o.file.includes(o.sha256))
        bad("BLOB_HASH", at, `${o.file} does not hash to its name and size`);
      for (const code of blobIssues(bytes, o.kind === "screenshot" ? "png" : "text", host))
        bad(code, at, `refused blob: ${code}`);
    }
    for (const file of options.blobs.keys())
      if (!referenced.has(file)) bad("BLOB_UNREFERENCED", "$", `${file} is not referenced`);
  }
  return issues;
}
