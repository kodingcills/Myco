/**
 * Build (or check) a frozen cross-app task set (capability track P): xa-v1 (default) or xa-v2.
 *
 *   npx tsx scripts/cross-app-taskset.ts [--set xa-v1|xa-v2] [--out <dir>] [--check]
 *
 * `--out` defaults to `benchmark/cross-app/<set>`. Deterministic: the same code writes
 * byte-identical files. With --check, it writes nothing and exits 1 if any committed file
 * differs, is missing, or is extra.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { renderXaBundle, XA_SETS, XA_V1 } from "../src/tasks/cross-app-taskset.ts";

const args = process.argv.slice(2);
const setIndex = args.indexOf("--set");
const setName = setIndex >= 0 ? (args[setIndex + 1] as string) : XA_V1.version;
const set = Object.hasOwn(XA_SETS, setName) ? XA_SETS[setName] : undefined;
if (set === undefined) {
  process.stderr.write(`unknown task set ${setName}; known: ${Object.keys(XA_SETS).join(", ")}\n`);
  process.exit(2);
}
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? (args[outIndex + 1] as string) : `benchmark/cross-app/${set.version}`;
const check = args.includes("--check");

const files = renderXaBundle(set);

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

if (check) {
  const problems: string[] = [];
  for (const [path, content] of files) {
    const full = join(out, path);
    if (!existsSync(full)) problems.push(`missing ${path}`);
    else if (readFileSync(full, "utf8") !== content) problems.push(`differs ${path}`);
  }
  for (const full of listFiles(out)) {
    const path = relative(out, full).split("\\").join("/");
    if (!files.has(path)) problems.push(`extra ${path}`);
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`bundle ${out} matches (${files.size} files)\n`);
} else {
  for (const [path, content] of files) {
    const full = join(out, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  process.stdout.write(`wrote ${files.size} files to ${out}\n`);
}
