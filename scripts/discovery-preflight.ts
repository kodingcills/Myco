#!/usr/bin/env node
/**
 * Direction A preflight gate.
 *
 * Usage: tsx scripts/discovery-preflight.ts --probe <probe.json> [--json]
 *
 * The probe file is the result of the live checks (see src/discovery/preflight.ts).
 * This command never starts a VM and never retries: a failed check is an abort.
 * Exit 0 = PASS, 2 = ABORT, 3 = unreadable probe.
 */
import { readFileSync } from "node:fs";
import { renderPreflight, runPreflight } from "../src/discovery/preflight.ts";

const args = process.argv.slice(2);
const probeIndex = args.indexOf("--probe");
const probePath = probeIndex >= 0 ? args[probeIndex + 1] : undefined;
if (!probePath) {
  process.stderr.write("usage: discovery-preflight --probe <probe.json> [--json]\n");
  process.exit(2);
}

let probe: unknown;
try {
  probe = JSON.parse(readFileSync(probePath, "utf8"));
} catch (error) {
  process.stderr.write(`preflight: cannot read ${probePath}: ${String(error)}\n`);
  process.exit(3);
}

const result = runPreflight(probe as Parameters<typeof runPreflight>[0]);
if (args.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else process.stdout.write(renderPreflight(result));
process.exit(result.ok ? 0 : 2);
