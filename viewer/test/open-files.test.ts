import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { loadRunFiles } from "../src/data/loaders.ts";
import { parseRun } from "../src/data/parse.ts";
import { droppedFiles, selectionName } from "../src/open-files.ts";

const result = JSON.stringify({
  recordKind: "session",
  runId: "opened",
  startedAt: "2026-11-21T12:00:00Z",
  steps: [],
});
const pair = [new File([result], "result.json"), new File([], "trace.jsonl")];
const archive = new File(
  [
    zipSync({
      "sample/result.json": strToU8(result),
      "sample/trace.jsonl": new Uint8Array(),
    }),
  ],
  "sample.mycotrace",
);

function folderEntry(): FileSystemDirectoryEntry {
  const batches = pair.map((file) => [
    {
      isFile: true,
      fullPath: `/sample/${file.name}`,
      file: (accept: FileCallback) => accept(file),
    },
  ]);
  return {
    isDirectory: true,
    createReader: () => ({
      readEntries: (accept: (entries: unknown[]) => void) => accept(batches.shift() ?? []),
    }),
  } as FileSystemDirectoryEntry;
}

test.each([
  ["archive", [archive], [], "sample.mycotrace"],
  ["bare pair", pair, [], "result.json + trace.jsonl"],
  ["folder", [], [{ webkitGetAsEntry: folderEntry }], "sample"],
] as const)("a dropped %s opens as one run", async (_, files, items, name) => {
  const inputs = await droppedFiles({ files, items } as unknown as DataTransfer);
  expect(selectionName(inputs)).toBe(name);
  const data = await parseRun(await loadRunFiles(inputs));
  expect(data.result?.runId).toBe("opened");
  expect(data.parseErrors).toEqual([]);
});
