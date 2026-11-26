/**
 * Export a filtered set of episodes to a dataset directory, and validate one.
 *
 *   <out>/manifest.json            myco.episode-dataset/1 (counts, schema version, hashes,
 *                                  provenance; no timestamps, no host paths)
 *   <out>/episodes/<id>.json       canonical JSON of the CLOSED form of a store episode
 *                                  (closed.ts: every string allowlisted or hashed; no free text)
 *   <out>/blobs/<sha256>.<ext>     only the blobs the exported episodes reference
 *
 * Deterministic: the same stores and filter give byte-identical output (episodes sorted by
 * id, canonical JSON everywhere, no clock). Fail closed: every source episode is fully
 * validated (schema, rules, cleanliness, blob hashes) before anything is written, and a real
 * export refuses a simulated store (and the reverse), so the two never mix in one dataset.
 *
 * Closed (TIF-265, #553's allowlist pattern): what leaves the machine is `closeEpisode(ep)`, never
 * the stored text. Free text is replaced by its hashed form, ids outside the closed grammar are
 * hashed, and a closed field holding anything else refuses the export. `validateDataset` refuses a
 * dataset with any string outside its field's closed grammar. The cleanliness scan is a backstop.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EPISODE_DATASET_SCHEMA,
  EPISODE_OUTCOMES,
  EPISODE_SCHEMA,
  episodeDatasetManifestSchema,
} from "../../schemas/episode.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { currentHost, type HostFacts } from "./clean.ts";
import { closeEpisode, ExportInputError, openStrings } from "./closed.ts";
import { blobsFor, EpisodeStore, readStoreDir } from "./store.ts";
import type { Episode, EpisodeOutcome } from "./types.ts";
import { canonicalJson, sha256Hex, validateEpisode } from "./validate.ts";

export interface EpisodeFilter {
  readonly taskSetVersion: string | null;
  readonly arm: string | null;
  readonly outcome: EpisodeOutcome | null;
  /** Inclusive dates (YYYY-MM-DD) on `harness.timing.startedAt`; an undated episode is excluded. */
  readonly since: string | null;
  readonly until: string | null;
}

export const NO_FILTER: EpisodeFilter = {
  taskSetVersion: null,
  arm: null,
  outcome: null,
  since: null,
  until: null,
};

export interface DatasetManifest {
  readonly schema: typeof EPISODE_DATASET_SCHEMA;
  readonly episodeSchema: typeof EPISODE_SCHEMA;
  readonly simulated: boolean;
  readonly filter: EpisodeFilter;
  readonly counts: {
    readonly episodes: number;
    readonly blobs: number;
    readonly byOutcome: Record<string, number>;
    readonly byArm: Record<string, number>;
    readonly byTaskSet: Record<string, number>;
    readonly byFamily: Record<string, number>;
    readonly bySource: Record<string, number>;
  };
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly datasetSha256: string;
  readonly provenance: {
    readonly runs: number;
    readonly attemptLedgerHeads: readonly {
      readonly events: number;
      readonly headSha256: string;
    }[];
  };
}

export function matches(ep: Episode, f: EpisodeFilter): boolean {
  if (f.taskSetVersion !== null && ep.task.taskSetVersion !== f.taskSetVersion) return false;
  if (f.arm !== null && ep.harness.arm !== f.arm) return false;
  if (f.outcome !== null && ep.outcome !== f.outcome) return false;
  if (f.since !== null || f.until !== null) {
    const day = ep.harness.timing.startedAt?.slice(0, 10);
    if (day === undefined) return false;
    if (f.since !== null && day < f.since) return false;
    if (f.until !== null && day > f.until) return false;
  }
  return true;
}

function tally(eps: readonly Episode[], key: (e: Episode) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of eps) out[key(e)] = (out[key(e)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function manifestFor(
  episodes: readonly Episode[],
  files: DatasetManifest["files"],
  blobCount: number,
  simulated: boolean,
  filter: EpisodeFilter,
): DatasetManifest {
  const heads = new Map<string, { events: number; headSha256: string }>();
  for (const e of episodes) {
    const a = e.provenance.attemptLedger;
    if (a !== null)
      heads.set(`${a.events}:${a.headSha256}`, { events: a.events, headSha256: a.headSha256 });
  }
  return {
    schema: EPISODE_DATASET_SCHEMA,
    episodeSchema: EPISODE_SCHEMA,
    simulated,
    filter,
    counts: {
      episodes: episodes.length,
      blobs: blobCount,
      byOutcome: tally(episodes, (e) => e.outcome),
      byArm: tally(episodes, (e) => e.harness.arm),
      byTaskSet: tally(episodes, (e) => e.task.taskSetVersion ?? "(none)"),
      byFamily: tally(episodes, (e) => e.task.family),
      bySource: tally(episodes, (e) => e.provenance.source),
    },
    files,
    datasetSha256: sha256Hex(canonicalJson(files)),
    provenance: {
      runs: new Set(episodes.map((e) => e.provenance.runId)).size,
      attemptLedgerHeads: [...heads.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, v]) => v),
    },
  };
}

export function validateFilter(f: EpisodeFilter): void {
  const issues = validateSchema(f, episodeDatasetManifestSchema.properties?.filter ?? {});
  if (issues.length > 0)
    throw new Error(`invalid filter: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  if (f.outcome !== null && !(EPISODE_OUTCOMES as readonly string[]).includes(f.outcome))
    throw new Error(`invalid filter outcome ${f.outcome}`);
  // The filter is written to the manifest: its strings are closed too (never free text).
  if (f.taskSetVersion !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(f.taskSetVersion))
    throw new Error("invalid filter: taskSetVersion is not a closed task-set id");
  if (f.arm !== null && !/^[a-z0-9][a-z0-9+._-]{0,63}$/.test(f.arm))
    throw new Error("invalid filter: arm is not a closed arm id");
}

export function exportDataset(options: {
  readonly stores: readonly string[];
  readonly out: string;
  readonly simulated: boolean;
  readonly filter?: EpisodeFilter;
  readonly host?: HostFacts;
}): DatasetManifest {
  const filter = options.filter ?? NO_FILTER;
  validateFilter(filter);
  const host = options.host ?? currentHost();
  if (options.stores.length === 0) throw new Error("export: name at least one store");
  const byId = new Map<string, Episode>();
  const allBlobs = new Map<string, Uint8Array>();
  for (const root of options.stores) {
    const kind = EpisodeStore.readKind(root);
    if (kind !== options.simulated)
      throw new Error(
        `export refused: a ${kind ? "simulated" : "real"} store in a ${options.simulated ? "simulated" : "real"} export (simulated rows never mix into real datasets)`,
      );
    const { episodes, blobs } = readStoreDir(root);
    for (const ep of episodes) {
      const own = blobsFor(ep, blobs);
      const issues = validateEpisode(ep, { blobs: own, host });
      if (ep.simulated !== options.simulated)
        issues.push({
          code: "SIMULATED",
          path: "$.simulated",
          message: "episode label does not match its store",
        });
      if (issues.length > 0)
        throw new Error(
          `export refused: episode ${String(ep.episodeId).slice(0, 12)} is invalid (${[...new Set(issues.map((i) => i.code))].join(", ")})`,
        );
      // Only the closed form leaves the machine; it is validated again as written.
      let closedEp: Episode;
      try {
        closedEp = closeEpisode(ep);
      } catch (e) {
        if (e instanceof ExportInputError)
          throw new Error(`episode ${String(ep.episodeId).slice(0, 12)}: ${e.message}`);
        throw e;
      }
      const closedIssues = validateEpisode(closedEp, { blobs: own, host });
      if (closedIssues.length > 0)
        throw new Error(
          `export refused: the closed form of episode ${String(ep.episodeId).slice(0, 12)} is invalid (${[...new Set(closedIssues.map((i) => i.code))].join(", ")})`,
        );
      byId.set(closedEp.episodeId, closedEp);
      for (const [k, v] of own) allBlobs.set(k, v);
    }
  }
  const selected = [...byId.values()]
    .filter((e) => matches(e, filter))
    .sort((a, b) => (a.episodeId < b.episodeId ? -1 : 1));

  if (existsSync(options.out) && readdirSync(options.out).length > 0)
    throw new Error("export refused: the output directory is not empty");
  mkdirSync(join(options.out, "episodes"), { recursive: true });
  mkdirSync(join(options.out, "blobs"), { recursive: true });
  const files: { path: string; sha256: string; bytes: number }[] = [];
  const usedBlobs = new Set<string>();
  for (const ep of selected) {
    const bytes = Buffer.from(`${canonicalJson(ep)}\n`);
    const path = `episodes/${ep.episodeId}.json`;
    writeFileSync(join(options.out, path), bytes);
    files.push({ path, sha256: sha256Hex(bytes), bytes: bytes.length });
    for (const file of blobsFor(ep, allBlobs).keys()) usedBlobs.add(file);
  }
  for (const file of [...usedBlobs].sort()) {
    const bytes = allBlobs.get(file) as Uint8Array;
    writeFileSync(join(options.out, file), bytes);
    files.push({ path: file, sha256: sha256Hex(bytes), bytes: bytes.length });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = manifestFor(selected, files, usedBlobs.size, options.simulated, filter);
  writeFileSync(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Validate an exported dataset. Returns problems (empty = valid); never throws on bad data. */
export function validateDataset(dir: string, host: HostFacts = currentHost()): string[] {
  const problems: string[] = [];
  let manifest: DatasetManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as DatasetManifest;
  } catch {
    return ["manifest.json is missing or not JSON"];
  }
  const schemaIssues = validateSchema(manifest, episodeDatasetManifestSchema);
  if (schemaIssues.length > 0)
    return schemaIssues.map((i) => `manifest ${i.path}: ${i.keyword} ${i.message}`);

  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const onDisk = new Set<string>();
  for (const entry of readdirSync(dir)) {
    if (entry === "manifest.json") continue;
    if (entry !== "episodes" && entry !== "blobs") {
      problems.push(`unexpected entry ${JSON.stringify(entry)}`);
      continue;
    }
    for (const name of readdirSync(join(dir, entry))) onDisk.add(`${entry}/${name}`);
  }
  for (const p of onDisk) if (!listed.has(p)) problems.push(`${p} is not in the manifest`);
  const blobs = new Map<string, Uint8Array>();
  const episodes: Episode[] = [];
  for (const f of manifest.files) {
    if (!onDisk.has(f.path)) {
      problems.push(`${f.path} is listed but missing`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(join(dir, f.path)));
    if (sha256Hex(bytes) !== f.sha256 || bytes.length !== f.bytes)
      problems.push(`${f.path} does not match its manifest hash`);
    if (f.path.startsWith("blobs/")) blobs.set(f.path, bytes);
    else {
      try {
        const ep = JSON.parse(Buffer.from(bytes).toString("utf8")) as Episode;
        if (`episodes/${ep.episodeId}.json` !== f.path)
          problems.push(`${f.path} holds another episode id`);
        if (Buffer.from(bytes).toString("utf8") !== `${canonicalJson(ep)}\n`)
          problems.push(`${f.path} is not canonical JSON`);
        episodes.push(ep);
      } catch {
        problems.push(`${f.path} is not JSON`);
      }
    }
  }
  const referenced = new Set<string>();
  for (const ep of episodes) {
    const own = blobsFor(ep, blobs);
    for (const k of own.keys()) referenced.add(k);
    const issues = validateEpisode(ep, { blobs: own, host });
    for (const i of issues)
      problems.push(`episode ${String(ep.episodeId).slice(0, 12)}: ${i.code} at ${i.path}`);
    for (const path of openStrings(ep))
      problems.push(
        `episode ${String(ep.episodeId).slice(0, 12)}: OPEN_STRING at ${path} (not a closed value)`,
      );
    if (ep.simulated !== manifest.simulated)
      problems.push(
        `episode ${String(ep.episodeId).slice(0, 12)}: simulated=${ep.simulated} in a ${manifest.simulated ? "simulated" : "real"} dataset`,
      );
    if (!matches(ep, manifest.filter))
      problems.push(
        `episode ${String(ep.episodeId).slice(0, 12)} does not match the manifest filter`,
      );
  }
  for (const b of blobs.keys())
    if (!referenced.has(b)) problems.push(`${b} is not referenced by any episode`);
  const expected = manifestFor(
    [...episodes].sort((a, b) => (a.episodeId < b.episodeId ? -1 : 1)),
    manifest.files,
    blobs.size,
    manifest.simulated,
    manifest.filter,
  );
  if (canonicalJson(expected) !== canonicalJson(manifest))
    problems.push("manifest counts, hashes or provenance do not match the dataset");
  return problems;
}

/** Validate a dataset, then copy its episodes into a store of the same kind. */
export function importDataset(dir: string, storeRoot: string, host: HostFacts = currentHost()) {
  const problems = validateDataset(dir, host);
  if (problems.length > 0)
    throw new Error(`import refused: ${problems.length} problem(s): ${problems[0]}`);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as DatasetManifest;
  const store = EpisodeStore.open(storeRoot, { simulated: manifest.simulated, host });
  const blobs = new Map<string, Uint8Array>();
  for (const f of manifest.files)
    if (f.path.startsWith("blobs/"))
      blobs.set(f.path, new Uint8Array(readFileSync(join(dir, f.path))));
  return manifest.files
    .filter((f) => f.path.startsWith("episodes/"))
    .map((f) => {
      const ep = JSON.parse(readFileSync(join(dir, f.path), "utf8")) as Episode;
      return store.write(ep, blobsFor(ep, blobs));
    });
}
