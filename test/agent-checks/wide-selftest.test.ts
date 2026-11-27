/**
 * Track C, #610 item 1 (S1 of #590's final verdict): R5's bound-task self-test now draws
 * documents with two errors, out-of-grammar wrong values, and inserted and deleted rows.
 *
 * Before, every drawn document carried one error of one shape, so a check that answered
 * honestly on single-error documents could say `verified` to anything else and still pass R5
 * (the verifier's A3 to A6). Each check below is honest everywhere except on one kind of
 * document the single-error draw never produced. Each was accepted by the single-error
 * self-test and lied on a real document; each is now refused.
 *
 * Every check embeds the bound task's pristine fixture (`errorCountingPrelude`), so it knows
 * exactly which errors a document carries: the strongest form of the attack.
 *
 * What remains (docs §5): a check can still lie on a document unlike anything drawn (three or
 * more errors, for one; see `known-limit.test.ts`). The signal stays advisory and is refused
 * as evidence.
 */
import { afterAll, describe, expect, it } from "vitest";
import { agentCheckSelfTestCases } from "../../src/agent-checks/check.ts";
import {
  CALC_ERROR_PAIRS,
  CALC_ERRORS,
  CALC_ODD_VALUES,
  type CalcError,
  calcCases,
} from "../../src/oracle-selftest/subjects.ts";
import type { SavedDocument } from "../../src/oracle-selftest/types.ts";
import { cleanupPlugins, SPEC, TASK } from "./helpers.ts";
import {
  ATTACKS,
  type Attack,
  COL,
  exactRows,
  fixture,
  ORIGINAL,
  refusedNow,
  render,
  SINGLE,
  T,
  targetRow,
} from "./wide-attacks.ts";

afterAll(cleanupPlugins);

describe("#610 item 1: checks that recognise only single-error documents are refused", () => {
  for (const name of ["A3", "A6", "A8"]) {
    const a = ATTACKS[name] as Attack;
    it(
      `${name}, lies on ${a.what}: accepted by the single-error self-test; refused now`,
      () => refusedNow(a),
      T,
    );
  }
});

// ---------------------------------------------------------------------------
// What every case carries (no sandbox): the classifier below reads a document the way the
// error-counting checks do, and names the single errors in it.
// ---------------------------------------------------------------------------

const text = (d: SavedDocument) => Buffer.from(d.bytes as Uint8Array).toString("utf8");

/** The single errors a bound-task document carries (naive comma split: no quoted cells). */
function errorsOf(csv: string): Set<CalcError> {
  const rows = csv
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const fx = new Map(fixture.rows.map((r) => [r[0], r]));
  const keys = new Set(rows.slice(1).map((r) => r[0]));
  const out = new Set<CalcError>();
  const tv = targetRow(rows)?.[COL];
  if (tv !== SPEC.newValue && tv !== ORIGINAL) out.add("wrong-value");
  for (const r of rows.slice(1)) {
    const f = fx.get(r[0] as string);
    if (f === undefined) {
      out.add("row-insert");
      continue;
    }
    for (let j = 1; j < f.length; j++) {
      if (r[0] === SPEC.rowKey && j === COL) continue;
      if (r[j] !== f[j]) out.add(r[j] === SPEC.newValue ? "wrong-target" : "cell");
    }
  }
  if (fixture.rows.some((r) => !keys.has(r[0]))) out.add("row-delete");
  return out;
}

const ownCases = () => agentCheckSelfTestCases("calc-record-edit", TASK).slice(0, 3);
const WIDE = CALC_ERROR_PAIRS.length + 2 + CALC_ODD_VALUES.length;

describe("#610 item 1: every bound-task case carries the wider drawn corruptions", () => {
  const cases = [...ownCases(), ...ownCases()];

  it("ten two-error documents (every pair), one per pair, each carrying exactly that pair", () => {
    expect(CALC_ERROR_PAIRS.length).toBe(10);
    for (const c of cases) {
      const wide = c.corruptions.slice(SINGLE.length);
      expect(wide.length).toBe(WIDE);
      const pairs = wide.slice(0, CALC_ERROR_PAIRS.length);
      pairs.forEach((x, k) => {
        const pair = CALC_ERROR_PAIRS[k] as readonly [CalcError, CalcError];
        expect([...errorsOf(text(x.doc))].sort(), pair.join("+")).toEqual([...pair].sort());
        const cls = pair.includes("wrong-value")
          ? "wrong-value"
          : pair.includes("wrong-target")
            ? "wrong-target"
            : "collateral";
        expect(x.cls, pair.join("+")).toBe(cls);
      });
    }
  });

  it("a document with only an inserted row and one with only a deleted row (collateral)", () => {
    for (const c of cases) {
      const [ins, del] = c.corruptions.slice(SINGLE.length + CALC_ERROR_PAIRS.length);
      expect([ins?.cls, [...errorsOf(text(ins?.doc as SavedDocument))]]).toEqual([
        "collateral",
        ["row-insert"],
      ]);
      expect([del?.cls, [...errorsOf(text(del?.doc as SavedDocument))]]).toEqual([
        "collateral",
        ["row-delete"],
      ]);
      // The deleted row is never the target's, so the edit itself is intact.
      expect(text(del?.doc as SavedDocument)).toContain(`${SPEC.rowKey},`);
    }
  });

  it("a wrong value of each out-of-grammar shape: long, quoted, space-edged, large negative", () => {
    for (const c of cases) {
      const odd = c.corruptions.slice(SINGLE.length + CALC_ERROR_PAIRS.length + 2);
      expect(odd.map((x) => x.cls)).toEqual(CALC_ODD_VALUES.map(() => "wrong-value"));
      // The target cell as written: the line's text between the cells before and after it.
      const raw = (d: SavedDocument) => {
        const line = text(d)
          .split("\n")
          .find((l) => l.startsWith(`${SPEC.rowKey},`)) as string;
        const parts = line.split(",");
        return parts.slice(COL, parts.length - (fixture.header.length - 1 - COL)).join(",");
      };
      const [long, quoted, spaced, negative] = odd.map((x) => raw(x.doc)) as string[];
      expect(long?.length).toBeGreaterThan(64);
      expect(quoted).toMatch(/^".*"$/);
      expect(spaced).toMatch(/^\s|\s$/);
      expect(spaced?.trim()).not.toBe(SPEC.newValue);
      expect(Number(negative)).toBeLessThanOrEqual(-20000);
      // Everything outside the target is untouched: one error per document.
      for (const x of odd) {
        const lines = text(x.doc).split("\n");
        const exact = render(exactRows).split("\n");
        expect(lines.filter((l, i) => l !== exact[i]).length).toBe(1);
      }
    }
  });

  it("drawn afresh: no two cases share a wide document", () => {
    for (let k = 0; k < WIDE; k++) {
      const docs = cases.map((c) => text(c.corruptions[SINGLE.length + k]?.doc as SavedDocument));
      expect(new Set(docs).size, `wide corruption ${k}`).toBeGreaterThan(1);
    }
  });

  it("the random cases carry them too, and the public (undrawn) cases do not", () => {
    const random = agentCheckSelfTestCases("calc-record-edit", TASK).slice(3);
    for (const c of random) expect(c.corruptions.length).toBe(SINGLE.length + WIDE);
    for (const c of calcCases()) expect(c.corruptions.map((x) => x.cls)).toEqual(SINGLE);
  });

  it("the error vocabulary is what the docs name", () => {
    expect(CALC_ERRORS).toEqual([
      "wrong-value",
      "wrong-target",
      "cell",
      "row-insert",
      "row-delete",
    ]);
    expect(CALC_ODD_VALUES).toEqual(["long", "quoted", "space-edged", "large-negative"]);
  });
});
