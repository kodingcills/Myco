/**
 * Round 2 of the gate-integrity PR (verdict comment 7204800200, D2): three more shapes,
 * built from the REAL LibreOffice fixture, that the gate verified while the independent
 * grader failed them. They sit in attributes and value semantics, which the element-tree pin
 * does not cover. Each row is the verifier's edit verbatim (its repro), run through the real
 * read path (`gateOn`) and the grader (`graderOn`): the grader's status proves the shape is
 * live, and the gate must refuse it.
 *
 *  - T3: an attribute whose NAME ends in `date1904` after `-` or `.` on `<workbookPr>`. The
 *    grader's `\bdate1904` reads it as the 1904 date system; the gate read only the exact
 *    attribute. Closed by the per-path attribute allowlist (`LO_ATTRS`, xlsx-tree.ts).
 *  - T2: a number-format code with a date token outside its first section. The grader tests
 *    the whole code; the gate classified only the first section. Closed by refusing any
 *    style whose date-ness the two readings disagree on (`readStyles`, xlsx-document.ts).
 *  - T1: an empty `<v></v>` in a numeric cell. The grader reads Number("") = 0; the gate read
 *    an empty cell. Closed by refusing an empty or whitespace-only `<v>` in every cell type.
 *
 * Each probe has a named mutant it kills (listed in the PR's round-3 comment); the mutants
 * were run by hand, one at a time.
 */
import { describe, expect, it } from "vitest";
import {
  editOnce,
  gateOn,
  graderOn,
  LO_BASE,
  loText,
  loWith,
  SHEET1,
  STYLES,
  WORKBOOK,
} from "./xlsx-lo-mutate.ts";
import { writerBytes } from "./xlsx-writer-files.ts";

async function expectRefused(bytes: Uint8Array, code: string) {
  const gate = await gateOn(bytes);
  expect(gate.verdict).toBe("uncertain");
  expect(gate.reasonCodes).toEqual(["STATE_CORRUPT"]);
  expect(gate.reasons.join(" ")).toContain(code);
}

describe("control: the unmodified fixture", () => {
  it("verifies, and the grader passes it", async () => {
    const bytes = writerBytes(LO_BASE);
    expect((await gateOn(bytes)).verdict).toBe("verified");
    expect(graderOn(bytes)).toBe("pass");
  });
});

describe("T3: an attribute name ending in date1904 (the grader's \\bdate1904)", () => {
  // Verbatim from the verdict's repro.
  const t3 = loWith({
    [WORKBOOK]: editOnce(
      loText(WORKBOOK),
      "<workbookPr backupFile",
      '<workbookPr x-date1904="true" backupFile',
    ),
  });

  it("verbatim: x-date1904 flips the grader to 1904; the gate refuses", async () => {
    expect(graderOn(t3)).toBe("fail");
    await expectRefused(t3, "XLSX_TREE_ATTRIBUTE");
  });

  it.each(['a.date1904="1"', 'x-date1904="1"', 'x.date1904="true"', 'b-c.date1904="true"'])(
    "variant %s: the grader is fooled, the gate refuses",
    async (attr) => {
      const bytes = loWith({
        [WORKBOOK]: editOnce(
          loText(WORKBOOK),
          "<workbookPr backupFile",
          `<workbookPr ${attr} backupFile`,
        ),
      });
      expect(graderOn(bytes)).toBe("fail");
      await expectRefused(bytes, "XLSX_TREE_ATTRIBUTE");
    },
  );

  it("the exact attribute is still read (both judges agree on 1904): never verified", async () => {
    // date1904 itself is allowed and interpreted: the date column then reads as other days
    // on both sides, so the edit is collateral to both.
    const bytes = loWith({
      [WORKBOOK]: editOnce(
        loText(WORKBOOK),
        "<workbookPr backupFile",
        '<workbookPr date1904="true" backupFile',
      ),
    });
    expect(graderOn(bytes)).toBe("fail");
    expect((await gateOn(bytes)).verdict).toBe("refuted");
  });

  it("an unknown attribute anywhere in a pinned part is refused, not ignored", async () => {
    for (const [part, from, to] of [
      [SHEET1, '<dimension ref="A1:E76"/>', '<dimension ref="A1:E76" x="1"/>'],
      [STYLES, "<cellXfs ", '<cellXfs x="1" '],
      [WORKBOOK, "<sheets>", '<sheets x="1">'],
    ] as const) {
      await expectRefused(
        loWith({ [part]: editOnce(loText(part), from, to) }),
        "XLSX_TREE_ATTRIBUTE",
      );
    }
  });
});
