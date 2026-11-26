/**
 * TIF-274 prerequisite (outer-loop ruling 08:38Z, option (a)): the gate reads xlsx on the
 * SAME whole-document rule and cell model as CSV, so both R2 arms can run the task set's
 * own format. Parity: every CSV case of the gate/grader agreement table (`calc-probes.ts`),
 * plus a typed-edit and collateral table, is rebuilt as its EQUIVALENT workbook
 * (`xlsxFromCsv`: the same rows and columns, each value typed as Calc types it on import)
 * and must get the same verdict, the same reason codes and the same reasons from the gate's
 * xlsx path as from its CSV path.
 *
 * Soundness against the independent grader: whenever the gate verifies a workbook, the
 * grader (its own xlsx reader) passes the same bytes. (#503 had one exception, a prefixed
 * root the grader cannot read; the raw-byte pre-scan now refuses it.) The last describe block EXECUTES that
 * claim over every workbook this file and its neighbours build: the agreement table, the
 * typed table, an xlsx-only table (formula cells, including round 1's h60 and h65, inline
 * and rich strings, booleans, prefixed namespaces) and the committed LibreOffice and
 * openpyxl workbooks. On the agreement table the two agree outright, including the two
 * CSV-only divergences (a quoted field and CR-only lines are just text in a workbook,
 * which both refute).
 */
import { describe, expect, it } from "vitest";
import { grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { documentCsv } from "../../src/gate/calc-document.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { XLSX_MAIN_SHEET, xlsxEntriesFromCsv, xlsxFromCsv } from "../../src/tasks/calc-xlsxgen.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { groundTruth } from "../../src/tasks/intent.ts";
import { AGREE, COLUMN_TYPES, KNOWN_DIVERGENCES, SEED } from "./calc-probes.ts";
import { tempRoot, writeState } from "./helpers.ts";
import { ACCEPTED, MALFORMED, probeWorkbook } from "./xlsx-malformed-probes.ts";
import { WRITERS_MANIFEST, writerBytes } from "./xlsx-writer-files.ts";

interface Intent {
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

const PROBE_INTENT: Intent = { rowKey: "EMP-0003", column: "qty", newValue: "4242" };

async function gateResult(intent: Intent, format: "csv" | "xlsx", bytes: string | Uint8Array) {
  const root = tempRoot();
  const stateFile = format === "xlsx" ? "sheet.xlsx" : "sheet.csv";
  writeState(root, "r", stateFile, bytes);
  const spec = {
    fixtureSeed: SEED,
    ...intent,
    ...(format === "xlsx" ? { persistedFormat: "xlsx" } : {}),
  };
  const result = await createGate({
    tasks: buildRegistry([{ id: "p", family: "calc-record-edit", stateFile, spec }]),
    reader: fileEvidenceReader(root),
    assignment: { taskId: "p", runId: "r" },
  }).check({ taskId: "p", runId: "r" });
  return { verdict: result.verdict, reasonCodes: result.reasonCodes, reasons: result.reasons };
}

function graderXlsx(intent: Intent, bytes: Uint8Array) {
  const fixtureCsv = Buffer.from(generateFixture(SEED).csv);
  return grade({
    fixtureCsv,
    fixtureSha256: sha256(fixtureCsv),
    persisted: { format: "xlsx", bytes },
    intent,
    columnTypes: COLUMN_TYPES,
  }).status;
}

describe("CSV/xlsx parity over the agreement table (every probe)", () => {
  const probes = [...AGREE, ...KNOWN_DIVERGENCES];
  it("covers the whole table", () => {
    expect(probes.length).toBe(23);
  });

  /**
   * Probes whose workbook holds a tab or CR in a text cell. The generator writes those as
   * `&#9;` / `&#13;` (LibreOffice writes `&#9;` and `&#10;`), and the raw-byte pre-scan
   * refuses every numeric reference, so the xlsx path is `uncertain` where the CSV path
   * refutes. Neither verifies; the difference errs towards refusing.
   */
  const XLSX_REFUSED = new Set([
    "trailing row whose only content is a tab in one cell",
    "CR-only line endings",
  ]);

  it.each(probes.map((p) => [p.name, p] as const))("%s", async (_name, probe) => {
    const xlsx = xlsxFromCsv(probe.csv);
    const fromCsv = await gateResult(PROBE_INTENT, "csv", probe.csv);
    const fromXlsx = await gateResult(PROBE_INTENT, "xlsx", xlsx);
    expect(fromCsv.verdict).toBe(probe.gate);
    if (XLSX_REFUSED.has(probe.name)) {
      expect(fromCsv.verdict).not.toBe("verified");
      expect(fromXlsx).toEqual({
        verdict: "uncertain",
        reasonCodes: ["STATE_CORRUPT"],
        reasons: [
          "could not look: persisted document is not a readable xlsx document (XLSX_PRESCAN_ENTITY)",
        ],
      });
      return;
    }
    expect(fromXlsx).toEqual(fromCsv);
    // Never verified where the independent grader fails the same workbook; on this table
    // the two agree outright.
    expect(fromXlsx.verdict === "verified").toBe(graderXlsx(PROBE_INTENT, xlsx) === "pass");
  });
});

// ---------------------------------------------------------------------------
// Typed edits and collateral damage, every column type
// ---------------------------------------------------------------------------

const SEED_ROWS = generateFixture(SEED);
const EDITS: Record<string, Intent> = {
  text: { rowKey: "EMP-0002", column: "name", newValue: "Gate Ops" },
  integer: PROBE_INTENT,
  date: { rowKey: "EMP-0004", column: "joined", newValue: "2024-02-29" },
  currency: { rowKey: "EMP-0005", column: "salary", newValue: "$51234.50" },
};

type Mutate = (rows: string[][]) => void;
const set =
  (r: number, c: number, v: string): Mutate =>
  (rows) => {
    (rows[r] as string[])[c] = v;
  };

function csvWith(intent: Intent, mutate?: Mutate): string {
  const rows = documentCsv(SEED, [intent])
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  mutate?.(rows);
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

const TYPED: [string, Intent, string][] = [
  ...Object.entries(EDITS).map(([type, intent]): [string, Intent, string] => [
    `${type} edit, exact`,
    intent,
    csvWith(intent),
  ]),
  ...Object.entries(EDITS).map(([type, intent]): [string, Intent, string] => [
    `${type} edit missing (the pristine fixture saved)`,
    intent,
    SEED_ROWS.csv,
  ]),
  ["integer edit, wrong value", PROBE_INTENT, csvWith({ ...PROBE_INTENT, newValue: "4243" })],
  ["integer edit as 4242.00", PROBE_INTENT, csvWith({ ...PROBE_INTENT, newValue: "4242.00" })],
  [
    "date edit, a different day",
    EDITS.date as Intent,
    csvWith({ ...(EDITS.date as Intent), newValue: "2024-03-01" }),
  ],
  [
    "currency edit, a cent off",
    EDITS.currency as Intent,
    csvWith({ ...(EDITS.currency as Intent), newValue: "$51234.51" }),
  ],
  [
    "currency edit without the dollar sign",
    EDITS.currency as Intent,
    csvWith({ ...(EDITS.currency as Intent), newValue: "51234.50" }),
  ],
  ["another cell in the same row changed", PROBE_INTENT, csvWith(PROBE_INTENT, set(3, 1, "777"))],
  ["a currency cell changed", PROBE_INTENT, csvWith(PROBE_INTENT, set(4, 4, "$1.00"))],
  ["a non-target cell cleared", PROBE_INTENT, csvWith(PROBE_INTENT, set(3, 1, ""))],
  ["a header renamed", PROBE_INTENT, csvWith(PROBE_INTENT, set(0, 0, "ID"))],
  [
    "a cell added past the last column",
    PROBE_INTENT,
    csvWith(PROBE_INTENT, (rows) => void (rows[1] as string[]).push("extra")),
  ],
  [
    "a row added below the data",
    PROBE_INTENT,
    csvWith(PROBE_INTENT, (rows) => void rows.push(["EMP-9999", "New Row"])),
  ],
  ["a date cell saved as a serial", PROBE_INTENT, csvWith(PROBE_INTENT, set(2, 3, "45000"))],
  [
    "a date cell rewritten as another day",
    PROBE_INTENT,
    csvWith(PROBE_INTENT, set(2, 3, "2020-01-02")),
  ],
  ["a data row deleted", PROBE_INTENT, csvWith(PROBE_INTENT, (rows) => void rows.splice(5, 1))],
];

describe("CSV/xlsx parity over typed edits and collateral damage", () => {
  it.each(TYPED)("%s", async (_name, intent, csv) => {
    const xlsx = xlsxFromCsv(csv);
    const fromCsv = await gateResult(intent, "csv", csv);
    const fromXlsx = await gateResult(intent, "xlsx", xlsx);
    expect(fromXlsx).toEqual(fromCsv);
    if (fromXlsx.verdict === "verified") expect(graderXlsx(intent, xlsx)).toBe("pass");
  });

  it("the typed table verifies exactly the four exact edits", async () => {
    const verified: string[] = [];
    for (const [name, intent, csv] of TYPED) {
      if ((await gateResult(intent, "xlsx", xlsxFromCsv(csv))).verdict === "verified")
        verified.push(name);
    }
    expect(verified).toEqual([
      "text edit, exact",
      "integer edit, exact",
      "date edit, exact",
      "currency edit, exact",
    ]);
  });
});

// ---------------------------------------------------------------------------
// xlsx-only probes: content a CSV cannot carry (round 2, D2 and D3)
// ---------------------------------------------------------------------------

const PROBE_EXACT = documentCsv(SEED, [PROBE_INTENT]);
const PROBE_TARGET = groundTruth({ fixtureSeed: SEED, ...PROBE_INTENT }).cellRef;
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const partText = (name: string) =>
  new TextDecoder().decode(xlsxEntriesFromCsv(PROBE_EXACT).find((e) => e.name === name)?.data);

/** The exact workbook with the target cell's XML replaced (`REF` = the target's ref). */
function targetXml(cellXml: string): Uint8Array {
  const sheet = partText(XLSX_MAIN_SHEET);
  const patched = sheet.replace(
    new RegExp(`<c r="${PROBE_TARGET}"[^>]*>.*?</c>`),
    cellXml.replaceAll("REF", PROBE_TARGET),
  );
  if (patched === sheet) throw new Error("target cell not found");
  return xlsxFromCsv(PROBE_EXACT, { patch: { [XLSX_MAIN_SHEET]: patched } });
}

interface XlsxProbe {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly gate: "verified" | "refuted" | "uncertain";
  /** `ungradable`: the grader's own reader could not look (its limitation, never a fail). */
  readonly grader: "pass" | "fail" | "ungradable";
}

const XLSX_ONLY: XlsxProbe[] = [
  {
    name: "h60: formula 1+1 cached as 4242",
    bytes: targetXml('<c r="REF"><f>1+1</f><v>4242</v></c>'),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: 'h65: t="str" formula "4242" cached as 4242',
    bytes: targetXml('<c r="REF" t="str"><f>"4242"</f><v>4242</v></c>'),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "formula 4000+242 (evaluates to the value) cached as 4242",
    bytes: targetXml('<c r="REF"><f>4000+242</f><v>4242</v></c>'),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "shared-formula child cached as 4242",
    bytes: targetXml('<c r="REF"><f t="shared" si="0"/><v>4242</v></c>'),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "formula with no cached value",
    bytes: targetXml('<c r="REF"><f>4000+242</f></c>'),
    gate: "uncertain",
    grader: "fail",
  },
  {
    name: "inline string 4242",
    bytes: targetXml('<c r="REF" t="inlineStr"><is><t>4242</t></is></c>'),
    gate: "verified",
    grader: "pass",
  },
  {
    name: "rich-text runs 42 + 42",
    bytes: targetXml('<c r="REF" t="inlineStr"><is><r><t>42</t></r><r><t>42</t></r></is></c>'),
    gate: "verified",
    grader: "pass",
  },
  {
    name: "number 4242 with an explicit General style",
    bytes: targetXml('<c r="REF" s="0"><v>4242</v></c>'),
    gate: "verified",
    grader: "pass",
  },
  {
    name: "boolean TRUE",
    bytes: targetXml('<c r="REF" t="b"><v>1</v></c>'),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "error value",
    bytes: targetXml('<c r="REF" t="e"><v>#VALUE!</v></c>'),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "4242.5",
    bytes: targetXml('<c r="REF"><v>4242.5</v></c>'),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "openpyxl-style xmlns:r on <sheet>",
    bytes: xlsxFromCsv(PROBE_EXACT, {
      patch: {
        "xl/workbook.xml": partText("xl/workbook.xml")
          .replace(` xmlns:r="${REL}"`, "")
          .replace("<sheet ", `<sheet xmlns:r="${REL}" `),
      },
    }),
    // Outside LibreOffice's byte grammar: refused by the pre-scan (was verified in #503).
    gate: "uncertain",
    grader: "pass",
  },
  {
    name: "prefixed <x:workbook> and <x:worksheet>",
    bytes: xlsxFromCsv(PROBE_EXACT, {
      patch: Object.fromEntries(
        ["xl/workbook.xml", XLSX_MAIN_SHEET].map((name) => [
          name,
          partText(name)
            .replace(`xmlns="${MAIN}"`, `xmlns:x="${MAIN}"`)
            .replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g, "<$1x:$2"),
        ]),
      ),
    }),
    // Refused by the pre-scan (XLSX_PRESCAN_NAMESPACE). #503 verified it while the grader,
    // reading prefixes literally, could not look: that exception is gone.
    gate: "uncertain",
    grader: "ungradable",
  },
];

describe("xlsx-only probes (formulas never verify; foreign namespace shapes are refused)", () => {
  it.each(XLSX_ONLY.map((p) => [p.name, p] as const))("%s", async (_name, probe) => {
    const result = await gateResult(PROBE_INTENT, "xlsx", probe.bytes);
    expect({ gate: result.verdict, grader: graderXlsx(PROBE_INTENT, probe.bytes) }).toEqual({
      gate: probe.gate,
      grader: probe.grader,
    });
  });
});

// ---------------------------------------------------------------------------
// Round 3, D6: malformed cell and string structure never verifies
// ---------------------------------------------------------------------------

describe("malformed cell and string structure is never verified (round 3, D6)", () => {
  it.each(MALFORMED.filter((p) => p.grader !== undefined).map((p) => [p.name, p] as const))(
    "%s: the gate is uncertain where round 2 verified it",
    async (_name, probe) => {
      const bytes = probeWorkbook(probe);
      const result = await gateResult(WRITERS_MANIFEST.edit, "xlsx", bytes);
      expect(result.verdict).toBe("uncertain");
      expect(result.reasonCodes).toEqual(["STATE_CORRUPT"]);
      // Pinned: what the independent grader makes of the same bytes (its own reader).
      expect(graderXlsx(WRITERS_MANIFEST.edit, bytes)).toBe(probe.grader);
    },
  );
});

// ---------------------------------------------------------------------------
// The soundness claim, executed over every workbook above and the writers' files
// ---------------------------------------------------------------------------

describe("soundness: whenever the gate verifies a workbook, the grader passes the same bytes", () => {
  const all: [string, Intent, Uint8Array][] = [
    ...[...AGREE, ...KNOWN_DIVERGENCES].map((p): [string, Intent, Uint8Array] => [
      `agreement: ${p.name}`,
      PROBE_INTENT,
      xlsxFromCsv(p.csv),
    ]),
    ...TYPED.map(([name, intent, csv]): [string, Intent, Uint8Array] => [
      `typed: ${name}`,
      intent,
      xlsxFromCsv(csv),
    ]),
    ...XLSX_ONLY.map((p): [string, Intent, Uint8Array] => [
      `xlsx-only: ${p.name}`,
      PROBE_INTENT,
      p.bytes,
    ]),
    ...Object.keys(WRITERS_MANIFEST.files).map((name): [string, Intent, Uint8Array] => [
      `writer: ${name}`,
      WRITERS_MANIFEST.edit,
      writerBytes(name),
    ]),
    ...ACCEPTED.map((p): [string, Intent, Uint8Array] => [
      `structure, accepted: ${p.name}`,
      WRITERS_MANIFEST.edit,
      probeWorkbook(p),
    ]),
    ...MALFORMED.map((p): [string, Intent, Uint8Array] => [
      `structure, malformed: ${p.name}`,
      WRITERS_MANIFEST.edit,
      probeWorkbook(p),
    ]),
  ];

  it("the table holds every probe (agreement, typed, xlsx-only, writer files, D6 structure)", () => {
    expect(all.length).toBe(
      23 + TYPED.length + XLSX_ONLY.length + 8 + ACCEPTED.length + MALFORMED.length,
    );
    expect(TYPED.length).toBe(22);
    expect(XLSX_ONLY.length).toBe(13);
    expect(ACCEPTED.length).toBe(7);
    expect(MALFORMED.length).toBe(56);
    // All eight round-2 D6 probes are in it.
    expect(MALFORMED.filter((p) => p.grader !== undefined)).toHaveLength(8);
  });

  it("whenever the gate verifies, the grader passes (no exception since the pre-scan)", async () => {
    const verifiedNotPassed: string[] = [];
    const verifiedMalformed: string[] = [];
    for (const [name, intent, bytes] of all) {
      if ((await gateResult(intent, "xlsx", bytes)).verdict !== "verified") continue;
      if (name.startsWith("structure, malformed: ")) verifiedMalformed.push(name);
      if (graderXlsx(intent, bytes) !== "pass") verifiedNotPassed.push(name);
    }
    expect(verifiedMalformed).toEqual([]);
    expect(verifiedNotPassed).toEqual([]);
  });

  it("no workbook is verified by the gate and failed by the grader", async () => {
    const unsound: string[] = [];
    const graderCannotLook: string[] = [];
    let verified = 0;
    for (const [name, intent, bytes] of all) {
      if ((await gateResult(intent, "xlsx", bytes)).verdict !== "verified") continue;
      verified++;
      const status = graderXlsx(intent, bytes);
      if (status === "ungradable") graderCannotLook.push(name);
      else if (status !== "pass") unsound.push(name);
    }
    expect(unsound).toEqual([]);
    expect(graderCannotLook).toEqual([]);
    // The claim is not vacuous: the exact edits, LibreOffice's exact files and the xlsx-only
    // string probes all verify.
    expect(verified).toBeGreaterThanOrEqual(15);
  });
});
