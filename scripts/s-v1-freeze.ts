/**
 * Track S: build the trg-v1 conformance corpus and the s-v1 pre-registration.
 *
 *   npx tsx scripts/s-v1-freeze.ts           # write the corpus and prereg.json
 *   npx tsx scripts/s-v1-freeze.ts --check   # exit 1 if anything committed differs
 *
 * Writes benchmark/schedule/trg-v1/{cases.jsonl,manifest.json} and
 * docs/product/capability-prereg/s-v1/prereg.json. Offline: no model, no VM, no network.
 * After the first conformance run under s-v1, do not re-freeze s-v1: a change is s-v2
 * (capability-spec §3.3).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildSV1Prereg,
  CASES_PATH,
  MANIFEST_PATH,
  PREREG_PATH,
  preregFileText,
} from "../src/schedule/conformance/prereg.ts";
import { buildTrgManifest, buildTrgV1, casesJsonl } from "../src/schedule/conformance/trg-v1.ts";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const cases = buildTrgV1();
const casesText = casesJsonl(cases);
const manifestText = `${JSON.stringify(buildTrgManifest(cases), null, 2)}\n`;

const differs: string[] = [];
const put = (rel: string, text: string) => {
  const path = join(root, rel);
  const same = existsSync(path) && readFileSync(path, "utf8") === text;
  if (same) return;
  if (check) {
    differs.push(rel);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

put(CASES_PATH, casesText);
put(MANIFEST_PATH, manifestText);
// The prereg reads the corpus files from disk, so in --check mode build it only when the
// corpus is current; otherwise the corpus difference is already reported.
if (!check || differs.length === 0) put(PREREG_PATH, preregFileText(buildSV1Prereg(root)));

if (differs.length > 0) {
  process.stderr.write(`s-v1 freeze: out of date: ${differs.join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(check ? "s-v1 freeze: up to date\n" : "s-v1 freeze: written\n");
}
