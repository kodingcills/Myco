import type { RunFileInput } from "./data/loaders.ts";

function readEntry(entry: FileSystemEntry): Promise<RunFileInput[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file(
        (file) => resolve([{ file, relativePath: entry.fullPath.slice(1) }]),
        reject,
      );
    });
  }
  if (!entry.isDirectory) return Promise.resolve([]);
  return readDirectory(entry as FileSystemDirectoryEntry);
}

async function readDirectory(directory: FileSystemDirectoryEntry): Promise<RunFileInput[]> {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) break;
    entries.push(...batch);
  }
  return (await Promise.all(entries.map(readEntry))).flat();
}

export async function droppedFiles(transfer: DataTransfer): Promise<RunFileInput[]> {
  const entries = Array.from(transfer.items, (item) => item.webkitGetAsEntry?.());
  if (!entries.some((entry) => entry?.isDirectory)) return Array.from(transfer.files);
  return (await Promise.all(entries.map((entry) => (entry ? readEntry(entry) : [])))).flat();
}

export function selectionName(files: readonly RunFileInput[]) {
  const first = files[0];
  if (!first) return "";
  const path = "file" in first ? first.relativePath : first.webkitRelativePath;
  if (path?.includes("/")) return path.split("/")[0]!;
  return files.length === 1
    ? ("file" in first ? first.file : first).name
    : "result.json + trace.jsonl";
}
