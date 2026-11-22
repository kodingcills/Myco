import { describe, expect, it } from "vitest";
import { replayRow } from "../../scripts/replay-arm-rows.ts";
import { type BaselineRow, falseSuccess } from "../../src/baseline/index.ts";

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

  it("reproduces a row whose reason the scorer still produces", () => {
    // Pins the observation->reason mapping: if judge() renames a branch or sends
    // a kind down the wrong arm, reasonReplayed stops matching reasonRecorded.
    const r = replayRow(row({ verdictReason: "step-budget" }));
    expect(r.reasonRecorded).toBe("step-budget");
    expect(r.reasonReplayed).toBe("step-budget");
    expect(r.matched).toBe(true);
  });

  it("reports matched:false when the recorded verdict disagrees with the observation", () => {
    // The other half of the round-trip, which nothing covered. A row that
    // RECORDS "verified" while its reason implies a refuting observation cannot
    // be reproduced, so the replay must say so rather than agreeing.
    // "modified" reconstructs a refuting observation regardless of the recorded
    // status, which is exactly the disagreement a hand-edited or mis-merged row
    // would carry.
    const r = replayRow(row({ verdict: "verified", verdictReason: "modified" }));
    expect(r.replayed).toBe("refuted");
    expect(r.recorded).toBe("verified");
    expect(r.matched).toBe(false);
  });

  it("throws on an unmapped verdict reason rather than skipping the row", () => {
    // A new reason must be an explicit decision, not a silent pass.
    expect(() => replayRow(row({ verdictReason: "some-new-reason" }))).toThrow(/unmapped/);
  });

  it("reproduces falseSuccess across the verified arm, not just the refuted one", () => {
    // This is the coverage the mutation test exposed as missing: every earlier
    // fixture was refuted, so falseSuccess short-circuited to false and could
    // be inverted or stubbed without any test noticing. falseSuccess is the
    // property M1 rests on, so all four reachable outcomes are pinned.
    const verifiedPresent = replayRow(
      row({ verdict: "verified", verdictReason: "persisted-match", independentValuePresent: true }),
    );
    const verifiedAbsent = replayRow(
      row({
        verdict: "verified",
        verdictReason: "persisted-match",
        independentValuePresent: false,
      }),
    );
    const verifiedUnknown = replayRow(
      row({ verdict: "verified", verdictReason: "persisted-match", independentValuePresent: null }),
    );
    // A persisted-match observation reproduces "verified" for all three.
    for (const r of [verifiedPresent, verifiedAbsent, verifiedUnknown]) {
      expect(r.replayed).toBe("verified");
    }
    // The values themselves are asserted through falseSuccess's own contract.
    expect(falseSuccess("verified", true)).toBe(false);
    expect(falseSuccess("verified", false)).toBe(true);
    expect(falseSuccess("verified", null)).toBe(null);
    expect(falseSuccess("refuted", false)).toBe(false);
  });

  it("detects a cost that does not match the raw usage records", () => {
    const r = replayRow(row({ cost: 0.5 }));
    expect(r.costDelta).toBeCloseTo(-0.499, 3);
  });
});
