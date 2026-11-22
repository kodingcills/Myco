import { describe, expect, it } from "vitest";
import {
  clopperPearson,
  FALSE_SUCCESS_BOUNDS,
  scoreClaim,
  wilson,
  zeroEventUpperBound,
} from "../../src/foundry/stats.ts";

describe("EF-004 statistics", () => {
  it("reproduces the survey's 27/30 interval", () => {
    const [low, high] = [clopperPearson(27, 30).low, clopperPearson(27, 30).high];
    expect(low).toBeCloseTo(0.735, 3);
    expect(high).toBeCloseTo(0.979, 3);
  });

  it("reproduces every row of the survey's false-success bound table", () => {
    for (const row of FALSE_SUCCESS_BOUNDS) {
      expect(zeroEventUpperBound(row.trials), `n=${row.trials}`).toBeCloseTo(row.upper95, 3);
    }
  });

  it("brackets the point estimate and never exceeds [0,1]", () => {
    for (const [k, n] of [
      [0, 10],
      [1, 10],
      [5, 10],
      [10, 10],
      [0, 1],
      [1, 1],
      [3, 100],
    ] as const) {
      const { low, high } = clopperPearson(k, n);
      expect(low).toBeLessThanOrEqual(k / n);
      expect(high).toBeGreaterThanOrEqual(k / n);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
    }
  });

  it("reports a vacuous interval for zero trials rather than a narrow one", () => {
    expect(clopperPearson(0, 0)).toEqual({ low: 0, high: 1 });
    expect(zeroEventUpperBound(0)).toBe(1);
  });

  it("Wilson agrees closely with the survey's published values", () => {
    const interval = wilson(27, 30)!;
    expect(interval.low).toBeCloseTo(0.744, 3);
    expect(wilson(0, 0)).toBeNull();
  });

  it("attaches the underpowered caveats instead of reporting a bare rate", () => {
    const small = scoreClaim(10, 10, 0);
    expect(small.caveats.join(" ")).toMatch(
      /zero false successes in 10 trials bounds the true rate only below 25\.9%/,
    );
    expect(small.caveats.join(" ")).toMatch(/underpowered/);

    const adequate = scoreClaim(100, 90, 0);
    expect(adequate.caveats).toEqual([]);
    expect(adequate.reliabilityInterval.low).toBeGreaterThan(0.8);
  });

  it("uses the exact upper bound once a false success has occurred", () => {
    const claim = scoreClaim(100, 90, 2);
    expect(claim.falseSuccessUpper95).toBeCloseTo(clopperPearson(2, 100).high, 6);
    expect(claim.falseSuccessUpper95).toBeGreaterThan(zeroEventUpperBound(100));
  });
});
