/** Track S s-v1: canonical JSON for the pre-registration hash. */
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../../src/schedule/conformance/canonical.ts";

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: true, e: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"e":null,"f":true}]},"b":1}',
    );
  });

  it("gives the same hash for the same value whatever the key order", () => {
    expect(sha256Hex(canonicalJson({ a: 1, b: 2 }))).toBe(sha256Hex(canonicalJson({ b: 2, a: 1 })));
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", { a: undefined }],
    ["a function", { a: () => 1 }],
    ["a Date", new Date(0)],
  ])("refuses %s instead of dropping it", (_, v) => {
    expect(() => canonicalJson(v)).toThrow(/canonicalJson/);
  });
});
