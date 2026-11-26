/**
 * Episode datasets (data capture track; docs/data/episode-format.md).
 *
 *   npx tsx scripts/myco-episodes.ts export --from <store> --out <dir> --simulated
 *   npx tsx scripts/myco-episodes.ts validate --dataset <dir>
 *   npx tsx scripts/myco-episodes.ts import --dataset <dir> --into <store>
 */
import { main } from "../src/episode/cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});
