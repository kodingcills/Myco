/**
 * R5 oracle mutation self-test (M2-09).
 *
 *   npx tsx scripts/oracle-selftest.ts --write   # regenerate the committed report
 *   npx tsx scripts/oracle-selftest.ts --check   # exit 1 if it differs, or any oracle fails its bar
 *
 * Host-only: no VM, no model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSelfTest, renderJson, renderReadme } from "../src/oracle-selftest/report.ts";

const DIR = "docs/research/experiments/r5-oracle-selftest";
const mode = process.argv[2];
if (mode !== "--write" && mode !== "--check") {
  process.stderr.write("usage: oracle-selftest.ts --write | --check\n");
  process.exit(2);
}
const bundle = buildSelfTest();
const files: Record<string, string> = {
  "report.json": renderJson(bundle),
  "README.md": renderReadme(bundle),
};
const failing = bundle.reports.filter((r) => !r.pass);

if (mode === "--write") {
  mkdirSync(DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(DIR, name), text);
  process.stdout.write(`wrote ${Object.keys(files).length} files to ${DIR}\n`);
} else {
  const differs = Object.entries(files).filter(
    ([name, text]) =>
      !existsSync(join(DIR, name)) || readFileSync(join(DIR, name), "utf8") !== text,
  );
  for (const [name] of differs) process.stderr.write(`differs ${join(DIR, name)}\n`);
  for (const r of failing) process.stderr.write(`FAIL ${r.oracle}: ${r.reasons.join("; ")}\n`);
  if (differs.length > 0 || failing.length > 0) process.exit(1);
  process.stdout.write(
    `oracle self-test matches ${DIR}; ${bundle.reports.length} oracles pass their bar\n`,
  );
}
