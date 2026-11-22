import { describe, expect, it } from "vitest";
import type { ScoredTrial } from "../../src/discovery/decision.ts";
import {
  parseC1Accounting,
  parseRunResult,
  parseScoredTrials,
  renderReplaySummary,
  replay,
} from "../../src/discovery/replay.ts";
import { renderHeadToHeadReport } from "../../src/discovery/report.ts";

const c1Accounting = {
  c1: {
    "0": {
      status: "scored",
      row: { index: 0, verdict: "refuted", falseSuccess: false, verdictReason: "step-budget" },
    },
    "1": {
      status: "scored",
      row: { index: 1, verdict: "verified", falseSuccess: true, verdictReason: "none" },
    },
    "2": { status: "omitted" },
  },
};

const runResult = {
  runId: "r1",
  taskId: "calc-record-edit",
  verdict: { status: "verified", checks: [], score: 1, reasons: [] },
};

function eligiblePair(seed: number, mycoFalse: boolean, comparatorFalse: boolean): ScoredTrial[] {
  const common = {
    taskId: "ef-t01b-add-four-items-noverify",
    promptVariant: "no-verify",
    seed,
    faultClass: "silent-drop",
    decisionEligible: true,
  };
  return [
    {
      ...common,
      armId: "myco",
      verdict: mycoFalse ? "verified" : "refuted",
      falseSuccess: mycoFalse,
    },
    {
      ...common,
      armId: "hcu+shell",
      verdict: comparatorFalse ? "verified" : "refuted",
      falseSuccess: comparatorFalse,
    },
  ];
}

describe("recorded evidence parsers", () => {
  it("parses C1 accounting rows and skips non-scored entries", () => {
    const parsed = parseC1Accounting(c1Accounting, "accounting.json");
    expect(parsed.trials).toHaveLength(2);
    expect(parsed.trials[0]).toMatchObject({
      armId: "screenshot-only-c1",
      taskId: "calc-record-edit",
      verdict: "refuted",
      falseSuccess: false,
      decisionEligible: false,
    });
    expect(parsed.trials[1]?.falseSuccess).toBe(true);
    expect(parsed.skipped).toHaveLength(1);
  });

  it("parses a run result without inventing a false-success value", () => {
    const parsed = parseRunResult(runResult, "result.json");
    expect(parsed.trials[0]).toMatchObject({
      armId: "myco",
      verdict: "verified",
      falseSuccess: false,
      falseSuccessKnown: false,
      decisionEligible: false,
    });
  });

  it("rejects malformed scored rows instead of coercing them", () => {
    const parsed = parseScoredTrials(
      [
        { armId: "myco", taskId: "t", promptVariant: "v", seed: 1, verdict: "verified" },
        {
          armId: "myco",
          taskId: "t",
          promptVariant: "v",
          seed: 2,
          verdict: "nope",
          falseSuccess: false,
          decisionEligible: true,
        },
      ],
      "rows.json",
    );
    expect(parsed.trials).toHaveLength(0);
    expect(parsed.skipped).toHaveLength(2);
  });
});

describe("offline replay", () => {
  it("refuses on recorded descriptive evidence and names what is missing", () => {
    const summary = replay([
      { source: "accounting.json", value: c1Accounting },
      { source: "result.json", value: runResult },
    ]);
    expect(summary.arms.map((arm) => arm.armId)).toEqual(["myco", "screenshot-only-c1"]);
    expect(summary.decision.status).toBe("refused");
    expect(summary.decision.reason).toBe("missing-arm");
    expect(summary.missing.join(" ")).toContain("Myco arm on ef-t01b");
    expect(summary.missing.join(" ")).toContain("hcu+shell arm on ef-t01b");
    expect(summary.missing.join(" ")).toContain("trusted ingest");
    const markdown = renderReplaySummary(summary);
    expect(markdown).toContain("Descriptive only");
    expect(markdown).toContain("screenshot-only-c1");
  });

  it("decides when eligible paired rows are supplied", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      eligiblePair(index + 1, false, index < 6),
    ).flat();
    const summary = replay([{ source: "rows.json", value: rows }]);
    expect(summary.decision.status).toBe("decided");
    expect(summary.decision.row).toBe("A-stands");
    expect(summary.decision.pairs).toBe(30);
    expect(summary.missing).toEqual([]);
  });
});

describe("head-to-head report", () => {
  it("renders the decision, arms, paired table and not-run arms", () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      eligiblePair(index + 1, false, index < 6),
    ).flat();
    const summary = replay([{ source: "rows.json", value: rows }]);
    const markdown = renderHeadToHeadReport({
      decision: summary.decision,
      arms: [
        { armId: "myco", trials: rows.filter((row) => row.armId === "myco") },
        { armId: "hcu+shell", trials: rows.filter((row) => row.armId === "hcu+shell") },
      ],
      notRun: [{ armId: "orgo", blocker: "account + card" }],
      evidence: ["rows.json"],
      generatedAt: "2026-11-22T00:00:00.000Z",
    });
    expect(markdown).toContain("**A-stands**");
    expect(markdown).toContain("| 1 | silent-drop | no | yes |");
    expect(markdown).toContain("| orgo | account + card |");
    expect(markdown).toContain("does not pool prompt variants");
  });

  it("escapes pipes in artifact values", () => {
    const rows = eligiblePair(1, false, true).map((row) => ({
      ...row,
      faultClass: "a|b",
    }));
    const summary = replay([{ source: "rows.json", value: rows }]);
    const markdown = renderHeadToHeadReport({
      decision: summary.decision,
      arms: [{ armId: "myco", trials: rows.filter((row) => row.armId === "myco") }],
    });
    expect(markdown).toContain("a\\|b");
  });

  it("renders a refused decision as a result, not a failure", () => {
    const summary = replay([{ source: "accounting.json", value: c1Accounting }]);
    const markdown = renderHeadToHeadReport({
      decision: summary.decision,
      arms: [],
    });
    expect(markdown).toContain("**refused**");
    expect(markdown).toContain("A `refused` decision is a result");
  });
});
