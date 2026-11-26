/**
 * Value semantics of a stored number (#550's round-3 verdict, comment 7205644970, D3). The
 * gate renders a stored number to the text the fixture would hold. The independent grader
 * compares a stored number by its column's TYPE (`cellMatches`): an integer column needs the
 * integer and no date style, a date column needs a date-styled serial of that ISO day, a
 * currency column needs the `$` amount and no date style, and a text or key column never
 * matches a number. So a number whose text equals the expected text could still fail the
 * grader, and the gate verified it (VA-VD). Separately, the gate read 1904-system serial 0
 * as 1904-01-01, a day the grader's `serial >= 1` bound denies (VE).
 *
 * The fix: the reader returns each literal number cell's stored kind as the column types it
 * can stand for (`numberDomain`), calc-record-edit refuses a document it would otherwise
 * verify when any number sits outside its column's set (XLSX_NUMBER_DOMAIN), and
 * `serialDay` requires serial >= 1 in both systems.
 *
 * Here: VA-VE verbatim (each from the real `pristine.lo.xlsx`, run through the real read
 * path and the grader), the controls, a column-domain differential family (column x
 * newValue x representation x date system, 752 variants) and a whole-range serial sweep
 * (-5 to 2,958,470 in both systems). Property (d): gate VERIFIED implies grader PASS, 0
 * violations. Each probe has a named mutant it kills (listed in the PR's Ready comment).
 */
import { describe, expect, it } from "vitest";
import { serialToIsoDate } from "../../src/benchmark/grade/sheet.ts";
import { numberDomain, serialDay } from "../../src/gate/xlsx-document.ts";
import { writeZip } from "../../src/tasks/writer-docgen.ts";
import {
  gateOn,
  graderOn,
  type LoEdit,
  loParts,
  SHEET1,
  SST,
  STYLES,
  WORKBOOK,
} from "./xlsx-lo-mutate.ts";

const BASE = new Map(loParts("pristine.lo.xlsx"));

function text(name: string): string {
  const t = BASE.get(name);
  if (t === undefined) throw new Error(`no part ${name}`);
  return t;
}

function zip(parts: ReadonlyMap<string, string>): Uint8Array {
  const enc = new TextEncoder();
  return writeZip([...parts].map(([name, t]) => ({ name, data: enc.encode(t) })));
}

/** Replace the one `<c r="REF" ...>...</c>` element of the sheet with `cell`. */
function withCell(sheet: string, ref: string, cell: string): string {
  const re = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>.*?</c>)`);
  if (!re.test(sheet)) throw new Error(`no cell ${ref}`);
  return sheet.replace(re, cell);
}

/** Move every date cell of column D down by `delta` serial days (for the 1904 system). */
function shiftDates(sheet: string, delta: number): string {
  return sheet.replace(
    /(<c r="D\d+" s="1" t="n"><v>)(\d+)(<\/v>)/g,
    (_m, a: string, v: string, b: string) => `${a}${Number(v) + delta}${b}`,
  );
}

const DATE1904 = (wb: string) =>
  wb.replace("<workbookPr backupFile", '<workbookPr date1904="true" backupFile');

const EDIT = (column: string, newValue: string): LoEdit => ({
  rowKey: "EMP-0003",
  column,
  newValue,
});

const REF: Readonly<Record<string, string>> = { name: "B4", qty: "C4", joined: "D4", salary: "E4" };

async function expectRefused(bytes: Uint8Array, edit: LoEdit, code: string) {
  const gate = await gateOn(bytes, edit);
  expect(gate.verdict).toBe("uncertain");
  expect(gate.reasonCodes).toEqual(["STATE_CORRUPT"]);
  expect(gate.reasons.join(" ")).toContain(code);
}

/** The base workbook with one cell replaced (and, for 1904, the date system moved). */
function variant(ref: string, cell: string, system: 1900 | 1904 = 1900): Uint8Array {
  const parts = new Map(BASE);
  let sheet = text(SHEET1);
  if (system === 1904) {
    sheet = shiftDates(sheet, -1462);
    parts.set(WORKBOOK, DATE1904(text(WORKBOOK)));
  }
  parts.set(SHEET1, withCell(sheet, ref, cell));
  return zip(parts);
}

describe("controls", () => {
  it("qty := 4242 stored as a number: verified, and the grader passes (1900)", async () => {
    const bytes = variant("C4", '<c r="C4" s="0" t="n"><v>4242</v></c>');
    expect(graderOn(bytes, EDIT("qty", "4242"))).toBe("pass");
    expect((await gateOn(bytes, EDIT("qty", "4242"))).verdict).toBe("verified");
  });

  it("the same with the date column moved to the 1904 system: verified, grader passes", async () => {
    const bytes = variant("C4", '<c r="C4" s="0" t="n"><v>4242</v></c>', 1904);
    expect(graderOn(bytes, EDIT("qty", "4242"))).toBe("pass");
    expect((await gateOn(bytes, EDIT("qty", "4242"))).verdict).toBe("verified");
  });

  it("joined := 2024-01-01 as a date-styled serial: verified, grader passes (both systems)", async () => {
    for (const [system, serial] of [
      [1900, 45292],
      [1904, 43830],
    ] as const) {
      const bytes = variant("D4", `<c r="D4" s="1" t="n"><v>${serial}</v></c>`, system);
      expect(graderOn(bytes, EDIT("joined", "2024-01-01"))).toBe("pass");
      expect((await gateOn(bytes, EDIT("joined", "2024-01-01"))).verdict).toBe("verified");
    }
  });

  it("name := 4242 as a shared string is text in a text column: verified, grader passes", async () => {
    const parts = new Map(BASE);
    parts.set(
      SST,
      text(SST)
        .replace(
          /count="(\d+)" uniqueCount="(\d+)"/,
          (_m, c, u) => `count="${c}" uniqueCount="${Number(u) + 1}"`,
        )
        .replace("</sst>", '<si><t xml:space="preserve">4242</t></si></sst>'),
    );
    const index = (text(SST).match(/<si>/g) ?? []).length;
    parts.set(SHEET1, withCell(text(SHEET1), "B4", `<c r="B4" s="0" t="s"><v>${index}</v></c>`));
    const bytes = zip(parts);
    expect(graderOn(bytes, EDIT("name", "4242"))).toBe("pass");
    expect((await gateOn(bytes, EDIT("name", "4242"))).verdict).toBe("verified");
  });
});

describe("D3 VA-VD: a stored number outside its column's domain (verbatim)", () => {
  it("VA: name := 4242, B4 a number in a text column: grader fails, the gate refuses", async () => {
    const bytes = variant("B4", '<c r="B4" s="0" t="n"><v>4242</v></c>');
    expect(graderOn(bytes, EDIT("name", "4242"))).toBe("fail");
    await expectRefused(bytes, EDIT("name", "4242"), "XLSX_NUMBER_DOMAIN");
  });

  it("VB: qty := 4242.5, C4 number 4242.5 General: grader fails, the gate refuses", async () => {
    const bytes = variant("C4", '<c r="C4" s="0" t="n"><v>4242.5</v></c>');
    expect(graderOn(bytes, EDIT("qty", "4242.5"))).toBe("fail");
    await expectRefused(bytes, EDIT("qty", "4242.5"), "XLSX_NUMBER_DOMAIN");
  });

  it("VC: salary := 36965.5, E4 number General: grader fails, the gate refuses", async () => {
    const bytes = variant("E4", '<c r="E4" s="0" t="n"><v>36965.5</v></c>');
    expect(graderOn(bytes, EDIT("salary", "36965.5"))).toBe("fail");
    await expectRefused(bytes, EDIT("salary", "36965.5"), "XLSX_NUMBER_DOMAIN");
  });

  it("VD: joined := 45000, D4 number 45000 General (not date-styled): grader fails, gate refuses", async () => {
    const bytes = variant("D4", '<c r="D4" s="0" t="n"><v>45000</v></c>');
    expect(graderOn(bytes, EDIT("joined", "45000"))).toBe("fail");
    await expectRefused(bytes, EDIT("joined", "45000"), "XLSX_NUMBER_DOMAIN");
  });

  it("a document the text comparison refutes stays refuted (R1's evidence rules unchanged)", async () => {
    // name := Enzo, but B4 holds the number 4242: a text mismatch, refuted as before.
    const bytes = variant("B4", '<c r="B4" s="0" t="n"><v>4242</v></c>');
    expect(graderOn(bytes, EDIT("name", "Enzo"))).toBe("fail");
    expect((await gateOn(bytes, EDIT("name", "Enzo"))).verdict).toBe("refuted");
  });
});

describe("D3 VE: serial 0 in the 1904 date system is no day (verbatim)", () => {
  it("VE: joined := 1904-01-01, date1904, D4 = serial 0 date-styled: grader fails, gate never verifies", async () => {
    const bytes = variant("D4", '<c r="D4" s="1" t="n"><v>0</v></c>', 1904);
    expect(graderOn(bytes, EDIT("joined", "1904-01-01"))).toBe("fail");
    const gate = await gateOn(bytes, EDIT("joined", "1904-01-01"));
    // Serial 0 renders as the impossible-date marker (R1): a text mismatch, refuted.
    expect(gate.verdict).toBe("refuted");
    expect(gate.reasonCodes).toContain("ORACLE_FAIL");
  });

  it("serial 1 in the 1904 system is 1904-01-02 on both sides: verified, grader passes", async () => {
    const bytes = variant("D4", '<c r="D4" s="1" t="n"><v>1</v></c>', 1904);
    expect(graderOn(bytes, EDIT("joined", "1904-01-02"))).toBe("pass");
    expect((await gateOn(bytes, EDIT("joined", "1904-01-02"))).verdict).toBe("verified");
  });

  it("serialDay(0, 1904) is null; 1 is 1904-01-02", () => {
    expect(serialDay(0, 1904)).toBeNull();
    expect(serialDay(1, 1904)).toBe("1904-01-02");
  });
});

describe("date1904 spellings the grader reads as 1900 are never verified (V-1904-UPPER)", () => {
  // The grader reads only "1"/"true" (its own reader) as 1904; the gate refuses any other
  // spelling. With the date column moved to 1904, the edit must never verify.
  it.each(['date1904="TRUE"', 'date1904="True"', 'date1904="yes"', 'date1904=" 1"'])(
    "%s: the gate does not verify",
    async (attr) => {
      const parts = new Map(BASE);
      parts.set(
        WORKBOOK,
        text(WORKBOOK).replace("<workbookPr backupFile", `<workbookPr ${attr} backupFile`),
      );
      parts.set(
        SHEET1,
        withCell(shiftDates(text(SHEET1), -1462), "C4", '<c r="C4" s="0" t="n"><v>4242</v></c>'),
      );
      const bytes = zip(parts);
      const gate = await gateOn(bytes, EDIT("qty", "4242"));
      expect(gate.verdict).not.toBe("verified");
      expect(graderOn(bytes, EDIT("qty", "4242"))).toBe("fail");
    },
  );
});

describe("numberDomain: the grader's acceptance by column type, re-derived", () => {
  const general = { kind: "general" } as const;
  const date = { kind: "date" } as const;
  const usd = { kind: "fixed", decimals: 2, currency: true } as const;
  it.each([
    ["4242", 4242, general, ["integer"]],
    ["-3", -3, general, ["integer"]],
    ["4242.5", 4242.5, general, []],
    ["1000", 1000, general, ["integer"]],
    ["2024-01-01", 45292, date, ["date"]],
    ["\u0000\nIMPOSSIBLE_DATE", 60, date, []],
    ["$4242.00", 4242, usd, ["currency"]],
    ["$-5.25", -5.25, usd, ["currency"]],
  ] as const)("%j (%d) -> %j", (t, v, cls, want) => {
    expect(numberDomain(t, v, cls)).toEqual(want);
  });
});

// ---------------------------------------------------------------------------
// The column-domain differential family
// ---------------------------------------------------------------------------

const COLUMNS = ["name", "qty", "joined", "salary"] as const;
const NEW_VALUES = [
  "4242",
  "4242.5",
  "36965.5",
  "45000",
  "0",
  "-3",
  "1e3",
  "2024-01-01",
  "$4242",
  "$4242.00",
  "Enzo",
  "TRUE",
  "1904-01-01",
  "100",
  "1900-01-01",
  "$-5.25",
  "45447",
] as const;
/** number in style 0 (General), 1 (date), 2 (text @), 3 (a "$"#,##0.00 style added here); a shared or inline string. */
const REPRESENTATIONS = ["n0", "n1", "n2", "n3", "shared", "inline"] as const;

/** The stored number a writer would put for `v`: the number, a day's serial, an amount. */
function storedNumber(v: string, system: 1900 | 1904): number | undefined {
  if (/^-?\d+(?:\.\d+)?$/.test(v) || v === "1e3") return Number(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    const ms = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    const epoch = system === 1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    return Math.round((ms - epoch) / 86_400_000);
  }
  const amount = /^\$(-?\d+(?:\.\d+)?)$/.exec(v);
  return amount ? Number(amount[1]) : undefined;
}

function withCurrencyStyle(styles: string): string {
  return styles
    .replace('<numFmts count="3">', '<numFmts count="4">')
    .replace("</numFmts>", '<numFmt numFmtId="167" formatCode="&quot;$&quot;#,##0.00"/></numFmts>')
    .replace('<cellXfs count="3">', '<cellXfs count="4">')
    .replace(
      "</cellXfs>",
      '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="false" applyBorder="false" applyAlignment="false" applyProtection="false"><alignment horizontal="general" vertical="bottom" textRotation="0" wrapText="false" indent="0" shrinkToFit="false"/><protection locked="true" hidden="false"/></xf></cellXfs>',
    );
}

interface Variant {
  readonly label: string;
  readonly bytes: Uint8Array;
  readonly edit: LoEdit;
}

function domainVariants(): Variant[] {
  const out: Variant[] = [];
  const sstIndex = (text(SST).match(/<si>/g) ?? []).length;
  for (const system of [1900, 1904] as const)
    for (const column of COLUMNS)
      for (const newValue of NEW_VALUES)
        for (const rep of REPRESENTATIONS) {
          const ref = REF[column] as string;
          const parts = new Map(BASE);
          let sheet = text(SHEET1);
          if (system === 1904) {
            sheet = shiftDates(sheet, -1462);
            parts.set(WORKBOOK, DATE1904(text(WORKBOOK)));
          }
          let cell: string;
          if (rep === "shared") {
            parts.set(
              SST,
              text(SST)
                .replace(
                  /count="(\d+)" uniqueCount="(\d+)"/,
                  (_m, c, u) => `count="${c}" uniqueCount="${Number(u) + 1}"`,
                )
                .replace("</sst>", `<si><t xml:space="preserve">${newValue}</t></si></sst>`),
            );
            cell = `<c r="${ref}" s="0" t="s"><v>${sstIndex}</v></c>`;
          } else if (rep === "inline") {
            cell = `<c r="${ref}" s="0" t="inlineStr"><is><t>${newValue}</t></is></c>`;
          } else {
            const value = storedNumber(newValue, system);
            if (value === undefined) continue;
            if (rep === "n3") parts.set(STYLES, withCurrencyStyle(text(STYLES)));
            cell = `<c r="${ref}" s="${rep.slice(1)}" t="n"><v>${String(value)}</v></c>`;
          }
          parts.set(SHEET1, withCell(sheet, ref, cell));
          out.push({
            label: `${system} ${column} := ${newValue} as ${rep}`,
            bytes: zip(parts),
            edit: EDIT(column, newValue),
          });
        }
  return out;
}

describe("column-domain differential family: gate VERIFIED implies grader PASS", () => {
  it("752 variants (column x newValue x representation x date system), 0 violations", async () => {
    const variants = domainVariants();
    expect(variants.length).toBe(752);
    const tally = { verified: 0, refuted: 0, uncertain: 0, domain: 0, graderPass: 0 };
    const violations: string[] = [];
    for (const v of variants) {
      const gate = await gateOn(v.bytes, v.edit);
      const grader = graderOn(v.bytes, v.edit);
      tally[gate.verdict as "verified" | "refuted" | "uncertain"] += 1;
      if (gate.reasons.join(" ").includes("XLSX_NUMBER_DOMAIN")) tally.domain += 1;
      if (grader === "pass") tally.graderPass += 1;
      if (gate.verdict === "verified" && grader !== "pass") violations.push(v.label);
    }
    expect(violations).toEqual([]);
    // Live: the family reaches every outcome, and the new refusal fires on the D3 shapes.
    expect(tally.verified).toBeGreaterThan(100);
    expect(tally.refuted).toBeGreaterThan(100);
    expect(tally.domain).toBeGreaterThan(20);
    // Every verified variant passes the grader (above), so verified <= graderPass.
    expect(tally.verified).toBeLessThanOrEqual(tally.graderPass);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The serial sweep
// ---------------------------------------------------------------------------

describe("serial sweep: serialDay agrees with the grader on every serial, both systems", () => {
  it("-5 to 2,958,470 in the 1900 and 1904 systems: 0 disagreements", () => {
    const disagreements: string[] = [];
    for (const system of [1900, 1904] as const)
      for (let s = -5; s <= 2_958_470; s++)
        if (serialDay(s, system) !== serialToIsoDate(s, system))
          disagreements.push(`${system}:${s}`);
    expect(disagreements).toEqual([]);
  }, 120_000);

  it("boundary serials through the gate: verified only where the grader passes", async () => {
    const violations: string[] = [];
    for (const system of [1900, 1904] as const)
      for (const serial of [
        -1, 0, 1, 2, 59, 60, 61, 1462, 2_957_003, 2_957_004, 2_958_465, 2_958_466,
      ]) {
        const day =
          serialToIsoDate(serial, system) ??
          serialDay(serial, system === 1900 ? 1904 : 1900) ??
          "1904-01-01";
        const bytes = variant("D4", `<c r="D4" s="1" t="n"><v>${serial}</v></c>`, system);
        const edit = EDIT("joined", day);
        const gate = await gateOn(bytes, edit);
        if (gate.verdict === "verified" && graderOn(bytes, edit) !== "pass")
          violations.push(`${system}:${serial}`);
      }
    expect(violations).toEqual([]);
  });
});
