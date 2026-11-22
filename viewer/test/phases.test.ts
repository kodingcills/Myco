import { readdir, readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { loadRunFiles } from "../src/data/loaders.ts";
import {
  cachedReader,
  finishEvidence,
  parseLedgerPhase,
  parseResultPhase,
  parseRunEvidence,
  parseTracePhase,
} from "../src/data/parse.ts";
import { deriveVerdict } from "../src/data/verdict.ts";

const sample = "../../docs/research/experiments/m1-013-session1";
const fixture = "../../foundry/viewer-fixtures";
const folders = [
  `${sample}/normal-711e16c1`,
  `${sample}/refuted-autocorrect-d7ad45bf`,
  `${sample}/kill-87ee5b14`,
  `${fixture}/verified`,
  `${fixture}/recovered`,
  `${fixture}/false-success`,
  `${fixture}/unknown`,
];

async function load(path: string, edit = (_name: string, body: string) => body) {
  const folder = new URL(`${path}/`, import.meta.url);
  const entries = await readdir(folder, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async ({ name }) => ({
        file: new File([edit(name, await readFile(new URL(name, folder), "utf8"))], name),
        relativePath: `run/${name}`,
      })),
  );
  return loadRunFiles(files);
}

/** The load workers run these phases on two threads; the join must match the sequential read. */
async function parallel(files: Awaited<ReturnType<typeof load>>) {
  const resultSide = (async () => {
    const read = cachedReader(files);
    const phase = await parseResultPhase(files, read);
    const ledger = await parseLedgerPhase(read);
    return { phase, ledger, manifestError: await phase.manifestCheck };
  })();
  const trace = await parseTracePhase(files, cachedReader(files));
  const { phase, ledger, manifestError } = await resultSide;
  return finishEvidence(files, phase, trace, ledger, manifestError);
}

test.each(folders)("two-thread phase join equals the sequential read for %s", async (folder) => {
  const sequential = await parseRunEvidence(await load(folder));
  const joined = await parallel(await load(folder));
  expect(joined).toEqual(sequential);
  expect(deriveVerdict(joined)).toEqual(deriveVerdict(sequential));
});

test.each([
  [
    "malformed trace",
    (name: string, body: string) => (name === "trace.jsonl" ? `${body}{\n` : body),
  ],
  [
    "bad result schema",
    (name: string, body: string) =>
      name === "result.json" ? body.replace('"runId"', '"runIdX"') : body,
  ],
  [
    "bad ledger row",
    (name: string, body: string) => (name === "ledger.jsonl" ? `${body}{"oops":1}\n` : body),
  ],
])("join keeps error order for %s", async (_label, edit) => {
  const folder = `${fixture}/verified`;
  const sequential = await parseRunEvidence(await load(folder, edit));
  const joined = await parallel(await load(folder, edit));
  expect(joined.parseErrors.length).toBeGreaterThan(0);
  expect(joined).toEqual(sequential);
});
