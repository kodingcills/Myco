/**
 * Track P pre-registration p-v1: check it, print its run order, or analyse a pack against it.
 *
 *   npx tsx scripts/cross-app-prereg.ts check
 *   npx tsx scripts/cross-app-prereg.ts schedule
 *   npx tsx scripts/cross-app-prereg.ts analyze <pack.json>
 *
 * `check` exits 1 if the committed prereg disagrees with its hash file or with anything it
 * pins (task set manifest, task ids, this script, the analysis module). `analyze` runs the
 * same check first and refuses to analyse under an inconsistent prereg; it prints the result
 * as JSON and exits 0 for a decided result (shown or not shown), 1 otherwise (refused,
 * incomplete). Every row a builder makes before the lead's GO is simulated, and the
 * analysis refuses it (`SIMULATED_ROW`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  analyzePPack,
  assignmentSchedule,
  loadPPrereg,
  type PPack,
} from "../src/benchmark/cross-app-prereg.ts";

const ROOT = resolve(import.meta.dirname, "..");
const [command, arg] = process.argv.slice(2);
const loaded = loadPPrereg(ROOT);

function failOnPrereg(): void {
  if (loaded.problems.length > 0) {
    process.stderr.write(`prereg p-v1 inconsistent: ${loaded.problems.join(", ")}\n`);
    process.exit(1);
  }
}

if (command === "check") {
  failOnPrereg();
  process.stdout.write(`prereg p-v1 ok: ${loaded.hash}\n`);
} else if (command === "schedule") {
  failOnPrereg();
  const schedule = assignmentSchedule(
    loaded.prereg.taskSet.taskIds,
    loaded.prereg.seeds.assignment,
  );
  process.stdout.write(schedule.map((s, i) => `${i}\t${s.arm}\t${s.taskId}\n`).join(""));
} else if (command === "analyze" && arg !== undefined) {
  failOnPrereg();
  const pack = JSON.parse(readFileSync(arg, "utf8")) as PPack;
  const result = analyzePPack(pack, loaded.prereg, loaded.hash);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.decision === "shown" || result.decision === "not-shown" ? 0 : 1);
} else {
  process.stderr.write("usage: cross-app-prereg.ts check | schedule | analyze <pack.json>\n");
  process.exit(2);
}
