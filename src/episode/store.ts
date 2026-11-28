/**
 * A local episode store (local-only default; nothing is uploaded):
 *
 *   <root>/STORE.json            { schema: "myco.episode-store/1", simulated }
 *   <root>/episodes/<id>.json    canonical JSON of one episode
 *   <root>/blobs/<sha256>.<ext>  content-addressed screenshots and state
 *   <root>/refused.jsonl         one line per refused episode: source, run id and issue CODES
 *                                only (never the offending content)
 *   <root>/hash-ledger.jsonl     the harness-side HASH LEDGER (#579 O3): one line per `h-<60 hex>`
 *                                value the harness produced, bound to its episode id and JSON
 *                                path. Written only by `importDataset` (export.ts), from a dataset
 *                                that validated; the export keeps an `h-<60 hex>` as is only when
 *                                this ledger records it there (src/export-guard/provenance.ts)
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
import { episodeScope, HashLedger, isHashedForm } from "../export-guard/provenance.ts";
import { buildEpisode, type EpisodeDraft } from "./build.ts";
import { currentHost, type HostFacts } from "./clean.ts";
import type { Episode, EpisodeBlobs } from "./types.ts";
import { canonicalJson, type EpisodeIssue, validateEpisode } from "./validate.ts";

const EPISODE_FILE = /^[0-9a-f]{64}\.json$/;
const BLOB_FILE = /^[0-9a-f]{64}\.(png|csv|json)$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** The store's hash ledger (#579 O3). */
export const HASH_LEDGER_FILE = "hash-ledger.jsonl";
export const HASH_LEDGER_SCHEMA = "myco.episode-hash-ledger/1";
/** A ledger path: a JSON path of plain keys and indexes (`$.actions.items[3].text`). */
const LEDGER_PATH = /^\$(?:\.[A-Za-z][A-Za-z0-9]{0,63}|\[\d{1,6}\]){1,16}$/;

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

  /**
   * Record harness-produced hashed values of a STORED episode in the hash ledger (#579 O3).
   * Only `importDataset` calls this, after the dataset validated and the episode was written:
   * the ledger is what lets a re-export keep exactly these `h-<60 hex>` values verbatim.
   */
  recordHashed(
    episodeId: string,
    leaves: readonly { readonly path: string; readonly value: string }[],
  ): void {
    if (!HEX64.test(episodeId) || !existsSync(join(this.root, "episodes", `${episodeId}.json`)))
      throw new Error("episode store: a hash-ledger entry names no stored episode");
    const lines = leaves.map((l) => {
      if (!LEDGER_PATH.test(l.path) || !isHashedForm(l.value))
        throw new Error("episode store: a hash-ledger entry is malformed");
      return `${canonicalJson({ schema: HASH_LEDGER_SCHEMA, episodeId, path: l.path, value: l.value })}\n`;
    });
    if (lines.length > 0) appendFileSync(join(this.root, HASH_LEDGER_FILE), lines.join(""));
  }

  /** Every episode in the store with its blobs (files that are not episodes or blobs are refused). */
  read(): {
    readonly episodes: readonly Episode[];
    readonly blobs: Map<string, Uint8Array>;
    readonly ledger: HashLedger;
  } {
    return readStoreDir(this.root);
  }
}

/**
 * A store's hash ledger (#579 O3). Missing: empty. Any line that is not exactly a ledger entry
 * (schema, a 64-hex episode id, a plain JSON path, an `h-<60 hex>` value, nothing else) refuses
 * the read: the ledger decides what leaves the machine verbatim, so it fails closed.
 */
export function readHashLedger(root: string): HashLedger {
  const ledger = new HashLedger();
  const file = join(root, HASH_LEDGER_FILE);
  if (!existsSync(file)) return ledger;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("episode store: the hash ledger is malformed");
    }
    const e = entry as Record<string, unknown> | null;
    const ok =
      e !== null &&
      typeof e === "object" &&
      !Array.isArray(e) &&
      Object.keys(e).sort().join(",") === "episodeId,path,schema,value" &&
      e.schema === HASH_LEDGER_SCHEMA &&
      typeof e.episodeId === "string" &&
      HEX64.test(e.episodeId) &&
      typeof e.path === "string" &&
      LEDGER_PATH.test(e.path) &&
      typeof e.value === "string" &&
      isHashedForm(e.value);
    if (!ok) throw new Error("episode store: the hash ledger is malformed");
    ledger.record(episodeScope(e.episodeId as string, e.path as string), e.value as string);
  }
  return ledger;
}

/** Read a store directory's episodes, blobs and hash ledger; any stray file fails closed. */
export function readStoreDir(root: string): {
  readonly episodes: readonly Episode[];
  readonly blobs: Map<string, Uint8Array>;
  readonly ledger: HashLedger;
} {
  for (const entry of readdirSync(root))
    if (!["STORE.json", "episodes", "blobs", "refused.jsonl", HASH_LEDGER_FILE].includes(entry))
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
  return { episodes, blobs, ledger: readHashLedger(root) };
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
