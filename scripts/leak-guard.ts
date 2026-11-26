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
import { hostIdentity, mergeIdentity } from "../src/leak-guard/detect.ts";
import {
  ALLOWLIST_PATH,
  type Finding,
  formatFindings,
  scanDir,
  scanTracked,
} from "../src/leak-guard/scan.ts";
import { runProducers } from "../test/leak-guard/produce.ts";

const ROOT = resolve(import.meta.dirname, "..");

const USAGE = `usage: pnpm leak-guard [--scan <dir>]... [--scan-only]
  --scan <dir>          also scan every file under <dir> (your run's outputs or logs)
  --scan-only           skip the tracked-file and writer scans (only the --scan dirs)
  --plant-user <name>   also look for this account name (revert checks; never a real one)
  --plant-host <name>   also look for this host name (revert checks)
`;

async function main(argv: readonly string[]): Promise<number> {
  const extra: string[] = [];
  const users: string[] = [];
  const hosts: string[] = [];
  let scanOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const list =
      flag === "--scan"
        ? extra
        : flag === "--plant-user"
          ? users
          : flag === "--plant-host"
            ? hosts
            : null;
    if (flag === "--scan-only") scanOnly = true;
    else if (list !== null && value !== undefined) {
      list.push(value);
      i++;
    } else {
      process.stderr.write(USAGE);
      return 2;
    }
  }
  if (scanOnly && extra.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const identity = mergeIdentity(hostIdentity(ROOT), { users, hosts });
  const findings: Finding[] = [];
  const parts: string[] = [];
  if (!scanOnly) {
    const allowlist = readFileSync(resolve(ROOT, ALLOWLIST_PATH), "utf8");
    const tracked = scanTracked(ROOT, identity, allowlist);
    findings.push(...tracked.findings);
    const produced = await runProducers(identity);
    findings.push(...produced.findings);
    parts.push(`${tracked.files} tracked file(s)`);
    parts.push(`${produced.producers.length} writer(s) [${produced.producers.join(", ")}]`);
  }
  for (const [i, dir] of extra.entries())
    findings.push(...scanDir(resolve(dir), `--scan#${i}`, identity));
  parts.push(`${extra.length} extra dir(s)`);
  const summary = `leak-guard: ${parts.join(", ")}: ${findings.length} finding(s)`;
  if (findings.length > 0) {
    process.stdout.write(`${formatFindings(findings)}\n${summary}\nleak-guard: FAIL\n`);
    return 1;
  }
  process.stdout.write(`${summary}\nleak-guard: PASS\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
