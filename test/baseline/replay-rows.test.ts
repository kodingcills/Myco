import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  exitCodeFor,
  matchesRecorded,
  type ReplayResult,
  replayDirectory,
  replayRow,
  summarizeFailures,
} from "../../scripts/replay-arm-rows.ts";
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
    transcript: { actions: [], claims: [], deliveries: [] },
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
    // matched must depend on the REAL falseSuccess computation, not just the
    // replayed status. These three rows have independentValuePresent
    // true/false/null against a stored falseSuccess of false, so exactly one of
    // them should agree:
    //   present=true  -> falseSuccess false  -> agrees -> matched
    //   present=false -> falseSuccess true   -> disagrees -> not matched
    //   present=null  -> falseSuccess null   -> disagrees -> not matched
    // Dropping independentValuePresent from that call (so it reads null for all
    // three) makes present=true stop agreeing, which is what these pin.
    expect(verifiedPresent.matched).toBe(true);
    expect(verifiedAbsent.matched).toBe(false);
    // The null case: an unaudited row. Its stored falseSuccess is false while
    // the recomputed value is null, so it must NOT read as matched - null means
    // the audit never ran, which is not evidence of success in either direction.
    expect(verifiedUnknown.matched).toBe(false);
    // A duplicate `lookalike` fixture (identical overrides to verifiedAbsent) and
    // a direct falseSuccess(...) call were removed here: the first re-replayed the
    // same row, and the second re-tested src/ rather than the replay. Both were
    // proven redundant - replacing either with a tautology left the suite green.
    // The three fixtures above carry the load through replayRow.
  });

  it("detects a cost that does not match the raw usage records", () => {
    const r = replayRow(row({ cost: 0.5 }));
    expect(r.costDelta).toBeCloseTo(-0.499, 3);
  });
});

describe("replay row ordering", () => {
  it("replayDirectory returns rows in numeric order, not lexical", () => {
    // Drives replayDirectory end to end rather than the comparator alone.
    // Calling compareRowFiles directly passes even when replayDirectory stops
    // sorting - the comparator exists and works, but nothing uses it. Found by
    // deleting the .sort() call and watching this test still pass.
    const dir = mkdtempSync(join(tmpdir(), "myco-replay-order-"));
    for (const name of ["10.json", "2.json", "1.json"]) {
      writeFileSync(
        join(dir, name),
        JSON.stringify(
          row({ index: Number.parseInt(name, 10), verdictReason: "modified" }) as never,
        ),
      );
    }
    expect(replayDirectory(dir).map((r) => r.index)).toEqual([1, 2, 10]);
  });
});

describe("the match rule has three independent halves", () => {
  // Asserted directly because no single fixture can isolate them: a row that
  // disagrees on status will also disagree on reason, so a status-only fixture
  // leaves the reason and falseSuccess halves untested. The verifier removed the
  // reason check from the conjunction and the suite stayed green - this is what
  // makes that mutation fail.
  const ok = { status: "refuted", reason: "modified", falseSuccess: false };

  it("accepts an exact match", () => {
    expect(matchesRecorded("refuted", "modified", false, ok)).toBe(true);
  });

  it("rejects a reason that differs while the status matches", () => {
    expect(matchesRecorded("refuted", "step-budget", false, ok)).toBe(false);
  });

  it("rejects a status that differs while the reason matches", () => {
    expect(matchesRecorded("verified", "modified", false, ok)).toBe(false);
  });

  it("rejects a falseSuccess that differs while status and reason match", () => {
    expect(matchesRecorded("refuted", "modified", true, ok)).toBe(false);
  });

  it("accepts a verified row that genuinely has no false success", () => {
    // The positive case for the verified arm. Without it, dropping
    // independentValuePresent from the falseSuccess call (so it reads the
    // replayed status with a null value) passes the suite AND the live replay,
    // because every verified fixture only ever asserted matched:false. That
    // mutation destroys verified-arm scoring outright - the exact property M1
    // rests on - and nothing caught it.
    expect(
      matchesRecorded("verified", "persisted-match", false, {
        status: "verified",
        reason: "persisted-match",
        falseSuccess: false,
      }),
    ).toBe(true);

    // ...and the same row WITH a false success must not read as matched.
    expect(
      matchesRecorded("verified", "persisted-match", true, {
        status: "verified",
        reason: "persisted-match",
        falseSuccess: true,
      }),
    ).toBe(true);
    expect(
      matchesRecorded("verified", "persisted-match", false, {
        status: "verified",
        reason: "persisted-match",
        falseSuccess: true,
      }),
    ).toBe(false);
  });

  it("treats null and false as different, so an unaudited row is not a pass", () => {
    expect(matchesRecorded("refuted", "modified", null, ok)).toBe(false);
    expect(matchesRecorded("refuted", "modified", null, { ...ok, falseSuccess: null })).toBe(true);
  });
});

describe("CLI exit contract", () => {
  // Extracted because the check was inline at module scope and no test drove it:
  // a mutation dropping the drift clause left all 832 tests green while the CLI
  // printed "cost drift" and exited 0. Drift is its own failure - the stored
  // cost has diverged from the usage records, so reported spend is wrong even
  // when every verdict reproduces.
  it("derives the counts from the results, not from the caller", () => {
    // Pins what FEEDS exitCodeFor. Without this, emptying the drift filter left
    // every test green and the gate silently dead - the arithmetic was covered
    // but nothing checked the inputs.
    const ok = { matched: true, costDelta: 0 } as ReplayResult;
    const failedRow = { matched: false, costDelta: 0 } as ReplayResult;
    const driftedRow = { matched: true, costDelta: -0.05 } as ReplayResult;
    expect(summarizeFailures([])).toEqual({ failed: 0, drifting: 0 });
    expect(summarizeFailures([ok])).toEqual({ failed: 0, drifting: 0 });
    expect(summarizeFailures([failedRow, ok])).toEqual({ failed: 1, drifting: 0 });
    expect(summarizeFailures([driftedRow, ok])).toEqual({ failed: 0, drifting: 1 });
    expect(summarizeFailures([failedRow, driftedRow])).toEqual({ failed: 1, drifting: 1 });
    // ...and the counts reach the exit code.
    const both = summarizeFailures([failedRow, driftedRow]);
    expect(exitCodeFor(both.failed, both.drifting)).toBe(1);
  });

  it("exits 0 only when every row reproduces and no cost has drifted", () => {
    expect(exitCodeFor(0, 0)).toBe(0);
  });

  it("exits 1 when a row fails to reproduce, even with no drift", () => {
    expect(exitCodeFor(1, 0)).toBe(1);
  });

  it("exits 1 on cost drift alone, with every row reproduced", () => {
    expect(exitCodeFor(0, 1)).toBe(1);
  });

  it("exits 1 when both fail", () => {
    expect(exitCodeFor(2, 3)).toBe(1);
  });
});
