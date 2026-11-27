/**
 * #579: the shared helpers every export surface uses (`src/export-guard`): the provenance-bound
 * hash ledger (O3) and the accent fold (O2). Plus the boundary: the helpers import nothing from
 * any surface or from `src/benchmark` (grader independence), and every surface uses them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripAccents } from "../../src/export-guard/fold.ts";
import {
  episodeScope,
  HashLedger,
  harnessHashed,
  isHashedForm,
  keepOrHash,
  NO_LEDGER,
} from "../../src/export-guard/provenance.ts";

const H = `h-${"0123456789abcdef".repeat(4).slice(0, 60)}`;
const hash = (raw: string) => `hashed(${raw})`;

describe("HashLedger and keepOrHash (O3)", () => {
  it("keeps an h-<60 hex> only when recorded at exactly that scope", () => {
    const l = new HashLedger();
    l.record("a", H);
    expect(keepOrHash(H, "a", l, hash)).toBe(H);
    expect(keepOrHash(H, "b", l, hash)).toBe(hash(H));
    expect(keepOrHash(H, "a", NO_LEDGER, hash)).toBe(hash(H));
    expect(harnessHashed(H, "a", l)).toBe(true);
    expect(harnessHashed(H, "a", new HashLedger())).toBe(false);
  });

  it("never keeps a value that is not exactly h-<60 hex>, recorded or not", () => {
    const l = new HashLedger();
    l.record("a", H);
    for (const v of [`${H}x`, ` ${H}`, H.toUpperCase(), `h-${"0".repeat(64)}`, "plain"])
      expect(keepOrHash(v, "a", l, hash), v).toBe(hash(v));
    expect(() => l.record("a", "plain")).toThrow();
    expect(() => l.record("a", `H-${"0".repeat(60)}`)).toThrow();
  });

  it("the empty ledger stays empty, entries are sorted, scopes do not collide", () => {
    expect(NO_LEDGER.size).toBe(0);
    const l = new HashLedger();
    const H2 = `h-${"f".repeat(60)}`;
    l.record(episodeScope("b".repeat(64), "$.x"), H2);
    l.record(episodeScope("a".repeat(64), "$.x"), H);
    l.record(episodeScope("a".repeat(64), "$.x"), H);
    expect(l.size).toBe(2);
    expect(l.entries().map(([, v]) => v)).toEqual([H, H2]);
    expect(episodeScope("a", "b.c")).not.toBe(episodeScope("a.b", "c"));
    expect(isHashedForm(H)).toBe(true);
  });
});

describe("stripAccents (O2)", () => {
  it("removes combining marks after NFD and transliterates the letters NFD does not split", () => {
    expect(stripAccents("josé")).toBe("jose");
    expect(stripAccents("josé")).toBe("jose");
    expect(stripAccents("reña")).toBe("rena");
    expect(stripAccents("zoë")).toBe("zoe");
    expect(stripAccents("søren")).toBe("soren");
    expect(stripAccents("łukasz")).toBe("lukasz");
    expect(stripAccents("ærø")).toBe("aero");
    expect(stripAccents("þór")).toBe("thor");
    expect(stripAccents("plain-ascii_1")).toBe("plain-ascii_1");
  });
});

describe("boundary: one shared helper, no surface or benchmark code reached", () => {
  const ROOT = resolve(import.meta.dirname, "..", "..");
  const IMPORT = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g;
  const reached = (entry: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const m of readFileSync(entry, "utf8").matchAll(IMPORT)) {
      const spec = m[1] as string;
      if (spec.startsWith(".")) reached(resolve(dirname(entry), spec), seen);
    }
    return seen;
  };

  it("src/export-guard imports nothing outside itself", () => {
    const dir = join(ROOT, "src/export-guard");
    for (const f of readdirSync(dir)) {
      const files = [...reached(join(dir, f))].map((p) => relative(ROOT, p));
      expect(
        files.filter((p) => !p.startsWith("src/export-guard/")),
        f,
      ).toEqual([]);
    }
  });

  it("every surface's closer uses the shared provenance helper and accent fold", () => {
    const uses = (file: string, name: string) =>
      readFileSync(join(ROOT, file), "utf8").includes(name);
    for (const f of ["src/episode/closed.ts", "src/dataset/closed.ts", "src/proof/hashed.ts"])
      expect(uses(f, "keepOrHash("), f).toBe(true);
    for (const f of ["src/episode/identity.ts", "src/dataset/closed.ts", "src/proof/identity.ts"])
      expect(uses(f, "stripAccents("), f).toBe(true);
  });
});
