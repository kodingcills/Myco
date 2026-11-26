/**
 * Build (or check) the frozen cross-app task set xa-v1 (capability track P).
 *
 *   npx tsx scripts/cross-app-taskset.ts [--out benchmark/cross-app/xa-v1] [--check]
 *
 * Deterministic: the same code writes byte-identical files. With --check, it writes
 * nothing and exits 1 if any committed file differs, is missing, or is extra.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { renderXaBundle } from "../src/tasks/cross-app-taskset.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? (args[outIndex + 1] as string) : "benchmark/cross-app/xa-v1";
const check = args.includes("--check");

const files = renderXaBundle();

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
