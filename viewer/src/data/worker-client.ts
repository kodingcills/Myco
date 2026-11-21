import type { RunFileInput } from "./loaders.ts";
import type { RunWorkerMessage, RunWorkerRequest } from "./trace.worker.ts";
import TraceWorker from "./trace.worker.ts?worker&inline";
import type { RunData, RunUpdate } from "./types.ts";

export interface WorkerLoadOptions {
  onUpdate?: (update: RunUpdate) => void;
  signal?: AbortSignal;
}

export function loadRunInWorker(
  files: readonly RunFileInput[],
  { onUpdate, signal }: WorkerLoadOptions = {},
): Promise<RunData> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new TraceWorker();
    let result: RunData["result"];
    const events: RunData["events"] = [];
    const byStep: RunData["byStep"] = new Map();
    let indexFrame: number | undefined;
    let indexTimeout: ReturnType<typeof setTimeout> | undefined;
    function cancelIndex() {
      if (indexFrame !== undefined) cancelAnimationFrame(indexFrame);
      clearTimeout(indexTimeout);
    }
    function send(message: RunWorkerRequest) {
      worker.postMessage(message);
    }
    function beginIndexing() {
      cancelIndex();
      send({ type: "index" });
    }
    function cleanup() {
      cancelIndex();
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    }
    function abort() {
      cleanup();
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data: message }: MessageEvent<RunWorkerMessage>) => {
      try {
        switch (message.type) {
          case "result":
            result = message.result;
            onUpdate?.(message);
            break;
          case "trace":
            events.push(...message.events);
            for (const entry of message.events) {
              if (entry.step === undefined) continue;
              const stepEvents = byStep.get(entry.step);
              if (stepEvents) stepEvents.push(entry);
              else byStep.set(entry.step, [entry]);
            }
            onUpdate?.(message);
            break;
          case "validated":
            onUpdate?.(message);
            indexFrame = requestAnimationFrame(() => {
              indexFrame = requestAnimationFrame(beginIndexing);
            });
            // Animation frames can pause in background tabs.
            indexTimeout = setTimeout(beginIndexing, 100);
            break;
          case "complete":
            cleanup();
            resolve({ ...message.data, result, events, byStep });
            break;
          case "error":
            throw new Error(message.message);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error("Could not read the trace worker response"));
    };
    try {
      // File's structured clone does not carry webkitRelativePath.
      send({
        type: "open",
        files: files.map((file) =>
          "file" in file ? file : { file, relativePath: file.webkitRelativePath },
        ),
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
