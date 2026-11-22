import { describe, expect, it } from "vitest";
import { compareArms, type PairedTrial, signTest } from "../../src/foundry/baseline/compare.ts";

const LABELS = { left: "myco", right: "screenshot-only" } as const;

function pairs(spec: readonly (readonly [boolean | null, boolean | null])[]): PairedTrial[] {
  return spec.map(([leftVerified, rightVerified], index) => ({
    key: `t${index}`,
    leftVerified,
    rightVerified,
  }));
}

describe("EF-005 sign test", () => {
  it("matches the published thresholds in contract §6.1", () => {
    expect(signTest(5, 0)).toBeCloseTo(0.0625, 6); // 5 of 5 proves nothing
    expect(signTest(6, 0)).toBeCloseTo(0.03125, 6); // 6 of 6 is the smallest significant result
    expect(signTest(0, 6)).toBeCloseTo(0.03125, 6);
    expect(signTest(0, 0)).toBe(1);
  });

  it("a split result needs far more discordance than a unanimous one", () => {
    // Unanimous: 6 is the first significant count.
    expect(signTest(5, 0)).toBeGreaterThan(0.05);
    expect(signTest(6, 0)).toBeLessThan(0.05);
    // Split: the smallest significant total is 9, at an 8-to-1 split.
    expect(signTest(1, 7)).toBeGreaterThan(0.05);
    expect(signTest(1, 8)).toBeLessThan(0.05);
    // Scattered discordance proves nothing at any size: 15/15 is p = 1.
    expect(signTest(3, 3)).toBe(1);
    expect(signTest(15, 15)).toBe(1);
    // And at n = 30 a lopsided-but-not-unanimous split still needs overwhelming evidence.
    expect(signTest(10, 20)).toBeGreaterThan(0.05);
  });

  it("rejects nonsense counts instead of returning the most significant p", () => {
    for (const [a, b] of [
      [-1, 0],
      [0, -1],
      [-5, 3],
      [1, -9],
      [Number.NaN, 2],
      [1.5, 2],
    ] as const) {
      expect(() => signTest(a, b), `${a},${b}`).toThrow(/non-negative safe integers/);
    }
  });

  it("is symmetric and never exceeds 1", () => {
    for (const [a, b] of [
      [1, 0],
      [3, 2],
      [7, 1],
      [0, 9],
      [12, 12],
    ] as const) {
      expect(signTest(a, b)).toBeCloseTo(signTest(b, a), 12);
      expect(signTest(a, b)).toBeLessThanOrEqual(1);
    }
  });
});

describe("EF-005 paired comparison", () => {
  it("refuses to name a winner when the arms agree everywhere", () => {
    const result = compareArms(
      pairs(Array.from({ length: 30 }, () => [true, true] as const)),
      LABELS,
    );
    expect(result.verdict).toBe("underpowered");
    expect(result.p).toBe(1);
    expect(result.statement).toContain("No winner is claimed");
  });

  it("names a winner on 6 unanimous discordant trials", () => {
    const spec = [
      ...Array.from({ length: 6 }, () => [true, false] as const),
      ...Array.from({ length: 24 }, () => [true, true] as const),
    ];
    const result = compareArms(pairs(spec), LABELS);
    expect(result.leftOnly).toBe(6);
    expect(result.rightOnly).toBe(0);
    expect(result.verdict).toBe("left");
    expect(result.unanimous).toBe(true);
    expect(result.statement).toContain("myco wins");
  });

  it("refuses a winner on 5 of 5, which is p = 0.0625", () => {
    const result = compareArms(
      pairs(Array.from({ length: 5 }, () => [true, false] as const)),
      LABELS,
    );
    expect(result.leftOnly).toBe(5);
    expect(result.verdict).toBe("underpowered");
  });

  it("excludes trials where either arm has no verdict, and never counts them as agreement", () => {
    const result = compareArms(
      pairs([
        [true, null],
        [null, false],
        [true, false],
        [false, false],
      ]),
      LABELS,
    );
    expect(result.excluded).toBe(2);
    expect(result.paired).toBe(2);
    expect(result.leftOnly).toBe(1);
  });

  it("refuses duplicate trial keys rather than pairing a trial with itself", () => {
    expect(() =>
      compareArms(
        [
          { key: "same", leftVerified: true, rightVerified: false },
          { key: "same", leftVerified: false, rightVerified: true },
        ],
        LABELS,
      ),
    ).toThrow(/duplicate trial key/);
  });

  it("reports per-arm rates with exact intervals, not bare percentages", () => {
    const spec = [
      ...Array.from({ length: 6 }, () => [true, false] as const),
      ...Array.from({ length: 24 }, () => [true, true] as const),
    ];
    const result = compareArms(pairs(spec), LABELS);
    expect(result.leftRate.rate).toBe(1);
    expect(result.rightRate.rate).toBeCloseTo(24 / 30, 6);
    expect(result.rightRate.interval.low).toBeLessThan(result.rightRate.rate);
    expect(result.rightRate.interval.high).toBeGreaterThan(result.rightRate.rate);
  });

  it("says nothing can be concluded when there are no paired trials", () => {
    const result = compareArms(pairs([[null, null]]), LABELS);
    expect(result.verdict).toBe("underpowered");
    expect(result.statement).toContain("no paired trials");
  });
});
