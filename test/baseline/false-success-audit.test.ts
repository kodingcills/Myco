import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditFalseSuccess } from "../../scripts/audit-false-success.ts";
import type { BaselineRow } from "../../src/baseline/index.ts";

/**
 * TIF-219: "0 false successes" means one of two different things.
 *
 * The audit only runs when the verdict is "verified" (c1-trial.ts:91), so an arm
 * with no verified rows has no audited rows. Reporting "0 false successes" for it
 * as though it were a measured bound is the error this pins against.
 */

const row = (over: Partial<BaselineRow> = {}) =>
  ({
    index: 0,
    verdict: "refuted",
    audited: false,
    independentValuePresent: null,
    falseSuccess: false,
    ...over,
  }) as BaselineRow;

describe("false-success audit", () => {
  it("reports an arm with no verified rows as OBSERVED, not bounded", () => {
    const a = auditFalseSuccess({ "0": { row: row() }, "1": { row: row({ index: 1 }) } });
    expect(a.rows).toBe(2);
    expect(a.verified).toBe(0);
    expect(a.audited).toBe(0);
    expect(a.falseSuccesses).toBe(0);
    expect(a.bounded).toBe(false);
    // The wording matters as much as the numbers: it must not read as a bound.
    expect(a.verdict).toContain("OBSERVED");
    expect(a.verdict).toContain("NO BOUND");
  });

  it("reports zero false successes as a bound when rows were actually audited", () => {
    const a = auditFalseSuccess({
      "0": { row: row({ verdict: "verified", audited: true, independentValuePresent: true }) },
    });
    expect(a.audited).toBe(1);
    expect(a.bounded).toBe(true);
    expect(a.verdict).toContain("the bound covers the audited population only");
  });

  it("counts a real false success", () => {
    // A success was scored while the document disagreed - the thing the audit
    // exists to catch. `falseSuccess: true` with an audited row.
    const a = auditFalseSuccess({
      "0": {
        row: row({
          verdict: "verified",
          audited: true,
          independentValuePresent: false,
          falseSuccess: true,
        }),
      },
    });
    expect(a.falseSuccesses).toBe(1);
    expect(a.bounded).toBe(true);
  });

  it("skips ledger entries with no row rather than counting them", () => {
    // An omitted or reserved entry is not a row; counting it would inflate the
    // denominator, which is the error this codebase has made before.
    const a = auditFalseSuccess({
      "0": { row: row() },
      "1": {},
      "2": {},
    });
    expect(a.rows).toBe(1);
  });

  it("arm-002 is observed-and-unbounded, verified against the recorded artifact", () => {
    // The actual claim for the scorecard. Pinned so a future edit to the corpus
    // or the gate cannot silently turn "observed" into "bounded".
    const ledger = (
      JSON.parse(
        readFileSync(
          join(process.cwd(), "docs/research/experiments/c1-arm-002/accounting.json"),
          "utf8",
        ),
      ) as { c1: Record<string, { row?: BaselineRow }> }
    ).c1;
    const a = auditFalseSuccess(ledger);
    expect(a.rows).toBe(29);
    expect(a.verified).toBe(0);
    expect(a.audited).toBe(0);
    expect(a.falseSuccesses).toBe(0);
    expect(a.bounded).toBe(false);
  });
});
