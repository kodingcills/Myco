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
import { classifyFormat, codeHasDateToken } from "../../src/gate/xlsx-document.ts";
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

describe("T2: a date token outside the first section of a format code", () => {
  // Verbatim from the verdict's repro.
  const t2 = loWith({
    [STYLES]: editOnce(loText(STYLES), 'formatCode="General"', 'formatCode="General;d"'),
  });

  it("verbatim: General;d makes every qty cell a date to the grader; the gate refuses", async () => {
    expect(graderOn(t2)).toBe("fail");
    await expectRefused(t2, "XLSX_NUMFMT_UNSUPPORTED");
  });

  it.each(["0;[Red]yyyy", "General;General;d", "0;0;0;yy", "#,##0;-#,##0;D", "0;&quot;x&quot;d"])(
    "variant %s: the grader is fooled, the gate refuses",
    async (code) => {
      const bytes = loWith({
        [STYLES]: editOnce(loText(STYLES), 'formatCode="General"', `formatCode="${code}"`),
      });
      expect(graderOn(bytes)).toBe("fail");
      await expectRefused(bytes, "XLSX_NUMFMT_UNSUPPORTED");
    },
  );

  it("a code whose sections agree is still read: verified, and the grader passes", async () => {
    // A second section whose only d is quoted: both readings say "not a date".
    const bytes = loWith({
      [STYLES]: editOnce(
        loText(STYLES),
        'formatCode="General"',
        'formatCode="General;&quot;d&quot;"',
      ),
    });
    expect(graderOn(bytes)).toBe("pass");
    expect((await gateOn(bytes)).verdict).toBe("verified");
  });

  it("codeHasDateToken reads every section, outside quotes, escapes and brackets", () => {
    for (const code of ["General;d", "0;[Red]yyyy", "0;0;0;y", "D", "[h]:mm;yy"])
      expect([code, codeHasDateToken(code)]).toEqual([code, true]);
    for (const code of ["General", "0;-0", '0;"d"', "0;\\d", "0;[$-409]0", "h:mm;[Red]h", "@"])
      expect([code, codeHasDateToken(code)]).toEqual([code, false]);
  });

  it("every built-in format the gate renders: its date class agrees with ECMA-376's date ids", () => {
    const ecmaDateIds = new Set([
      14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58,
    ]);
    const builtins: Record<number, string> = {
      0: "General",
      1: "0",
      2: "0.00",
      3: "#,##0",
      4: "#,##0.00",
      9: "0%",
      10: "0.00%",
      11: "0.00E+00",
      12: "# ?/?",
      13: "# ??/??",
      14: "mm-dd-yy",
      15: "d-mmm-yy",
      16: "d-mmm",
      17: "mmm-yy",
      18: "h:mm AM/PM",
      19: "h:mm:ss AM/PM",
      20: "h:mm",
      21: "h:mm:ss",
      22: "m/d/yy h:mm",
      45: "mm:ss",
      46: "[h]:mm:ss",
      47: "mmss.0",
      48: "##0.0E+0",
      49: "@",
    };
    for (const [id, code] of Object.entries(builtins))
      expect([id, classifyFormat(code).kind === "date"]).toEqual([id, ecmaDateIds.has(Number(id))]);
  });
});
