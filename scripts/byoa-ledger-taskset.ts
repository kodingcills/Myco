/**
 * Build (or check) the frozen task set byoa-ledger-v1 (capability track T, #673).
 *
 *   npx tsx scripts/byoa-ledger-taskset.ts [--out benchmark/byoa-ledger/byoa-ledger-v1] [--check]
 *
 * Deterministic: the same code writes byte-identical files. With --check, it writes nothing
 * and exits 1 if any committed file differs, is missing, or is extra.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BYOA_BUNDLE_DIR,
  checkByoaBundle,
  renderByoaBundle,
} from "../src/tasks/byoa-ledger-taskset.ts";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? (args[outIndex + 1] as string) : BYOA_BUNDLE_DIR;
const files = renderByoaBundle();

if (args.includes("--check")) {
  const problems = checkByoaBundle(out, files);
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
