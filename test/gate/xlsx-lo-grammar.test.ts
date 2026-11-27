/**
 * Real LibreOffice output pins the pre-scan's reference rule (see
 * test/fixtures/calc-xlsx-lo-grammar/README.md): the five predefined escapes LibreOffice
 * writes are accepted and read exactly; the numeric references it writes for a tab or line
 * break are refused (fail closed).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readXlsxDocument, readZipEntries } from "../../src/gate/xlsx-document.ts";
import { contentKindOf, prescanXmlPart } from "../../src/gate/xlsx-prescan.ts";

const DIR = join(import.meta.dirname, "..", "fixtures", "calc-xlsx-lo-grammar");
const MANIFEST = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as {
  soffice: string;
  files: Record<string, { sha256: string }>;
};
const bytes = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

describe("LibreOffice's own references", () => {
  it("the files are the pinned LibreOffice output", () => {
    expect(MANIFEST.soffice).toMatch(/^LibreOffice 24\.2\./);
    for (const [name, { sha256 }] of Object.entries(MANIFEST.files))
      expect(createHash("sha256").update(bytes(name)).digest("hex")).toBe(sha256);
  });

  it("the five predefined escapes: every part passes the pre-scan, and reads exactly", () => {
    const file = bytes("escapes.lo.xlsx");
    const sst = new TextDecoder().decode(readZipEntries(file).get("xl/sharedStrings.xml"));
    for (const ref of ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"]) expect(sst).toContain(ref);
    for (const [name, data] of readZipEntries(file))
      expect([name, prescanXmlPart(data, contentKindOf(name))]).toEqual([name, undefined]);
    const { cells } = readXlsxDocument(file);
    expect([cells.B2, cells.B3, cells.B4, cells.B5, cells.B6, cells.B7]).toEqual([
      "A&B",
      "x<y>z",
      'q"uote',
      "it's",
      " lead and trail ",
      "Zoë €",
    ]);
  });

  it("&#9; and &#10; (a tab, a line break) are refused: XLSX_PRESCAN_ENTITY", () => {
    const file = bytes("tab-newline.lo.xlsx");
    const sst = new TextDecoder().decode(readZipEntries(file).get("xl/sharedStrings.xml"));
    expect(sst).toContain("tab&#9;here");
    expect(sst).toContain("line&#10;break");
    expect(() => readXlsxDocument(file)).toThrow(
      expect.objectContaining({ code: "XLSX_PRESCAN_ENTITY" }),
    );
  });
});
