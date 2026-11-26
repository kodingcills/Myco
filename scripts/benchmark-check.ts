/**
 * False-completion benchmark check CLI (TIF-267): joins arm and grade ledgers and
 * recomputes R1.
 *
 *   npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades grades.jsonl \
 *     --expect myco-gate=100 --expect-unregistrable myco-gate=10 [--expect hcu+shell=30] \
 *     [--require-r1] [--evidence]
 *
 * Prints the CheckResult as JSON. Exit 1 when the ledgers are inconsistent, empty or
 * miscounted; with --require-r1, also when R1 does not pass; with --evidence, also when any
 * row lacks evidence provenance (its planner is not a Claude model id, e.g. a dry run) or had
 * the gate's corrections on (R1 evidence keeps corrections off).
 * --expect-unregistrable asserts how many of an arm's --expect trials are unregistrable (the
 * rest must be gated); --require-r1 needs it for myco-gate (ruling 2026-11-26 08:38Z), so R1's
 * denominator cannot shrink silently. With --require-r1 or --evidence the myco-gate rows are also
 * bound to their published task set (src/benchmark/taskset-binding.ts, shared with the M2 pack
 * check): exactly a whole number of runs of fc-v1, real hashes, split = runs x 10.
 */
import { readFileSync } from "node:fs";
import { type Arm, checkBenchmark } from "../src/benchmark/check.ts";

const args = process.argv.slice(2);
let armPath: string | undefined;
let gradesPath: string | undefined;
let requireR1 = false;
let evidence = false;
const expectTrials: Partial<Record<Arm, number>> = {};
const expectUnregistrable: Partial<Record<Arm, number>> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--arm") armPath = args[++i];
  else if (a === "--grades") gradesPath = args[++i];
  else if (a === "--require-r1") requireR1 = true;
  else if (a === "--evidence") evidence = true;
  else if (a === "--expect" || a === "--expect-unregistrable") {
    const [arm, n] = (args[++i] ?? "").split("=");
    const count = a === "--expect" ? /^[1-9][0-9]*$/ : /^(?:0|[1-9][0-9]*)$/;
    if ((arm !== "myco-gate" && arm !== "hcu+shell") || !count.test(n ?? "")) {
      process.stderr.write(`bad ${a} ${args[i]}\n`);
      process.exit(2);
    }
    (a === "--expect" ? expectTrials : expectUnregistrable)[arm] = Number(n);
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
if (
  requireR1 &&
  expectTrials["myco-gate"] !== undefined &&
  expectUnregistrable["myco-gate"] === undefined
) {
  process.stderr.write(
    "--require-r1 needs --expect-unregistrable myco-gate=<n>: R1's denominator is all trials, with the gated/unregistrable split asserted\n",
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
  expectUnregistrable,
  evidence,
  // R1 and evidence runs are bound to the published task set (#509 round 1, D2), by the same
  // module as the M2 pack check: the split cannot rest on numbers typed here.
  bindTaskSet: requireR1 || evidence,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(!result.ok || (requireR1 && result.r1?.pass !== true) ? 1 : 0);
