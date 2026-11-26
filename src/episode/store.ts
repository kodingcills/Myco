/**
 * A local episode store (local-only default; nothing is uploaded):
 *
 *   <root>/STORE.json            { schema: "myco.episode-store/1", simulated }
 *   <root>/episodes/<id>.json    canonical JSON of one episode
 *   <root>/blobs/<sha256>.<ext>  content-addressed screenshots and state
 *   <root>/refused.jsonl         one line per refused episode: source, run id and issue CODES
 *                                only (never the offending content)
 *
 * A store is either real or simulated, fixed when it is created: a simulated episode is never
 * written to a real store, or the reverse, so simulated rows cannot mix into a real dataset.
 * Writes are append-only: an existing episode file is never replaced by different bytes.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { EPISODE_STORE_SCHEMA, episodeStoreSchema } from "../../schemas/episode.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { buildEpisode, type EpisodeDraft } from "./build.ts";
import { currentHost, type HostFacts } from "./clean.ts";
import type { Episode, EpisodeBlobs } from "./types.ts";
import { canonicalJson, type EpisodeIssue, validateEpisode } from "./validate.ts";

const EPISODE_FILE = /^[0-9a-f]{64}\.json$/;
const BLOB_FILE = /^[0-9a-f]{64}\.(png|csv|json)$/;

/** Places an episode store must never live (the Sai ledger, secrets, evidence packs). */
export function forbiddenStoreRoot(root: string): string | null {
  const abs = `${resolve(root)}${sep}`.split("\\").join("/");
  if (/\/scripts\/sai\//.test(abs)) return "scripts/sai (the Sai ledger is never captured)";
  if (/\/\.myco\/secrets\//.test(abs)) return "~/.myco/secrets";
  if (/\/docs\/research\/experiments\//.test(abs))
    return "docs/research/experiments (evidence packs)";
  return null;
}

export type WriteResult =
  | { readonly status: "written" | "exists"; readonly episodeId: string }
  | { readonly status: "refused"; readonly issues: readonly EpisodeIssue[] };

export class EpisodeStore {
  readonly root: string;
  readonly simulated: boolean;
  readonly #host: HostFacts;

  private constructor(root: string, simulated: boolean, host: HostFacts) {
    this.root = root;
    this.simulated = simulated;
    this.#host = host;
  }

  /** Open (or create) a store. The real/simulated kind must match an existing store's. */
  static open(
    root: string,
    options: { readonly simulated: boolean; readonly host?: HostFacts },
  ): EpisodeStore {
    const why = forbiddenStoreRoot(root);
    if (why !== null) throw new Error(`episode store refused: it may not live under ${why}`);
    const manifest = join(root, "STORE.json");
    if (existsSync(manifest)) {
      const kind = EpisodeStore.readKind(root);
      if (kind !== options.simulated)
        throw new Error(
          `episode store refused: it holds ${kind ? "simulated" : "real"} episodes, not ${options.simulated ? "simulated" : "real"} ones`,
        );
    } else {
      mkdirSync(root, { recursive: true });
      if (readdirSync(root).length > 0)
        throw new Error("episode store refused: a new store needs an empty directory");
      writeFileSync(
        manifest,
        `${canonicalJson({ schema: EPISODE_STORE_SCHEMA, simulated: options.simulated })}\n`,
      );
    }
    mkdirSync(join(root, "episodes"), { recursive: true });
    mkdirSync(join(root, "blobs"), { recursive: true });
    return new EpisodeStore(realpathSync(root), options.simulated, options.host ?? currentHost());
  }

  /** The store's kind from its STORE.json (true: simulated). Throws on a malformed manifest. */
  static readKind(root: string): boolean {
    const parsed: unknown = JSON.parse(readFileSync(join(root, "STORE.json"), "utf8"));
    if (validateSchema(parsed, episodeStoreSchema).length > 0)
      throw new Error("episode store refused: STORE.json is not a myco.episode-store/1 manifest");
    return (parsed as { simulated: boolean }).simulated;
  }

  /** Validate and write an episode and its blobs; a refusal is logged by code and returned. */
  write(episode: Episode, blobs: EpisodeBlobs): WriteResult {
    const issues = validateEpisode(episode, { blobs, host: this.#host });
    if (episode.simulated !== this.simulated)
      return this.#refuse(episode.provenance?.source, episode.provenance?.runId, [
        {
          code: "SIMULATED",
          path: "$.simulated",
          message: `a ${episode.simulated ? "simulated" : "real"} episode in a ${this.simulated ? "simulated" : "real"} store`,
        },
      ]);
    if (issues.length > 0)
      return this.#refuse(episode.provenance?.source, episode.provenance?.runId, issues);
    for (const [file, bytes] of blobs) {
      const path = join(this.root, file);
      if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx" });
    }
    const bytes = `${canonicalJson(episode)}\n`;
    const path = join(this.root, "episodes", `${episode.episodeId}.json`);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== bytes)
        throw new Error(`episode store: ${episode.episodeId} exists with different bytes`);
      return { status: "exists", episodeId: episode.episodeId };
    }
    writeFileSync(path, bytes, { flag: "wx" });
    return { status: "written", episodeId: episode.episodeId };
  }

  /** Build from a draft, then write. Build refusals are logged the same way. */
  record(draft: EpisodeDraft, blobs: EpisodeBlobs = new Map()): WriteResult {
    const built = buildEpisode(draft, blobs, this.#host);
    if (!built.ok)
      return this.#refuse(draft.provenance.source, draft.provenance.runId, built.issues);
    return this.write(built.episode, built.blobs);
  }

  #refuse(source: unknown, runId: unknown, issues: readonly EpisodeIssue[]): WriteResult {
    const safe = (v: unknown) =>
      typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v) ? v : null;
    const codes = [...new Set(issues.map((i) => i.code))].sort();
    appendFileSync(
      join(this.root, "refused.jsonl"),
      `${canonicalJson({ schema: "myco.episode-refusal/1", source: safe(source), runId: safe(runId), codes })}\n`,
    );
    return { status: "refused", issues };
  }

  /** Every episode in the store with its blobs (files that are not episodes or blobs are refused). */
  read(): { readonly episodes: readonly Episode[]; readonly blobs: Map<string, Uint8Array> } {
    return readStoreDir(this.root);
  }
}

/** Read a store directory's episodes and blobs; any stray file fails closed. */
export function readStoreDir(root: string): {
  readonly episodes: readonly Episode[];
  readonly blobs: Map<string, Uint8Array>;
} {
  for (const entry of readdirSync(root))
    if (!["STORE.json", "episodes", "blobs", "refused.jsonl"].includes(entry))
      throw new Error(`episode store: unexpected entry ${JSON.stringify(entry)}`);
  const episodes: Episode[] = [];
  for (const name of readdirSync(join(root, "episodes")).sort()) {
    if (!EPISODE_FILE.test(name))
      throw new Error(`episode store: unexpected file episodes/${name}`);
    episodes.push(JSON.parse(readFileSync(join(root, "episodes", name), "utf8")) as Episode);
  }
  const blobs = new Map<string, Uint8Array>();
  for (const name of readdirSync(join(root, "blobs")).sort()) {
    if (!BLOB_FILE.test(name)) throw new Error(`episode store: unexpected file blobs/${name}`);
    blobs.set(`blobs/${name}`, new Uint8Array(readFileSync(join(root, "blobs", name))));
  }
  return { episodes, blobs };
}

/** The blobs one episode references. */
export function blobsFor(
  episode: Episode,
  all: ReadonlyMap<string, Uint8Array>,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const o of episode.observations.items) {
    if (o.kind === "ui-status") continue;
    const bytes = all.get(o.file);
    if (bytes !== undefined) out.set(o.file, bytes);
  }
  return out;
}
