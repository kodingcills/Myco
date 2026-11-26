/**
 * TIF-267 part 2 (D3, round 2): the on-disk guards behind `benchmark-make-requests.ts`.
 *
 * The CLI tests (`make-requests-cli.test.ts`) refuse a planted symlink at planning time, via
 * `regularFileInside` and `assertFreshOut`. These unit tests pin the write-side guards on their
 * own, so each still holds if the planning check in front of it is weakened:
 * `destinationInside` refuses a symlinked (or non-directory) component below --out, and
 * `writePlanned` creates every file exclusively, so a planted link is refused, not written
 * through. All file contents are fakes.
 */
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFreshOut,
  destinationInside,
  RequestBuildError,
  regularFileInside,
  writePlanned,
} from "../../src/benchmark/requests.ts";

function world() {
  const w = mkdtempSync(join(tmpdir(), "myco-req-fs-"));
  const outside = join(w, "outside");
  const out = join(w, "out");
  mkdirSync(outside);
  mkdirSync(out);
  const src = join(w, "src.csv");
  writeFileSync(src, "fake-source\n");
  writeFileSync(join(outside, "victim.csv"), "fake-victim\n");
  return { w, outside, out, src };
}

describe("destinationInside", () => {
  it("creates missing directories below --out and returns the path", () => {
    const { out } = world();
    expect(destinationInside(out, "docs/a.csv")).toBe(join(out, "docs", "a.csv"));
    expect(lstatSync(join(out, "docs")).isDirectory()).toBe(true);
  });

  it("refuses a symlinked directory component and creates nothing through it", () => {
    const { out, outside } = world();
    symlinkSync(outside, join(out, "docs"));
    expect(() => destinationInside(out, "docs/sub/a.csv")).toThrow(/docs is a symlink/);
    expect(readdirSync(outside)).toEqual(["victim.csv"]);
  });

  it("refuses a component that is a file, not a directory", () => {
    const { out } = world();
    writeFileSync(join(out, "docs"), "fake\n");
    expect(() => destinationInside(out, "docs/a.csv")).toThrow(/docs is not a directory/);
  });

  it("still refuses a lexical escape", () => {
    const { out } = world();
    expect(() => destinationInside(out, "../a.csv")).toThrow(RequestBuildError);
  });
});

describe("writePlanned", () => {
  it("refuses to copy through a planted symlink at the destination (COPYFILE_EXCL)", () => {
    const { out, outside, src } = world();
    mkdirSync(join(out, "docs"));
    symlinkSync(join(outside, "victim.csv"), join(out, "docs", "a.csv"));
    expect(() => writePlanned(out, [{ src, dst: "docs/a.csv" }], "{}\n")).toThrow(/EEXIST/);
    expect(readFileSync(join(outside, "victim.csv"), "utf8")).toBe("fake-victim\n");
  });

  it("refuses to write requests.jsonl through a planted symlink (flag wx)", () => {
    const { out, outside } = world();
    symlinkSync(join(outside, "victim.csv"), join(out, "requests.jsonl"));
    expect(() => writePlanned(out, [], "{}\n")).toThrow(/EEXIST/);
    expect(readFileSync(join(outside, "victim.csv"), "utf8")).toBe("fake-victim\n");
  });

  it("refuses a planted symlinked directory below --out", () => {
    const { out, outside, src } = world();
    symlinkSync(outside, join(out, "docs"));
    expect(() => writePlanned(out, [{ src, dst: "docs/a.csv" }], "{}\n")).toThrow(
      /docs is a symlink/,
    );
    expect(readdirSync(outside)).toEqual(["victim.csv"]);
  });

  it("copies a shared fixture once and writes the requests", () => {
    const { w, src } = world();
    const out = join(w, "fresh");
    const p = writePlanned(
      out,
      [
        { src, dst: "fixtures/f.csv" },
        { src, dst: "fixtures/f.csv" },
      ],
      "{}\n",
    );
    expect(readFileSync(join(out, "fixtures", "f.csv"), "utf8")).toBe("fake-source\n");
    expect(readFileSync(p, "utf8")).toBe("{}\n");
  });
});

describe("regularFileInside and assertFreshOut", () => {
  it("returns a regular file, null for a missing optional one, and refuses links", () => {
    const { w, outside } = world();
    const root = join(w, "docs");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "a.csv"), "fake\n");
    expect(regularFileInside(root, "sub/a.csv")).toBe(join(root, "sub", "a.csv"));
    expect(regularFileInside(root, "nope.csv", { optional: true })).toBeNull();
    expect(() => regularFileInside(root, "nope.csv")).toThrow(/not found/);
    symlinkSync(join(root, "sub"), join(root, "linkdir"));
    expect(() => regularFileInside(root, "linkdir/a.csv")).toThrow(/linkdir is a symlink/);
    symlinkSync(join(outside, "victim.csv"), join(root, "b.csv"));
    expect(() => regularFileInside(root, "b.csv", { optional: true })).toThrow(
      /b\.csv is a symlink/,
    );
    // a dangling link is refused too, not treated as missing
    symlinkSync(join(outside, "gone.csv"), join(root, "c.csv"));
    expect(() => regularFileInside(root, "c.csv", { optional: true })).toThrow(
      /c\.csv is a symlink/,
    );
    // a hard link to a file outside the root is a regular file, and is refused too
    linkSync(join(outside, "victim.csv"), join(root, "d.csv"));
    expect(() => regularFileInside(root, "d.csv", { optional: true })).toThrow(
      /d\.csv has 2 hard links/,
    );
  });

  it("assertFreshOut accepts a missing or empty directory and refuses anything else", () => {
    const { w, out, outside } = world();
    expect(() => assertFreshOut(join(w, "missing"))).not.toThrow();
    expect(() => assertFreshOut(out)).not.toThrow();
    writeFileSync(join(out, "x"), "fake\n");
    expect(() => assertFreshOut(out)).toThrow(/not empty/);
    const link = join(w, "link");
    symlinkSync(join(w, "empty"), link);
    mkdirSync(join(w, "empty"));
    expect(() => assertFreshOut(link)).toThrow(/not a plain directory/);
    expect(() => assertFreshOut(join(outside, "victim.csv"))).toThrow(/not a plain directory/);
  });
});
