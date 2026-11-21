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
  SourceRef,
  ViewTraceEvent,
} from "./types.ts";

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
  const value = json(await blob.text(), source, errors);
  return valid(value, schema, source, errors) ? (value as T) : undefined;
}

async function* jsonLines(blob: Blob) {
  const reader = blob.stream().pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  let line = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      let start = 0;
      let end = pending.indexOf("\n");
      while (end !== -1) {
        yield { line: ++line, text: pending.slice(start, end).replace(/\r$/, "") };
        start = end + 1;
        end = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    }
    if (pending) yield { line: ++line, text: pending.replace(/\r$/, "") };
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
  const parseErrors: ParseError[] = [];
  const result = await readJson<ResultRecord>(
    files,
    "result.json",
    resultRecordSchema,
    parseErrors,
  );
  emit?.({ type: "result", result, parseErrors: [...parseErrors] });

  const events: ViewTraceEvent[] = [];
  const byStep = new Map<number, ViewTraceEvent[]>();
  const seen = files.paths.includes("trace.extended.jsonl") ? new Set<string>() : undefined;
  let batch: ViewTraceEvent[] = [];
  for (const file of ["trace.jsonl", "trace.extended.jsonl"]) {
    const blob = files.read(file);
    if (!blob) continue;
    for await (const { line, text } of jsonLines(blob)) {
      if (!text.trim()) continue;
      // The extended artifact may be a full copy of the trace with extra lines.
      if (file === "trace.extended.jsonl" && seen?.has(text.trim())) continue;
      const source = { file, line };
      const value = json(text, source, parseErrors);
      const schema = traceSchemas.get(eventType(value));
      if (!valid(value, schema ?? additiveEventSchema, source, parseErrors)) {
        continue;
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
        let stepEvents = byStep.get(entry.step);
        if (!stepEvents) {
          stepEvents = [];
          byStep.set(entry.step, stepEvents);
        }
        stepEvents.push(entry);
      }
      if (file === "trace.jsonl") seen?.add(text.trim());
      events.push(entry);
      if (emit) {
        batch.push(entry);
        if (batch.length === 256) {
          emit({ type: "trace", events: batch });
          batch = [];
        }
      }
    }
  }
  if (batch.length > 0) emit?.({ type: "trace", events: batch });

  const ledger: RunData["ledger"] = [];
  const ledgerFile = files.read("ledger.jsonl");
  if (ledgerFile) {
    for await (const { line, text } of jsonLines(ledgerFile)) {
      if (!text.trim()) continue;
      const source = { file: "ledger.jsonl", line };
      const value = json(text, source, parseErrors);
      if (valid(value, ledgerRowSchema, source, parseErrors)) {
        ledger.push({ value: value as LedgerRow, source });
      }
    }
  }
  let manifest = await readJson<RunManifest>(files, "manifest.json", manifestSchema, parseErrors);
  if (manifest && Object.values(manifest.files).some((hash) => !/^[a-f0-9]{64}$/i.test(hash))) {
    parseErrors.push({
      source: { file: "manifest.json", path: "/files" },
      issues: [{ path: "$.files", keyword: "pattern", message: "Expected SHA-256 hex digests" }],
    });
    manifest = undefined;
  }
  return {
    result,
    events,
    byStep,
    ledger,
    manifest,
    artifactPaths: artifactPaths(files),
    screenshots: await screenshotPaths(files, events),
    parseErrors,
  };
}

function artifactPaths(files: RunFiles) {
  return files.paths.filter((path) => path.startsWith("artifacts/"));
}

async function screenshotPaths(files: RunFiles, events: ViewTraceEvent[]) {
  const screenshots: NonNullable<RunData["screenshots"]> = new Map();
  const paths = new Set(files.paths);
  const isImage = (path: string) =>
    path.startsWith("artifacts/") && /\.(?:png|webp)$/i.test(path) && paths.has(path);
  for (const { event, step, source } of events) {
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
  return screenshots;
}
