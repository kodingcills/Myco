/**
 * Requirement (c): every #503 round-3 probe, P01-P53 (see xlsx-probes-503.ts for how each is
 * built and numbered), becomes a test that the gate never verifies it. Each row pins the
 * gate's decision (verdict and its code) and, for the record, what the independent grader
 * makes of the same bytes. In #503 the gate verified P01-P15 and P46 while the grader failed
 * them (D8, BLOCKING), and verified P03, P10, P21, P45, P50, P53 and the "verified, and the
 * grader passes" list; now none verifies.
 */
import { describe, expect, it } from "vitest";
import { gateOn, graderOn } from "./xlsx-lo-mutate.ts";
import { PROBES_503 } from "./xlsx-probes-503.ts";

/** id: [gate verdict, gate code (refusal code or refutation reason), grader status]. */
const EXPECTED: Readonly<Record<string, readonly [string, string, string]>> = {
  P01: ["uncertain", "XLSX_PRESCAN_COMMENT", "fail"],
  P02: ["uncertain", "XLSX_PRESCAN_COMMENT", "fail"],
  P03: ["uncertain", "XLSX_PRESCAN_COMMENT", "ungradable"],
  P04: ["uncertain", "XLSX_PRESCAN_COMMENT", "fail"],
  P05: ["uncertain", "XLSX_PRESCAN_COMMENT", "fail"],
  P06: ["uncertain", "XLSX_PRESCAN_QUOTE", "fail"],
  P07: ["uncertain", "XLSX_PRESCAN_QUOTE", "fail"],
  P08: ["uncertain", "XLSX_PRESCAN_TAG_SPACE", "fail"],
  P09: ["uncertain", "XLSX_PRESCAN_TAG_SPACE", "fail"],
  P10: ["uncertain", "XLSX_PRESCAN_TAG_SPACE", "ungradable"],
  P11: ["uncertain", "XLSX_PRESCAN_NAMESPACE", "fail"],
  P12: ["uncertain", "XLSX_PRESCAN_NAMESPACE", "fail"],
  P13: ["uncertain", "XLSX_PRESCAN_NAMESPACE", "fail"],
  P14: ["uncertain", "XLSX_PART_UNEXPECTED", "fail"],
  P15: ["uncertain", "XLSX_PART_UNEXPECTED", "fail"],
  P16: ["uncertain", "XLSX_PRESCAN_CDATA", "fail"],
  P17: ["uncertain", "XLSX_XML_UNSUPPORTED", "fail"],
  P18: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P19: ["uncertain", "XLSX_CELL_MALFORMED", "ungradable"],
  P20: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P21: ["uncertain", "XLSX_PRESCAN_ENTITY", "ungradable"],
  P22: ["uncertain", "XLSX_CELL_MALFORMED", "fail"],
  P23: ["uncertain", "XLSX_CELL_MALFORMED", "ungradable"],
  P24: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P25: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P26: ["uncertain", "XLSX_PRESCAN_NAMESPACE", "pass"],
  P27: ["uncertain", "XLSX_CELL_MALFORMED", "fail"],
  P28: ["uncertain", "XLSX_CELL_MALFORMED", "fail"],
  P29: ["uncertain", "XLSX_XML_MALFORMED", "ungradable"],
  P30: ["uncertain", "XLSX_RATIO_EXCEEDED", "fail"],
  P31: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P32: ["refuted", "TARGET_MISMATCH", "pass"],
  P33: ["refuted", "TARGET_MISMATCH", "fail"],
  P34: ["refuted", "DOCUMENT_COLLATERAL", "fail"],
  P35: ["uncertain", "XLSX_PRESCAN_ENTITY", "pass"],
  P36: ["uncertain", "XLSX_PRESCAN_SYNTAX", "pass"],
  P37: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P38: ["uncertain", "XLSX_PRESCAN_TEXT", "pass"],
  P39: ["uncertain", "XLSX_PRESCAN_COMMENT", "pass"],
  P40: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P41: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P42: ["uncertain", "XLSX_CELL_MALFORMED", "pass"],
  P43: ["uncertain", "XLSX_STYLE_MALFORMED", "pass"],
  P44: ["uncertain", "XLSX_PRESCAN_TEXT", "pass"],
  P45: ["uncertain", "XLSX_PRESCAN_QUOTE", "ungradable"],
  P46: ["uncertain", "XLSX_PRESCAN_QUOTE", "fail"],
  P47: ["uncertain", "XLSX_PRESCAN_TAG_SPACE", "pass"],
  P48: ["uncertain", "XLSX_PRESCAN_TAG_SPACE", "pass"],
  P49: ["uncertain", "XLSX_PRESCAN_ENTITY", "pass"],
  P50: ["uncertain", "XLSX_PRESCAN_ENTITY", "ungradable"],
  P51: ["uncertain", "XLSX_PRESCAN_PI", "pass"],
  P52: ["uncertain", "XLSX_PRESCAN_DECL", "pass"],
  P53: ["uncertain", "XLSX_PRESCAN_NAMESPACE", "ungradable"],
};

describe("#503 probes P01-P53 on a real LibreOffice workbook: the gate never verifies one", () => {
  it("all 53 probes are here, P01 to P53, each once", () => {
    const ids = PROBES_503.map((p) => p.id);
    expect(ids).toEqual(Array.from({ length: 53 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`));
    expect(Object.keys(EXPECTED)).toEqual(ids);
  });

  it.each(PROBES_503.map((p) => [p.id, p.change, p] as const))("%s: %s", async (id, _c, probe) => {
    const bytes = probe.build();
    const result = await gateOn(bytes);
    const [verdict, code, grader] = EXPECTED[id] as readonly [string, string, string];
    expect(result.verdict).not.toBe("verified");
    expect(result.verdict).toBe(verdict);
    if (verdict === "uncertain") {
      expect(result.reasonCodes).toEqual(["STATE_CORRUPT"]);
      expect(result.reasons).toEqual([
        `could not look: persisted document is not a readable xlsx document (${code})`,
      ]);
    } else {
      expect(result.reasonCodes).toEqual(["ORACLE_FAIL", code]);
    }
    expect(graderOn(bytes)).toBe(grader);
  });

  it("the D8 false VERIFIEDs (P01-P15 minus P03 and P10, plus P46) are ones the grader fails", () => {
    const failed = Object.entries(EXPECTED)
      .filter(([, [, , g]]) => g === "fail")
      .map(([id]) => id);
    for (const id of [
      "P01",
      "P02",
      "P04",
      "P05",
      "P06",
      "P07",
      "P08",
      "P09",
      "P11",
      "P12",
      "P13",
      "P14",
      "P15",
      "P46",
    ])
      expect(failed).toContain(id);
  });
});
