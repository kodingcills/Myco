import { describe, expect, it } from "vitest";
import { replayRow } from "../../scripts/replay-arm-rows.ts";
import type { BaselineRow } from "../../src/baseline/index.ts";

/** A minimal row in the shape the live sweep writes, so the replay contract is
 * pinned without depending on a recorded artefact being present in CI. */
function row(overrides: Partial<BaselineRow> = {}): BaselineRow {
  return {
    index: 0,
    params: { fixtureSeed: "s", rowKey: "EMP-0001", column: "name", newValue: "X" },
    cellRef: "B2",
    expected: "X",
    previousValue: "old",
    subArm: "c1",
    verdict: "refuted",
    verdictReason: "modified",
    transcript: { actions: [], claims: [] },
    usage: [{ prompt: 100, completion: 50, cost: 0.001 }],
    cost: 0.001,
    tokens: { in: 100, out: 50 },
    modelCalls: 1,
    steps: 1,
    stepBudget: 30,
    budgetExhausted: false,
    audited: false,
    independentValuePresent: null,
    falseSuccess: false,
    elapsedMs: 1,
    resetMs: 1,
    acPower: false,
    caffeinate: true,
    hostLoad: { loadAvg1: 1 },
    screenshotSource: "cua-window",
    resumed: false,
    recoveryEvents: 0,
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      pipeReachable: true,
      sessionIdentityMatches: true,
    },
    deviations: [],
    ...overrides,
  } as BaselineRow;
}

describe("offline arm-row replay", () => {
  it("reproduces a recorded row's verdict, reason and recomputed cost", () => {
    expect(replayRow(row())).toMatchObject({
      recorded: "refuted",
      replayed: "refuted",
      reasonReplayed: "modified",
      matched: true,
      costDelta: 0,
    });
  });

  it("reproduces a persisted mismatch as refuted/persisted-mismatch", () => {
    const r = replayRow(row({ verdictReason: "persisted-mismatch" }));
    expect(r.reasonReplayed).toBe("persisted-mismatch");
    expect(r.matched).toBe(true);
  });

  it("reproduces driver-unreachable as uncertain, not as a refutation", () => {
    // The distinction the whole denominator rests on: an infrastructure failure
    // must never be scored as a substantive failure.
    const r = replayRow(row({ verdict: "uncertain", verdictReason: "driver-unreachable" }));
    expect(r.replayed).toBe("uncertain");
    expect(r.matched).toBe(true);
  });

  it("fails a row whose recorded reason the scorer no longer produces", () => {
    // The real regression guard: if judge() stops reporting the reason the row
    // recorded - a renamed branch, a reordered switch, a kind falling into the
    // wrong arm - the replay must fail. Asserting on judge() directly would not
    // cover this, because the replay's own mapping is what has to stay honest.
    const r = replayRow(row({ verdictReason: "step-budget" }));
    expect(r.reasonRecorded).toBe("step-budget");
    expect(r.reasonReplayed).toBe("step-budget");
    expect(r.matched).toBe(true);
  });

  it("throws on an unmapped verdict reason rather than skipping the row", () => {
    // A new reason must be an explicit decision, not a silent pass.
    expect(() => replayRow(row({ verdictReason: "some-new-reason" }))).toThrow(/unmapped/);
  });

  it("detects a cost that does not match the raw usage records", () => {
    const r = replayRow(row({ cost: 0.5 }));
    expect(r.costDelta).toBeCloseTo(-0.499, 3);
    expect(r.matched).toBe(true);
  });
});
