/**
 * TIF-270 round 3 (D2): the gate's whole-document Calc check (`calc-record-edit` v2) and the
 * independent grader (`src/benchmark/grade/`) must agree on every document of the round-2
 * verifier's probe set. Both read the same bytes: the gate through `createGate` and the
 * mock-path file reader, the grader through `grade()`.
 *
 * Trailing rows with no content (blank lines, CRLF blank lines, `,,,,` rows at the end) are
 * no content to both, like a trailing empty column; interior blank or all-empty rows shift
 * the records below them and fail both. A trailing row WITH content (`,,x,,`, a blank line
 * then `x`, or a cell holding only whitespace) is an added cell: refuted with
 * DOCUMENT_COLLATERAL by the gate and failed by the grader (round-3 S-1, follow-up to #485).
 *
 * Two rows are KNOWN DIVERGENCES, pinned here on purpose (false refutes, never a false
 * done): an RFC 4180 quoted target and CR-only line endings. The grader parses RFC 4180 and
 * splits on CR; the gate's strict parse does neither (documented in
 * `src/gate/calc-document.ts` and `docs/gate/api.md`, "Row structure"). If either is ever
 * fixed, its pin fails and moves to the agreeing rows.
 */
import { describe, expect, it } from "vitest";
import { type ColumnType, grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { documentCsv } from "../../src/gate/calc-document.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";
import { tempRoot, writeState } from "./helpers.ts";

const SEED = "probe-seed";
const INTENT = { rowKey: "EMP-0003", column: "qty", newValue: "4242" };
const SPEC = { fixtureSeed: SEED, ...INTENT };
const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);

const exact = documentCsv(SEED, [INTENT]);
const lines = exact.trimEnd().split("\n");

/** Insert raw `extra` lines after line `at` (header = line 0), joined with `eol`. */
function insert(at: number, extra: readonly string[], eol = "\n"): string {
  const out = [...lines];
  out.splice(at + 1, 0, ...extra);
  return `${out.join(eol)}${eol}`;
}

/** The exact document with the target cell written as an RFC 4180 quoted field. */
function quotedTarget(): string {
  const col = generateFixture(SEED).header.indexOf(INTENT.column);
  const out = lines.map((line) => {
    if (!line.startsWith(`${INTENT.rowKey},`)) return line;
    const cells = line.split(",");
    cells[col] = `"${cells[col]}"`;
    return cells.join(",");
  });
  return `${out.join("\n")}\n`;
}

type Outcome = "verified" | "refuted";
interface Probe {
  readonly name: string;
  readonly csv: string;
  /** Both implementations' answer, as `gate`/`grader`. */
  readonly gate: Outcome;
  readonly grader: "pass" | "fail";
}

const AGREE: Probe[] = [
  { name: "exact, LF", csv: exact, gate: "verified", grader: "pass" },
  { name: "exact, CRLF", csv: exact.replaceAll("\n", "\r\n"), gate: "verified", grader: "pass" },
  { name: "exact, no trailing newline", csv: exact.trimEnd(), gate: "verified", grader: "pass" },
  {
    name: "exact, CRLF, no trailing newline",
    csv: exact.trimEnd().replaceAll("\n", "\r\n"),
    gate: "verified",
    grader: "pass",
  },
  { name: "blank line after the header", csv: insert(0, [""]), gate: "refuted", grader: "fail" },
  { name: "blank line mid-sheet", csv: insert(30, [""]), gate: "refuted", grader: "fail" },
  {
    name: "two interior blank lines (apart)",
    csv: (() => {
      const out = [...lines];
      out.splice(40, 0, "");
      out.splice(10, 0, "");
      return `${out.join("\n")}\n`;
    })(),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "two consecutive blank lines",
    csv: insert(20, ["", ""]),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "CRLF blank line inside a CRLF sheet",
    csv: insert(5, [""], "\r\n"),
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "',,,,' row inside the sheet",
    csv: insert(12, [",,,,"]),
    gate: "refuted",
    grader: "fail",
  },
  { name: "blank line at the end", csv: `${exact}\n`, gate: "verified", grader: "pass" },
  { name: "two blank lines at the end", csv: `${exact}\n\n`, gate: "verified", grader: "pass" },
  {
    name: "CRLF blank line at the end",
    csv: `${exact.replaceAll("\n", "\r\n")}\r\n`,
    gate: "verified",
    grader: "pass",
  },
  { name: "',,,,' row at the end", csv: `${exact},,,,\n`, gate: "verified", grader: "pass" },
  {
    name: "',,,,' rows and blank lines at the end, mixed",
    csv: `${exact},,,,\r\n\n,,\n`,
    gate: "verified",
    grader: "pass",
  },
  // S-1 (round-3 verdict, follow-up to #485): a trailing row WITH content is a cell the
  // agent added, so it is refuted (DOCUMENT_COLLATERAL) and the grader fails it. Only rows
  // with no content at all are ignored at the end.
  { name: "',,x,,' row at the end", csv: `${exact},,x,,\n`, gate: "refuted", grader: "fail" },
  {
    name: "',,x,,' row at the end, no trailing newline",
    csv: `${exact},,x,,`,
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "blank line, then an 'x' row, at the end",
    csv: `${exact}\nx\n`,
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "',,,,' row, then a ',,x,,' row, at the end",
    csv: `${exact},,,,\n,,x,,\n`,
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "trailing row whose only content is whitespace in one cell (', ,,,')",
    csv: `${exact}, ,,,\n`,
    gate: "refuted",
    grader: "fail",
  },
  {
    name: "trailing row whose only content is a tab in one cell",
    csv: `${exact},,\t,,\n`,
    gate: "refuted",
    grader: "fail",
  },
];

/** Known divergences: the gate refutes, the grader passes. Never the other way round. */
const KNOWN_DIVERGENCES: Probe[] = [
  { name: "RFC 4180 quoted target", csv: quotedTarget(), gate: "refuted", grader: "pass" },
  {
    name: "CR-only line endings",
    csv: exact.replaceAll("\n", "\r"),
    gate: "refuted",
    grader: "pass",
  },
];

async function gateVerdict(csv: string) {
  const root = tempRoot();
  writeState(root, "r", "sheet.csv", csv);
  return createGate({
    tasks: buildRegistry([
      { id: "probe", family: "calc-record-edit", stateFile: "sheet.csv", spec: SPEC },
    ]),
    reader: fileEvidenceReader(root),
    assignment: { taskId: "probe", runId: "r" },
  }).check({ taskId: "probe", runId: "r" });
}

function graderStatus(csv: string) {
  const fixtureCsv = Buffer.from(generateFixture(SEED).csv);
  return grade({
    fixtureCsv,
    fixtureSha256: sha256(fixtureCsv),
    persisted: { format: "csv", bytes: Buffer.from(csv) },
    intent: INTENT,
    columnTypes: COLUMN_TYPES,
  }).status;
}

describe("gate and grader agree on the round-2 verifier's probe set (round-3 D2)", () => {
  it.each(AGREE.map((p) => [p.name, p] as const))("%s", async (_name, probe) => {
    const result = await gateVerdict(probe.csv);
    const status = graderStatus(probe.csv);
    expect({ gate: result.verdict, grader: status }).toEqual({
      gate: probe.gate,
      grader: probe.grader,
    });
    // The agreement itself, stated directly: verified exactly when the grader passes.
    expect(result.verdict === "verified").toBe(status === "pass");
    if (result.verdict === "refuted") expect(result.reasonCodes).toContain("DOCUMENT_COLLATERAL");
  });

  it.each(KNOWN_DIVERGENCES.map((p) => [p.name, p] as const))(
    'KNOWN DIVERGENCE (false refute, documented in docs/gate/api.md "Row structure"): %s',
    async (_name, probe) => {
      const result = await gateVerdict(probe.csv);
      expect(result.verdict).toBe(probe.gate);
      expect(result.accepted).toBe(false);
      expect(graderStatus(probe.csv)).toBe(probe.grader);
    },
  );
});
