/**
 * Check a false-completion bundle on disk against its own manifest.json (TIF-267 part 2).
 *
 *   npx tsx scripts/benchmark-verify-bundle.ts <bundle dir>
 *
 * For someone holding only the bundle: it re-hashes every file and compares it with the
 * SHA-256 the manifest records, and reports any file that is missing, differs, or is not in
 * the manifest. It uses Node built-ins only and imports nothing from the repo, so it can be
 * copied out and run on its own. Exits 0 when the bundle matches, 1 otherwise.
 *
 * Unlike `benchmark-build-taskset.ts --check`, which regenerates the bundle from code, this
 * trusts the manifest; it proves the copy is intact, not that the manifest is the one the
 * repo publishes (compare manifest.json's own hash with a published one for that).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const dir = process.argv[2];
if (dir === undefined) {
  process.stderr.write("usage: benchmark-verify-bundle.ts <bundle dir>\n");
  process.exit(2);
}
const root = resolve(dir);

function listFiles(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(d, e.name)) : [join(d, e.name)],
  );
}

let manifest: { schema?: unknown; files?: unknown };
try {
  manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
} catch (e) {
  process.stderr.write(`cannot read ${join(dir, "manifest.json")}: ${(e as Error).message}\n`);
  process.exit(1);
}
const files = manifest.files;
if (
  manifest.schema !== "myco.benchmark.bundle/1" ||
  typeof files !== "object" ||
  files === null ||
  Array.isArray(files)
) {
  process.stderr.write("manifest.json is not a myco.benchmark.bundle/1 manifest\n");
  process.exit(1);
}

const problems: string[] = [];
const listed = new Set<string>();
for (const [path, expected] of Object.entries(files as Record<string, unknown>)) {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === "" || isAbsolute(rel) || rel.split(/[\\/]/)[0] === ".." || path === "manifest.json") {
    problems.push(`bad path ${JSON.stringify(path)}`);
    continue;
  }
  listed.add(rel.split("\\").join("/"));
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
    problems.push(`bad hash for ${path}`);
  } else if (!existsSync(full)) {
    problems.push(`missing ${path}`);
  } else if (createHash("sha256").update(readFileSync(full)).digest("hex") !== expected) {
    problems.push(`differs ${path}`);
  }
}
for (const full of listFiles(root)) {
  const path = relative(root, full).split("\\").join("/");
  if (path !== "manifest.json" && !listed.has(path)) problems.push(`extra ${path}`);
}
if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`bundle ${dir} matches its manifest (${listed.size} files + manifest.json)\n`);
