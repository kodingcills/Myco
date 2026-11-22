import type { RunFileInput } from "./loaders.ts";
import type { RunWorkerMessage, RunWorkerRequest } from "./trace.worker.ts";
import TraceWorker from "./trace.worker.ts?worker&inline";
import type { RunData, RunUpdate } from "./types.ts";

// Two workers load a run: one streams the trace while the other validates the result, manifest and
// ledger. Idle workers are spawned ahead of a drop so their start-up stays off the verdict path.
const pool: Worker[] = [];

export function warmWorkers(count = 2) {
  while (pool.length < count) pool.push(new TraceWorker());
}

function takeWorker() {
  return pool.pop() ?? new TraceWorker();
}

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
    const worker = takeWorker();
    const resultWorker = takeWorker();
    const channel = new MessageChannel();
    let result: RunData["result"];
    let resultSeen = false;
    // The two workers post independently; everything but the result waits for the result.
    const queued: RunWorkerMessage[] = [];
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
      resultWorker.terminate();
      channel.port1.close();
      channel.port2.close();
      signal?.removeEventListener("abort", abort);
      setTimeout(warmWorkers);
    }
    function abort() {
      cleanup();
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
    function receive({ data: message }: MessageEvent<RunWorkerMessage>) {
      if (message.type !== "result" && message.type !== "error" && !resultSeen) {
        queued.push(message);
        return;
      }
      try {
        handle(message);
        if (message.type === "result") {
          resultSeen = true;
          for (const next of queued.splice(0)) handle(next);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    }
    function handle(message: RunWorkerMessage) {
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
    }
    for (const target of [worker, resultWorker]) {
      target.onmessage = receive;
      target.onerror = (event) => {
        cleanup();
        reject(new Error(event.message));
      };
      target.onmessageerror = () => {
        cleanup();
        reject(new Error("Could not read the trace worker response"));
      };
    }
    try {
      // File's structured clone does not carry webkitRelativePath.
      const inputs = files.map((file) =>
        "file" in file ? file : { file, relativePath: file.webkitRelativePath },
      );
      resultWorker.postMessage({ type: "open-evidence", files: inputs, evidence: channel.port2 }, [
        channel.port2,
      ]);
      worker.postMessage({ type: "open", files: inputs, evidence: channel.port1 }, [channel.port1]);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
