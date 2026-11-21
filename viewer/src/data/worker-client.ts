import type { RunFileInput } from "./loaders.ts";
import type { RunWorkerMessage } from "./trace.worker.ts";
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
    function cleanup() {
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
            onUpdate?.(message);
            break;
          case "complete": {
            const byStep = new Map(
              Array.from(message.stepIndices, ([step, indices]) => [
                step,
                indices.map((index) => events[index]!),
              ]),
            );
            cleanup();
            resolve({ ...message.data, result, events, byStep });
            break;
          }
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
      worker.postMessage(
        files.map((file) =>
          "file" in file ? file : { file, relativePath: file.webkitRelativePath },
        ),
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
