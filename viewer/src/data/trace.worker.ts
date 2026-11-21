import { loadRunFiles, type RunFileInput } from "./loaders.ts";
import { parseRun } from "./parse.ts";
import type { RunData, RunUpdate } from "./types.ts";

export type RunWorkerMessage =
  | RunUpdate
  | {
      type: "complete";
      data: Omit<RunData, "result" | "events" | "byStep">;
      stepIndices: Map<number, number[]>;
    }
  | { type: "error"; message: string };

function send(message: RunWorkerMessage) {
  self.postMessage(message);
}

self.onmessage = async ({ data: files }: MessageEvent<RunFileInput[]>) => {
  try {
    const {
      result: _result,
      events,
      byStep,
      ...data
    } = await parseRun(await loadRunFiles(files), send);
    const indices = new Map(events.map((entry, index) => [entry, index]));
    const stepIndices = new Map(
      Array.from(byStep, ([step, entries]) => [step, entries.map((entry) => indices.get(entry)!)]),
    );
    send({ type: "complete", data, stepIndices });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
