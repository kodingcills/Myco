/**
 * #578 N3 / #561 mutant M3: the vault's post-read one-link check in `readChecked`.
 *
 * The `lstat` before the read checks `nlink === 1`, and the open fd must be the same inode.
 * A hard link added between the two calls passes both, so only the check on the fd's own
 * `stat.nlink` catches it. The race is made deterministic by wrapping `readRegularNoBlock`:
 * just before the real read of the target file, the wrapper adds a hard link to it (outside
 * the vault dir, so no other check fires).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ target: "", link: "" }));

vi.mock("../../src/integrity/nonblocking-read.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/integrity/nonblocking-read.ts")>();
  const { linkSync: link } = await import("node:fs");
  return {
    ...real,
    readRegularNoBlock: (path: string, opts: Parameters<typeof real.readRegularNoBlock>[1]) => {
      if (race.target && path === race.target) {
        link(path, race.link);
        race.target = "";
      }
      return real.readRegularNoBlock(path, opts);
    },
  };
});

const { newVaultKey, VerdictVault } = await import("../../src/integrity/vault.ts");
const { CALC_ORACLE_SOURCES } = await import("../../src/parallel/throughput.ts");

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mnl-"));
});
afterEach(() => {
  race.target = "";
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("M3: a hard link added after the lstat", () => {
  it.each([
    ["sealed/ground-truth.json", "sealed-file-not-regular"],
    ["captured/persisted/sheet.csv", "captured-file-not-regular"],
  ])("%s gets %s", (rel, code) => {
    const vault = new VerdictVault({
      root: join(base, "vault"),
      key: newVaultKey(),
      agentRoots: [],
    });
    const receipt = vault.seal("run-1", {
      groundTruth: { cell: "B2", value: 42 },
      fixtures: { "fixture.csv": Buffer.from("a,b\n1,2\n") },
      oracle: { id: "fam@1", sourceFiles: CALC_ORACLE_SOURCES },
    });
    vault.markAgentStopped("run-1");
    vault.capture("run-1", { "persisted/sheet.csv": Buffer.from("a,b\n1,42\n") });
    expect(vault.checkIntegrity("run-1", receipt).ok).toBe(true);

    race.target = join(base, "vault", "run-1", rel);
    race.link = join(base, "outside-link");
    const r = vault.checkIntegrity("run-1", receipt);
    expect(race.target).toBe(""); // the link was really added, mid-check
    expect(r.ok ? [] : r.violations.map((v) => [v.code, v.path])).toEqual([[code, rel]]);
  });
});
