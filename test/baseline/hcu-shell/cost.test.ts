/** TIF-268: the M2-12 cost estimate is computed, and the arm doc quotes the computation. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC, estimate } from "../../../scripts/m2-hcu-shell-cost.ts";

describe("hcu+shell cost estimate", () => {
  const result = estimate();
  it("is recomputed from the committed r6 extract", () => {
    expect(result.r6).toMatchObject({ rows: 30, micros: 3_371_350 });
    expect(result.expected.armMicros).toBeGreaterThan(result.r6.micros);
    expect(result.ceiling.armMicros).toBeGreaterThan(result.expected.armMicros);
  });
  it("is quoted verbatim by the arm doc", () =>
    expect(readFileSync(DOC, "utf8")).toContain(result.block));
  it("refuses an empty base", () => expect(() => estimate({ rows: [] })).toThrow(/no rows/));
});
