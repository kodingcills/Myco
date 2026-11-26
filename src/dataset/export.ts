/**
 * Dataset exporter (track U, docs/product/linux-scale.md §6). Turns finished desktop runs
 * into a clean dataset: actions, observations, verdict, grade, provenance and hashes, plus a
 * manifest and the schema (`schemas/dataset-export.ts`).
 *
 * Which runs are exported (fail closed; every rule is pinned by test/dataset/export.test.ts
 * and mutation-proved by scripts/desktops-mutation-proof.sh):
 *  - **positive** only when BOTH are recorded and agree: the gate (`myco.gate/v1`, bound to
 *    this run's taskId and runId) said `verified` and accepted, AND the independent grader
 *    graded the captured bytes `pass` (its `persistedSha256` is the digest the exporter
 *    computes from the captured bytes itself, and its fixture digest is the task's), AND the
 *    agent claimed done. A pass without a done claim is "correct, not claimed", not verified.
 *  - **negative** only when the operator passes `includeNegatives`, and only for a run the
 *    gate refuted AND the grader graded `fail`, labelled `negative`.
 *  - everything else (uncertain, ungradable, gate/grader disagreement, unbound or missing
 *    records) is excluded and counted by code in the manifest.
 *
 * What refuses the WHOLE export (nothing is written): a leak (host path, user or host name,
 * operator-named string, secret-shaped string) anywhere in what would be written; a
 * scripted/mock run not labelled simulated; a duplicate trial or run id; a record that fails
 * its schema; an existing output directory. A refusal names the code and a location, never
 * the offending value. A dataset is never scorecard evidence (`evidence: false`), and
 * simulated records are counted separately.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  DATASET_MANIFEST_SCHEMA_ID,
  DATASET_RECORD_SCHEMA_ID,
  datasetManifestSchema,
  datasetRecordSchema,
} from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { type HygieneOptions, scanForLeaks } from "./hygiene.ts";

export const EXPORTER_VERSION = "myco-dataset-exporter/1";
const GATE_API = "myco.gate/v1";

export interface DatasetStep {
  readonly index: number;
  readonly action: { readonly tool: string; readonly input: Readonly<Record<string, unknown>> };
  readonly observation: { readonly kind: "text"; readonly text: string } | null;
}

/** The fields of a `myco.gate/v1` GateResult the exporter reads (structurally compatible). */
export interface GateLike {
  readonly apiVersion: string;
  readonly verdict: string;
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[];
  readonly request: { readonly taskId?: string; readonly runId?: string };
}

/** The fields of a grader GradeResult the exporter reads (structurally compatible). */
export interface GradeLike {
  readonly graderVersion: string;
  readonly status: string;
  readonly fixtureSha256: string;
  readonly persistedSha256: string | null;
  readonly mismatchCount: number;
}

export interface Provenance {
  readonly backend: string;
  readonly isolation: "process" | "container" | "microvm";
  readonly networkEnforced: boolean;
  readonly image: string;
  readonly plannerModelId: string | null;
  readonly simulated: boolean;
  readonly harness: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ExportCandidate {
  readonly trialKey: string;
  readonly taskId: string;
  readonly runId: string;
  readonly family: string;
  readonly instruction: string;
  /** The task set's declared fixture digest; the grade must be against this fixture. */
  readonly fixtureSha256: string;
  readonly steps: readonly DatasetStep[];
  readonly claim: { readonly done: boolean; readonly text: string };
  readonly gate: { readonly source: "myco-gate" | "mock-gate"; readonly result: GateLike } | null;
  readonly grade: GradeLike | null;
  /** The bytes the harness captured after the agent stopped, or null if nothing was captured. */
  readonly persisted: {
    readonly path: string;
    readonly format: "csv" | "xlsx";
    readonly bytes: Uint8Array;
  } | null;
  readonly provenance: Provenance;
}

export const EXCLUSION_CODES = [
  "MISSING_GATE",
  "MISSING_GRADE",
  "MISSING_CAPTURE",
  "GATE_MALFORMED",
  "GATE_NOT_BOUND",
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
  "LEAK",
  "SIMULATED_UNLABELLED",
  "DUPLICATE_TRIAL",
  "SCHEMA_INVALID",
  "OUT_EXISTS",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** The whole export was refused. `where` is a trial key and JSON path; never a value. */
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

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

/** Canonical JSON: sorted keys, no whitespace. Deterministic bytes for hashing. */
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

/**
 * Decides whether one run is a positive, a negative, or excluded. Pure; no I/O. Order matters
 * only for which code is reported: any failed binding excludes the run before its verdict is
 * looked at, so an unbound "verified" never becomes a positive.
 */
export function classify(c: ExportCandidate, includeNegatives: boolean): Classification {
  if (c.gate === null) return { excluded: "MISSING_GATE" };
  if (c.grade === null) return { excluded: "MISSING_GRADE" };
  if (c.persisted === null) return { excluded: "MISSING_CAPTURE" };
  const gate = c.gate.result;
  const verdicts = ["verified", "refuted", "uncertain"];
  if (
    gate.apiVersion !== GATE_API ||
    !verdicts.includes(gate.verdict) ||
    gate.accepted !== (gate.verdict === "verified")
  ) {
    return { excluded: "GATE_MALFORMED" };
  }
  // The gate is bound to one trial: its answer counts only for this run's taskId and runId.
  if (gate.request.taskId !== c.taskId || gate.request.runId !== c.runId) {
    return { excluded: "GATE_NOT_BOUND" };
  }
  // The grade counts only if it graded exactly the bytes captured for this run, against the
  // task's declared fixture. The digest is recomputed here, never taken from the caller.
  const captured = sha256Hex(c.persisted.bytes);
  if (c.grade.persistedSha256 !== captured || c.grade.fixtureSha256 !== c.fixtureSha256) {
    return { excluded: "GRADE_NOT_BOUND" };
  }
  if (gate.verdict === "uncertain") return { excluded: "GATE_UNCERTAIN" };
  if (c.grade.status !== "pass" && c.grade.status !== "fail") {
    return { excluded: "GRADE_UNGRADABLE" };
  }
  if (gate.verdict === "verified" && gate.accepted && c.grade.status === "pass") {
    return c.claim.done ? { label: "positive" } : { excluded: "NOT_CLAIMED" };
  }
  if (gate.verdict === "refuted" && !gate.accepted && c.grade.status === "fail") {
    return includeNegatives ? { label: "negative" } : { excluded: "NEGATIVES_NOT_REQUESTED" };
  }
  return { excluded: "GATE_GRADER_DISAGREE" };
}

/** A scripted planner or a mock gate makes a run simulated; it must say so. */
function mustBeSimulated(c: ExportCandidate): boolean {
  return c.provenance.plannerModelId === null || c.gate?.source === "mock-gate";
}

function buildRecord(c: ExportCandidate, label: "positive" | "negative"): Record<string, unknown> {
  // classify() has already proven gate, grade and persisted present and bound.
  const gate = c.gate!.result;
  const grade = c.grade!;
  const persisted = c.persisted!;
  const persistedSha256 = sha256Hex(persisted.bytes);
  const steps = c.steps.map((s) => ({
    index: s.index,
    action: { tool: s.action.tool, input: s.action.input },
    observation: s.observation === null ? null : { kind: "text", text: s.observation.text },
  }));
  const claim = { done: c.claim.done, text: c.claim.text };
  return {
    schema: DATASET_RECORD_SCHEMA_ID,
    label,
    trialKey: c.trialKey,
    taskId: c.taskId,
    runId: c.runId,
    family: c.family,
    instruction: c.instruction,
    steps,
    claim,
    verdict: {
      apiVersion: GATE_API,
      source: c.gate!.source,
      verdict: gate.verdict,
      accepted: gate.accepted,
      reasonCodes: [...gate.reasonCodes],
    },
    grade: {
      graderVersion: grade.graderVersion,
      status: grade.status,
      fixtureSha256: grade.fixtureSha256,
      persistedSha256,
      mismatchCount: grade.mismatchCount,
    },
    persisted: {
      path: persisted.path,
      format: persisted.format,
      sha256: persistedSha256,
      size: persisted.bytes.byteLength,
    },
    provenance: { ...c.provenance },
    hashes: {
      instructionSha256: sha256Hex(c.instruction),
      transcriptSha256: sha256Hex(canonicalJson({ steps, claim })),
      persistedSha256,
    },
  };
}

export interface ExportOptions {
  /** Directory to create. Must not exist; it appears only when the export succeeds. */
  readonly outDir: string;
  /** Export refuted+fail runs as labelled negatives. Default false. */
  readonly includeNegatives?: boolean;
  readonly hygiene?: HygieneOptions;
  /** Clock for `createdAt` (tests pin it). */
  readonly now?: () => Date;
}

export interface ExportResult {
  readonly outDir: string;
  readonly manifest: Record<string, unknown>;
  readonly excluded: ReadonlyArray<{ readonly trialKey: string; readonly code: ExclusionCode }>;
}

export function exportDataset(
  candidates: readonly ExportCandidate[],
  options: ExportOptions,
): ExportResult {
  const includeNegatives = options.includeNegatives === true;
  if (existsSync(options.outDir)) throw new ExportRefused("OUT_EXISTS", "outDir");

  const trialKeys = new Set<string>();
  const runIds = new Set<string>();
  for (const [i, c] of candidates.entries()) {
    if (trialKeys.has(c.trialKey) || runIds.has(c.runId)) {
      throw new ExportRefused("DUPLICATE_TRIAL", `candidates[${i}]`);
    }
    trialKeys.add(c.trialKey);
    runIds.add(c.runId);
    if (mustBeSimulated(c) && c.provenance.simulated !== true) {
      throw new ExportRefused("SIMULATED_UNLABELLED", `candidates[${i}]`);
    }
  }

  const records: Array<{
    trialKey: string;
    label: "positive" | "negative";
    simulated: boolean;
    line: string;
  }> = [];
  const excluded: Array<{ trialKey: string; code: ExclusionCode }> = [];
  const sorted = [...candidates].sort((a, b) =>
    a.trialKey < b.trialKey ? -1 : a.trialKey > b.trialKey ? 1 : 0,
  );
  for (const c of sorted) {
    const decision = classify(c, includeNegatives);
    if ("excluded" in decision) {
      excluded.push({ trialKey: c.trialKey, code: decision.excluded });
      continue;
    }
    const record = buildRecord(c, decision.label);
    const issues = validateSchema(record, datasetRecordSchema);
    if (issues.length > 0) {
      throw new ExportRefused(
        "SCHEMA_INVALID",
        `${c.trialKey}:${issues[0]!.path}`,
        issues[0]!.keyword,
      );
    }
    const leaks = scanForLeaks(record, options.hygiene);
    if (leaks.length > 0) {
      // The trial key itself may be what leaks; report the candidate position instead.
      const where =
        scanForLeaks(c.trialKey, options.hygiene).length > 0 ? "<trialKey>" : c.trialKey;
      throw new ExportRefused("LEAK", `${where}:${leaks[0]!.path}`, leaks[0]!.kind);
    }
    records.push({
      trialKey: c.trialKey,
      label: decision.label,
      simulated: c.provenance.simulated,
      line: canonicalJson(record),
    });
  }

  const recordsJsonl = records.map((r) => `${r.line}\n`).join("");
  const schemaJson = `${canonicalJson({
    [DATASET_RECORD_SCHEMA_ID]: datasetRecordSchema,
    [DATASET_MANIFEST_SCHEMA_ID]: datasetManifestSchema,
  })}\n`;
  const excludedCounts: Record<string, number> = {};
  for (const e of excluded) excludedCounts[e.code] = (excludedCounts[e.code] ?? 0) + 1;
  const manifest = {
    schema: DATASET_MANIFEST_SCHEMA_ID,
    exporter: EXPORTER_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    evidence: false,
    negativesIncluded: includeNegatives,
    counts: {
      candidates: candidates.length,
      records: records.length,
      positive: records.filter((r) => r.label === "positive").length,
      negative: records.filter((r) => r.label === "negative").length,
      simulated: records.filter((r) => r.simulated).length,
      excluded: excludedCounts,
    },
    records: records.map((r) => ({
      trialKey: r.trialKey,
      label: r.label,
      simulated: r.simulated,
      sha256: sha256Hex(r.line),
    })),
    files: { "records.jsonl": sha256Hex(recordsJsonl), "schema.json": sha256Hex(schemaJson) },
  };
  const manifestIssues = validateSchema(manifest, datasetManifestSchema);
  if (manifestIssues.length > 0) {
    throw new ExportRefused("SCHEMA_INVALID", `manifest:${manifestIssues[0]!.path}`);
  }
  const manifestLeaks = scanForLeaks(manifest, options.hygiene);
  if (manifestLeaks.length > 0) {
    throw new ExportRefused("LEAK", `manifest:${manifestLeaks[0]!.path}`, manifestLeaks[0]!.kind);
  }

  // Write to a sibling temp directory and rename, so a failed write leaves no partial export.
  const staging = mkdtempSync(join(dirname(options.outDir), `.${basename(options.outDir)}.tmp-`));
  try {
    writeFileSync(join(staging, "records.jsonl"), recordsJsonl, { flag: "wx" });
    writeFileSync(join(staging, "schema.json"), schemaJson, { flag: "wx" });
    writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    if (existsSync(options.outDir)) throw new ExportRefused("OUT_EXISTS", "outDir");
    renameSync(staging, options.outDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { outDir: options.outDir, manifest, excluded };
}
