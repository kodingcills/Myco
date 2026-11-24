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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpendCeiling } from "../../scripts/spend-ceiling.ts";
import { runC1Sweep } from "../../src/baseline/sweep.ts";

const COMBINED_LIMIT = 9_000_000;

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

  // TIF-187. The documented pairing USED to be unlaunchable, and nothing caught it.
  //
  // The doctrine (docs/research/experiments/c1-arm-003d/SPEND-CEILING.md:174) says
  // MYCO_ARM_LIMIT_MICROS should be the REMAINING budget, ceiling - prior. The
  // guard then read `priorSpend + c1 + reservation > armLimit`, adding prior spend
  // to a value prior spend had already been subtracted from. With prior 4480732
  // and a 607200 reservation, 5087932 > 4519268, so EVERY trial was omitted:
  // r6's first launch produced completed 0 and 30 spend-limit rows. The
  // configuration the documentation prescribes could not start a single trial.
  //
  // Asserted through the REAL sweep rather than the arithmetic alone, because the
  // arithmetic was never the problem - the guard's scoping was, and only running
  // it shows which ceiling prior spend is charged against.
  it("starts trials when arm is the documented remaining budget", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-ceiling-launch-"));
    try {
      const prior = 4_480_732;
      const report = await runC1Sweep({
        directory,
        coordinatorGo: true,
        priorSpendMicros: prior,
        armLimitMicros: COMBINED_LIMIT - prior, // the documented rule
        planner: { paid: true, act: async () => ({ calls: [], decision: "done" }) },
        prepare: async () => {
          throw new Error("launch probe: prepare fails after the guard admits the trial");
        },
      });
      // The point: the guard ADMITTED trials instead of omitting them. A
      // spend-limit omission is booked before prepare is ever called, so seeing
      // any trial-interrupted row proves the arm check passed.
      const omitted = report.rows.filter((r) => r.omitted === "spend-limit").length;
      expect(omitted).toBe(0);
      expect(report.rows.some((r) => r.omitted === "trial-interrupted")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a value beyond the safe-integer range", () => {
    expect(() =>
      parseSpendCeiling({ ...ok, MYCO_PRIOR_SPEND_MICROS: "99999999999999999999" }),
    ).toThrow();
  });
});
