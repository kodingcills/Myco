/**
 * The shared capability-analysis guard (`src/capability/analysis-guard.ts`, GitHub #652).
 *
 *  G1 pending rulings: never "shown" while any recognised pending list is non-empty; a
 *     missing or malformed list fails closed; code LEAD_RULING_PENDING, exit code 3.
 *  G2 simulated rows: a row counts only if `simulated` is absent or exactly `false`.
 *  G3 pre-registration hash: a pack is refused unless its recorded hash and its frozen
 *     commit's pre-registration both equal the pre-registration's hash; exit code 1.
 *  G4 the guard imports nothing (in particular nothing from src/gate).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ANALYSIS_GUARD_PATH,
  type CapabilityGuardInput,
  GUARD_EXIT_LEAD_RULING_PENDING,
  GUARD_EXIT_OK,
  GUARD_EXIT_REFUSED,
  guardCapabilityAnalysis,
  guardedVerdict,
  LEAD_RULING_PENDING,
  PREREG_HASH_MISMATCH,
  pendingRulings,
  rowCounts,
  SIMULATED,
} from "../../src/capability/analysis-guard.ts";

const H = "a".repeat(64);
const OTHER = "b".repeat(64);
const clean = (over: Partial<CapabilityGuardInput> = {}): CapabilityGuardInput => ({
  prereg: { leadRulingPending: [] },
  preregHash: H,
  packs: [{ recordedHash: H, committedHash: H }],
  rows: [{ simulated: false }, {}],
  ...over,
});

describe("a clean input", () => {
  it("may show, with no reasons and exit 0", () => {
    const g = guardCapabilityAnalysis(clean());
    expect(g).toMatchObject({ refused: false, mayShow: true, code: "OK", exitCode: GUARD_EXIT_OK });
    expect(g.reasons).toEqual([]);
    expect(guardedVerdict(g, true)).toBe("shown");
    expect(guardedVerdict(g, false)).toBe("not-shown");
  });
});

describe("G1: pending rulings", () => {
  for (const field of ["leadRulingPending", "leadRulingsPending", "pendingRulings", "pending"])
    it(`a non-empty ${field} blocks "shown" with LEAD_RULING_PENDING and exit 3`, () => {
      const g = guardCapabilityAnalysis(clean({ prereg: { [field]: ["margin"] } }));
      expect(g.mayShow).toBe(false);
      expect(g.refused).toBe(false);
      expect(g.code).toBe(LEAD_RULING_PENDING);
      expect(g.exitCode).toBe(GUARD_EXIT_LEAD_RULING_PENDING);
      expect(g.exitCode).not.toBe(0);
      expect(g.reasons).toEqual(["LEAD_RULING_PENDING: margin"]);
      expect(guardedVerdict(g, true)).toBe("not-shown");
    });

  it("reads { field, reason } items (track K's shape) by field", () => {
    expect(pendingRulings({ pending: [{ field: "stepBudget", reason: "r" }] })).toEqual([
      "stepBudget",
    ]);
  });

  it("an empty list in one field does not hide a non-empty list in another", () => {
    expect(pendingRulings({ leadRulingPending: [], pending: ["x"] })).toEqual(["x"]);
  });

  it("fails closed: no pending list at all is pending", () => {
    const g = guardCapabilityAnalysis(clean({ prereg: { status: "frozen" } }));
    expect(g.code).toBe(LEAD_RULING_PENDING);
    expect(g.reasons[0]).toMatch(/^LEAD_RULING_PENDING: PENDING_LIST_MISSING/);
    expect(guardCapabilityAnalysis(clean({ prereg: null })).mayShow).toBe(false);
    expect(guardCapabilityAnalysis(clean({ prereg: [] })).mayShow).toBe(false);
  });

  it("fails closed: a pending list that is not an array is pending", () => {
    for (const v of ["", "none", 0, null, {}, false]) {
      const g = guardCapabilityAnalysis(clean({ prereg: { leadRulingPending: v } }));
      expect(g.mayShow, JSON.stringify(v)).toBe(false);
      expect(g.reasons[0]).toMatch(/PENDING_LIST_MALFORMED: leadRulingPending/);
    }
  });

  it("pending outranks simulated in the code, and both reasons are reported", () => {
    const g = guardCapabilityAnalysis(
      clean({ prereg: { pending: ["x"] }, rows: [{ simulated: true }] }),
    );
    expect(g.code).toBe(LEAD_RULING_PENDING);
    expect(g.reasons).toHaveLength(2);
  });
});

describe("G2: simulated rows", () => {
  it("counts a row whose simulated is absent or exactly false", () => {
    expect(rowCounts({})).toBe(true);
    expect(rowCounts({ simulated: false })).toBe(true);
  });

  for (const v of [true, "true", "false", 1, 0, null, "", [], {}])
    it(`refuses a row whose simulated is ${JSON.stringify(v)}`, () => {
      expect(rowCounts({ simulated: v })).toBe(false);
      const g = guardCapabilityAnalysis(clean({ rows: [{}, { simulated: v }] }));
      expect(g.mayShow).toBe(false);
      expect(g.code).toBe(SIMULATED);
      expect(g.simulatedRows).toEqual([1]);
      expect(g.reasons).toEqual(["SIMULATED: 1 row(s); simulated rows are never evidence"]);
      expect(g.exitCode).toBe(GUARD_EXIT_OK);
      expect(guardedVerdict(g, true)).toBe("not-shown");
    });

  it("refuses an own simulated member set to undefined, and a row that is not an object", () => {
    expect(rowCounts({ simulated: undefined })).toBe(false);
    for (const r of [null, undefined, "row", 1, [], [{ simulated: false }]])
      expect(rowCounts(r), JSON.stringify(r)).toBe(false);
  });
});

describe("G3: the pre-registration hash", () => {
  const refusedWith = (over: Partial<CapabilityGuardInput>, re: RegExp) => {
    const g = guardCapabilityAnalysis(clean(over));
    expect(g.refused).toBe(true);
    expect(g.mayShow).toBe(false);
    expect(g.code).toBe(PREREG_HASH_MISMATCH);
    expect(g.exitCode).toBe(GUARD_EXIT_REFUSED);
    expect(g.reasons.every((r) => r.startsWith("PREREG_HASH_MISMATCH: "))).toBe(true);
    expect(g.reasons.join("|")).toMatch(re);
    expect(guardedVerdict(g, true)).toBe("not-shown");
  };

  it("refuses a pack that records another hash", () =>
    refusedWith({ packs: [{ recordedHash: OTHER, committedHash: H }] }, /records another/));

  it("refuses a pack whose frozen commit holds another pre-registration, or none", () => {
    refusedWith({ packs: [{ recordedHash: H, committedHash: OTHER }] }, /frozen commit/);
    refusedWith({ packs: [{ recordedHash: H, committedHash: null }] }, /frozen commit/);
  });

  it("refuses when any one of several packs mismatches", () =>
    refusedWith(
      {
        packs: [
          { recordedHash: H, committedHash: H },
          { recordedHash: H, committedHash: OTHER },
        ],
      },
      /pack 1/,
    ));

  it("refuses with no pack at all", () => refusedWith({ packs: [] }, /no pack/));

  it("refuses a pre-registration hash that is not sha256 hex, even when everything equals it", () => {
    for (const bad of ["", "A".repeat(64), "a".repeat(63)])
      refusedWith(
        { preregHash: bad, packs: [{ recordedHash: bad, committedHash: bad }] },
        /not sha256 hex/,
      );
  });

  it("a refusal outranks pending and simulated, and reports neither", () => {
    const g = guardCapabilityAnalysis(
      clean({
        prereg: { pending: ["x"] },
        rows: [{ simulated: true }],
        packs: [{ recordedHash: OTHER, committedHash: H }],
      }),
    );
    expect(g.code).toBe(PREREG_HASH_MISMATCH);
    expect(g.reasons.some((r) => r.startsWith(LEAD_RULING_PENDING))).toBe(false);
  });
});

describe("guardedVerdict", () => {
  it("is shown only when the guard allows it and the analysis computed shown", () => {
    const ok = guardCapabilityAnalysis(clean());
    const blocked = guardCapabilityAnalysis(clean({ prereg: { pending: ["x"] } }));
    expect(guardedVerdict(ok, true)).toBe("shown");
    expect(guardedVerdict(ok, false)).toBe("not-shown");
    expect(guardedVerdict(blocked, true)).toBe("not-shown");
    expect(guardedVerdict(ok, "yes" as unknown as boolean)).toBe("not-shown");
  });

  it("the result is frozen: an analysis cannot clear a blocker", () => {
    const g = guardCapabilityAnalysis(clean({ prereg: { pending: ["x"] } }));
    expect(Object.isFrozen(g)).toBe(true);
    expect(Object.isFrozen(g.reasons)).toBe(true);
  });
});

describe("G4: the guard imports nothing", () => {
  it("has no import, export-from, dynamic import or require", () => {
    const src = readFileSync(CAPABILITY_ANALYSIS_GUARD_PATH, "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\bfrom\s+["']/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
