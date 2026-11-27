/**
 * Track M's pre-registered analysis CLI (capability-spec §3; pre-registration
 * `docs/product/capability-prereg/m-v1/prereg.json`). All logic is in
 * `src/skills/m-analysis.ts`; both files are pinned by SHA-256 in the pre-registration.
 *
 *   npx tsx scripts/m-learning-analysis.ts --pack <pack-dir> [--out <report.json>]
 *
 * Exit codes: 0 analysed (`shown`, `not-shown` or `simulated`), 3 refused, 2 usage.
 * A `simulated` report is plumbing and never evidence; nothing here is R1 evidence.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeMPackDir } from "../src/skills/m-analysis.ts";

function main(argv: readonly string[]): number {
  let pack: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pack") pack = argv[++i];
    else if (a === "--out") out = argv[++i];
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      return 2;
    }
  }
  if (pack === undefined) {
    process.stderr.write("usage: m-learning-analysis --pack <pack-dir> [--out <report.json>]\n");
    return 2;
  }
  const report = analyzeMPackDir(resolve(import.meta.dirname, ".."), resolve(pack));
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out !== undefined) writeFileSync(out, text);
  process.stdout.write(text);
  return report.result === "refused" ? 3 : 0;
}

process.exitCode = main(process.argv.slice(2));
