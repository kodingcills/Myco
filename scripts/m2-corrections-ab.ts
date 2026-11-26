/**
 * Corrections ON/OFF A/B under the independent grader (TIF-274 / track B; pre-registered in
 * the M2 plan, #526 §7.2.1). See src/m2/corrections-ab.ts.
 *
 *   npx tsx scripts/m2-corrections-ab.ts --on-arm on/arm.jsonl --on-grades on/grades.jsonl \
 *     --off-arm off/arm.jsonl --off-grades off/grades.jsonl --stage 0|1 [--evidence]
 *
 * Prints the AbResult as JSON. Exit 1 when the run is not ok (inconsistent ledgers, incomplete
 * pairs, or an integrity incident: a false DONE accepted in either arm); 2 on usage.
 */
import { readFileSync } from "node:fs";
import { type AbStage, checkCorrectionsAb } from "../src/m2/corrections-ab.ts";

const FILES = ["--on-arm", "--on-grades", "--off-arm", "--off-grades"] as const;
const args = process.argv.slice(2);
const paths: Partial<Record<(typeof FILES)[number], string>> = {};
let stage: AbStage | undefined;
let evidence = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if ((FILES as readonly string[]).includes(a as string))
    paths[a as (typeof FILES)[number]] = args[++i];
  else if (a === "--stage") {
    const s = args[++i];
    if (s !== "0" && s !== "1") {
      process.stderr.write(`bad --stage ${s} (0 or 1)\n`);
      process.exit(2);
    }
    stage = Number(s) as AbStage;
  } else if (a === "--evidence") evidence = true;
  else {
    process.stderr.write(`unknown argument ${a}\n`);
    process.exit(2);
  }
}
if (FILES.some((k) => paths[k] === undefined) || stage === undefined) {
  process.stderr.write(
    "usage: m2-corrections-ab.ts --on-arm <jsonl> --on-grades <jsonl> --off-arm <jsonl> --off-grades <jsonl> --stage 0|1 [--evidence]\n",
  );
  process.exit(2);
}
const read = (k: (typeof FILES)[number]) =>
  readFileSync(paths[k] as string, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
const result = checkCorrectionsAb(
  {
    on: { arm: read("--on-arm"), grades: read("--on-grades") },
    off: { arm: read("--off-arm"), grades: read("--off-grades") },
  },
  { stage, evidence },
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
