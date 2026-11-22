import { create } from "zustand";
import type { HeadToHeadReport } from "./data/head-to-head.ts";
import type { RunFileInput } from "./data/loaders.ts";
import { joinSteps } from "./data/steps.ts";
import type { RunData, RunUpdate, SourceRef } from "./data/types.ts";
import type { DisplayVerdict } from "./data/verdict.ts";
import { loadRunInWorker } from "./data/worker-client.ts";

export type InspectorTab = "detail" | "raw";
export type Mode = "why" | "proof";
export type ProofFilter = "checks" | "guards" | "recoveries";
export interface Selection {
  run?: string;
  step?: number;
  check?: number;
  source?: SourceRef;
}

export interface OpenedRun {
  key: string;
  name: string;
  files: readonly RunFileInput[];
  opened: number;
  data: RunData;
  loading: boolean;
  resultReceived?: boolean;
  verdict?: DisplayVerdict;
  error?: string;
}

interface ViewerStore {
  runs: OpenedRun[];
  comparison?: HeadToHeadReport;
  comparisonName?: string;
  openComparison(name: string, report: HeadToHeadReport): void;
  closeComparison(): void;
  selection: Selection;
  mode: Mode;
  sidebarOpen?: boolean;
  railWidth?: number;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  selectStep(step: number): void;
  filter?: ProofFilter;
  select(selection: Selection): void;
  activate(run: OpenedRun): void;
  open(name: string, files: readonly RunFileInput[]): Promise<void>;
  remove(key: string): void;
  inspect(source: SourceRef): void;
  setMode(mode: Mode): void;
  toggleFilter(filter: ProofFilter): void;
}

function readIndex(params: URLSearchParams, key: string) {
  const value = params.get(key);
  return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
}

function readHash(): Selection {
  const params = new URLSearchParams(location.hash.replace(/^#\??/, ""));
  const file = params.get("file");
  const path = params.get("path");
  const line = readIndex(params, "line");
  return {
    run: params.get("run") ?? undefined,
    step: readIndex(params, "step"),
    check: readIndex(params, "check"),
    source: file && line ? { file, line } : file && path !== null ? { file, path } : undefined,
  };
}

function writeHash(selection: Selection) {
  if (typeof location === "undefined") return;
  const { run, step, check, source } = selection;
  const params = new URLSearchParams();
  if (run !== undefined) params.set("run", run);
  if (step !== undefined) params.set("step", String(step));
  if (check !== undefined) params.set("check", String(check));
  if (source) {
    params.set("file", source.file);
    if ("line" in source) params.set("line", String(source.line));
    else params.set("path", source.path);
  }
  const hash = params.size ? `#?${params}` : "";
  if (location.hash !== hash) history.replaceState(null, "", location.href.split("#")[0] + hash);
}

const jobs = new Map<string, AbortController>();
const emptyData = (): RunData => ({
  validation: { kind: "pending" },
  events: [],
  byStep: new Map(),
  ledger: [],
  artifactPaths: [],
  parseErrors: [],
});

// Record references only. Browser file inputs grant access for this session.
function saveRunReferences(runs: OpenedRun[]) {
  if (!globalThis.indexedDB) return;
  let request: IDBOpenDBRequest;
  try {
    request = indexedDB.open("myco-viewer", 1);
  } catch {
    return;
  }
  request.onupgradeneeded = () => request.result.createObjectStore("references");
  request.onsuccess = () => {
    const db = request.result;
    try {
      db.transaction("references", "readwrite")
        .objectStore("references")
        .put(
          runs.map(({ name, data, opened }) => ({ name, runId: data.result?.runId, opened })),
          "opened-runs",
        );
    } finally {
      db.close();
    }
  };
}

export const useViewer = create<ViewerStore>((set, get) => ({
  runs: [],
  openComparison(name, report) {
    set({ comparison: report, comparisonName: name });
  },
  closeComparison() {
    set({ comparison: undefined, comparisonName: undefined });
  },
  selection: typeof location === "undefined" ? {} : readHash(),
  mode: "proof",
  inspectorOpen: true,
  inspectorTab: typeof location !== "undefined" && readHash().source ? "raw" : "detail",
  selectStep(step) {
    const { selection, select } = get();
    if (selection.step === step && !selection.source && selection.check === undefined) return;
    select({ run: selection.run, step });
  },
  select(selection) {
    writeHash(selection);
    set({ selection });
  },
  activate(run) {
    get().select({ run: run.key });
    set({ mode: "proof", filter: undefined, inspectorOpen: true, inspectorTab: "detail" });
  },
  async open(name, files) {
    const run: OpenedRun = {
      key: crypto.randomUUID(),
      name,
      files,
      opened: Date.now(),
      data: emptyData(),
      loading: true,
    };
    const controller = new AbortController();
    jobs.set(run.key, controller);
    const pendingSelection = get().runs.length === 0 ? get().selection : undefined;
    set((state) => ({ runs: [run, ...state.runs] }));
    get().activate(run);

    let key = run.key;
    let previewFrame: number | undefined;
    const pendingEvents: RunData["events"] = [];
    function update(patch: Partial<OpenedRun>) {
      if (controller.signal.aborted) return;
      set((state) => ({
        runs: state.runs.map((item) => (item.key === key ? { ...item, ...patch } : item)),
      }));
    }
    function receive(message: RunUpdate) {
      if (controller.signal.aborted) return;
      if (message.type === "result") {
        const id = message.result?.runId;
        const current = get().selection.run === key;
        const previous = key;
        const { runs } = get();
        // Rows are newest first, even while their workers are still reading the run ID.
        const existing = runs.findIndex((item) => item.key === id);
        if (existing >= 0 && existing < runs.findIndex((item) => item.key === previous)) {
          get().remove(previous);
          if (current) get().activate(runs[existing]!);
          return;
        }
        key = id ?? key;
        if (previous !== key) {
          jobs.get(key)?.abort();
          jobs.delete(previous);
          jobs.set(key, controller);
        }
        set(({ runs }) => ({
          runs: runs
            .filter((item) => item.key !== key || item.key === previous)
            .map((item) =>
              item.key === previous
                ? {
                    ...item,
                    key,
                    resultReceived: true,
                    data: {
                      ...emptyData(),
                      result: message.result,
                      parseErrors: message.parseErrors,
                    },
                  }
                : item,
            ),
        }));
        if (current) {
          const selection = pendingSelection?.run === key ? pendingSelection : { run: key };
          get().select(selection);
          if (selection.source) set({ inspectorOpen: true, inspectorTab: "raw" });
        }
      } else {
        const item = get().runs.find((item) => item.key === key);
        if (!item) return;
        if (message.type === "trace") {
          pendingEvents.push(...message.events);
          previewFrame ??= requestAnimationFrame(publishPreview);
        } else {
          update({ verdict: message.verdict, data: { ...item.data, ...message.evidence } });
        }
      }
    }
    function publishPreview() {
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
      previewFrame = undefined;
      const item = get().runs.find((item) => item.key === key);
      if (item && pendingEvents.length && !controller.signal.aborted) {
        update({ data: { ...item.data, events: item.data.events.concat(pendingEvents) } });
      }
      pendingEvents.length = 0;
    }
    try {
      const data = await loadRunInWorker(files, { onUpdate: receive, signal: controller.signal });
      update({ data, loading: false });
    } catch (error) {
      if (!controller.signal.aborted) {
        publishPreview();
        const message = error instanceof Error ? error.message : String(error);
        const current = get().runs.find((item) => item.key === key);
        if (current) {
          update({
            error: message,
            verdict: undefined,
            loading: false,
            data: {
              ...current.data,
              validation: {
                kind: "invalid",
                reason: {
                  value: "Run evidence could not be read",
                  source: { file: "trace.jsonl", path: "" },
                },
              },
            },
          });
        }
      }
    } finally {
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
      if (jobs.get(key) === controller) jobs.delete(key);
      if (!controller.signal.aborted) saveRunReferences(get().runs);
    }
  },
  remove(key) {
    jobs.get(key)?.abort();
    jobs.delete(key);
    const { runs, selection, activate, select } = get();
    const index = runs.findIndex((item) => item.key === key);
    const remaining = runs.filter((item) => item.key !== key);
    set({ runs: remaining });
    if (selection.run === key) {
      const next = remaining[index] ?? remaining.at(-1);
      if (next) activate(next);
      else select({});
    }
    saveRunReferences(remaining);
  },
  inspect(source) {
    const { selection, runs, select, mode } = get();
    const run = runs.find((item) => item.key === selection.run);
    const check = "path" in source && /^\/(?:verdict\/)?checks\/(\d+)/.exec(source.path);
    const stepPath =
      "path" in source &&
      source.file === "result.json" &&
      /^\/steps\/(\d+)(?:\/|$)/.exec(source.path);
    const trace = "line" in source && /^trace(?:\.extended)?\.jsonl$/.test(source.file);
    const direct = trace && run ? findTraceEntry(run.data, source) : undefined;
    const step = stepPath
      ? run?.data.result?.steps[Number(stepPath[1])]?.step
      : (direct?.step ??
        (run && direct
          ? joinSteps(run.data).rows.find((row) => row.events.includes(direct))?.step
          : undefined));
    const hasStep =
      step !== undefined && run?.data.result?.steps.some((record) => record.step === step);
    const detail = mode === "proof" && trace && hasStep;
    select({
      run: selection.run,
      step: hasStep ? step : selection.step,
      check: check ? Number(check[1]) : undefined,
      source,
    });
    set({
      mode: hasStep ? "why" : mode,
      inspectorOpen: true,
      inspectorTab: detail ? "detail" : "raw",
    });
  },
  setMode: (mode) => set({ mode, filter: undefined }),
  toggleFilter: (filter) =>
    set((state) => ({
      mode: "proof",
      filter: state.filter === filter ? undefined : filter,
    })),
}));

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const selection = readHash();
    useViewer.setState({
      selection,
      ...(selection.source && { inspectorOpen: true, inspectorTab: "raw" }),
    });
  });
}

export function findTraceEntry(data: RunData, source: Extract<SourceRef, { line: number }>) {
  const matches = ({ source: entry }: RunData["events"][number]) =>
    "line" in entry && entry.file === source.file && entry.line === source.line;
  return data.events.find(matches) ?? data.proofEvents?.find(matches);
}

export function useActiveRun() {
  return useViewer((state) => state.runs.find((run) => run.key === state.selection.run));
}
