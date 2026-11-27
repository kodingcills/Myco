/**
 * Judge a track N run against its pre-registered bar (capability-spec-2 §2 N).
 *
 *   npx tsx scripts/handoff-bar.ts --prereg docs/product/capability-prereg/n-v1/prereg.json \
 *     --trials <run>/handoff-bar.jsonl [--json]
 *
 * Refuses (exit 2) a pre-registration whose pinned spec or analysis files differ from the ones on
 * disk, and any run that is incomplete or inconsistent. Exit 0 only when the bar is shown on
 * evidence rows; a simulated run that would pass exits 1, because simulated rows are never
 * evidence, and so does a run that meets the bar while a lead ruling is pending
 * (`LEAD_RULING_PENDING`).
 * Exit codes: 0 shown (evidence), 1 not shown, simulated or lead ruling pending, 2 incomplete or
 * refused, 3 usage.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  analysisPinProblems,
  analyzeHandoffBar,
  type HoPrereg,
  preregProblems,
} from "../src/handoff/bar.ts";

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: handoff-bar --prereg <json> --trials <jsonl> [--json]\n`,
  );
  process.exit(3);
}

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const preregPath = value("--prereg") ?? usage("missing --prereg");
const trialsPath = value("--trials") ?? usage("missing --trials");
const asJson = args.includes("--json");

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return refuse(`${what} is not JSON`);
  }
}

const prereg = parseJson(readFileSync(preregPath, "utf8"), "the pre-registration");
const trials = readFileSync(trialsPath, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l, i) => parseJson(l, `trial line ${i + 1}`));

const refusals = preregProblems(prereg);
if (refusals.length === 0) {
  const root = process.cwd();
  refusals.push(
    ...analysisPinProblems(prereg as HoPrereg, (path) => {
      const full = resolve(root, path);
      return existsSync(full) ? readFileSync(full) : null;
    }),
  );
}
if (refusals.length > 0) {
  process.stderr.write(`refused: ${refusals.join("; ")}\n`);
  process.exit(2);
}

const result = analyzeHandoffBar(prereg, trials);
if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  // Tag only rows that are simulated; an incomplete evidence run is not "SIMULATED".
  const simulated = result.provenance === "simulated" || result.provenance === "mixed";
  process.stdout.write(`track N bar: ${result.decision}${simulated ? " (SIMULATED)" : ""}\n`);
  for (const r of result.reasons) process.stdout.write(`  ${r}\n`);
  for (const e of result.errors.slice(0, 20)) process.stdout.write(`  error: ${e}\n`);
}
process.exit(
  result.decision === "incomplete" ? 2 : result.decision === "shown" && result.evidence ? 0 : 1,
);
