import type { RunFiles } from "./loaders.ts";
import type { ResultRecord, RunData, RunManifest, Sourced, ViewTraceEvent } from "./types.ts";
import { equalJson, isRecovery } from "./verdict.ts";

export async function checkManifest({
  files,
  manifest,
  result,
  read,
}: {
  files: RunFiles;
  manifest?: RunManifest;
  result?: ResultRecord;
  read: RunFiles["read"];
}): Promise<Sourced<string> | undefined> {
  const file = "manifest.json";
  if (!files.paths.includes(file)) return;
  if (!manifest) return { value: "The manifest could not be read", source: { file, path: "" } };
  if (!result || manifest.runId !== result.runId) {
    return { value: "Manifest run ID does not match the result", source: { file, path: "/runId" } };
  }

  const required = new Set(["result.json", "trace.jsonl", ...files.paths]);
  required.delete(file);
  for (const path of required) {
    if (!Object.hasOwn(manifest.files, path)) {
      return {
        value: `Manifest is missing the digest for ${path}`,
        source: { file, path: "/files" },
      };
    }
  }
  for (const [path, expected] of Object.entries(manifest.files)) {
    const source = { file, path: `/files/${path.replaceAll("~", "~0").replaceAll("/", "~1")}` };
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) {
      return { value: `Invalid SHA-256 digest for ${path}`, source };
    }
    try {
      const blob = read(path) ?? files.readManifestEntry?.(path);
      if (!blob) return { value: `Manifest lists missing file ${path}`, source };
      const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      const actual = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (actual !== expected.toLowerCase()) {
        return { value: `SHA-256 mismatch for ${path}`, source };
      }
    } catch {
      return { value: `Could not check the SHA-256 digest for ${path}`, source };
    }
  }
}

export function checkRunEvidence(
  result: ResultRecord | undefined,
  events: ViewTraceEvent[],
  byStep: RunData["byStep"],
  ledger: RunData["ledger"],
  manifestChecked: boolean,
): Sourced<string> | undefined {
  if (!result) return;
  const couldVerify = result.recordKind !== "session" && result.verdict.status === "verified";
  let started = false;
  let recovery = false;
  for (const entry of events) {
    if (entry.kind !== "standard") continue;
    const { event, source } = entry;
    if (event.type === "run-start") {
      if (
        event.runId !== result.runId ||
        (result.taskId !== undefined && event.taskId !== result.taskId) ||
        (event.startedAt !== result.startedAt &&
          Date.parse(event.startedAt) !== Date.parse(result.startedAt))
      ) {
        return { value: "Trace run identity does not match the result", source };
      }
      if (source.file === "trace.jsonl") {
        if (started) return { value: "Trace contains multiple run starts", source };
        started = true;
      }
    }
    if (isRecovery(event)) recovery = true;
  }
  if (!started && (couldVerify || manifestChecked)) {
    return {
      value: "Trace is missing its run start",
      source: { file: "trace.jsonl", path: "" },
    };
  }
  const wrongRun = manifestChecked && ledger.find(({ value }) => value.runId !== result.runId);
  if (wrongRun)
    return { value: "Ledger run ID does not match the result", source: wrongRun.source };
  if (!couldVerify) return;

  const seen = new Set<number>();
  for (const [index, step] of result.steps.entries()) {
    const source = { file: "result.json", path: `/steps/${index}` };
    const entries = byStep.get(step.step) ?? [];
    if (seen.has(step.step)) return { value: `Duplicate result step ${step.step}`, source };
    seen.add(step.step);
    if (
      !entries.some(
        ({ kind, event, source }) =>
          kind === "standard" &&
          event.type === "action" &&
          source.file === "trace.jsonl" &&
          equalJson(event.action, step.action),
      )
    ) {
      return { value: `Trace is missing the recorded action for step ${step.step}`, source };
    }
    for (const [phase, guards] of [
      ["pre", step.preconditionResults],
      ["post", step.postconditionResults],
    ] as const) {
      if (
        guards.length &&
        !entries.some(
          ({ kind, event, source }) =>
            kind === "standard" &&
            event.type === "guard-evaluation" &&
            event.phase === phase &&
            source.file === "trace.jsonl" &&
            equalJson(event.results, guards),
        )
      ) {
        return {
          value: `Trace is missing recorded ${phase}condition evidence for step ${step.step}`,
          source,
        };
      }
    }
    if (
      !recovery &&
      [...step.preconditionResults, ...step.postconditionResults].some(({ passed }) => !passed) &&
      !entries.some(({ kind, event }) => kind === "standard" && event.type === "guard-failure")
    ) {
      return {
        value: `Trace is missing failure or recovery evidence for step ${step.step}`,
        source,
      };
    }
  }
}
