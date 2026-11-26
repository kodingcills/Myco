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
 * What refuses the WHOLE export (nothing is written): an episode that is not a valid
 * `myco.episode/1` (closed shape, content id, outcome/verdict agreement; blob observations
 * are not carried yet); a leak (host path, user or host name, operator-named string,
 * secret-shaped string) anywhere in ANY output file (episodes, records, manifest, schema);
 * a scripted, mock or non-gated episode not labelled simulated; a duplicate trial, run or
 * episode; a record that fails its schema; an existing output directory. A refusal names
 * the code and a location (file and JSON path, or candidate index), never the offending
 * value. A dataset is never scorecard evidence (`evidence: false`).
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DATASET_MANIFEST_SCHEMA_ID,
  DATASET_RECORD_SCHEMA_ID,
  datasetManifestSchema,
  datasetRecordSchema,
} from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  canonicalJson,
  EPISODE_MIRROR_PINNED_AT,
  EPISODE_SCHEMA,
  type Episode,
  episodeIdOf,
  episodeMirrorSchema,
  sha256Hex,
} from "./episode.ts";
import { type HygieneOptions, scanForLeaks } from "./hygiene.ts";

export { canonicalJson, sha256Hex };
export const EXPORTER_VERSION = "myco-dataset-exporter/2";
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
    readonly format: "csv" | "xlsx";
    readonly bytes: Uint8Array;
  } | null;
  readonly desktop: DesktopFacts;
}

export const EXCLUSION_CODES = [
  "MISSING_GATE",
  "MISSING_GRADE",
  "MISSING_CAPTURE",
  "GATE_MALFORMED",
  "GATE_NOT_BOUND",
  "GATE_EPISODE_MISMATCH",
  "GRADE_NOT_BOUND",
  "GATE_UNCERTAIN",
  "GRADE_UNGRADABLE",
  "GATE_GRADER_DISAGREE",
  "NOT_CLAIMED",
  "NEGATIVES_NOT_REQUESTED",
] as const;
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

/** A scripted planner, or anything but a real gated trial, makes an episode simulated. */
function mustBeSimulated(ep: Episode): boolean {
  return ep.harness.plannerModelId === null || ep.provenance.source !== "gated-trial";
}

/** Checks an episode against the mirrored `myco.episode/1` contract. Returns a JSON path or null. */
export function episodeProblem(ep: unknown): { path: string; detail: string } | null {
  const issues = validateSchema(ep, episodeMirrorSchema);
  if (issues.length > 0) return { path: issues[0]!.path, detail: issues[0]!.keyword };
  const e = ep as Episode;
  if (episodeIdOf(e) !== e.episodeId) return { path: "$.episodeId", detail: "ID_MISMATCH" };
  for (const [i, o] of e.observations.items.entries()) {
    // The container does not carry blobs yet; a blob reference would dangle.
    if (o.kind !== "ui-status") {
      return { path: `$.observations.items[${i}]`, detail: "BLOBS_UNSUPPORTED" };
    }
    if (o.seq !== i || (o.afterAction !== null && o.afterAction >= e.actions.items.length)) {
      return { path: `$.observations.items[${i}]`, detail: "SEQ" };
    }
  }
  for (const [i, a] of e.actions.items.entries()) {
    if (a.seq !== i) return { path: `$.actions.items[${i}]`, detail: "SEQ" };
  }
  const decided = ["verified", "refuted", "uncertain"];
  if (decided.includes(e.outcome) && e.gate?.verdict !== e.outcome) {
    return { path: "$.outcome", detail: "OUTCOME_GATE_MISMATCH" };
  }
  if (e.gate !== null && e.gate.accepted !== (e.gate.verdict === "verified")) {
    return { path: "$.gate.accepted", detail: "ACCEPTED_VERDICT_MISMATCH" };
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
  if (existsSync(options.outDir)) throw new ExportRefused("OUT_EXISTS", "outDir");

  const trialKeys = new Set<string>();
  const runIds = new Set<string>();
  const episodeIds = new Set<string>();
  for (const [i, c] of candidates.entries()) {
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
    // classify() has proven the capture present and bound.
    const capture = c.capture!;
    const episodeText = `${canonicalJson(c.episode)}\n`;
    const record = {
      schema: DATASET_RECORD_SCHEMA_ID,
      label: decision.label,
      episode: {
        schema: EPISODE_SCHEMA,
        id: c.episode.episodeId,
        sha256: sha256Hex(episodeText),
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
    const issues = validateSchema(record, datasetRecordSchema);
    if (issues.length > 0) {
      throw new ExportRefused(
        "SCHEMA_INVALID",
        `${episodeFile(c.episode.episodeId)}:record${issues[0]!.path.slice(1)}`,
        issues[0]!.keyword,
      );
    }
    exported.push({
      episodeId: c.episode.episodeId,
      label: decision.label,
      simulated: c.episode.simulated,
      episodeText,
      line: canonicalJson(record),
    });
  }

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
  const leak = firstLeak(outputs, options.hygiene);
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
