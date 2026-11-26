/**
 * Track R: the one document format a recording, a workflow and a derived oracle speak.
 *
 * The gate stays CSV-only for Calc until the xlsx replacement for #503 lands, so the
 * recorded document, the replayed document and the derived oracle's input are all CSV. The
 * parse is strict and refuses what it cannot represent instead of guessing:
 *  - bytes must be UTF-8 (`fatal` decode);
 *  - a double quote anywhere is refused (no RFC 4180 unquoting: a quoted field would be
 *    read differently here and in Calc, so it is "could not look", never a verdict);
 *  - lines split on LF or CRLF; trailing empty lines are no content.
 * Row 0 is the header; column 0 is the record key.
 */
import { createHash } from "node:crypto";

export class CsvDocumentError extends Error {
  override readonly name = "CsvDocumentError";
}

export type Rows = readonly (readonly string[])[];

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseCsvRows(bytes: Uint8Array): string[][] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CsvDocumentError("document is not valid UTF-8");
  }
  if (text.includes('"')) throw new CsvDocumentError("document holds a quoted field");
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split(","));
}

export function serializeCsvRows(rows: Rows): string {
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

/** A1 column letters for a 0-based column index. */
export function columnLetters(col: number): string {
  let name = "";
  let c = col;
  do {
    name = String.fromCharCode(65 + (c % 26)) + name;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return name;
}

export function a1(row: number, col: number): string {
  return `${columnLetters(col)}${row + 1}`;
}

/** Parse an A1 ref into 0-based row/col, or undefined. */
export function parseA1(ref: string): { row: number; col: number } | undefined {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]) - 1, col: col - 1 };
}

/** Characters a CSV cell of this format cannot hold. */
export const CSV_UNSAFE = /[,\r\n"]/;

/**
 * Locate a keyed cell: the row whose column 0 is `rowKey` (exactly one, below the header)
 * and the column whose header is `column` (exactly one, not the key column).
 */
export function locateKeyed(
  rows: Rows,
  rowKey: string,
  column: string,
): { row: number; col: number } | { error: "no-record" | "no-column" | "ambiguous" } {
  const header = rows[0] ?? [];
  const cols = header.flatMap((h, i) => (h === column && i > 0 ? [i] : []));
  const keyRows = rows.flatMap((r, i) => (i > 0 && r[0] === rowKey ? [i] : []));
  if (cols.length > 1 || keyRows.length > 1) return { error: "ambiguous" };
  if (cols.length === 0) return { error: "no-column" };
  if (keyRows.length === 0) return { error: "no-record" };
  return { row: keyRows[0] as number, col: cols[0] as number };
}
