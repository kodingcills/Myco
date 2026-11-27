/**
 * Build (or check) the public-benchmark task sets from pinned upstream checkouts (#675, #682).
 *
 *   npx tsx scripts/upstream-import.ts --osworld <checkout> --waa <checkout> [--check]
 *
 * Each checkout must be a git clone of the pinned repo at the pinned commit
 * (src/benchmark/upstream/pins.ts); the script refuses any other HEAD. It writes
 * benchmark/upstream/<version>/{manifest.json,tasks.jsonl} and
 * docs/benchmark/upstream/requirements.md. Nothing is downloaded: per-task assets are recorded
 * by URL only (license unclear). With --check it writes nothing and exits 1 on any drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  importSubset,
  OSWORLD_OFFICE_V1,
  type SubsetSpec,
  type UpstreamPin,
  type UpstreamReader,
  WAA_OFFICE_V1,
} from "../src/benchmark/upstream/import.ts";
import { OSWORLD_PIN, WAA_PIN } from "../src/benchmark/upstream/pins.ts";
import { renderRequirementsReport } from "../src/benchmark/upstream/requirements-report.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const check = args.includes("--check");

function fsReader(root: string): UpstreamReader {
  const abs = (rel: string) => {
    const p = resolve(root, rel);
    if (!p.startsWith(`${resolve(root)}/`)) throw new Error(`path escapes checkout: ${rel}`);
    return p;
  };
  return {
    readFile: (rel) => readFileSync(abs(rel)),
    listDir: (rel) => readdirSync(abs(rel)),
    exists: (rel) => existsSync(abs(rel)) && statSync(abs(rel)).isFile(),
  };
}

function headOf(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const outputs = new Map<string, string>();
const manifests = [];
for (const [flag, spec, pin] of [
  ["--osworld", OSWORLD_OFFICE_V1, OSWORLD_PIN],
  ["--waa", WAA_OFFICE_V1, WAA_PIN],
] as [string, SubsetSpec, UpstreamPin][]) {
  const root = opt(flag);
  if (!root) {
    process.stderr.write(`missing ${flag} <checkout>\n`);
    process.exit(2);
  }
  const head = headOf(root);
  if (head !== pin.commit) {
    process.stderr.write(`${flag}: checkout HEAD ${head} is not the pin ${pin.commit}\n`);
    process.exit(1);
  }
  const { manifest, tasks, tasksJsonl } = importSubset(fsReader(root), spec, pin);
  const dir = `benchmark/upstream/${spec.taskSetVersion}`;
  outputs.set(`${dir}/tasks.jsonl`, tasksJsonl);
  outputs.set(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  manifests.push({ manifest, tasks });
}
outputs.set("docs/benchmark/upstream/requirements.md", renderRequirementsReport(manifests));

const problems: string[] = [];
for (const [path, content] of outputs) {
  if (check) {
    if (!existsSync(path)) problems.push(`missing ${path}`);
    else if (readFileSync(path, "utf8") !== content) problems.push(`differs ${path}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
for (const { manifest } of manifests)
  process.stdout.write(
    `${manifest.taskSetVersion}: ${manifest.counts.total} tasks ${JSON.stringify(manifest.counts.perDomain)}\n`,
  );
process.stdout.write(check ? "all outputs match\n" : `wrote ${outputs.size} files\n`);
