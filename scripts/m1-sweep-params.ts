/**
 * M1-013 sweep parameters, generated once on the host.
 *
 *   tsx scripts/m1-sweep-params.ts params      > params.json
 *   tsx scripts/m1-sweep-params.ts fingerprints > fingerprints.json
 *
 * `params`: the 30 calc-record-edit parameter sets (6 fixture seeds x 5).
 * `fingerprints`: { fixtureSeed: csvSha256 } for every seed in those sets,
 * computed from the seed alone. The sweep compares each trial's reported
 * fixture fingerprint against this map, so a seed that never reaches the
 * trial cannot pass unnoticed.
 *
 * This is a FILE on purpose: `tsx -e` with top-level await silently produced an
 * empty params file once (m1-state log, discarded-param-bug).
 */

import process from "node:process";
import { fixtureFingerprint, generateFixture } from "../src/tasks/fixture.ts";
import { generateParameterSets } from "../src/tasks/intent.ts";

export const SWEEP_SEEDS = ["m1-013-live", "seed-b", "seed-c", "seed-d", "seed-e", "seed-f"];

const mode = process.argv[2];
const sets = generateParameterSets(SWEEP_SEEDS);

if (mode === "params") {
  process.stdout.write(JSON.stringify(sets));
} else if (mode === "fingerprints") {
  const map: Record<string, string> = {};
  for (const seed of new Set(sets.map((s) => s.fixtureSeed))) {
    map[seed] = fixtureFingerprint(generateFixture(seed)).csvSha256;
  }
  if (new Set(Object.values(map)).size !== Object.keys(map).length) {
    process.stderr.write("two sweep seeds produce the same fixture bytes\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(map));
} else {
  process.stderr.write("usage: m1-sweep-params.ts params|fingerprints\n");
  process.exit(2);
}
