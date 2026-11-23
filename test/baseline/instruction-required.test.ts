import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBaselineRow } from "../../src/baseline/index.ts";

/**
 * TIF-128 / M1-031: a C1 row records the instruction it was given.
 *
 * The rule, and why it is two-sided: a C1 row must carry a non-empty
 * `instruction`, OR declare `instructionUnrecorded: true` and carry none.
 *
 * Requiring it unconditionally is the obvious rule and it is wrong here. The 29
 * recorded arm-002 rows were produced before the field existed; making it
 * mandatory would have silently invalidated every one of them, turning real
 * evidence into failed validation with no code change to explain it. Measured:
 * 29 of 29 became invalid under the unconditional rule.
 *
 * So the marker exists to keep the historical gap explicit rather than implied,
 * and the tests below pin BOTH directions - a new row forgetting the field is
 * rejected, and a documented legacy row still validates.
 */

const legacy = JSON.parse(
  readFileSync(join(process.cwd(), "docs/research/experiments/c1-arm-002/rows/0.json"), "utf8"),
) as Record<string, unknown>;

/** A C1 row with neither the field nor the marker. */
function newRowWithoutInstruction(): Record<string, unknown> {
  const r = { ...legacy };
  delete r.instructionUnrecorded;
  return r;
}

describe("a C1 row must record its instruction or declare the gap", () => {
  it("accepts a row carrying the instruction", () => {
    expect(isBaselineRow({ ...newRowWithoutInstruction(), instruction: "Set x, and save." })).toBe(
      true,
    );
  });

  it("rejects a row with neither the instruction nor the marker", () => {
    // The property M1-031 exists for: a new row that forgets the field must fail
    // rather than ship evidence whose parity cannot be checked.
    expect(isBaselineRow(newRowWithoutInstruction())).toBe(false);
  });

  it("rejects an empty instruction rather than treating it as present", () => {
    // `str("")` passes a typeof check, so this needs the length test too.
    expect(isBaselineRow({ ...newRowWithoutInstruction(), instruction: "" })).toBe(false);
  });

  it("accepts a legacy row that declares it predates the field", () => {
    // Verbatim from arm-002. If this flips, the recorded evidence has been
    // invalidated by a validator change rather than by anything in the artifact.
    expect(isBaselineRow(legacy)).toBe(true);
    expect(legacy.instruction).toBeUndefined();
    expect(legacy.instructionUnrecorded).toBe(true);
  });

  it("does not constrain non-C1 rows", () => {
    // Discovery's live runner has no sentence and must not be forced to invent
    // one; only the screenshot baseline is prompted.
    const hcu = { ...newRowWithoutInstruction(), subArm: "hcu" };
    expect(isBaselineRow(hcu)).toBe(true);
  });

  it("all 29 recorded arm-002 rows validate, so the evidence survives the rule", () => {
    // The count is pinned deliberately. An earlier draft of this work claimed
    // "0 of 30" when the artifact has 30 ledger entries and only 29 rows - entry
    // 9 is `omitted` with no row at all. Pinning 29 makes that distinction a
    // failing test rather than a wrong sentence in a comment.
    const files = readFileSync(
      join(process.cwd(), "docs/research/experiments/c1-arm-002/accounting.json"),
      "utf8",
    );
    const ledger = (JSON.parse(files) as { c1: Record<string, { row?: unknown }> }).c1;
    const rows = Object.values(ledger).filter((e) => e.row !== undefined);
    expect(rows.length).toBe(29);
    expect(rows.every((e) => isBaselineRow(e.row))).toBe(true);
  });
});
