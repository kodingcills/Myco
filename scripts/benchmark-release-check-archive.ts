/**
 * Check a release archive's raw tar headers (track G, #613; #612 N2).
 *
 *   node scripts/benchmark-release-check-archive.ts <archive.tar> <root>
 *
 * Refuses any header that is not a plain ustar regular file (pax `x`/`g`, GNU `L`/`K`, a
 * directory or link), a mode other than 0644, a uid or gid other than 0, an owner or group
 * name, a path outside `<root>/`, and any entry `<root>/SHA256SUMS` does not list (or a listed
 * file that is missing or differs). See `src/benchmark/release/archive-check.ts`. Run by
 * `scripts/benchmark-release-repro.sh` before it unpacks anything.
 *
 * Exit 0 when clean; 1 with one finding per line on stderr; 2 on a usage error.
 */
import { readFileSync } from "node:fs";
import { checkReleaseArchive } from "../src/benchmark/release/archive-check.ts";

const [archive, root] = process.argv.slice(2);
if (archive === undefined || root === undefined || process.argv.length !== 4) {
  process.stderr.write("usage: benchmark-release-check-archive.ts <archive.tar> <root>\n");
  process.exit(2);
}
const findings = checkReleaseArchive(readFileSync(archive), root);
if (findings.length > 0) {
  process.stderr.write(`archive refused: ${findings.length} finding(s)\n${findings.join("\n")}\n`);
  process.exit(1);
}
