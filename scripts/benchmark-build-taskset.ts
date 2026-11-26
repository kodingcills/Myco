/**
 * Build (or check) the published false-completion task set (TIF-267 part 2).
 *
 *   npx tsx scripts/benchmark-build-taskset.ts [--out benchmark/false-completion/fc-v1] [--check]
 *
 * Deterministic: the same code writes byte-identical files. With --check, it writes
 * nothing and exits 1 if any committed file differs, is missing, or is extra.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BUNDLE_README } from "../src/benchmark/bundle-readme.ts";
import { GRADER_VERSION } from "../src/benchmark/grade/grade.ts";
import { buildTaskSet, renderBundle } from "../src/benchmark/taskset.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? (args[outIndex + 1] as string) : "benchmark/false-completion/fc-v1";
const check = args.includes("--check");

const files = renderBundle(buildTaskSet(), GRADER_VERSION, BUNDLE_README);

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
