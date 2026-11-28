/**
 * Track I pre-registered analysis (capability spec §3):
 *
 *   npx tsx scripts/capability-i-analysis.ts <pack.json>
 *
 * Frozen by SHA-256 in docs/product/capability-prereg/i-v1/prereg.json; logic lives in
 * src/state/i-analysis.ts and src/state/i-analysis-cli.ts.
 */
import { resolve } from "node:path";
import { main } from "../src/state/i-analysis-cli.ts";

process.exitCode = main(process.argv.slice(2), resolve(import.meta.dirname, ".."), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
