import { loadRunFiles, type RunFileInput } from "./loaders.ts";
import {
  cachedReader,
  finishEvidence,
  indexScreenshots,
  parseLedgerPhase,
  parseResultPhase,
  parseTracePhase,
} from "./parse.ts";
import type { ParseError, RunData, RunUpdate, Sourced } from "./types.ts";
import { deriveVerdict } from "./verdict.ts";

export type RunWorkerMessage =
  | RunUpdate
  | { type: "complete"; data: Omit<RunData, "result" | "events" | "byStep"> }
  | { type: "error"; message: string };

/** What the result worker hands the trace worker once the result, manifest and ledger are checked. */
export interface EvidencePayload {
  error?: string;
  result?: RunData["result"];
  manifest?: RunData["manifest"];
  resultErrors: ParseError[];
  ledger: RunData["ledger"];
  ledgerErrors: ParseError[];
  manifestError?: Sourced<string>;
}

export type RunWorkerRequest =
  /** Streams the trace; the result worker's payload arrives on `evidence`. */
  | { type: "open"; files: readonly RunFileInput[]; evidence: MessagePort }
  /** Validates result, manifest and ledger in parallel with the trace scan. */
  | { type: "open-evidence"; files: readonly RunFileInput[]; evidence: MessagePort }
  | { type: "index" };

function send(message: RunWorkerMessage) {
  self.postMessage(message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function validateResult(request: Extract<RunWorkerRequest, { type: "open-evidence" }>) {
  try {
    const files = await loadRunFiles(request.files);
    const read = cachedReader(files);
    const phase = await parseResultPhase(files, read, send);
    const { ledger, errors: ledgerErrors } = await parseLedgerPhase(read);
    const manifestError = await phase.manifestCheck;
    const payload: EvidencePayload = {
      result: phase.result,
      manifest: phase.manifest,
      resultErrors: phase.errors,
      ledger,
      ledgerErrors,
      manifestError,
    };
    request.evidence.postMessage(payload);
  } catch (error) {
    const message = errorMessage(error);
    request.evidence.postMessage({
      error: message,
      resultErrors: [],
      ledger: [],
      ledgerErrors: [],
    } satisfies EvidencePayload);
    send({ type: "error", message });
  } finally {
    request.evidence.close();
  }
}

let beginIndexing: (() => void) | undefined;
self.onmessage = async ({ data: request }: MessageEvent<RunWorkerRequest>) => {
  if (request.type === "index") {
    beginIndexing?.();
    return;
  }
  if (request.type === "open-evidence") {
    await validateResult(request);
    return;
  }
  try {
    const payload = new Promise<EvidencePayload>((resolve) => {
      request.evidence.onmessage = ({ data }: MessageEvent<EvidencePayload>) => resolve(data);
    });
    const files = await loadRunFiles(request.files);
    const read = cachedReader(files);
    let previewLength = 0;
    const trace = await parseTracePhase(files, read, (message) => {
      if (message.type === "trace") previewLength = message.events.length;
      send(message);
    });
    const evidence = await payload;
    request.evidence.close();
    if (evidence.error !== undefined) throw new Error(evidence.error);
    const data = finishEvidence(
      files,
      { result: evidence.result, manifest: evidence.manifest, errors: evidence.resultErrors },
      trace,
      { ledger: evidence.ledger, errors: evidence.ledgerErrors },
      evidence.manifestError,
    );
    const { validation, parseErrors, ledger, manifest } = data;
    const proofEvents = data.events.filter(
      ({ kind, event }) =>
        event.type === "claim" ||
        (kind === "standard" &&
          (event.type === "fault-injection" ||
            event.type === "guard-failure" ||
            event.type === "recovery")),
    );
    const verdict = deriveVerdict(data);
    const ready = new Promise<void>((resolve) => {
      beginIndexing = resolve;
    });
    send({
      type: "validated",
      verdict,
      evidence: { validation, parseErrors, proofEvents, ledger, manifest },
    });

    // Wait for a render opportunity before indexing screenshots and cloning the full trace.
    await ready;
    const batchSize = 2048;
    for (let offset = previewLength; offset < data.events.length; offset += batchSize) {
      send({ type: "trace", events: data.events.slice(offset, offset + batchSize) });
    }
    const {
      result: _result,
      events: _events,
      byStep: _byStep,
      ...indexed
    } = await indexScreenshots(files, data);
    send({ type: "complete", data: indexed });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
