/**
 * M2 evidence-pack check CLI (TIF-273 / M2-11). See src/m2/evidence.ts.
 *
 *   npx tsx scripts/m2-evidence-check.ts --all [--root DIR]   every m2-* pack under DIR
 *   npx tsx scripts/m2-evidence-check.ts PACK_DIR...           the named packs
 *   npx tsx scripts/m2-evidence-check.ts --constants           the bars and the load gate
 *
 * A pack whose pack.json says `myco.m2.ab-pack/1` is a corrections A/B pack (the scorecard's
 * experiment row; schemas/m2-ab-pack.ts) and is checked by src/m2/ab-pack.ts. Every other pack is
 * an R pack, checked by src/m2/evidence.ts, which refuses the A/B manifest and A/B rows.
 *
 * DIR defaults to docs/research/experiments. Every `m2-*` directory there is a pack and
 * must hold a valid pack.json (a directory without one fails, so evidence cannot skip the
 * check by leaving the manifest out). `--all` with no pack at all prints an empty list and
 * passes: the scorecard check, not this gate, fails a row that cites no evidence.
 *
 * Prints JSON. Exit 1 when any pack fails a schema, ledger or process check; 2 on usage.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HARNESS_CLASSES } from "../schemas/m2-evidence.ts";
import { AB_PACK_SCHEMA, checkAbPack, readAbPack } from "../src/m2/ab-pack.ts";
import { AB_ALPHA, AB_EVIDENCE_USE, AB_STAGES } from "../src/m2/corrections-ab.ts";
import {
  checkPack,
  LOAD_GATE,
  NO_FAULT,
  R1_MIN_TRIALS,
  R2_MIN_PAIRS,
  R3_MIN_ELIGIBLE,
  R3_SECURITY_CLASSES,
  readPack,
  SIGN_TEST_UNDERPOWERED,
} from "../src/m2/evidence.ts";
import { packProvenanceErrors } from "../src/m2/provenance.ts";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

if (args[0] === "--constants") {
  process.stdout.write(
    `${JSON.stringify({
      loadGate: LOAD_GATE,
      r1MinTrials: R1_MIN_TRIALS,
      r2MinPairs: R2_MIN_PAIRS,
      r3MinEligible: R3_MIN_ELIGIBLE,
      signTestUnderpowered: SIGN_TEST_UNDERPOWERED,
      noFault: NO_FAULT,
      r3SecurityClasses: R3_SECURITY_CLASSES,
      harnessClasses: HARNESS_CLASSES,
      abStage0Pairs: AB_STAGES[0].pairs,
      abStage1Pairs: AB_STAGES[1].pairs,
      abAlpha: AB_ALPHA,
      abEvidenceUse: AB_EVIDENCE_USE,
      abPackSchema: AB_PACK_SCHEMA,
    })}\n`,
  );
  process.exit(0);
}

let dirs: string[] = [];
if (args[0] === "--all") {
  let root = join(ROOT, "docs/research/experiments");
  if (args[1] === "--root" && args[2] !== undefined) root = resolve(args[2]);
  else if (args.length > 1) {
    process.stderr.write("usage: m2-evidence-check.ts --all [--root DIR]\n");
    process.exit(2);
  }
  dirs = readdirSync(root)
    .filter((e) => e.startsWith("m2-") && statSync(join(root, e)).isDirectory())
    .sort()
    .map((e) => join(root, e));
} else if (args.length > 0 && !args.some((a) => a.startsWith("--"))) {
  dirs = args.map((a) => resolve(a));
} else {
  process.stderr.write(
    "usage: m2-evidence-check.ts --all [--root DIR] | PACK_DIR... | --constants\n",
  );
  process.exit(2);
}

function validateRuns(runsDir: string, expect: number) {
  const out = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/integration/validate-live.ts", runsDir, "--expect", String(expect)],
    { cwd: ROOT, encoding: "utf8" },
  );
  const tail = `${out.stdout}${out.stderr}`.trim().split("\n").pop() ?? "";
  return { ok: out.status === 0, detail: `validate-live exit ${out.status}: ${tail}` };
}

/** The manifest's schema id, or null when pack.json is missing or not JSON (the R check says so). */
function packSchema(dir: string): unknown {
  try {
    const m = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as { schema?: unknown };
    return m?.schema ?? null;
  } catch {
    return null;
  }
}

const packs = dirs.map((dir) => {
  if (packSchema(dir) === AB_PACK_SCHEMA) {
    const input = readAbPack(dir, ROOT);
    const result = checkAbPack(input);
    const provenance = packProvenanceErrors(dir, [...input.on.arm, ...input.off.arm], {
      abPack: true,
    }).map((e) => `provenance: ${e}`);
    return {
      pack: relative(ROOT, dir) || ".",
      result:
        provenance.length === 0
          ? result
          : { ...result, ok: false, errors: [...result.errors, ...provenance] },
    };
  }
  const input = readPack(dir, validateRuns);
  const result = checkPack(input);
  // Provenance (src/m2/provenance.ts): simulated rows are never evidence, whatever R1 says.
  const provenance = packProvenanceErrors(dir, input.arm).map((e) => `provenance: ${e}`);
  return {
    pack: relative(ROOT, dir) || ".",
    result:
      provenance.length === 0
        ? result
        : { ...result, ok: false, errors: [...result.errors, ...provenance] },
  };
});
process.stdout.write(`${JSON.stringify({ packs }, null, 2)}\n`);
for (const p of packs)
  for (const e of p.result.errors) process.stderr.write(`ERROR ${p.pack}: ${e}\n`);
process.exit(packs.every((p) => p.result.ok) ? 0 : 1);
