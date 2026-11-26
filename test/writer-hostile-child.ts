/**
 * Child process for the hostile-document tests: verifies one saved file and reports the
 * verdict with this process's peak RSS, so a test can bound the reader's memory without
 * the test runner's own heap in the measurement.
 *
 * Usage: node --import tsx test/writer-hostile-child.ts <file> <seed> <kind>
 */

import type { WriterPostconditionKind } from "../src/tasks/writer-doc-edit.ts";
import { writerIntentFor, writerTaskFor } from "../src/tasks/writer-doc-edit.ts";
import { verifyWriterFile } from "../src/verify/writer-oracle.ts";

const [file, seed, kind] = process.argv.slice(2);
if (file === undefined || seed === undefined || kind === undefined) {
  process.stderr.write("usage: writer-hostile-child.ts <file> <seed> <kind>\n");
  process.exit(2);
}
const intent = writerIntentFor(writerTaskFor(seed, kind as WriterPostconditionKind));
const started = performance.now();
const verdict = verifyWriterFile(file, intent);
const ms = Math.round(performance.now() - started);
process.stdout.write(
  `${JSON.stringify({
    status: verdict.status,
    code: verdict.code,
    reason: verdict.reasons.join(" ").slice(0, 300),
    ms,
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  })}\n`,
);
