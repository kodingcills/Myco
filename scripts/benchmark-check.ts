/**
 * False-completion benchmark check CLI (TIF-267): joins arm and grade ledgers and
 * recomputes R1.
 *
 *   npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades grades.jsonl \
 *     --expect myco-gate=100 [--expect hcu+shell=30] [--require-r1] [--evidence]
 *
 * Prints the CheckResult as JSON. Exit 1 when the ledgers are inconsistent, empty or
 * miscounted; with --require-r1, also when R1 does not pass; with --evidence, also when any
 * row lacks evidence provenance (its planner is not a Claude model id, e.g. a dry run).
 */
import { readFileSync } from "node:fs";
import { type Arm, checkBenchmark } from "../src/benchmark/check.ts";

const args = process.argv.slice(2);
let armPath: string | undefined;
let gradesPath: string | undefined;
let requireR1 = false;
let evidence = false;
const expectTrials: Partial<Record<Arm, number>> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--arm") armPath = args[++i];
  else if (a === "--grades") gradesPath = args[++i];
  else if (a === "--require-r1") requireR1 = true;
  else if (a === "--evidence") evidence = true;
  else if (a === "--expect") {
    const [arm, n] = (args[++i] ?? "").split("=");
    if ((arm !== "myco-gate" && arm !== "hcu+shell") || !/^[1-9][0-9]*$/.test(n ?? "")) {
      process.stderr.write(`bad --expect ${args[i]}\n`);
      process.exit(2);
    }
    expectTrials[arm] = Number(n);
  } else {
    process.stderr.write(`unknown argument ${a}\n`);
    process.exit(2);
  }
}
if (armPath === undefined || gradesPath === undefined || Object.keys(expectTrials).length === 0) {
  process.stderr.write(
    "usage: benchmark-check.ts --arm <jsonl> --grades <jsonl> --expect <arm>=<n> ...\n",
  );
  process.exit(2);
}
const readJsonl = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);

const result = checkBenchmark(readJsonl(armPath), readJsonl(gradesPath), {
  expectTrials,
  evidence,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(!result.ok || (requireR1 && result.r1?.pass !== true) ? 1 : 0);
