/**
 * Track Q (replayable proof): export, verify and report proof bundles. See src/proof/cli.ts.
 */
import { main } from "../src/proof/cli.ts";

process.exitCode = main(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
