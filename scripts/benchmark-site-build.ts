/**
 * Build the false-completion benchmark site locally (workstream 3, track G). See
 * src/benchmark/site/build.ts and docs/benchmark/site.md.
 *
 *   npx tsx scripts/benchmark-site-build.ts --out DIR [--identity-file FILE]
 *
 * Writes the static site into DIR (which must not exist or be empty). Nothing is published or
 * deployed. The results table is filled only from committed, digest-verified result packs under
 * benchmark/false-completion/results/, recomputed by the M2 evidence check; test-fixture packs
 * are always refused here. Exit 1 on a refused pack or a leak finding (reasons are codes, paths
 * and line numbers, never file content), 2 on usage.
 */
import { resolve } from "node:path";
import { buildSite, gitCommittedCheck, writeSite } from "../src/benchmark/site/build.ts";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
let out: string | undefined;
let identityFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === "--out" && v !== undefined) {
    out = resolve(v);
    i++;
  } else if (a === "--identity-file" && v !== undefined) {
    identityFile = resolve(v);
    i++;
  } else {
    out = undefined;
    break;
  }
}
if (out === undefined) {
  process.stderr.write("usage: benchmark-site-build.ts --out DIR [--identity-file FILE]\n");
  process.exit(2);
}

try {
  const files = buildSite({
    repoRoot: ROOT,
    isCommitted: gitCommittedCheck(ROOT),
    ...(identityFile === undefined ? {} : { identityFile }),
  });
  writeSite(out, files);
  process.stdout.write(`${JSON.stringify({ ok: true, files: [...files.keys()] })}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
