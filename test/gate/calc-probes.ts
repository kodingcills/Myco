/**
 * The round-2 verifier's probe set (TIF-270 round 3, D2), shared by the gate/grader
 * agreement test (CSV) and the CSV/xlsx parity test (TIF-274 prerequisite). Moved here
 * unchanged from `calc-gate-grader-agreement.test.ts` so both tests run the same table.
 */
import type { ColumnType } from "../../src/benchmark/grade/grade.ts";
import { documentCsv } from "../../src/gate/calc-document.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";

export const SEED = "probe-seed";
export const INTENT = { rowKey: "EMP-0003", column: "qty", newValue: "4242" };
export const SPEC = { fixtureSeed: SEED, ...INTENT };
export const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
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

export type Outcome = "verified" | "refuted";
export interface Probe {
  readonly name: string;
  readonly csv: string;
  /** Both implementations' answer, as `gate`/`grader`. */
  readonly gate: Outcome;
  readonly grader: "pass" | "fail";
}

export const AGREE: Probe[] = [
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
];

/** Known divergences: the gate refutes, the grader passes. Never the other way round. */
export const KNOWN_DIVERGENCES: Probe[] = [
  { name: "RFC 4180 quoted target", csv: quotedTarget(), gate: "refuted", grader: "pass" },
  {
    name: "CR-only line endings",
    csv: exact.replaceAll("\n", "\r"),
    gate: "refuted",
    grader: "pass",
  },
];
