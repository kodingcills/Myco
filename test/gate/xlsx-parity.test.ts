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
 * grader (its own xlsx reader) passes the same bytes. On the probe table the two agree
 * outright, including the two CSV-only divergences (a quoted field and CR-only lines are
 * just text in a workbook, which both refute).
 */
import { describe, expect, it } from "vitest";
import { grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { documentCsv } from "../../src/gate/calc-document.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { xlsxFromCsv } from "../../src/tasks/calc-xlsxgen.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { AGREE, COLUMN_TYPES, KNOWN_DIVERGENCES, SEED } from "./calc-probes.ts";
import { tempRoot, writeState } from "./helpers.ts";

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

  it.each(probes.map((p) => [p.name, p] as const))("%s", async (_name, probe) => {
    const xlsx = xlsxFromCsv(probe.csv);
    const fromCsv = await gateResult(PROBE_INTENT, "csv", probe.csv);
    const fromXlsx = await gateResult(PROBE_INTENT, "xlsx", xlsx);
    expect(fromCsv.verdict).toBe(probe.gate);
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
