/**
 * #578 F1, Linux: `readDirNoFollow` lists the dir it OPENED, through its fd, even when the
 * path is swapped for a symlink after the open and before the listing.
 *
 * The swap is made deterministic by wrapping `opendirSync`: just before the real call, the
 * wrapper renames the dir away and puts a symlink to another dir at its path. Listing through
 * `/proc/self/fd/<fd>` still names the original dir (same inode, now renamed), so the
 * original names come back. A listing by path would follow the symlink.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({ path: "", away: "", other: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const opendirSync: typeof real.opendirSync = (path, opts) => {
    if (race.path) {
      real.renameSync(race.path, race.away);
      real.symlinkSync(race.other, race.path);
      race.path = "";
    }
    return real.opendirSync(path, opts);
  };
  return { ...real, default: { ...real, opendirSync }, opendirSync };
});

const { readDirNoFollow } = await import("../../src/integrity/nonblocking-read.ts");

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mdr-"));
});
afterEach(() => {
  race.path = "";
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("readDirNoFollow lists the opened dir", () => {
  it("a swap between the open and the listing does not redirect it", () => {
    const dir = join(base, "d");
    mkdirSync(dir);
    writeFileSync(join(dir, "mine"), "");
    mkdirSync(join(base, "other"));
    writeFileSync(join(base, "other", "theirs"), "");
    race.path = dir;
    race.away = join(base, "d-away");
    race.other = join(base, "other");
    const r = readDirNoFollow(dir, { maxEntries: 10 });
    expect(race.path).toBe(""); // the swap really happened, mid-call
    expect(r.ok && [...r.names]).toEqual(["mine"]);
  });
});
