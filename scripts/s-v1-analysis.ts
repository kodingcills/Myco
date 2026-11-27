/**
 * Track S: analyse a trg-v1 conformance run against the frozen s-v1 pre-registration.
 *
 *   npx tsx scripts/s-v1-analysis.ts --results <results.json> --mutation-log <proof output>
 *
 * `--results` is the conformance runner's `myco.schedule.conformance-results/1` file;
 * `--mutation-log` is the output of `python3 scripts/schedule-mutation-proof.py`.
 * Prints the `myco.schedule.s-v1-report/1` report as JSON on stdout.
 *
 * The mutation log's rows must be exactly the mutants of the frozen proof script (label and
 * file), parsed from that script by `loadSV1Prereg`; made-up or missing rows read "not shown".
 * While the pre-registration lists any pending lead ruling, the verdict is "not shown" with
 * LEAD_RULING_PENDING (exit 1), whatever the data says.
 *
 * Exit codes: 0 "property holds"; 1 "not shown"; 2 refused (the input or the tree does not
 * match the frozen pre-registration; the code is printed, nothing is analysed); 64 usage.
 * Offline: no model, no VM, no network. The report is never evidence (simulated rows).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeSV1, SV1RefusalError } from "../src/schedule/conformance/analysis.ts";
import { loadSV1Prereg, parseMutationLog } from "../src/schedule/conformance/prereg.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const resultsPath = arg("--results");
const mutationPath = arg("--mutation-log");
if (!resultsPath || !mutationPath) {
  process.stderr.write(
    "usage: s-v1-analysis --results <results.json> --mutation-log <proof output>\n",
  );
  process.exit(64);
}

const root = resolve(import.meta.dirname, "..");
try {
  const loaded = loadSV1Prereg(root);
  let results: unknown;
  try {
    results = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch {
    throw new SV1RefusalError("RESULTS_UNREADABLE");
  }
  let log: string;
  try {
    log = readFileSync(mutationPath, "utf8");
  } catch {
    throw new SV1RefusalError("MUTATION_LOG_UNREADABLE");
  }
  const mutation = parseMutationLog(log, loaded.frozen.mutationScriptSha256);
  const report = analyzeSV1(loaded.frozen, loaded.corpus, results, mutation);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === "property holds" ? 0 : 1;
} catch (e) {
  if (!(e instanceof SV1RefusalError)) throw e;
  process.stderr.write(`s-v1 analysis refused: ${e.code}\n`);
  process.exitCode = 2;
}
