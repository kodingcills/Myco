/**
 * `pnpm leak-guard` (TIF-98): the builder preflight. Run it before every push and state the
 * result in your PR comment. It runs the same checks as `test/leak-guard/` (which CI runs
 * in the core smoke set on every PR):
 *
 *   1. every tracked file (with `src/leak-guard/allowlist.json`),
 *   2. every outward-bound writer run on fixtures (episode export, dataset export, ...),
 *      its produced files AND its log output,
 *   3. any directory you pass with `--scan <dir>` (your run's outputs or logs).
 *
 * Prints `file:line class` per finding, never the matched value. Exit 0 clean, 1 findings,
 * 2 usage error. Fails closed: an unreadable file or a bad allowlist is a finding.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hostIdentity } from "../src/leak-guard/detect.ts";
import {
  ALLOWLIST_PATH,
  type Finding,
  formatFindings,
  scanDir,
  scanTracked,
} from "../src/leak-guard/scan.ts";
import { runProducers } from "../test/leak-guard/produce.ts";

const ROOT = resolve(import.meta.dirname, "..");

async function main(argv: readonly string[]): Promise<number> {
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scan" && argv[i + 1] !== undefined) extra.push(argv[++i] as string);
    else {
      process.stderr.write("usage: pnpm leak-guard [--scan <dir>]...\n");
      return 2;
    }
  }
  const identity = hostIdentity(ROOT);
  const findings: Finding[] = [];
  const tracked = scanTracked(ROOT, identity, readFileSync(resolve(ROOT, ALLOWLIST_PATH), "utf8"));
  findings.push(...tracked.findings);
  const produced = await runProducers(identity);
  findings.push(...produced.findings);
  for (const [i, dir] of extra.entries())
    findings.push(...scanDir(resolve(dir), `--scan#${i}`, identity));
  const summary = `leak-guard: ${tracked.files} tracked file(s), ${produced.producers.length} writer(s) [${produced.producers.join(", ")}], ${extra.length} extra dir(s): ${findings.length} finding(s)`;
  if (findings.length > 0) {
    process.stdout.write(`${formatFindings(findings)}\n${summary}\nleak-guard: FAIL\n`);
    return 1;
  }
  process.stdout.write(`${summary}\nleak-guard: PASS\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
