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
import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { agentCheckSelfTestCases } from "../../src/agent-checks/check.ts";
import {
  CALC_ERROR_PAIRS,
  CALC_ERRORS,
  CALC_ODD_VALUES,
  type CalcError,
  calcCases,
  calcCasesFor,
} from "../../src/oracle-selftest/subjects.ts";
import type { SavedDocument, SelfTestCase } from "../../src/oracle-selftest/types.ts";
import { cleanupPlugins, SEED, SPEC, TASK } from "./helpers.ts";
import {
  ATTACKS,
  type Attack,
  COL,
  exactRows,
  fixture,
  refusedNow,
  render,
  SINGLE,
  T,
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
function errorsOf(csv: string, spec: typeof SPEC = SPEC): Set<CalcError> {
  const rows = csv
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const fx = new Map(fixture.rows.map((r) => [r[0], r]));
  const keys = new Set(rows.slice(1).map((r) => r[0]));
  const out = new Set<CalcError>();
  const col = fixture.header.indexOf(spec.column);
  const original = fx.get(spec.rowKey)?.[col];
  const tv = rows.find((r, i) => i > 0 && r[0] === spec.rowKey)?.[col];
  if (tv !== spec.newValue && tv !== original) out.add("wrong-value");
  for (const r of rows.slice(1)) {
    const f = fx.get(r[0] as string);
    if (f === undefined) {
      out.add("row-insert");
      continue;
    }
    for (let j = 1; j < f.length; j++) {
      if (r[0] === spec.rowKey && j === col) continue;
      if (r[j] !== f[j]) out.add(r[j] === spec.newValue ? "wrong-target" : "cell");
    }
  }
  if (fixture.rows.some((r) => !keys.has(r[0]))) out.add("row-delete");
  return out;
}

/** The bound-task case that carries the wider corruptions: the first of each proposal. */
const wideCase = () =>
  agentCheckSelfTestCases("calc-record-edit", TASK)[0] as SelfTestCase<unknown>;
const WIDE = CALC_ERROR_PAIRS.length + 2 + CALC_ODD_VALUES.length;

describe("#610 item 1: every proposal's self-test carries the wider drawn corruptions", () => {
  const cases = Array.from({ length: 6 }, wideCase);

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

  it("every drawn pair document carries exactly its pair, no fewer and no more (1000 draws)", () => {
    // Rare draws are where an error goes missing or a third appears: a deletion that hits the
    // moved cell's row or a changed cell's row (about once in 100 draws with 198 rows) leaves
    // one error; a changed cell that takes the new value adds a wrong target.
    for (let n = 0; n < 1000; n++) {
      const [c] = calcCasesFor([SPEC], TASK.fileName, randomInt, true);
      CALC_ERROR_PAIRS.forEach((pair, k) => {
        const doc = c?.corruptions[SINGLE.length + k]?.doc as SavedDocument;
        const got = [...errorsOf(text(doc))].sort();
        // Only on a mismatch, so 10,000 passing checks stay cheap.
        if (got.join("+") !== [...pair].sort().join("+"))
          expect(got, pair.join("+")).toEqual([...pair].sort());
      });
    }
  }, 60_000);

  it("no third error even when the new value is common in the sheet (1000 draws)", () => {
    // The sheet's most common name as the new value of another row's name: a changed cell
    // drawn from the sheet's own cells hits it about once in 125 cases, which would add a
    // wrong target to the pair.
    const counts = new Map<string, number>();
    for (const r of fixture.rows) counts.set(r[1] as string, (counts.get(r[1] as string) ?? 0) + 1);
    const [common] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];
    const row = fixture.rows.find((r) => r[1] !== common) as string[];
    const spec = { fixtureSeed: SEED, rowKey: row[0] as string, column: "name", newValue: common };
    for (let n = 0; n < 1000; n++) {
      const [c] = calcCasesFor([spec], TASK.fileName, randomInt, true);
      CALC_ERROR_PAIRS.forEach((pair, k) => {
        const doc = c?.corruptions[SINGLE.length + k]?.doc as SavedDocument;
        const got = [...errorsOf(text(doc), spec)].sort();
        if (got.join("+") !== [...pair].sort().join("+"))
          expect(got, pair.join("+")).toEqual([...pair].sort());
      });
    }
  }, 60_000);

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

  it("one bound-task case per proposal carries them; the other cases and the public ones do not", () => {
    for (let n = 0; n < 4; n++) {
      const cases = agentCheckSelfTestCases("calc-record-edit", TASK);
      expect(cases.map((c) => c.corruptions.length)).toEqual([
        SINGLE.length + WIDE,
        ...cases.slice(1).map(() => SINGLE.length),
      ]);
      expect([cases[0]?.intent, cases[0]?.correct.fileName]).toEqual([SPEC, TASK.fileName]);
    }
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
