import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport } from "../../scripts/c1-arm-report.ts";

/** A minimal ledger in the shape the sweep writes. */
function ledgerAt(entries: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-arm-report-"));
  writeFileSync(join(dir, "accounting.json"), JSON.stringify({ c1: entries, c2: {} }));
  return dir;
}

function scoredRow(over: Record<string, unknown> = {}) {
  return {
    index: 0,
    verdict: "refuted",
    verdictReason: "modified",
    falseSuccess: false,
    cost: 0.1,
    ...over,
  };
}

describe("C1 arm report", () => {
  it("counts committed spend across every status, not just scored rows", () => {
    // The error this guards: an omitted trial made real API calls before it
    // died, so reporting scored-only under-reports by exactly the amount that
    // matters when a cap is being approached.
    const dir = ledgerAt({
      "0": { status: "scored", micros: 100_000, row: scoredRow() },
      "1": { status: "omitted", micros: 376_800, reason: "trial-interrupted" },
      "2": { status: "reserved", micros: 376_800 },
    });
    const r = buildReport(dir);
    expect(r.scoredUsd).toBeCloseTo(0.1, 6);
    expect(r.omittedUsd).toBeCloseTo(0.3768, 6);
    expect(r.reservedUsd).toBeCloseTo(0.3768, 6);
    expect(r.committedUsd).toBeCloseTo(0.8536, 6);
    expect(r.committedUsd).toBeGreaterThan(r.scoredUsd);
  });

  it("reports the denominator separately from the manifest size", () => {
    const dir = ledgerAt({
      "0": { status: "scored", micros: 1_000, row: scoredRow() },
      "1": { status: "omitted", micros: 0, reason: "driver-unreachable" },
      "2": { status: "omitted", micros: 0, reason: "driver-unreachable" },
    });
    const r = buildReport(dir);
    expect(r.scored).toBe(1);
    expect(r.omitted).toBe(2);
    expect(r.trialsInManifest).toBe(3);
    // The rate is over rows produced, never over the manifest.
    expect(r.refutedRate).toBeCloseTo(1, 6);
    expect(r.exclusionReasons).toEqual({ "driver-unreachable": 2 });
  });

  it("counts a null falseSuccess as unknown, not as a pass", () => {
    // null means the independent audit never ran, which is not evidence of
    // success in either direction.
    const dir = ledgerAt({
      "0": { status: "scored", micros: 1, row: scoredRow({ falseSuccess: null }) },
      "1": { status: "scored", micros: 1, row: scoredRow({ index: 1, falseSuccess: true }) },
    });
    const r = buildReport(dir);
    expect(r.falseSuccesses).toBe(1);
    expect(r.falseSuccessUnknown).toBe(1);
  });

  it("breaks reasons out individually rather than as one number", () => {
    const dir = ledgerAt({
      "0": { status: "scored", micros: 1, row: scoredRow({ verdictReason: "modified" }) },
      "1": {
        status: "scored",
        micros: 1,
        row: scoredRow({ index: 1, verdictReason: "step-budget" }),
      },
      "2": {
        status: "scored",
        micros: 1,
        row: scoredRow({ index: 2, verdictReason: "persisted-mismatch" }),
      },
    });
    expect(buildReport(dir).reasons).toEqual({
      modified: 1,
      "step-budget": 1,
      "persisted-mismatch": 1,
    });
  });
});
