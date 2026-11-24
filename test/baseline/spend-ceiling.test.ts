/**
 * The spend ceiling's env boundary, unit-tested.
 *
 * This is the one place a STRING becomes a spend limit, and a mistake here is
 * invisible until a run overspends. The empty-string defect lived exactly here:
 * `Number("")` is 0, 0 is a valid prior spend, so `MYCO_PRIOR_SPEND_MICROS=` read
 * as "nothing spent before" and silently restored the allowance the seed exists
 * to remove. It survived a round of review because the parse was inline in the
 * CLI entry point and had no test at all - the reviewer reproduced it by hand.
 *
 * The empty case is the one that matters: an exported-but-empty variable is the
 * canonical way an operator writes "missing", and it is the only invalid form
 * that coercion turns into a plausible value rather than NaN.
 */
import { describe, expect, it } from "vitest";
import { parseSpendCeiling } from "../../scripts/spend-ceiling.ts";

const ok = { MYCO_PRIOR_SPEND_MICROS: "3190688", MYCO_ARM_LIMIT_MICROS: "5432512" };

describe("spend ceiling env parsing", () => {
  it("accepts the pair the arm-003d relaunch uses", () => {
    expect(parseSpendCeiling(ok)).toEqual({
      priorSpendMicros: 3_190_688,
      remainingMicros: 5_432_512,
    });
  });

  it("refuses an EMPTY prior spend rather than reading it as zero", () => {
    // The regression. `Number("")` is 0, which is a safe non-negative integer, so
    // coercion alone accepts this and the run gets a full allowance it has
    // already spent part of.
    expect(() => parseSpendCeiling({ ...ok, MYCO_PRIOR_SPEND_MICROS: "" })).toThrow(
      "must both be set",
    );
  });

  it("refuses an empty remaining budget rather than reading it as zero", () => {
    // A zero budget is rejected by the `<= 0` clause, but an empty string must
    // not reach that clause as a number at all.
    expect(() => parseSpendCeiling({ ...ok, MYCO_ARM_LIMIT_MICROS: "" })).toThrow();
  });

  it("refuses every form that lenient coercion would accept", () => {
    // `Number` accepts all of these; none is a valid micros count. Listed
    // together so the reason for strict digits is visible rather than implied by
    // one example.
    for (const bad of [" ", " 42 ", "0x10", "1.5", "1e6", "+7", "-1", "abc", "42\n"]) {
      expect(() => parseSpendCeiling({ ...ok, MYCO_PRIOR_SPEND_MICROS: bad }), bad).toThrow();
    }
  });

  it("accepts a zero PRIOR spend, which is legitimate", () => {
    // Zero committed spend is a real state - a first arm - and must not be
    // confused with the empty string that merely looks like it.
    expect(parseSpendCeiling({ ...ok, MYCO_PRIOR_SPEND_MICROS: "0" }).priorSpendMicros).toBe(0);
  });

  it("refuses a missing variable", () => {
    const { MYCO_PRIOR_SPEND_MICROS: _drop, ...withoutPrior } = ok;
    expect(() => parseSpendCeiling(withoutPrior)).toThrow("must both be set");
  });

  it("refuses a zero remaining budget", () => {
    expect(() => parseSpendCeiling({ ...ok, MYCO_ARM_LIMIT_MICROS: "0" })).toThrow();
  });

  it("refuses a value beyond the safe-integer range", () => {
    expect(() =>
      parseSpendCeiling({ ...ok, MYCO_PRIOR_SPEND_MICROS: "99999999999999999999" }),
    ).toThrow();
  });
});
