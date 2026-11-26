/**
 * TIF-274 SIMULATED dry run over fc-v1 (no model, no VM; never evidence).
 *
 *   npx tsx scripts/m2-r1-dryrun.ts --out <dir>
 *
 * Writes <dir>/SIMULATED, <dir>/arm.jsonl and <dir>/docs/. Then grade and check as usual:
 *   npx tsx scripts/benchmark-make-requests.ts --bundle benchmark/false-completion/fc-v1 \
 *     --arm <dir>/arm.jsonl --docs <dir>/docs --out <dir>/work
 *   npx tsx scripts/benchmark-grade.ts <dir>/work/requests.jsonl > <dir>/grades.jsonl
 *   npx tsx scripts/benchmark-check.ts --arm <dir>/arm.jsonl --grades <dir>/grades.jsonl --expect myco-gate=100
 * Adding `--evidence` to the check refuses the ledger: simulated rows are never evidence.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runDryRun } from "../src/benchmark/r1-dryrun.ts";
import type { BenchmarkTask } from "../src/benchmark/taskset.ts";

const args = process.argv.slice(2);
const i = args.indexOf("--out");
const out = i >= 0 ? args[i + 1] : undefined;
if (out === undefined) {
  process.stderr.write("usage: m2-r1-dryrun.ts --out <dir>\n");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const tasks = readFileSync(join(root, "benchmark/false-completion/fc-v1/tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);
const { armRows } = await runDryRun(
  tasks,
  resolve(out),
  ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) => join(root, p)),
);
process.stdout.write(
  `SIMULATED dry run: ${armRows.length} arm rows written to ${resolve(out)} (never evidence)\n`,
);
