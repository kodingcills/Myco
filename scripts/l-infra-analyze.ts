/**
 * `myco-l-infra-analyze` — recompute an L-infra result from its `run.json` and `rows.jsonl`
 * (`--check`: it must equal the dir's `result.json`). See src/parallel/l-infra-cli.ts.
 */

import { mainAnalyze } from "../src/parallel/l-infra-cli.ts";

process.exitCode = mainAnalyze(process.argv.slice(2));
