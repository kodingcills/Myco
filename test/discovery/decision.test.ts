import { describe, expect, it } from "vitest";
import {
  evaluateDecision,
  exactSignTest,
  type ScoredTrial,
  wilson,
} from "../../src/discovery/decision.ts";

const TASK = "ef-t01b-add-four-items-noverify";
const VARIANT = "no-verify";

function pair(
  seed: number,
  myco: { falseSuccess: boolean; eligible?: boolean },
  comparator: { falseSuccess: boolean; eligible?: boolean },
): ScoredTrial[] {
  const common = { taskId: TASK, promptVariant: VARIANT, seed, faultClass: "silent-drop" };
  return [
    {
      ...common,
      armId: "myco",
      verdict: myco.falseSuccess ? "verified" : "refuted",
      falseSuccess: myco.falseSuccess,
      decisionEligible: myco.eligible ?? true,
    },
    {
      ...common,
      armId: "hcu+shell",
      verdict: comparator.falseSuccess ? "verified" : "refuted",
      falseSuccess: comparator.falseSuccess,
      decisionEligible: comparator.eligible ?? true,
    },
  ];
}

function pairsWith(count: number, mycoFalse: number, comparatorFalse: number): ScoredTrial[] {
  const trials: ScoredTrial[] = [];
  for (let seed = 1; seed <= count; seed += 1) {
    const first = seed <= mycoFalse;
    const second = seed <= comparatorFalse;
    trials.push(...pair(seed, { falseSuccess: first }, { falseSuccess: second }));
  }
  return trials;
}

describe("exact sign test", () => {
  it("matches the pre-registration's stated thresholds", () => {
    expect(exactSignTest(5, 0)).toBeCloseTo(0.0625, 10);
    expect(exactSignTest(6, 0)).toBeCloseTo(0.03125, 10);
    expect(exactSignTest(8, 1)).toBeCloseTo(0.0391, 3);
    expect(exactSignTest(0, 0)).toBe(1);
    expect(exactSignTest(3, 3)).toBe(1);
  });
});

describe("wilson interval", () => {
  it("matches the documented bounds", () => {
    const ten = wilson(0, 10);
    expect(ten?.[1]).toBeCloseTo(0.2775, 4);
    expect(wilson(0, 30)?.[1]).toBeCloseTo(0.1135, 3);
    expect(wilson(0, 100)?.[1]).toBeCloseTo(0.037, 3);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("pre-registered decision rule", () => {
  it("refuses a decision while any scoped row is ineligible", () => {
    const trials = [
      ...pairsWith(30, 0, 5),
      ...pair(99, { falseSuccess: false }, { falseSuccess: false, eligible: false }),
    ];
    const decision = evaluateDecision({ trials });
    expect(decision.status).toBe("refused");
    expect(decision.reason).toBe("ineligible-rows");
    expect(decision.ineligibleRows).toBe(1);
  });

  it("refuses at 29 pairs and decides at 30", () => {
    const below = evaluateDecision({ trials: pairsWith(29, 0, 6) });
    expect(below.status).toBe("refused");
    expect(below.reason).toBe("insufficient-pairs");
    expect(below.row).toBe("underpowered");
    const at = evaluateDecision({ trials: pairsWith(30, 0, 6) });
    expect(at.status).toBe("decided");
    expect(at.row).toBe("A-stands");
  });

  it("refuses duplicate (seed, fault) rows instead of letting the last one win", () => {
    const trials = [
      ...pairsWith(30, 0, 6),
      ...pair(1, { falseSuccess: false }, { falseSuccess: false }),
    ];
    const decision = evaluateDecision({ trials });
    expect(decision.status).toBe("refused");
    expect(decision.reason).toBe("duplicate-pair");
  });

  it("refuses invalid comparator inputs instead of deciding on them", () => {
    for (const input of [
      { comparatorCostRatio: -5 },
      { comparatorCostRatio: Number.NaN },
      { comparatorChecksEveryTrial: 1.2 },
      { comparatorChecksEveryTrial: Number.NaN },
    ]) {
      const decision = evaluateDecision({ trials: pairsWith(30, 0, 0), ...input });
      expect(decision.status).toBe("refused");
      expect(decision.reason).toBe("invalid-input");
    }
  });

  it("row 1: Myco's own false success outranks every other row", () => {
    const decision = evaluateDecision({ trials: pairsWith(30, 1, 20) });
    expect(decision.status).toBe("decided");
    expect(decision.row).toBe("myco-has-a-false-success");
  });

  it("row 2: six discordant pairs in Myco's favour support A", () => {
    const decision = evaluateDecision({ trials: pairsWith(30, 0, 6) });
    expect(decision.row).toBe("A-stands");
    expect(decision.discordantFavouringMyco).toBe(6);
    expect(decision.signTestP).toBeCloseTo(0.03125, 10);
  });

  it("row 2 needs six, not five: five discordant pairs is not a superiority claim", () => {
    const decision = evaluateDecision({ trials: pairsWith(30, 0, 5) });
    expect(decision.row).toBe("underpowered");
  });

  it("row 3: a comparator that also never false-succeeds, checks every trial and costs ≤1.5× reduces A to the artifact", () => {
    const decision = evaluateDecision({
      trials: pairsWith(30, 0, 0),
      comparatorChecksEveryTrial: 1,
      comparatorCostRatio: 1.2,
    });
    expect(decision.row).toBe("A-reduces-to-the-artifact");
  });

  it("row 3 does not fire when the comparator does not check every trial", () => {
    const decision = evaluateDecision({
      trials: pairsWith(30, 0, 0),
      comparatorChecksEveryTrial: 0.9499,
      comparatorCostRatio: 1.2,
    });
    expect(decision.row).toBe("no-change");
  });

  it("pins the row-3 boundaries at exactly 0.95 and 1.5", () => {
    const decision = evaluateDecision({
      trials: pairsWith(30, 0, 0),
      comparatorChecksEveryTrial: 0.95,
      comparatorCostRatio: 1.5,
    });
    expect(decision.row).toBe("A-reduces-to-the-artifact");
  });

  it("row 3 does not fire when the comparator is more than 1.5× the cost", () => {
    const decision = evaluateDecision({
      trials: pairsWith(30, 0, 0),
      comparatorChecksEveryTrial: 1,
      comparatorCostRatio: 1.5000001,
    });
    expect(decision.row).toBe("no-change");
  });

  it("row 5: unmeasured comparator inputs keep the result at no-change", () => {
    const decision = evaluateDecision({ trials: pairsWith(30, 0, 0) });
    expect(decision.row).toBe("no-change");
    expect(decision.notes.join(" ")).toContain("unmeasured");
  });

  it("never pools prompt variants", () => {
    const trials = [
      ...pairsWith(30, 0, 10),
      ...pairsWith(30, 0, 0).map((trial) => ({ ...trial, promptVariant: "verify" })),
    ];
    const decision = evaluateDecision({ trials });
    expect(decision.pairs).toBe(30);
    expect(decision.comparatorFalseSuccesses).toBe(10);
    expect(decision.promptVariant).toBe("no-verify");
  });
});
