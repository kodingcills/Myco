/**
 * Corrections ON/OFF A/B under the independent grader (TIF-274 / track B), the analysis only.
 * Track E's runner (#524 follow-up) runs the arms and calls this. See src/m2/corrections-ab.ts.
 *
 *   npx tsx scripts/m2-corrections-ab.ts --stage 0|1 \
 *     --on-arm on/arm.jsonl --on-grades on/grades.jsonl \
 *     --off-arm off/arm.jsonl --off-grades off/grades.jsonl \
 *     --on-config on/run-config.json --off-config off/run-config.json \
 *     [--stage0-on-arm s0/on/arm.jsonl --stage0-off-arm s0/off/arm.jsonl]   (required for Stage 1)
 *     [--prereg-file docs/.../preregistration.md --prereg-declared <sha256>] (required for Stage 1)
 *     [--evidence]
 *
 * `--prereg-file` is the committed pre-registration file (its sha256 is computed here);
 * `--prereg-declared` is the hash the pack declares. Prints the AbResult as JSON. Exit 1 when the
 * run is not ok (a precondition fails, the pairs are incomplete, or the gate missed); 2 on usage.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AbInput, type AbStage, checkCorrectionsAb } from "../src/m2/corrections-ab.ts";

const REQUIRED = [
  "--on-arm",
  "--on-grades",
  "--off-arm",
  "--off-grades",
  "--on-config",
  "--off-config",
] as const;
const OPTIONAL = [
  "--stage0-on-arm",
  "--stage0-off-arm",
  "--prereg-file",
  "--prereg-declared",
] as const;
type Flag = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number];

const args = process.argv.slice(2);
const values: Partial<Record<Flag, string>> = {};
let stage: AbStage | undefined;
let evidence = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if ((REQUIRED as readonly string[]).includes(a) || (OPTIONAL as readonly string[]).includes(a))
    values[a as Flag] = args[++i];
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
if (REQUIRED.some((k) => values[k] === undefined) || stage === undefined) {
  process.stderr.write(
    `usage: m2-corrections-ab.ts --stage 0|1 ${REQUIRED.map((k) => `${k} <file>`).join(" ")} [--stage0-on-arm <jsonl> --stage0-off-arm <jsonl>] [--prereg-file <file> --prereg-declared <sha256>] [--evidence]\n`,
  );
  process.exit(2);
}
const jsonl = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const v = values as Record<Flag, string | undefined>;

const input: AbInput = {
  on: { arm: jsonl(v["--on-arm"] as string), grades: jsonl(v["--on-grades"] as string) },
  off: { arm: jsonl(v["--off-arm"] as string), grades: jsonl(v["--off-grades"] as string) },
  runConfigs: { on: json(v["--on-config"] as string), off: json(v["--off-config"] as string) },
  ...(v["--stage0-on-arm"] !== undefined && v["--stage0-off-arm"] !== undefined
    ? { stage0: { on: jsonl(v["--stage0-on-arm"]), off: jsonl(v["--stage0-off-arm"]) } }
    : {}),
  ...(v["--prereg-file"] !== undefined && v["--prereg-declared"] !== undefined
    ? {
        preregistration: {
          committedSha256: createHash("sha256")
            .update(readFileSync(v["--prereg-file"]))
            .digest("hex"),
          declaredSha256: v["--prereg-declared"],
        },
      }
    : {}),
};
const result = checkCorrectionsAb(input, { stage, evidence });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.ok ? 0 : 1);
