import { ledgerRowSchema } from "../../../schemas/ledger-row.ts";
import { resultRecordSchema } from "../../../schemas/result-record.ts";
import { traceEventSchema } from "../../../schemas/trace-events.ts";
import { type JsonSchema, validateSchema } from "../../../schemas/validate.ts";
import type { LedgerRow, TraceEvent } from "../../../src/core/evidence.ts";
import type { RunFiles } from "./loaders.ts";
import type {
  ExtendedEvent,
  ParseError,
  ResultRecord,
  RunData,
  RunManifest,
  RunUpdate,
  Sourced,
  SourceRef,
  ViewTraceEvent,
} from "./types.ts";

import { checkManifest, checkRunEvidence } from "./validation.ts";

const traceSchemas = new Map(
  traceEventSchema.oneOf?.map((branch) => [
    branch.properties?.type?.const,
    { ...branch, $defs: traceEventSchema.$defs },
  ]),
);
const additiveEventSchema: JsonSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", minLength: 1 },
  },
};
const manifestSchema: JsonSchema = {
  type: "object",
  required: ["format", "runId", "files"],
  properties: {
    format: { const: "mycotrace/1" },
    runId: { type: "string", minLength: 1 },
    files: { type: "object" },
    simulated: { type: "boolean" },
    dryRun: { type: "boolean" },
  },
};

function json(text: string, source: SourceRef, errors: ParseError[]): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push({
      source,
      issues: [{ path: "$", keyword: "json", message: String(error) }],
    });
    return undefined;
  }
}

function valid(value: unknown, schema: JsonSchema, source: SourceRef, errors: ParseError[]) {
  if (value === undefined) return false;
  const issues = validateSchema(value, schema);
  if (issues.length === 0) return true;
  errors.push({ source, issues });
  return false;
}

async function readJson<T>(
  files: RunFiles,
  file: string,
  schema: JsonSchema,
  errors: ParseError[],
) {
  const blob = files.read(file);
  if (!blob) return undefined;
  const source = { file, path: "" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
  } catch {
    errors.push({
      source,
      issues: [{ path: "$", keyword: "read", message: "Could not read UTF-8 JSON" }],
    });
    return undefined;
  }
  const value = json(text, source, errors);
  return valid(value, schema, source, errors) ? (value as T) : undefined;
}

function stripCarriageReturn(line: string) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

async function readLines(
  blob: Blob,
  file: string,
  errors: ParseError[],
  consume: (line: number, text: string) => void,
) {
  const stream = new TextDecoderStream("utf-8", { fatal: true });
  const reader = blob.stream().pipeThrough(stream).getReader();
  let pending = "";
  let line = 0;
  try {
    for (;;) {
      const next = await reader.read().catch(() => undefined);
      if (!next) {
        errors.push({
          source: { file, path: "" },
          issues: [{ path: "$", keyword: "read", message: "Could not read UTF-8 JSON Lines" }],
        });
        return;
      }
      const { done, value } = next;
      if (done) break;
      pending += value;
      let start = 0;
      let end = pending.indexOf("\n");
      while (end !== -1) {
        consume(++line, stripCarriageReturn(pending.slice(start, end)));
        start = end + 1;
        end = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    }
    if (pending) consume(++line, stripCarriageReturn(pending));
  } finally {
    reader.releaseLock();
  }
}

function eventType(value: unknown) {
  if (value && typeof value === "object" && "type" in value) return value.type;
  return undefined;
}

export async function parseRun(
  files: RunFiles,
  emit?: (update: RunUpdate) => void,
): Promise<RunData> {
  return indexScreenshots(files, await parseRunEvidence(files, emit));
}

/** Reads files once per phase owner; artifacts stay uncached so each is read on demand. */
export function cachedReader(files: RunFiles): RunFiles["read"] {
  const cached = new Map<string, Blob | undefined>();
  return (path) => {
    if (path.startsWith("artifacts/")) return files.read(path);
    if (!cached.has(path)) cached.set(path, files.read(path));
    return cached.get(path);
  };
}

export interface ResultPhase {
  result?: ResultRecord;
  manifest?: RunManifest;
  /** Result and manifest JSON errors, in read order. */
  errors: ParseError[];
  /** Resolves once every manifest digest has been checked. */
  manifestCheck: Promise<Sourced<string> | undefined>;
}

/** The result and manifest, validated first so the verdict can paint before the trace finishes. */
export async function parseResultPhase(
  files: RunFiles,
  read: RunFiles["read"],
  emit?: (update: RunUpdate) => void,
): Promise<ResultPhase> {
  const errors: ParseError[] = [];
  const evidence = { paths: files.paths, read };
  const result = await readJson<ResultRecord>(evidence, "result.json", resultRecordSchema, errors);
  emit?.({ type: "result", result, parseErrors: [...errors] });
  const manifest = files.paths.includes("manifest.json")
    ? await readJson<RunManifest>(evidence, "manifest.json", manifestSchema, errors)
    : undefined;
  return {
    result,
    manifest,
    errors,
    manifestCheck: checkManifest({ files, manifest, result, read }),
  };
}

export interface LedgerPhase {
  ledger: RunData["ledger"];
  errors: ParseError[];
}

export async function parseLedgerPhase(read: RunFiles["read"]): Promise<LedgerPhase> {
  const errors: ParseError[] = [];
  const ledger: RunData["ledger"] = [];
  const ledgerFile = read("ledger.jsonl");
  if (ledgerFile) {
    await readLines(ledgerFile, "ledger.jsonl", errors, (line, text) => {
      if (!text.trim()) return;
      const source = { file: "ledger.jsonl", line };
      const value = json(text, source, errors);
      if (valid(value, ledgerRowSchema, source, errors)) {
        ledger.push({ value: value as LedgerRow, source });
      }
    });
  }
  return { ledger, errors };
}

export interface TracePhase {
  events: ViewTraceEvent[];
  byStep: Map<number, ViewTraceEvent[]>;
  errors: ParseError[];
}

/** Streams trace.jsonl, then trace.extended.jsonl, validating and indexing each event by step. */
export async function parseTracePhase(
  files: RunFiles,
  read: RunFiles["read"],
  emit?: (update: RunUpdate) => void,
): Promise<TracePhase> {
  const errors: ParseError[] = [];
  const events: ViewTraceEvent[] = [];
  const byStep = new Map<number, ViewTraceEvent[]>();
  const seen = files.paths.includes("trace.extended.jsonl") ? new Set<string>() : undefined;
  const previewSize = 256;
  let activeStep: number | undefined;
  for (const file of ["trace.jsonl", "trace.extended.jsonl"]) {
    const blob = read(file);
    if (!blob) continue;
    await readLines(blob, file, errors, (line, text) => {
      if (!text.trim()) return;
      // The extended artifact may be a full copy of the trace with extra lines.
      if (file === "trace.extended.jsonl" && seen?.has(text.trim())) return;
      const source = { file, line };
      const value = json(text, source, errors);
      const schema = traceSchemas.get(eventType(value));
      if (!valid(value, schema ?? additiveEventSchema, source, errors)) {
        return;
      }

      const entry: ViewTraceEvent = schema
        ? { kind: "standard", event: value as TraceEvent, source }
        : { kind: "extended", event: value as ExtendedEvent, source };
      entry.raw = text;
      if (
        "step" in entry.event &&
        typeof entry.event.step === "number" &&
        Number.isInteger(entry.event.step) &&
        (entry.kind === "standard" || entry.event.step >= 0)
      ) {
        entry.step = entry.event.step;
        activeStep = entry.step;
        let stepEvents = byStep.get(entry.step);
        if (!stepEvents) {
          stepEvents = [];
          byStep.set(entry.step, stepEvents);
        }
        stepEvents.push(entry);
      } else if (entry.event.type === "recovery" || entry.event.type === "fault-injection") {
        // Keep the source destination when Proof receives this line without its preceding events.
        entry.step = activeStep;
      }
      if (file === "trace.jsonl") seen?.add(text.trim());
      events.push(entry);
      // Show the beginning of the trace while the worker validates the full run.
      if (emit && events.length === previewSize) {
        emit({ type: "trace", events: events.slice(0, previewSize) });
      }
    });
  }
  if (emit && events.length > 0 && events.length < previewSize) {
    emit({ type: "trace", events: [...events] });
  }
  return { events, byStep, errors };
}

/** Joins the phases in their original order: result, trace, ledger, then cross-file checks. */
export function finishEvidence(
  files: RunFiles,
  { result, manifest, errors: resultErrors }: Omit<ResultPhase, "manifestCheck">,
  { events, byStep, errors: traceErrors }: TracePhase,
  { ledger, errors: ledgerErrors }: LedgerPhase,
  manifestError: Sourced<string> | undefined,
): RunData {
  const parseErrors = [...resultErrors, ...traceErrors, ...ledgerErrors];
  const manifestChecked = manifest !== undefined && !manifestError;
  const reason = manifestError ?? checkRunEvidence(result, events, byStep, ledger, manifestChecked);
  if (reason) {
    parseErrors.push({
      source: reason.source,
      issues: [{ path: "$", keyword: "evidence", message: reason.value }],
    });
  }
  return {
    validation: reason ? { kind: "invalid", reason } : { kind: "complete", manifestChecked },
    result,
    events,
    byStep,
    ledger,
    manifest,
    artifactPaths: artifactPaths(files),
    parseErrors,
  };
}

export async function parseRunEvidence(
  files: RunFiles,
  emit?: (update: RunUpdate) => void,
): Promise<RunData> {
  const read = cachedReader(files);
  const resultPhase = await parseResultPhase(files, read, emit);
  const trace = await parseTracePhase(files, read, emit);
  const ledger = await parseLedgerPhase(read);
  return finishEvidence(files, resultPhase, trace, ledger, await resultPhase.manifestCheck);
}

function artifactPaths(files: RunFiles) {
  return files.paths.filter((path) => path.startsWith("artifacts/"));
}

export async function indexScreenshots(files: RunFiles, data: RunData): Promise<RunData> {
  const screenshots: NonNullable<RunData["screenshots"]> = new Map();
  const paths = new Set(data.artifactPaths);
  if (paths.size === 0) return { ...data, screenshots };
  const isImage = (path: string) =>
    path.startsWith("artifacts/") && /\.(?:png|webp)$/i.test(path) && paths.has(path);
  for (const { event, step, source } of data.events) {
    if (
      event.type === "screenshot" &&
      "path" in event &&
      typeof event.path === "string" &&
      step !== undefined &&
      isImage(event.path)
    ) {
      screenshots.set(step, { value: event.path, source });
    }
  }
  for (const path of paths) {
    if (!path.startsWith("artifacts/") || !path.endsWith("-meta.json")) continue;
    const metadata = json((await files.read(path)?.text()) ?? "", { file: path, path: "" }, []);
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !("step" in metadata) ||
      typeof metadata.step !== "number" ||
      !Number.isSafeInteger(metadata.step) ||
      metadata.step < 0 ||
      screenshots.has(metadata.step)
    )
      continue;
    const stem = path.slice(0, -"-meta.json".length);
    const image = [`${stem}.png`, `${stem}.webp`].find(isImage);
    if (image)
      screenshots.set(metadata.step, { value: image, source: { file: path, path: "/step" } });
  }
  return { ...data, screenshots };
}
