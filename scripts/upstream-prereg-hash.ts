/**
 * Print the canonical SHA-256 (`preregSha256`) of the public-R1 pre-registration and its parity
 * sample, for re-pinning after an edit (#741):
 *
 *   npx tsx scripts/upstream-prereg-hash.ts
 *
 * test/benchmark/upstream-prereg.test.ts checks the .md quotes the first and the record pins the
 * second.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PARITY_SAMPLE_PATH, preregSha256 } from "../src/benchmark/upstream/prereg.ts";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8"));
process.stdout.write(
  `prereg ${preregSha256(read("docs/benchmark/upstream/r1-public-prereg.json"))}` + "\n",
);
process.stdout.write(`parity-sample ${preregSha256(read(PARITY_SAMPLE_PATH))}` + "\n");
