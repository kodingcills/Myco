/**
 * Track Q (replayable proof): the bundle's reference to the canonical per-attempt record.
 *
 * `myco.episode/1` (data capture, #542, specified in capability spec part 2 #538 §3) is the
 * ONE canonical record of an attempt. A proof bundle does not define a competing one: it is
 * a tamper-evident CONTAINER over an attempt that references the attempt's episode by id
 * and digest (`run.episode`), projects a few of its fields (`run.runId`, `taskId`, `arm`,
 * `simulated`), and carries only Q's own extra fields (the hash chain, evidence digests,
 * the ledger anchor). With the episode in hand the verifier recomputes both the id and the
 * digest and refuses any projected field that disagrees.
 *
 * #542 is not merged, so its code is NOT imported. This module mirrors ONLY the episode
 * fields Q reads (`EPISODE_FIELDS_USED`, pinned by `test/proof/episode-ref.test.ts`) and
 * #542's documented id rule: `episodeId` is the sha256 of the canonical JSON (sorted keys,
 * no undefined members) of the episode without `episodeId`. It does not validate the
 * episode as a whole: that is #542's `validateEpisode`.
 *
 * TO FILE: once #542 merges, replace `EpisodeProjectionSource` with #542's `Episode` type
 * and `episodeIdOf`, and run its `validateEpisode` before projecting (a parity test pins
 * that both compute the same id).
 */
import { canonicalJson, sha256Hex } from "./ledger.ts";

export const EPISODE_SCHEMA = "myco.episode/1" as const;

/** The episode fields Q reads, as JSON paths. Changing this list is a reviewed change. */
export const EPISODE_FIELDS_USED = [
  "schema",
  "episodeId",
  "simulated",
  "task.id",
  "harness.arm",
  "provenance.runId",
  "provenance.trialKey",
] as const;

/** The subset of #542's `Episode` that Q reads (mirrored, not imported). */
export interface EpisodeProjectionSource {
  readonly schema: typeof EPISODE_SCHEMA;
  readonly episodeId: string;
  readonly simulated: boolean;
  readonly task: { readonly id: string };
  readonly harness: { readonly arm: string };
  readonly provenance: { readonly runId: string; readonly trialKey: string | null };
}

/** What a bundle carries: the reference, never the episode itself. */
export interface EpisodeRef {
  readonly schema: typeof EPISODE_SCHEMA;
  readonly episodeId: string;
  /** sha256 of the episode's canonical JSON (the bytes #542's store writes). */
  readonly sha256: string;
}

/** The episode fields a bundle projects into `run` (and the ledger trial key). */
export interface EpisodeProjection {
  readonly ref: EpisodeRef;
  readonly runId: string;
  readonly taskId: string;
  readonly arm: string;
  readonly simulated: boolean;
  readonly trialKey: string | null;
}

/** #542's id rule, re-stated: sha256 of the canonical episode without `episodeId`. */
export function episodeIdOf(episode: Record<string, unknown>): string {
  const { episodeId: _ignored, ...rest } = episode;
  return sha256Hex(canonicalJson(rest));
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Project an episode. Returns error codes-with-messages (structural only, never a value)
 * when a field Q reads is missing or mistyped, or when the id is not the content hash.
 */
export function projectEpisode(
  value: unknown,
): { ok: true; projection: EpisodeProjection } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!obj(value)) return { ok: false, errors: ["the episode is not an object"] };
  const task = value.task;
  const harness = value.harness;
  const prov = value.provenance;
  if (value.schema !== EPISODE_SCHEMA) errors.push("$.schema is not myco.episode/1");
  if (!str(value.episodeId)) errors.push("$.episodeId is missing");
  if (typeof value.simulated !== "boolean") errors.push("$.simulated is not a boolean");
  if (!obj(task) || !str(task.id)) errors.push("$.task.id is missing");
  if (!obj(harness) || !str(harness.arm)) errors.push("$.harness.arm is missing");
  if (!obj(prov) || !str(prov.runId)) errors.push("$.provenance.runId is missing");
  if (!obj(prov) || !(prov.trialKey === null || str(prov.trialKey)))
    errors.push("$.provenance.trialKey is not a string or null");
  if (errors.length > 0) return { ok: false, errors };
  if (episodeIdOf(value) !== value.episodeId)
    return { ok: false, errors: ["$.episodeId is not the hash of the episode's content"] };
  const ep = value as unknown as EpisodeProjectionSource;
  return {
    ok: true,
    projection: {
      ref: {
        schema: EPISODE_SCHEMA,
        episodeId: ep.episodeId,
        sha256: sha256Hex(canonicalJson(value)),
      },
      runId: ep.provenance.runId,
      taskId: ep.task.id,
      arm: ep.harness.arm,
      simulated: ep.simulated,
      trialKey: ep.provenance.trialKey,
    },
  };
}
