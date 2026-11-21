import { loadRunFiles, type RunFileInput } from "./loaders.ts";
import { indexScreenshots, parseRunEvidence } from "./parse.ts";
import type { RunData, RunUpdate } from "./types.ts";
import { deriveVerdict } from "./verdict.ts";

export type RunWorkerMessage =
  | RunUpdate
  | { type: "complete"; data: Omit<RunData, "result" | "events" | "byStep"> }
  | { type: "error"; message: string };

export type RunWorkerRequest = { type: "open"; files: readonly RunFileInput[] } | { type: "index" };

function send(message: RunWorkerMessage) {
  self.postMessage(message);
}

let beginIndexing: (() => void) | undefined;
self.onmessage = async ({ data: request }: MessageEvent<RunWorkerRequest>) => {
  if (request.type === "index") {
    beginIndexing?.();
    return;
  }
  try {
    const files = await loadRunFiles(request.files);
    let previewLength = 0;
    const data = await parseRunEvidence(files, (message) => {
      if (message.type === "trace") previewLength = message.events.length;
      send(message);
    });
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
