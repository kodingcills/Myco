/**
 * Replace the first occurrence of a literal string in a file (used by mutation-proof scripts).
 *
 *   npx tsx scripts/replace-once.ts <file>    with FROM and TO in the environment
 *
 * Exits 1 if FROM does not occur, so a stale mutant pattern is reported, never silently skipped.
 */
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
const from = process.env.FROM;
const to = process.env.TO ?? "";
if (!file || !from) {
  process.stderr.write("usage: FROM=... TO=... replace-once.ts <file>\n");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
const at = text.indexOf(from);
if (at < 0) process.exit(1);
writeFileSync(file, text.slice(0, at) + to + text.slice(at + from.length));
