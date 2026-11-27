/**
 * Dataset exporter (track U, docs/product/linux-scale.md §6). Builds a clean dataset FROM
 * canonical `myco.episode/1` records (#538 §3, #542; mirrored in `./episode.ts`): the
 * export is a container that copies each selected episode byte for byte and adds one thin
 * record per episode (label, desktop backend facts, capture location), plus a manifest and
 * the schemas (`schemas/dataset-export.ts`). It defines no per-attempt record of its own.
 *
 * Which episodes are exported (fail closed; every rule is pinned by
 * test/dataset/export.test.ts and mutation-proved by scripts/desktops-mutation-proof.sh):
 *  - **positive** only when ALL hold: the raw gate result (`myco.gate/v1`) is bound to this
 *    episode's task id and run id and agrees with the episode's gate record; it said
 *    `verified` and accepted; the independent grader's ground truth graded the captured
 *    bytes `pass` (its `persistedSha256` is the digest the exporter computes from the
 *    captured bytes itself, and its fixture digest is the task set's); and the agent
 *    claimed done. A pass without a done claim is "correct, not claimed", not verified.
 *  - **negative** only when the operator passes `includeNegatives`, and only for an episode
 *    the gate refuted AND the grader graded `fail`, labelled `negative`.
 *  - everything else (uncertain, ungradable, gate/grader disagreement, unbound or missing
 *    records) is excluded and counted by code in the manifest.
 *
 * Blobs are DIGEST-ONLY (lead ruling 2026-11-26 20:3xZ): the captured persisted document each
 * exported episode graded is never written. The episode's `state` / `persisted` / `text/csv`
 * observation (which #542 requires of a graded episode) carries its sha256, byte count and
 * content-addressed name; the captured bytes bind the grade and are scanned raw, never carried.
 *
 * What refuses the WHOLE export (nothing is written): an episode that is not a valid
 * `myco.episode/1` under every rule of #542's `validateEpisode` at the pinned head
 * (`episodeProblem`), or that carries a blob other than one persisted CSV document; a leak
 * (host path, user or host name, planted marker, operator-named string, secret-shaped
 * string) anywhere in ANY output file (episodes, records, manifest, schema) or in a captured
 * document (scanned raw, never written), or a captured document that is not UTF-8 text and so
 * cannot be scanned; a value the allowlist may neither keep nor
 * hash (`OPEN_VALUE`, closed.ts);
 * a scripted, mock or non-gated episode not labelled simulated; a duplicate trial, run or
 * episode; a record that fails its schema; an existing output directory. A refusal names
 * the code and a location (file and JSON path, or candidate index), never the offending
 * value. A dataset is never scorecard evidence (`evidence: false`).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DATASET_EXCLUSION_CODES,
  DATASET_MANIFEST_SCHEMA_ID,
  DATASET_RECORD_SCHEMA_ID,
  datasetManifestSchema,
  datasetRecordSchema,
} from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { HashLedger } from "../export-guard/provenance.ts";
import {
  closeEpisode,
  closeRecordFields,
  hashLedgerOf,
  joinedIdentity,
  manifestIdentity,
  OpenValueError,
  openEpisodeStrings,
  openRecordStrings,
} from "./closed.ts";
import {
  canonicalJson,
  EPISODE_MIRROR_PINNED_AT,
  EPISODE_REAL_PLANNERS,
  EPISODE_SCHEMA,
  type Episode,
  episodeIdOf,
  episodeMirrorSchema,
  persistedBlobFile,
  sha256Hex,
} from "./episode.ts";
import { type HygieneOptions, identityStrings, scanForLeaks } from "./hygiene.ts";

export { canonicalJson, sha256Hex };
export const EXPORTER_VERSION = "myco-dataset-exporter/3";
const GATE_API = "myco.gate/v1";

/** The fields of a `myco.gate/v1` GateResult the exporter reads (structurally compatible). */
export interface GateLike {
  readonly apiVersion: string;
  readonly verdict: string;
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[];
  readonly request: { readonly taskId?: string; readonly runId?: string };
}

/** Track U's own facts about the desktop that ran the attempt. */
export interface DesktopFacts {
  readonly backend: string;
  readonly isolation: "process" | "container" | "microvm";
  readonly networkEnforced: boolean;
  readonly image: string;
}

export interface ExportCandidate {
  /** The canonical record of the attempt. */
  readonly episode: Episode;
  /** The task set's declared fixture digest; the grade must be against this fixture. */
  readonly fixtureSha256: string;
  /** The raw gate result for this attempt (binds the episode's gate record to its trial). */
  readonly gate: GateLike | null;
  /** The bytes the harness captured after the agent stopped, or null if nothing was captured. */
  readonly capture: {
    readonly path: string;
    /** CSV only: #542 stores a persisted document as a `text/csv` state observation. */
    readonly format: "csv";
    readonly bytes: Uint8Array;
  } | null;
  readonly desktop: DesktopFacts;
}

/** The exclusion codes; the manifest schema closes `counts.excluded` over the same list. */
export const EXCLUSION_CODES = DATASET_EXCLUSION_CODES;
export type ExclusionCode = (typeof EXCLUSION_CODES)[number];

export type Classification =
  | { readonly label: "positive" | "negative" }
  | { readonly excluded: ExclusionCode };

export const REFUSAL_CODES = [
  "EPISODE_INVALID",
  "LEAK",
  "SIMULATED_UNLABELLED",
  "DUPLICATE_TRIAL",
  "SCHEMA_INVALID",
  "OUT_EXISTS",
  "OPEN_VALUE",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** The whole export was refused. `where` is a file/candidate and JSON path; never a value. */
export class ExportRefused extends Error {
  readonly code: RefusalCode;
  readonly where: string;
  readonly detail: string;
  constructor(code: RefusalCode, where: string, detail = "") {
    super(`${code} at ${where}${detail ? ` (${detail})` : ""}`);
    this.name = "ExportRefused";
    this.code = code;
    this.where = where;
    this.detail = detail;
  }
}

const sameCodes = (a: readonly string[] | null, b: readonly string[]): boolean =>
  a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Decides whether one episode is a positive, a negative, or excluded. Pure; no I/O. Any
 * failed binding excludes the episode before its verdict is looked at, so an unbound
 * "verified" never becomes a positive.
 */
export function classify(c: ExportCandidate, includeNegatives: boolean): Classification {
  const ep = c.episode;
  if (c.gate === null || ep.gate === null) return { excluded: "MISSING_GATE" };
  const truth = ep.groundTruth;
  if (truth.source !== "independent-grader") return { excluded: "MISSING_GRADE" };
  if (c.capture === null) return { excluded: "MISSING_CAPTURE" };
  const gate = c.gate;
  const verdicts = ["verified", "refuted", "uncertain"];
  if (
    gate.apiVersion !== GATE_API ||
    !verdicts.includes(gate.verdict) ||
    gate.accepted !== (gate.verdict === "verified")
  ) {
    return { excluded: "GATE_MALFORMED" };
  }
  // The gate is bound to one trial: its answer counts only for this episode's task and run.
  if (gate.request.taskId !== ep.task.id || gate.request.runId !== ep.provenance.runId) {
    return { excluded: "GATE_NOT_BOUND" };
  }
  // The episode's gate record must be exactly that answer (verdict, accepted, codes).
  if (
    ep.gate.verdict !== gate.verdict ||
    ep.gate.accepted !== gate.accepted ||
    !sameCodes(ep.gate.reasonCodes, gate.reasonCodes)
  ) {
    return { excluded: "GATE_EPISODE_MISMATCH" };
  }
  // The grade counts only if it graded exactly the bytes captured for this attempt, against
  // the task set's declared fixture. The digest is recomputed here, never taken on trust.
  const captured = sha256Hex(c.capture.bytes);
  if (
    truth.persistedSha256 !== captured ||
    truth.fixtureSha256 !== c.fixtureSha256 ||
    ep.task.fixtureSha256 !== c.fixtureSha256
  ) {
    return { excluded: "GRADE_NOT_BOUND" };
  }
  if (gate.verdict === "uncertain") return { excluded: "GATE_UNCERTAIN" };
  if (truth.status !== "pass" && truth.status !== "fail") {
    return { excluded: "GRADE_UNGRADABLE" };
  }
  if (gate.verdict === "verified" && gate.accepted && truth.status === "pass") {
    return ep.agentClaim === "done" ? { label: "positive" } : { excluded: "NOT_CLAIMED" };
  }
  if (gate.verdict === "refuted" && !gate.accepted && truth.status === "fail") {
    return includeNegatives ? { label: "negative" } : { excluded: "NEGATIVES_NOT_REQUESTED" };
  }
  return { excluded: "GATE_GRADER_DISAGREE" };
}

/**
 * #542's SIMULATED rule: an episode is real only from a gated trial whose planner is a real
 * planner id (`EPISODE_REAL_PLANNERS`). A scripted planner, an unknown planner, or anything
 * but a gated trial must be labelled simulated.
 */
function mustBeSimulated(ep: Episode): boolean {
  return (
    ep.harness.plannerModelId === null ||
    !EPISODE_REAL_PLANNERS.has(ep.harness.plannerModelId) ||
    ep.provenance.source !== "gated-trial"
  );
}

/**
 * Checks an episode against the mirrored `myco.episode/1` contract: #542's closed schema and
 * every rule of #542's `validateEpisode` at `EPISODE_MIRROR_PINNED_AT` (ID_MISMATCH, SEQ,
 * OUTCOME, GROUND_TRUTH incl. the document-observation binding, SIMULATED, COST, BLOB_*),
 * plus U's own blob limit (only a persisted CSV document is carried). Returns the first
 * problem's JSON path and code, or null. #542's cleanliness scan is covered by the
 * exporter's leak scan, which runs over every output file (blobs included).
 */
export function episodeProblem(
  ep: unknown,
  blobs?: ReadonlyMap<string, Uint8Array>,
): { path: string; detail: string } | null {
  const issues = validateSchema(ep, episodeMirrorSchema);
  if (issues.length > 0) return { path: issues[0]!.path, detail: issues[0]!.keyword };
  const e = ep as Episode;
  if (episodeIdOf(e) !== e.episodeId) return { path: "$.episodeId", detail: "ID_MISMATCH" };
  // SEQ
  for (const [i, a] of e.actions.items.entries()) {
    if (a.seq !== i) return { path: `$.actions.items[${i}]`, detail: "SEQ" };
  }
  for (const [i, o] of e.observations.items.entries()) {
    if (o.seq !== i || (o.afterAction !== null && o.afterAction >= e.actions.items.length)) {
      return { path: `$.observations.items[${i}]`, detail: "SEQ" };
    }
  }
  if (e.actions.capture === "not-recorded" && (e.actions.items.length > 0 || e.actions.truncated))
    return { path: "$.actions", detail: "SEQ" };
  if (
    e.observations.capture === "not-recorded" &&
    (e.observations.items.length > 0 || e.observations.withheld > 0)
  )
    return { path: "$.observations", detail: "SEQ" };
  // BLOBS (U's limit): the container carries one persisted CSV document and nothing else.
  let persisted: { sha256: string; bytes: number; file: string } | undefined;
  let persistedAt = "$";
  for (const [i, o] of e.observations.items.entries()) {
    if (o.kind === "ui-status") continue;
    if (
      o.kind !== "state" ||
      o.label !== "persisted" ||
      o.mediaType !== "text/csv" ||
      persisted !== undefined
    ) {
      return { path: `$.observations.items[${i}]`, detail: "BLOBS_UNSUPPORTED" };
    }
    persisted = o;
    persistedAt = `$.observations.items[${i}]`;
  }
  // OUTCOME
  if ((e.outcome === "harness-fault") !== (e.harness.fault !== null))
    return { path: "$.outcome", detail: "OUTCOME_FAULT_MISMATCH" };
  const decided = ["verified", "refuted", "uncertain"];
  if (decided.includes(e.outcome) && e.gate?.verdict !== e.outcome) {
    return { path: "$.outcome", detail: "OUTCOME_GATE_MISMATCH" };
  }
  if ((e.outcome === "launch-refused" || e.outcome === "unregistrable") && e.gate !== null)
    return { path: "$.gate", detail: "OUTCOME_GATE_MISMATCH" };
  if (e.gate !== null && e.gate.accepted !== (e.gate.verdict === "verified")) {
    return { path: "$.gate.accepted", detail: "ACCEPTED_VERDICT_MISMATCH" };
  }
  // GROUND_TRUTH
  const gt = e.groundTruth;
  const faultTruth = gt.source === "none" && gt.reason === "harness-fault";
  if ((e.outcome === "harness-fault") !== faultTruth)
    return { path: "$.groundTruth", detail: "GROUND_TRUTH_FAULT" };
  if (
    gt.source === "none" &&
    gt.reason === "document-withheld" &&
    (e.observations.withheld === 0 || persisted !== undefined)
  )
    return { path: "$.groundTruth", detail: "GROUND_TRUTH_WITHHELD" };
  if (gt.source === "independent-grader") {
    if (gt.persistedSha256 === null && gt.status !== "ungradable")
      return { path: "$.groundTruth.status", detail: "GROUND_TRUTH_NO_DOCUMENT" };
    // Bound both ways (#542): a captured document is the graded one, and a graded document
    // is captured in the episode.
    if ((persisted?.sha256 ?? null) !== gt.persistedSha256)
      return { path: "$.groundTruth.persistedSha256", detail: "GROUND_TRUTH_DOCUMENT" };
    if (e.task.fixtureSha256 !== null && gt.fixtureSha256 !== e.task.fixtureSha256)
      return { path: "$.groundTruth.fixtureSha256", detail: "GROUND_TRUTH_FIXTURE" };
  }
  // SIMULATED is #542's rule too; the exporter reports it as SIMULATED_UNLABELLED
  // (see mustBeSimulated).
  // COST
  const cost = e.harness.cost;
  if (cost.estimateUsd !== null && (cost.inputTokens === null || cost.outputTokens === null))
    return { path: "$.harness.cost", detail: "COST" };
  // BLOB_* (when a consumer supplies the blobs, e.g. re-validating an export). A capture the
  // episode does not reference is not an error here: such an episode is not graded on it, so
  // classify() excludes it (MISSING_GRADE / GRADE_NOT_BOUND) and the capture is never written.
  if (blobs !== undefined && persisted !== undefined) {
    const bytes = blobs.get(persisted.file);
    if (bytes === undefined) return { path: persistedAt, detail: "BLOB_MISSING" };
    if (
      sha256Hex(bytes) !== persisted.sha256 ||
      bytes.byteLength !== persisted.bytes ||
      persisted.file !== `blobs/${persisted.sha256}.csv`
    )
      return { path: persistedAt, detail: "BLOB_HASH" };
  }
  return null;
}

const episodeFile = (id: string) => `episodes/${id}.json`;

/**
 * Scans every output file before anything is written. Every output is JSON (or JSON lines),
 * so every byte is structure, a number, a boolean, or a key or string the scan walks (each
 * in every decoded form, see hygiene.ts). Returns the first leak's location.
 */
function firstLeak(
  files: ReadonlyArray<readonly [string, string]>,
  hygiene: HygieneOptions | undefined,
): { where: string; kind: string } | null {
  for (const [name, text] of files) {
    if (name.startsWith("blobs/")) {
      // A captured document: raw text, scanned as one string (every decoded form).
      const leaks = scanForLeaks(text, hygiene);
      if (leaks.length > 0) return { where: `${name}:${leaks[0]!.path}`, kind: leaks[0]!.kind };
      continue;
    }
    const docs = name.endsWith(".jsonl")
      ? text
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l, i) => [`${name}#${i + 1}`, l] as const)
      : [[name, text] as const];
    for (const [where, doc] of docs) {
      const leaks = scanForLeaks(JSON.parse(doc), hygiene);
      if (leaks.length > 0) return { where: `${where}:${leaks[0]!.path}`, kind: leaks[0]!.kind };
    }
  }
  return null;
}

export interface ExportOptions {
  /** Directory to create. Must not exist; it appears only when the export succeeds. */
  readonly outDir: string;
  /** Export refuted+fail episodes as labelled negatives. Default false. */
  readonly includeNegatives?: boolean;
  readonly hygiene?: HygieneOptions;
  /** Clock for `createdAt` (tests pin it). */
  readonly now?: () => Date;
  /**
   * The harness's hash ledger (#579 O3): the ONLY `h-<60 hex>` inputs written as is, each bound
   * to its episode id and path. Built by the harness from a container it wrote
   * (`containerHashLedger`), never from run inputs. Default: none, so every `h-<60 hex>` input
   * (an agent's) is re-hashed.
   */
  readonly hashLedger?: HashLedger;
}

export interface ExportResult {
  readonly outDir: string;
  readonly manifest: Record<string, unknown>;
  readonly excluded: ReadonlyArray<{ readonly episodeId: string; readonly code: ExclusionCode }>;
}

export function exportDataset(
  candidates: readonly ExportCandidate[],
  options: ExportOptions,
): ExportResult {
  const includeNegatives = options.includeNegatives === true;
  // Identity strings (lead ruling 21:52Z): this machine's account and host name, read now, the
  // caller's planted identity and the identity file. Ids and tokens holding one are digested.
  const joined = identityStrings(options.hygiene);
  if (existsSync(options.outDir)) throw new ExportRefused("OUT_EXISTS", "outDir");

  const trialKeys = new Set<string>();
  const runIds = new Set<string>();
  const episodeIds = new Set<string>();
  for (const [i, c] of candidates.entries()) {
    // Structure and #542's rules. The captured document is bound by classify(): an exported
    // episode's persisted observation hashes to the grade's digest, which must equal the
    // digest of the captured bytes (which are never written: digest-only).
    const problem = episodeProblem(c.episode);
    if (problem !== null) {
      throw new ExportRefused(
        "EPISODE_INVALID",
        `candidates[${i}]:${problem.path}`,
        problem.detail,
      );
    }
    const ep = c.episode;
    const trialKey = ep.provenance.trialKey;
    if (
      (trialKey !== null && trialKeys.has(trialKey)) ||
      runIds.has(ep.provenance.runId) ||
      episodeIds.has(ep.episodeId)
    ) {
      throw new ExportRefused("DUPLICATE_TRIAL", `candidates[${i}]`);
    }
    if (trialKey !== null) trialKeys.add(trialKey);
    runIds.add(ep.provenance.runId);
    episodeIds.add(ep.episodeId);
    if (mustBeSimulated(ep) && ep.simulated !== true) {
      throw new ExportRefused("SIMULATED_UNLABELLED", `candidates[${i}]`);
    }
  }

  const exported: Array<{
    episodeId: string;
    label: "positive" | "negative";
    simulated: boolean;
    episodeText: string;
    line: string;
    /** The raw (pre-closure) views, scanned for leaks as a signal, never written. */
    rawEpisodeFile: string;
    rawEpisodeText: string;
    rawLine: string;
    blob: { file: string; bytes: Uint8Array };
  }> = [];
  const excluded: Array<{ episodeId: string; code: ExclusionCode }> = [];
  const sorted = [...candidates].sort((a, b) =>
    a.episode.episodeId < b.episode.episodeId
      ? -1
      : a.episode.episodeId > b.episode.episodeId
        ? 1
        : 0,
  );
  for (const c of sorted) {
    const decision = classify(c, includeNegatives);
    if ("excluded" in decision) {
      excluded.push({ episodeId: c.episode.episodeId, code: decision.excluded });
      continue;
    }
    // classify() has proven the capture present and bound to the grade.
    const capture = c.capture!;
    // Only the CLOSED form leaves the machine (closed.ts, TIF-265): free text hashed, ids
    // closed or hashed, a closed field holding anything else refuses the export. The closed
    // episode must pass every rule, BLOB_* included against the captured bytes: its persisted
    // observation names exactly the document the grade is bound to (the bytes themselves are
    // never written). Closing never touches a digest or a blob file name.
    let closedEp: Episode;
    try {
      closedEp = closeEpisode(c.episode, joined, options.hashLedger);
    } catch (error) {
      if (error instanceof OpenValueError)
        throw new ExportRefused("OPEN_VALUE", `${episodeFile(c.episode.episodeId)}:${error.path}`);
      throw error;
    }
    const closedProblem = episodeProblem(
      closedEp,
      new Map([[persistedBlobFile(capture.bytes), capture.bytes]]),
    );
    if (closedProblem !== null) {
      throw new ExportRefused(
        "EPISODE_INVALID",
        `${episodeFile(c.episode.episodeId)}:${closedProblem.path}`,
        closedProblem.detail,
      );
    }
    const rawEpisodeText = `${canonicalJson(c.episode)}\n`;
    const episodeText = `${canonicalJson(closedEp)}\n`;
    const rawRecord = {
      schema: DATASET_RECORD_SCHEMA_ID,
      label: decision.label,
      episode: {
        schema: EPISODE_SCHEMA,
        id: c.episode.episodeId,
        sha256: sha256Hex(rawEpisodeText),
        file: episodeFile(c.episode.episodeId),
      },
      desktop: {
        backend: c.desktop.backend,
        isolation: c.desktop.isolation,
        networkEnforced: c.desktop.networkEnforced,
        image: c.desktop.image,
      },
      capture: { path: capture.path, format: capture.format, size: capture.bytes.byteLength },
    };
    const record = closeRecordFields(
      {
        ...rawRecord,
        episode: {
          schema: EPISODE_SCHEMA,
          id: closedEp.episodeId,
          sha256: sha256Hex(episodeText),
          file: episodeFile(closedEp.episodeId),
        },
      },
      joined,
      options.hashLedger,
    );
    // An identity string left in a closed pattern field (a task family, a version) refuses.
    const named = [
      ...joinedIdentity(closedEp, joined).map((x) => ({
        ...x,
        file: episodeFile(closedEp.episodeId),
      })),
      ...joinedIdentity(record, joined, "record").map((x) => ({ ...x, file: "records.jsonl" })),
    ];
    if (named.length > 0)
      throw new ExportRefused("LEAK", `${named[0]!.file}:${named[0]!.path}`, named[0]!.kind);
    const issues = validateSchema(record, datasetRecordSchema);
    if (issues.length > 0) {
      throw new ExportRefused(
        "SCHEMA_INVALID",
        `${episodeFile(c.episode.episodeId)}:record${issues[0]!.path.slice(1)}`,
        issues[0]!.keyword,
      );
    }
    exported.push({
      episodeId: closedEp.episodeId,
      label: decision.label,
      simulated: c.episode.simulated,
      episodeText,
      line: canonicalJson(record),
      rawEpisodeFile: episodeFile(c.episode.episodeId),
      rawEpisodeText,
      rawLine: canonicalJson(rawRecord),
      blob: { file: persistedBlobFile(capture.bytes), bytes: capture.bytes },
    });
  }

  // Records are sorted by the (closed) episode id they reference.
  exported.sort((a, b) => (a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0));

  // The captured persisted documents. DIGEST-ONLY (lead ruling 2026-11-26 20:3xZ): they are never
  // written; each exported episode's `state`/`persisted` observation carries the document's
  // sha256, byte count and content-addressed name. They are still scanned raw (UTF-8 text only),
  // so a planted marker, a secret or a detectable path in a captured document refuses the export
  // as a signal that a leak path exists.
  const blobs = new Map<string, string>();
  for (const r of exported) {
    if (blobs.has(r.blob.file)) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(r.blob.bytes);
    } catch {
      throw new ExportRefused("LEAK", `${r.blob.file}:$`, "unscannable");
    }
    blobs.set(r.blob.file, text);
  }
  const blobFiles = [...blobs.keys()].sort();

  const recordsJsonl = exported.map((r) => `${r.line}\n`).join("");
  const schemaJson = `${canonicalJson({
    [DATASET_RECORD_SCHEMA_ID]: datasetRecordSchema,
    [DATASET_MANIFEST_SCHEMA_ID]: datasetManifestSchema,
    [EPISODE_SCHEMA]: episodeMirrorSchema,
  })}\n`;
  const excludedCounts: Record<string, number> = {};
  for (const e of excluded) excludedCounts[e.code] = (excludedCounts[e.code] ?? 0) + 1;
  const manifest = {
    schema: DATASET_MANIFEST_SCHEMA_ID,
    exporter: EXPORTER_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    evidence: false,
    negativesIncluded: includeNegatives,
    episodeFormat: { schema: EPISODE_SCHEMA, mirrorPinnedAt: EPISODE_MIRROR_PINNED_AT },
    counts: {
      candidates: candidates.length,
      records: exported.length,
      positive: exported.filter((r) => r.label === "positive").length,
      negative: exported.filter((r) => r.label === "negative").length,
      simulated: exported.filter((r) => r.simulated).length,
      excluded: excludedCounts,
    },
    records: exported.map((r) => ({
      episodeId: r.episodeId,
      label: r.label,
      sha256: sha256Hex(r.line),
    })),
    files: { "records.jsonl": sha256Hex(recordsJsonl), "schema.json": sha256Hex(schemaJson) },
    // Blobs carried: none (digest-only).
    blobs: [],
  };
  const manifestIssues = validateSchema(manifest, datasetManifestSchema);
  if (manifestIssues.length > 0) {
    throw new ExportRefused("SCHEMA_INVALID", `manifest.json:${manifestIssues[0]!.path}`);
  }
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  // Every byte that would be written is scanned, in every file, before anything is written.
  const outputs: Array<readonly [string, string]> = [
    ...exported.map((r) => [episodeFile(r.episodeId), r.episodeText] as const),
    ["records.jsonl", recordsJsonl],
    ["schema.json", schemaJson],
    ["manifest.json", manifestJson],
  ];
  // The raw views are scanned first: a planted marker, a secret or a detectable path in an
  // episode or record still refuses the export (a leak path exists), even though the closed
  // form would carry it only as a digest. Then every closed output, as a backstop.
  const rawOutputs: Array<readonly [string, string]> = [
    ...exported.map((r) => [r.rawEpisodeFile, r.rawEpisodeText] as const),
    ["records.jsonl", exported.map((r) => `${r.rawLine}\n`).join("")],
    ...blobFiles.map((file) => [file, blobs.get(file)!] as const),
  ];
  // Identity strings (lead ruling 21:52Z) are handled when each episode and record is closed: this
  // machine's account and host name (always, from os), the caller's identity and the identity file
  // are digested out of every id and token, joined forms included, and refuse the export in any
  // other verbatim field (`joinedIdentity`, above). Every other written string is fixed vocabulary.
  const leak = firstLeak(rawOutputs, options.hygiene) ?? firstLeak(outputs, options.hygiene);
  if (leak !== null) throw new ExportRefused("LEAK", leak.where, leak.kind);

  // Write to a sibling temp directory and rename, so a failed write leaves no partial export.
  const staging = mkdtempSync(join(dirname(options.outDir), `.${basename(options.outDir)}.tmp-`));
  try {
    mkdirSync(join(staging, "episodes"));
    for (const [name, text] of outputs) writeFileSync(join(staging, name), text, { flag: "wx" });
    if (existsSync(options.outDir)) throw new ExportRefused("OUT_EXISTS", "outDir");
    renameSync(staging, options.outDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { outDir: options.outDir, manifest, excluded };
}

/** The only entries a container holds (digest-only: never `blobs/`). */
const CONTAINER_ENTRIES = new Set(["manifest.json", "records.jsonl", "schema.json", "episodes"]);

/** Every code `validateContainer` reports; a problem is `CODE location`, never a value. */
export const CONTAINER_PROBLEM_CODES = [
  "CONTAINER_UNREADABLE",
  "BLOBS_PRESENT",
  "STRAY_ENTRY",
  "LINK",
  "NOT_REGULAR",
  "HARDLINK",
  "TOO_LARGE",
  "MISSING",
  "MANIFEST_JSON",
  "MANIFEST_SCHEMA",
  "FILE_HASH",
  "RECORD_COUNT",
  "RECORD_HASH",
  "RECORD_JSON",
  "RECORD_SCHEMA",
  "RECORD_OPEN",
  "RECORD_MISMATCH",
  "EPISODE_HASH",
  "EPISODE_JSON",
  "EPISODE_DEPTH",
  "EPISODE_SCHEMA",
  "EPISODE_RULE",
  "OPEN_STRING",
  "UNREFERENCED",
  "COUNTS",
  "LEAK",
  "VALIDATOR_ERROR",
] as const;

/** A container file is at most this large (an export is far smaller; a huge file is refused, not read). */
export const CONTAINER_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** JSON nesting deeper than this is refused before anything recursive touches it. */
export const CONTAINER_MAX_DEPTH = 32;

/** A foreign directory-entry name, never echoed: `h-` plus 12 hex of its sha256. */
const nameRef = (name: string) => `h-${sha256Hex(name).slice(0, 12)}`;

/** Deepest nesting of a parsed JSON value, iteratively (stops once past `limit`). */
function depthOf(value: unknown, limit: number): number {
  let max = 0;
  const stack: Array<readonly [unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [node, d] = stack.pop() as readonly [unknown, number];
    if (d > max) max = d;
    if (max > limit) return max;
    if (node !== null && typeof node === "object")
      for (const v of Array.isArray(node) ? node : Object.values(node)) stack.push([v, d + 1]);
  }
  return max;
}

/**
 * Validates an exported container directory (TIF-265; #559 round 1, D1-D6). Returns problems,
 * each `CODE location` with a fixed code (`CONTAINER_PROBLEM_CODES`) and a location that is a
 * fixed file name, a record index or a JSON path: never a value, and a foreign entry name only as
 * `h-<12 hex>`. Empty means valid. NEVER throws: every read is guarded, nesting is bounded before
 * any recursive check, and anything unexpected is `VALIDATOR_ERROR`.
 *
 * Refuses: a root that is missing, not a directory or a link; any entry outside the layout,
 * `blobs/` by name (digest-only); a link, a non-regular file, a hard link (`nlink > 1`) or a file
 * over `CONTAINER_MAX_FILE_BYTES`, for every file and for `episodes/`; a manifest that is not JSON
 * or fails its schema (a blob in it included); a records or schema file that does not hash to the
 * manifest; a record count, a record line's digest, its schema (`datasetRecordSchema`), its free
 * fields' closed grammar or its episode id and label that disagree with the manifest; an episode
 * file that does not hash to its record, is not JSON, nests deeper than `CONTAINER_MAX_DEPTH`,
 * fails `episodeMirrorSchema` (closed: no extra key, a path used as a key included) or a #542 rule,
 * or holds a string outside its closed grammar; an episode file no record references; manifest
 * counts that do not match the records and episodes; and, as a backstop, any leak the exporter's
 * scan finds (this machine's identity and the identity file always included, joined forms too).
 */
/**
 * The hash ledger of a container this harness wrote (#579 O3), for re-exporting its episodes:
 * the container must validate first (`validateContainer`, same hygiene), then every
 * `h-<60 hex>` of its episodes and records is recorded, bound to its episode id and path. A
 * container that does not validate throws (codes only). The container is TRUSTED as harness
 * output: one written before #579 may hold an agent's verbatim `h-<60 hex>`; re-export it from
 * its source episodes instead.
 */
export function containerHashLedger(dir: string, hygiene?: HygieneOptions): HashLedger {
  const problems = validateContainer(dir, hygiene);
  if (problems.length > 0)
    throw new Error(`hash ledger refused: the container is invalid (${problems[0]})`);
  const lines = readFileSync(join(dir, "records.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { episode: { file: string } });
  const episodes = lines.map(
    (r) => JSON.parse(readFileSync(join(dir, r.episode.file), "utf8")) as Episode,
  );
  return hashLedgerOf(episodes, lines);
}

export function validateContainer(dir: string, hygiene?: HygieneOptions): string[] {
  try {
    return checkContainer(dir, hygiene);
  } catch {
    return ["VALIDATOR_ERROR $"];
  }
}

function checkContainer(dir: string, hygiene?: HygieneOptions): string[] {
  const problems: string[] = [];
  // This machine's identity (always), the caller's and the identity file's, by substring in every
  // verbatim field (joined forms included); plus the exporter's own leak scan.
  const joined = identityStrings(hygiene);
  const leaksOf = (value: unknown, table: "episode" | "record" | null) => {
    const seen = new Set<string>();
    const all = [
      ...scanForLeaks(value, hygiene),
      // The manifest has no field table: every non-digest string is checked (B1 for #559).
      ...(table === null ? manifestIdentity(value, joined) : joinedIdentity(value, joined, table)),
    ];
    return all.filter((l) => {
      const k = `${l.kind}@${l.path}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  /** lstat a container path; null (and a problem) unless it is a plain file / directory. */
  const plain = (rel: string, kind: "file" | "dir", label: string): boolean => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(dir, rel));
    } catch {
      problems.push(`MISSING ${label}`);
      return false;
    }
    if (st.isSymbolicLink()) problems.push(`LINK ${label}`);
    else if (kind === "file" ? !st.isFile() : !st.isDirectory())
      problems.push(`NOT_REGULAR ${label}`);
    else if (kind === "file" && st.nlink > 1) problems.push(`HARDLINK ${label}`);
    else if (kind === "file" && st.size > CONTAINER_MAX_FILE_BYTES)
      problems.push(`TOO_LARGE ${label}`);
    else return true;
    return false;
  };
  const readText = (rel: string, label: string): string | null => {
    if (!plain(rel, "file", label)) return null;
    try {
      return readFileSync(join(dir, rel), "utf8");
    } catch {
      problems.push(`MISSING ${label}`);
      return null;
    }
  };

  // The root and its entries.
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return ["CONTAINER_UNREADABLE $"];
  } catch {
    return ["CONTAINER_UNREADABLE $"];
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return ["CONTAINER_UNREADABLE $"];
  }
  for (const entry of entries) {
    if (entry === "blobs") problems.push("BLOBS_PRESENT blobs/");
    else if (!CONTAINER_ENTRIES.has(entry)) problems.push(`STRAY_ENTRY ${nameRef(entry)}`);
  }

  // The manifest.
  const manifestText = readText("manifest.json", "manifest.json");
  if (manifestText === null) return problems;
  let manifest: {
    files: Record<string, string>;
    records: { episodeId: string; label: string; sha256: string }[];
    counts: {
      candidates: number;
      records: number;
      positive: number;
      negative: number;
      simulated: number;
      excluded: Record<string, unknown>;
    };
    blobs: unknown[];
  };
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return [...problems, "MANIFEST_JSON manifest.json"];
  }
  if (depthOf(manifest, CONTAINER_MAX_DEPTH) > CONTAINER_MAX_DEPTH)
    return [...problems, "MANIFEST_SCHEMA manifest.json:$ depth"];
  const mIssues = validateSchema(manifest, datasetManifestSchema);
  if (mIssues.length > 0)
    return [
      ...problems,
      `MANIFEST_SCHEMA manifest.json:${mIssues[0]!.path} ${mIssues[0]!.keyword}`,
    ];
  for (const leak of leaksOf(manifest, null))
    problems.push(`LEAK manifest.json:${leak.path} ${leak.kind}`);

  // records.jsonl and schema.json.
  const recordsText = readText("records.jsonl", "records.jsonl");
  const schemaText = readText("schema.json", "schema.json");
  if (recordsText !== null && sha256Hex(recordsText) !== manifest.files["records.jsonl"])
    problems.push("FILE_HASH records.jsonl");
  if (schemaText !== null && sha256Hex(schemaText) !== manifest.files["schema.json"])
    problems.push("FILE_HASH schema.json");
  const lines = (recordsText ?? "").split("\n").filter((l) => l.length > 0);
  if (lines.length !== manifest.records.length) problems.push("RECORD_COUNT records.jsonl");

  // The episodes directory.
  const episodesOk = lines.length === 0 ? true : plain("episodes", "dir", "episodes/");
  const referenced = new Set<string>();
  let positive = 0;
  let negative = 0;
  let simulated = 0;
  for (const [i, line] of lines.entries()) {
    const at = `records.jsonl#${i + 1}`;
    const listed = manifest.records[i];
    if (sha256Hex(line) !== listed?.sha256) problems.push(`RECORD_HASH ${at}`);
    let record: {
      label: string;
      episode: { id: string; file: string; sha256: string };
    };
    try {
      record = JSON.parse(line);
    } catch {
      problems.push(`RECORD_JSON ${at}`);
      continue;
    }
    if (depthOf(record, CONTAINER_MAX_DEPTH) > CONTAINER_MAX_DEPTH) {
      problems.push(`RECORD_SCHEMA ${at}:$ depth`);
      continue;
    }
    const rIssues = validateSchema(record, datasetRecordSchema);
    if (rIssues.length > 0) {
      problems.push(`RECORD_SCHEMA ${at}:${rIssues[0]!.path} ${rIssues[0]!.keyword}`);
      continue;
    }
    for (const path of openRecordStrings(record)) problems.push(`RECORD_OPEN ${at}:${path}`);
    if (
      listed !== undefined &&
      (listed.episodeId !== record.episode.id || listed.label !== record.label)
    )
      problems.push(`RECORD_MISMATCH ${at}`);
    if (record.label === "positive") positive++;
    else negative++;
    for (const leak of leaksOf(record, "record"))
      problems.push(`LEAK ${at}:${leak.path} ${leak.kind}`);
    referenced.add(record.episode.file);
    if (!episodesOk) continue;
    const file = record.episode.file;
    const text = readText(file, file);
    if (text === null) continue;
    if (sha256Hex(text) !== record.episode.sha256) problems.push(`EPISODE_HASH ${file}`);
    let episode: unknown;
    try {
      episode = JSON.parse(text);
    } catch {
      problems.push(`EPISODE_JSON ${file}`);
      continue;
    }
    if (depthOf(episode, CONTAINER_MAX_DEPTH) > CONTAINER_MAX_DEPTH) {
      problems.push(`EPISODE_DEPTH ${file}`);
      continue;
    }
    const eIssues = validateSchema(episode, episodeMirrorSchema);
    if (eIssues.length > 0) {
      problems.push(`EPISODE_SCHEMA ${file}:${eIssues[0]!.path} ${eIssues[0]!.keyword}`);
      continue;
    }
    const rule = episodeProblem(episode);
    if (rule !== null) problems.push(`EPISODE_RULE ${file}:${rule.path} ${rule.detail}`);
    if ((episode as Episode).episodeId !== record.episode.id)
      problems.push(`RECORD_MISMATCH ${at}`);
    if ((episode as Episode).simulated) simulated++;
    for (const path of openEpisodeStrings(episode)) problems.push(`OPEN_STRING ${file}:${path}`);
    for (const leak of leaksOf(episode, "episode"))
      problems.push(`LEAK ${file}:${leak.path} ${leak.kind}`);
  }
  if (episodesOk && lines.length > 0) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, "episodes"));
    } catch {
      problems.push("MISSING episodes/");
    }
    for (const f of names)
      if (!referenced.has(`episodes/${f}`))
        problems.push(
          `UNREFERENCED ${/^[0-9a-f]{64}\.json$/.test(f) ? `episodes/${f}` : `episodes/${nameRef(f)}`}`,
        );
  } else if (lines.length === 0 && entries.includes("episodes")) {
    try {
      if (plain("episodes", "dir", "episodes/") && readdirSync(join(dir, "episodes")).length > 0)
        problems.push("UNREFERENCED episodes/");
    } catch {
      problems.push("MISSING episodes/");
    }
  }

  // The manifest's counts, recomputed. The schema already closes `counts.excluded` (known codes,
  // non-negative integers); the code and integer checks below stay as a backstop.
  const c = manifest.counts;
  const excludedValues = Object.entries(c.excluded);
  const excludedOk = excludedValues.every(
    ([k, v]) =>
      (EXCLUSION_CODES as readonly string[]).includes(k) &&
      Number.isInteger(v) &&
      (v as number) >= 0,
  );
  const excludedSum = excludedValues.reduce((n, [, v]) => n + (typeof v === "number" ? v : 0), 0);
  if (
    !excludedOk ||
    c.records !== lines.length ||
    c.positive !== positive ||
    c.negative !== negative ||
    (episodesOk && c.simulated !== simulated) ||
    c.candidates !== c.records + excludedSum
  )
    problems.push("COUNTS manifest.json");
  return problems;
}
