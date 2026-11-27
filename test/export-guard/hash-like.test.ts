/**
 * #612 D1/D2: the shared hash look-alike rules (`src/export-guard/hash-like.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  exporterHashes,
  HASH_LIKE,
  malformedHash,
  skipsIdentityCheck,
} from "../../src/export-guard/hash-like.ts";

const HEX60 = "0123456789abcdef".repeat(4).slice(0, 60);

describe("malformedHash (D2)", () => {
  it("is false for exactly h-<60 hex> and for values that do not start like a hash", () => {
    expect(malformedHash(`h-${HEX60}`)).toBe(false);
    for (const v of ["task-1", "run-1", "hx-1", "ah-1", "h", "H", "h_1", ""])
      expect(malformedHash(v), v).toBe(false);
  });

  it("is true for every other h-/H- form", () => {
    for (const v of [
      `H-${HEX60.toUpperCase()}`,
      `H-${HEX60}`,
      `h-${HEX60.toUpperCase()}`,
      `h-${"a".repeat(64)}`,
      `h-${HEX60.slice(0, 59)}`,
      `h-${HEX60}0`,
      `h-${HEX60.slice(0, 59)}g`,
      "h-",
      "H-x",
      "h-task",
    ])
      expect(malformedHash(v), v).toBe(true);
  });

  it("HASH_LIKE is exactly a leading h- or H-", () => {
    expect(HASH_LIKE.test("h-1")).toBe(true);
    expect(HASH_LIKE.test("H-1")).toBe(true);
    expect(HASH_LIKE.test("xh-1")).toBe(false);
    expect(HASH_LIKE.test("h1")).toBe(false);
  });
});

describe("skipsIdentityCheck (D1)", () => {
  const hashedForm = `h-${"cafe".repeat(15)}`;
  it("skips exactly h-<60 hex> in a field the exporter hashes (text, id, token)", () => {
    for (const k of ["text", "id", "token"] as const) {
      expect(exporterHashes(k)).toBe(true);
      expect(skipsIdentityCheck(k, hashedForm), k).toBe(true);
      expect(skipsIdentityCheck(k, `h-${"cafe".repeat(15)}0`), k).toBe(false);
      expect(skipsIdentityCheck(k, `H-${"CAFE".repeat(15)}`), k).toBe(false);
    }
  });

  it("never skips in a closed-pattern field, whatever the value", () => {
    expect(exporterHashes("closed")).toBe(false);
    for (const v of [hashedForm, `h-${HEX60}`, "cafe"])
      expect(skipsIdentityCheck("closed", v), v).toBe(false);
  });
});
