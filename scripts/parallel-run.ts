/**
 * `myco-parallel` — track L (safe parallelism): N isolated disposable Linux desktops,
 * each trial gated and checked for cross-trial contamination. $0: scripted agents only.
 * See src/parallel/cli.ts for flags and docs/product/safe-parallelism.md for the model.
 */

import { main } from "../src/parallel/cli.ts";

process.exitCode = await main(process.argv.slice(2));
