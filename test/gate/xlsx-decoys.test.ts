/**
 * Round 1 of the gate-integrity PR (verdict comment 7203828539, D1): six shapes, built from
 * the REAL LibreOffice fixture, that the gate verified while the independent grader failed
 * them. Each row here is the verifier's edit verbatim, run through the real read path
 * (`gateOn`) and the grader (`graderOn`). The gate must never verify any of them.
 *
 * Two mechanisms:
 *  - zip (V6): a decoy archive in the EOCD comment, which a reader scanning back for the last
 *    EOCD signature (the grader) takes; and, more generally, bytes no entry covers;
 *  - tree (V1-V5): an in-grammar decoy nested inside an element the gate's reader skipped,
 *    which the grader's whole-text regex finds.
 *
 * Each probe has a named mutant of `src/gate/xlsx-document.ts` that it kills (listed in the
 * PR's round-2 comment); the mutants were run by hand, one at a time.
 */
import { describe, expect, it } from "vitest";
import { readZipEntries, XlsxError } from "../../src/gate/xlsx-document.ts";
import { gateOn, graderOn, LO_BASE } from "./xlsx-lo-mutate.ts";
import { writerBytes } from "./xlsx-writer-files.ts";
import { entryEnds, withComment, withCommentDecoy, withGap } from "./xlsx-zip-surgery.ts";

const EXACT = writerBytes(LO_BASE);
const PRISTINE = writerBytes("pristine.lo.xlsx");

function zipCode(bytes: Uint8Array): string {
  try {
    readZipEntries(bytes);
    return "read";
  } catch (error) {
    if (error instanceof XlsxError) return error.code;
    throw error;
  }
}

describe("baseline: the unmodified LibreOffice fixture", () => {
  it("verifies, and the grader passes it", async () => {
    expect((await gateOn(EXACT)).verdict).toBe("verified");
    expect(graderOn(EXACT)).toBe("pass");
  });
});

describe("zip: every byte is accounted for, and the EOCD carries no comment (V6)", () => {
  it("V6: a complete decoy archive (pristine.lo.xlsx) in the real EOCD's comment, plus one pad byte", async () => {
    const bytes = withCommentDecoy(EXACT, PRISTINE, 1);
    // The shape is live: the grader reads the decoy (the unedited workbook) and fails it.
    expect(graderOn(bytes)).toBe("fail");
    const gate = await gateOn(bytes);
    expect(gate.verdict).toBe("uncertain");
    expect(gate.reasonCodes).toContain("STATE_CORRUPT");
    expect(gate.reasons.join(" ")).toContain("XLSX_ZIP_MALFORMED");
    expect(zipCode(bytes)).toBe("XLSX_ZIP_MALFORMED");
  });

  it("V6 with no pad byte, and with the decoy as the whole comment, is refused too", () => {
    expect(zipCode(withCommentDecoy(EXACT, PRISTINE, 0))).toBe("XLSX_ZIP_MALFORMED");
    expect(zipCode(withCommentDecoy(EXACT, EXACT, 3))).toBe("XLSX_ZIP_MALFORMED");
  });

  it("any EOCD comment is refused, even a plain one (LibreOffice writes none)", () => {
    expect(zipCode(withComment(EXACT, new TextEncoder().encode("x")))).toBe("XLSX_ZIP_MALFORMED");
    // A comment holding only an EOCD signature (the stray-signature shape).
    const sig = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    expect(zipCode(withComment(EXACT, sig))).toBe("XLSX_ZIP_MALFORMED");
  });

  it("bytes no entry covers are refused: junk between entries, offsets fixed so the grader still reads it", async () => {
    const ends = entryEnds(EXACT);
    for (const at of [ends[0] as number, ends[3] as number, ends[ends.length - 1] as number]) {
      const bytes = withGap(EXACT, at, new TextEncoder().encode("JUNK-NOBODY-COVERS"));
      // The grader reads every entry through its offsets, so the shape is otherwise intact.
      expect(graderOn(bytes)).toBe("pass");
      expect(zipCode(bytes)).toBe("XLSX_ZIP_MALFORMED");
      expect((await gateOn(bytes)).verdict).toBe("uncertain");
    }
  });

  it("a whole decoy archive hidden in a gap between entries is refused", () => {
    const ends = entryEnds(EXACT);
    expect(zipCode(withGap(EXACT, ends[2] as number, PRISTINE))).toBe("XLSX_ZIP_MALFORMED");
  });

  it("a data descriptor that does not repeat the central directory's values is refused", () => {
    // LibreOffice sets bit 3 and writes `PK\x07\x08` + CRC + sizes after each entry's data.
    const bytes = EXACT.slice();
    const view = new DataView(bytes.buffer);
    const descriptor = (entryEnds(EXACT)[0] as number) - 16;
    expect(view.getUint32(descriptor, true)).toBe(0x08074b50);
    view.setUint32(descriptor + 8, view.getUint32(descriptor + 8, true) + 1, true);
    expect(zipCode(bytes)).toBe("XLSX_ZIP_MALFORMED");
  });

  it("all four LibreOffice fixtures still read (every byte covered, no comment)", () => {
    for (const name of [
      "exact.lo.xlsx",
      "pristine.lo.xlsx",
      "collateral.lo.xlsx",
      "roundtrip-exact.lo.xlsx",
    ])
      expect(zipCode(writerBytes(name)), name).toBe("read");
  });
});
