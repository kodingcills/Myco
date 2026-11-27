/**
 * #649 (lead ruling 2026-11-27 06:01Z): capability tracks reuse the `hcu+shell` arm as their
 * baseline, so a capability pack's `hcu+shell` row cannot be told apart by arm from an R2
 * head-to-head row. Separation is by pack, fail-closed: a pack that reads `hcu+shell` rows as
 * head-to-head evidence (rows R2 and R7) counts them only when `pack.json` carries a committed
 * R2 pre-registration hash (`R2_PREREGISTRATION_SHA256`, an allowlist). A capability hash, or no
 * hash, is refused. No arm-schema change. The committed allowlist is empty until an R2
 * pre-registration is committed, so today every R2 or R7 pack is refused.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { m2PackManifestSchema } from "../../schemas/m2-evidence.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  checkPack,
  type PackManifest,
  type PackResult,
  R2_PREREGISTRATION_SHA256,
  r2PreregistrationError,
} from "../../src/m2/evidence.ts";
import {
  input,
  manifest,
  r1Trials,
  r2Manifest,
  r2Trials,
  r3Manifest,
  r3Trials,
  TEST_CAPABILITY_PREREG,
  TEST_R2_ALLOW,
  TEST_R2_PREREG,
  trial,
  writePack,
} from "./pack-fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const NO_HASH =
  "R2 pre-registration: pack.json carries no pre-registration hash: hcu+shell rows are R2 head-to-head evidence only under a committed R2 pre-registration (R2_PREREGISTRATION_SHA256)";
const notCommitted = (h: string) =>
  `R2 pre-registration: pack.json carries pre-registration ${JSON.stringify(h)}, which is not a committed R2 pre-registration (R2_PREREGISTRATION_SHA256; a capability pre-registration never is): its hcu+shell rows are never R2 evidence`;
const prereg = (r: PackResult) => r.errors.filter((e) => e.startsWith("R2 pre-registration"));

/** The R2 + R7 fixture pack without any pre-registration field. */
function unhashed(over: Partial<PackManifest> = {}): PackManifest {
  const { preregistration: _drop, ...m } = r2Manifest(over);
  return m;
}

describe("#649: an hcu+shell row is R2 evidence only under a committed R2 pre-registration", () => {
  it("R2 hash: accepted; R2 and R7 recompute and pass exactly as before", () => {
    const r = checkPack(input(r2Trials(), r2Manifest()), TEST_R2_ALLOW);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.r2).toMatchObject({
      pass: true,
      reasons: [],
      pairs: 30,
      bothSucceed: 15,
      gateOnly: 5,
      shellOnly: 0,
      neither: 10,
    });
    expect(r.r7).toMatchObject({ pass: true, reasons: [] });
    expect(r.r7?.arms.map((a) => [a.arm, a.trials, a.verified])).toEqual([
      ["hcu+shell", 30, 15],
      ["myco-gate", 30, 20],
    ]);
  });

  it("capability hash: refused, and R2 and R7 do not pass", () => {
    const m = r2Manifest({ preregistration: { sha256: TEST_CAPABILITY_PREREG } });
    const r = checkPack(input(r2Trials(), m), TEST_R2_ALLOW);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([notCommitted(TEST_CAPABILITY_PREREG)]);
    expect(r.r2?.pass).toBe(false);
    expect(r.r7?.pass).toBe(false);
    expect(r.r2?.reasons[0]).toBe("pack is not consistent (see errors)");
  });

  it("no hash: refused, and R2 and R7 do not pass", () => {
    const r = checkPack(input(r2Trials(), unhashed()), TEST_R2_ALLOW);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([NO_HASH]);
    expect(r.r2?.pass).toBe(false);
    expect(r.r7?.pass).toBe(false);
  });

  it("matches the hash exactly: an upper-case variant of the R2 hash is refused", () => {
    // The schema refuses it first; the allowlist refuses it on its own as well.
    const upper = TEST_R2_PREREG.toUpperCase();
    expect(
      validateSchema(r2Manifest({ preregistration: { sha256: upper } }), m2PackManifestSchema),
    ).not.toEqual([]);
    expect(r2PreregistrationError(upper, [TEST_R2_PREREG])).toMatch(/not a committed R2/);
    expect(r2PreregistrationError(TEST_R2_PREREG, [TEST_R2_PREREG])).toBeNull();
  });

  it("applies to an R7-only and an R2-only pack alike (both read hcu+shell rows)", () => {
    for (const rows of [["R7"], ["R2"]] as const) {
      const over = rows[0] === "R7" ? { rows: [...rows], expectPairs: null } : { rows: [...rows] };
      const ok = checkPack(input(r2Trials(), r2Manifest(over)), TEST_R2_ALLOW);
      expect(ok.errors, rows[0]).toEqual([]);
      const cap = checkPack(
        input(
          r2Trials(),
          r2Manifest({ ...over, preregistration: { sha256: TEST_CAPABILITY_PREREG } }),
        ),
        TEST_R2_ALLOW,
      );
      expect(prereg(cap), rows[0]).toEqual([notCommitted(TEST_CAPABILITY_PREREG)]);
      const none = checkPack(input(r2Trials(), unhashed(over)), TEST_R2_ALLOW);
      expect(prereg(none), rows[0]).toEqual([NO_HASH]);
    }
  });
});

describe("#649: the committed allowlist", () => {
  it("is empty (no R2 pre-registration is committed yet) and frozen", () => {
    expect(R2_PREREGISTRATION_SHA256).toEqual([]);
    expect(Object.isFrozen(R2_PREREGISTRATION_SHA256)).toBe(true);
    // Every entry, once one is committed, is a lowercase SHA-256, and never the test hashes.
    for (const h of R2_PREREGISTRATION_SHA256) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(R2_PREREGISTRATION_SHA256).not.toContain(TEST_R2_PREREG);
    expect(R2_PREREGISTRATION_SHA256).not.toContain(TEST_CAPABILITY_PREREG);
  });

  it("so, by default, every R2 or R7 pack is refused, whatever hash it carries", () => {
    for (const m of [
      r2Manifest(),
      r2Manifest({ preregistration: { sha256: TEST_CAPABILITY_PREREG } }),
      unhashed(),
    ]) {
      const r = checkPack(input(r2Trials(), m));
      expect(r.ok).toBe(false);
      expect(prereg(r)).toHaveLength(1);
      expect(r.r2?.pass).toBe(false);
      expect(r.r7?.pass).toBe(false);
    }
  });

  it("the evidence-check CLI uses the committed allowlist: it refuses the R2 fixture pack", () => {
    const dir = writePack("m2-fx-r2", r2Trials(), r2Manifest());
    const out = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts", "m2-evidence-check.ts"), dir],
      { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
    );
    expect(out.status, out.stderr).toBe(1);
    const result = (JSON.parse(out.stdout) as { packs: { result: PackResult }[] }).packs[0]!.result;
    expect(result.errors).toContain(notCommitted(TEST_R2_PREREG));
    expect(result.r2?.pass).toBe(false);
  });

  it("the test seam is never passed outside tests (scans src/ and scripts/)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(?:ts|mts|js|mjs|py|sh)$/.test(e)) files.push(p);
      }
    };
    walk(join(ROOT, "src"));
    walk(join(ROOT, "scripts"));
    expect(files.length).toBeGreaterThan(50);
    const users = files
      .filter((f) => readFileSync(f, "utf8").includes("r2PreregistrationAllowlist"))
      .map((f) => relative(ROOT, f));
    // Only its definition and its one read in checkPack.
    expect(users).toEqual(["src/m2/evidence.ts"]);
    const src = readFileSync(join(ROOT, "src/m2/evidence.ts"), "utf8");
    expect(src.match(/r2PreregistrationAllowlist/g)).toHaveLength(2);
  });
});

describe("#649: R1 and R3 packs, and myco-gate rows, are unchanged", () => {
  it("an R1 pack needs no pre-registration hash and passes as before", () => {
    const r = checkPack(input(r1Trials(), manifest()));
    expect(r.errors).toEqual([]);
    expect(r.r1).toMatchObject({ pass: true, counted: 100, accepted: 60 });
  });

  it("an R1 pack holding hcu+shell rows is unchanged: no R2 row reads them", () => {
    const shell = [0, 1].map((i) =>
      trial(200 + i, { arm: "hcu+shell", gate: null, taskSetVersion: "fc-v1" }),
    );
    const r = checkPack(
      input(
        [...r1Trials(), ...shell],
        manifest({ expectTrials: { "myco-gate": 100, "hcu+shell": 2 } }),
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.r1?.pass).toBe(true);
  });

  it("an R3 pack needs no pre-registration hash and passes as before", () => {
    const r = checkPack(input(r3Trials(), r3Manifest()));
    expect(r.errors).toEqual([]);
    expect(r.r3?.pass).toBe(true);
  });

  it("a hash on an R1 pack, R2 or capability, changes nothing", () => {
    for (const sha256 of [TEST_R2_PREREG, TEST_CAPABILITY_PREREG]) {
      const r = checkPack(input(r1Trials(), manifest({ preregistration: { sha256 } })));
      expect(r.errors).toEqual([]);
      expect(r.r1?.pass).toBe(true);
    }
  });
});
