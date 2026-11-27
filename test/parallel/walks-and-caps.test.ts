/**
 * #578 (from #561's round-1 PASS): no-follow directory walks, tighter read caps, the socket
 * disqualifier, and the snapshot-cap test gap.
 *
 * - F1: `listRunTree` (the vault) and `scanTree` (the pool) list each dir only through
 *   `readDirNoFollow`, against the `lstat` that decided to recurse. A dir the agent swaps for
 *   a symlink (to `/usr`, or into another trial's root) is refused, never walked. The swap is
 *   simulated deterministically with an `lstat` that lies, the same seam `scanTree`'s FIFO
 *   test uses.
 * - F2: manifests are read with a 1 MiB cap, oracle sources (and so the pool's snapshot
 *   copies) with 16 MiB.
 * - N1: a unix socket is `not-regular`, not `missing`, so a socket at an oracle source gives
 *   `VaultError("not-regular")`, which the pool maps to `oracle-source`.
 * - N3: the snapshot's 16 MiB cap has a test (mutant M5 in #561).
 *
 * Linux and macOS (unix sockets, symlinks); skipped on Windows.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  type Stats,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDirNoFollow, readRegularNoBlock } from "../../src/integrity/nonblocking-read.ts";
import {
  type IntegrityViolation,
  listRunTree,
  MANIFEST_READ_LIMIT_BYTES,
  newVaultKey,
  ORACLE_SOURCE_READ_LIMIT_BYTES,
  VAULT_LIST_LIMIT_ENTRIES,
  VaultError,
  VerdictVault,
} from "../../src/integrity/vault.ts";
import {
  ORACLE_SOURCE_LIMIT_BYTES,
  PoolRefused,
  SCAN_LIMIT_ENTRIES,
  scanTree,
  snapshotOracleSources,
} from "../../src/parallel/pool.ts";
import { CALC_ORACLE_SOURCES } from "../../src/parallel/throughput.ts";

const UNIX = process.platform !== "win32";

let base: string;
const servers: Server[] = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mwc-"));
});
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  rmSync(base, { recursive: true, force: true });
});

/** A unix socket bound at `path` (kept open until the test ends). */
async function socketAt(path: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  expect(lstatSync(path).isSocket()).toBe(true);
}

function files(dir: string, names: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, n), n);
}

describe.skipIf(!UNIX)("readDirNoFollow", () => {
  it("lists a dir's names (no . or ..), and its stat", () => {
    files(join(base, "d"), ["a", "b", "c"]);
    const r = readDirNoFollow(join(base, "d"), { maxEntries: 10 });
    expect(r.ok && [...r.names].sort()).toEqual(["a", "b", "c"]);
    expect(r.ok && r.stat.ino).toBe(lstatSync(join(base, "d")).ino);
  });

  it("refuses a symlink to a dir, a regular file, and a missing path, each with a code", () => {
    files(join(base, "d"), ["a"]);
    symlinkSync(join(base, "d"), join(base, "link"));
    expect(readDirNoFollow(join(base, "link"), { maxEntries: 10 })).toMatchObject({
      ok: false,
      code: "not-directory",
    });
    expect(readDirNoFollow(join(base, "d", "a"), { maxEntries: 10 })).toMatchObject({
      ok: false,
      code: "not-directory",
    });
    expect(readDirNoFollow(join(base, "nope"), { maxEntries: 10 })).toMatchObject({
      ok: false,
      code: "missing",
    });
  });

  it("refuses a dir that is not the one the caller's lstat saw (swapped)", () => {
    files(join(base, "d"), ["a"]);
    files(join(base, "other"), ["b"]);
    const r = readDirNoFollow(join(base, "d"), {
      maxEntries: 10,
      expect: lstatSync(join(base, "other")),
    });
    expect(r).toMatchObject({ ok: false, code: "swapped" });
  });

  it("stops past maxEntries (too-many); exactly maxEntries is fine", () => {
    files(join(base, "d"), ["a", "b", "c"]);
    expect(readDirNoFollow(join(base, "d"), { maxEntries: 2 })).toMatchObject({
      ok: false,
      code: "too-many",
    });
    expect(readDirNoFollow(join(base, "d"), { maxEntries: 3 }).ok).toBe(true);
  });
});

describe.skipIf(!UNIX)("F1: the vault's run-dir walk never follows a swapped dir", () => {
  /** A run dir whose `captured` dir the agent swapped for a symlink to `/usr`. */
  function swappedRunDir(): { dir: string; lying: (p: string) => Stats } {
    const dir = join(base, "run");
    files(join(dir, "sealed"), ["ground-truth.json"]);
    writeFileSync(join(dir, "seal.json"), "{}");
    symlinkSync("/usr", join(dir, "captured"));
    // What the walk's lstat saw just before the swap: a directory.
    const sawDir = lstatSync("/usr");
    const lying = (p: string): Stats => (p === join(dir, "captured") ? sawDir : lstatSync(p));
    return { dir, lying };
  }

  it("refuses the swapped dir with an unexpected-file violation, and lists nothing under it", () => {
    const { dir, lying } = swappedRunDir();
    const violations: IntegrityViolation[] = [];
    const listed = listRunTree(dir, violations, { lstat: lying });
    expect(listed.sort()).toEqual(["seal.json", "sealed/ground-truth.json"]);
    expect(violations).toEqual([
      { code: "unexpected-file", path: "captured", detail: "directory refused (not-directory)" },
    ]);
  });

  it("a dir that vanishes mid-walk is a violation, never a throw out of the check", () => {
    const dir = join(base, "run");
    files(dir, ["seal.json"]);
    const sawDir = lstatSync(base);
    const lying = (p: string): Stats => (p === join(dir, "seal.json") ? sawDir : lstatSync(p));
    const violations: IntegrityViolation[] = [];
    expect(() => listRunTree(dir, violations, { lstat: lying })).not.toThrow();
    expect(violations.map((v) => [v.code, v.path])).toEqual([["unexpected-file", "seal.json"]]);
  });

  it("a refused dir does not stop the walk: every sibling is still listed, whatever the readdir order", () => {
    const dir = join(base, "run");
    const names = Array.from({ length: 20 }, (_, i) => `f${i}`);
    files(dir, names);
    symlinkSync("/usr", join(dir, "captured"));
    const sawDir = lstatSync("/usr");
    const lying = (p: string): Stats => (p === join(dir, "captured") ? sawDir : lstatSync(p));
    const violations: IntegrityViolation[] = [];
    expect(listRunTree(dir, violations, { lstat: lying }).sort()).toEqual([...names].sort());
    expect(violations.map((v) => v.path)).toEqual(["captured"]);
  });

  it("a name that vanishes before its lstat is still listed, so an unaccounted name fails", () => {
    const dir = join(base, "run");
    files(dir, ["seal.json", "ghost"]);
    const lying = (p: string): Stats => {
      if (p === join(dir, "ghost")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return lstatSync(p);
    };
    const violations: IntegrityViolation[] = [];
    expect(listRunTree(dir, violations, { lstat: lying }).sort()).toEqual(["ghost", "seal.json"]);
    expect(violations).toEqual([]);
  });

  it("caps the entries it lists (VAULT_LIST_LIMIT_ENTRIES), fail closed", () => {
    const dir = join(base, "run");
    files(join(dir, "x"), ["1", "2", "3"]);
    files(dir, ["seal.json"]);
    const violations: IntegrityViolation[] = [];
    listRunTree(dir, violations, { limit: 3 });
    expect(violations).toEqual([
      { code: "unexpected-file", path: "x", detail: "directory refused (too-many)" },
    ]);
    expect(VAULT_LIST_LIMIT_ENTRIES).toBe(10_000);
  });

  it("checkIntegrity on a real vault refuses a captured dir swapped for a symlink", () => {
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
    const runDir = join(base, "vault", "run-1");
    rmSync(join(runDir, "captured"), { recursive: true, force: true });
    symlinkSync("/usr", join(runDir, "captured"));
    const r = vault.checkIntegrity("run-1", receipt);
    expect(r.ok).toBe(false);
    // Bounded: the walk lists the symlink, it never walks /usr (94,313 violations in #561).
    expect(r.ok ? 0 : r.violations.length).toBeLessThan(20);
  });
});

describe.skipIf(!UNIX)("F1: the pool's marker scan never follows a swapped dir", () => {
  it("a dir swapped for a symlink into another trial's tree is refused: incomplete, no foreign marker", () => {
    const mine = join(base, "mine");
    const theirs = join(base, "theirs");
    files(mine, ["own.txt"]);
    writeFileSync(join(mine, "own.txt"), "MARK-MINE");
    files(theirs, ["note.txt"]);
    writeFileSync(join(theirs, "note.txt"), "MARK-THEIRS");
    symlinkSync(theirs, join(mine, "sub"));
    const sawDir = lstatSync(theirs); // what the lstat saw before the swap
    const lying = (p: string): Stats => (p === join(mine, "sub") ? sawDir : lstatSync(p));
    const markers = new Map([
      ["me", "MARK-MINE"],
      ["them", "MARK-THEIRS"],
    ]);
    const r = scanTree(mine, markers, lying);
    expect(r.complete).toBe(false);
    expect([...r.found]).toEqual(["me"]);
  });

  it("caps the entries it scans (SCAN_LIMIT_ENTRIES), so a huge tree is incomplete, not stalled", () => {
    files(join(base, "t"), ["1", "2", "3"]);
    const markers = new Map([["me", "nope"]]);
    expect(scanTree(join(base, "t"), markers, lstatSync, { entries: 2 }).complete).toBe(false);
    expect(scanTree(join(base, "t"), markers, lstatSync, { entries: 3 }).complete).toBe(true);
    expect(SCAN_LIMIT_ENTRIES).toBe(100_000);
  });
});

describe.skipIf(!UNIX)("N1: a unix socket is not-regular, never missing", () => {
  it("readRegularNoBlock refuses a socket as not-regular", async () => {
    await socketAt(join(base, "s"));
    expect(readRegularNoBlock(join(base, "s"), { maxBytes: 1024 })).toMatchObject({
      ok: false,
      code: "not-regular",
    });
  });

  it("a socket at an oracle source makes seal throw VaultError not-regular (the pool's oracle-source)", async () => {
    await socketAt(join(base, "src.ts"));
    const vault = new VerdictVault({
      root: join(base, "vault"),
      key: newVaultKey(),
      agentRoots: [],
    });
    let thrown: unknown;
    try {
      vault.seal("run-1", {
        groundTruth: { cell: "B2", value: 42 },
        fixtures: { "fixture.csv": Buffer.from("a\n") },
        oracle: { id: "fam@1", sourceFiles: [join(base, "src.ts")] },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VaultError);
    expect((thrown as VaultError).code).toBe("not-regular");
  });

  it("a socket at an oracle source refuses the pool before anything runs (not-regular)", async () => {
    await socketAt(join(base, "src.ts"));
    mkdirSync(join(base, "run"));
    await expect(snapshotOracleSources([join(base, "src.ts")], join(base, "run"))).rejects.toThrow(
      /src\.ts": not-regular$/,
    );
  });
});

describe.skipIf(!UNIX)("F2 and N3: tighter caps", () => {
  it("the snapshot refuses an oracle source over 16 MiB (too-large), and the pool is refused", async () => {
    const src = join(base, "big.ts");
    writeFileSync(src, "");
    truncateSync(src, ORACLE_SOURCE_LIMIT_BYTES + 1);
    mkdirSync(join(base, "run"));
    const run = snapshotOracleSources([src], join(base, "run"));
    await expect(run).rejects.toBeInstanceOf(PoolRefused);
    await expect(run).rejects.toThrow(/big\.ts": too-large$/);
    // Exactly at the cap is read.
    truncateSync(src, ORACLE_SOURCE_LIMIT_BYTES);
    mkdirSync(join(base, "run2"));
    await expect(snapshotOracleSources([src], join(base, "run2"))).resolves.toHaveLength(1);
  });

  it("the pool's snapshot cap and the vault's oracle-source cap are the same 16 MiB", () => {
    expect(ORACLE_SOURCE_LIMIT_BYTES).toBe(16 * 1024 * 1024);
    expect(ORACLE_SOURCE_READ_LIMIT_BYTES).toBe(ORACLE_SOURCE_LIMIT_BYTES);
    expect(MANIFEST_READ_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it("the vault refuses an oracle source over 16 MiB at seal and at check", () => {
    const src = join(base, "src.ts");
    writeFileSync(src, "// source\n");
    const vault = new VerdictVault({
      root: join(base, "vault"),
      key: newVaultKey(),
      agentRoots: [],
    });
    const receipt = vault.seal("run-1", {
      groundTruth: { cell: "B2", value: 42 },
      fixtures: { "fixture.csv": Buffer.from("a\n") },
      oracle: { id: "fam@1", sourceFiles: [src] },
    });
    vault.markAgentStopped("run-1");
    vault.capture("run-1", { "persisted/sheet.csv": Buffer.from("a\n") });
    truncateSync(src, ORACLE_SOURCE_READ_LIMIT_BYTES + 1);
    const r = vault.checkIntegrity("run-1", receipt);
    expect(r.ok ? [] : r.violations.map((v) => [v.code, v.detail])).toEqual([
      ["oracle-source-missing", "oracle source is not a regular file (too-large)"],
    ]);
    expect(() =>
      vault.seal("run-2", {
        groundTruth: { cell: "B2", value: 42 },
        fixtures: { "fixture.csv": Buffer.from("a\n") },
        oracle: { id: "fam@1", sourceFiles: [src] },
      }),
    ).toThrow(/\(too-large\)$/);
  });

  it("a manifest over 1 MiB is seal-malformed and never read", () => {
    const vault = new VerdictVault({
      root: join(base, "vault"),
      key: newVaultKey(),
      agentRoots: [],
    });
    const receipt = vault.seal("run-1", {
      groundTruth: { cell: "B2", value: 42 },
      fixtures: { "fixture.csv": Buffer.from("a\n") },
      oracle: { id: "fam@1", sourceFiles: CALC_ORACLE_SOURCES },
    });
    vault.markAgentStopped("run-1");
    vault.capture("run-1", { "persisted/sheet.csv": Buffer.from("a\n") });
    const manifest = join(base, "vault", "run-1", "capture.json");
    rmSync(manifest);
    writeFileSync(manifest, "");
    truncateSync(manifest, MANIFEST_READ_LIMIT_BYTES + 1);
    const r = vault.checkIntegrity("run-1", receipt);
    expect(r.ok ? [] : r.violations.map((v) => [v.code, v.path])).toContainEqual([
      "capture-signature",
      "capture.json",
    ]);
    expect(r.ok ? "" : JSON.stringify(r.violations)).toContain("manifest is not a regular file");
  });
});
