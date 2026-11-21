import { unzipSync } from "fflate";

export type RunFileInput = File | { file: File; relativePath: string };

export interface RunFiles {
  paths: readonly string[];
  /** Archive entries are expanded only when requested. */
  read(path: string): Blob | undefined;
}

const evidenceFiles = new Set([
  "result.json",
  "trace.jsonl",
  "trace.extended.jsonl",
  "ledger.jsonl",
  "manifest.json",
]);

function addEntry<T>(entries: Map<string, T>, path: string, value: T) {
  if (
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid evidence path: ${path}`);
  }
  if (entries.has(path)) throw new Error(`Duplicate evidence path: ${path}`);
  entries.set(path, value);
}

function runLayout<T>(entries: Map<string, T>) {
  const traces = [...entries.keys()].filter((path) => path.split("/").at(-1) === "trace.jsonl");
  const trace = traces.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!trace) throw new Error("Run is missing trace.jsonl");
  const prefix = trace.slice(0, -"trace.jsonl".length);
  const layout = new Map<string, T>();
  for (const [path, value] of entries) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (evidenceFiles.has(relative) || relative.startsWith("artifacts/")) {
      layout.set(relative, value);
    }
  }
  if (traces.some((path) => !path.startsWith(`${prefix}artifacts/`) && path !== trace)) {
    throw new Error("Expected exactly one run folder");
  }
  return layout;
}

async function archiveFiles(file: File): Promise<RunFiles> {
  const zip = new Uint8Array(await file.arrayBuffer());
  const entries = new Map<string, string>();
  unzipSync(zip, {
    filter({ name }) {
      if (!name.endsWith("/")) addEntry(entries, name, name);
      return false;
    },
  });
  const layout = runLayout(entries);
  return {
    paths: [...layout.keys()],
    read(path) {
      const entry = layout.get(path);
      if (!entry) return undefined;
      const content = unzipSync(zip, { filter: ({ name }) => name === entry })[entry];
      if (!content) throw new Error(`Could not read archive entry: ${path}`);
      return new Blob([content]);
    },
  };
}

export async function loadRunFiles(inputs: readonly RunFileInput[]): Promise<RunFiles> {
  const files = inputs.map((input) =>
    "file" in input ? input : { file: input, relativePath: input.webkitRelativePath },
  );
  const first = files[0]?.file;
  if (first && files.length === 1 && first.name.toLowerCase().endsWith(".mycotrace")) {
    return archiveFiles(first);
  }

  const entries = new Map<string, File>();
  const isFolder = files.some(({ relativePath }) => relativePath);
  if (!isFolder && (files.length !== 2 || !files.some(({ file }) => file.name === "result.json"))) {
    throw new Error("Select a .mycotrace, a run folder, or a result.json and trace.jsonl pair");
  }
  for (const { file, relativePath } of files) addEntry(entries, relativePath || file.name, file);
  const layout = runLayout(entries);
  return { paths: [...layout.keys()], read: (path) => layout.get(path) };
}
