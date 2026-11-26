/**
 * Example `myco.plugin/1` plugin: "ledger", a simple text/CSV app (capability track T).
 *
 * The app saves a ledger as UTF-8 CSV: a header row, one row per entry (no quoting: fields
 * never contain commas, quotes or newlines), then a trailer line `#rows,<n>` and a final
 * newline. The trailer is what lets this oracle tell a complete save from a truncated one.
 *
 * Task intent: "set column C of the row whose `id` is K to V". The oracle reads the saved
 * bytes in full and says:
 *  - `uncertain` when it cannot read the whole document (missing, not UTF-8, ragged, no or
 *    wrong trailer, duplicate id): it never guesses;
 *  - `refuted` when the document is complete and the target does not hold V;
 *  - `verified` only when the document is complete and the target holds exactly V.
 * It claims edit-missing, wrong-value, wrong-target, truncated and missing-file. It does NOT
 * claim collateral (it checks the target only) or corrupt-byte (a flipped byte in another
 * row is invisible to a target-only check); the self-test report shows those gaps.
 *
 * Runtime-import-free on purpose (only `import type`), so the directory is self-contained.
 */
import type {
  OracleAnswer,
  PluginDocument,
  PluginModule,
  PluginSelfTestCase,
  ReaderAnswer,
  StateCell,
} from "../../../src/plugins/sdk/index.ts";

export interface LedgerIntent {
  readonly id: string;
  readonly column: string;
  readonly value: string;
}

type Parsed =
  | { readonly ok: true; readonly header: readonly string[]; readonly rows: readonly string[][] }
  | { readonly ok: false; readonly code: string };

const TRAILER = /^#rows,(0|[1-9]\d{0,6})$/;

/** Strict parse of a complete ledger; anything unexpected is a code, never a guess. */
export function parseLedger(bytes: Uint8Array | null): Parsed {
  if (bytes === null) return { ok: false, code: "FILE_MISSING" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: "NOT_UTF8" };
  }
  if (!text.endsWith("\n")) return { ok: false, code: "INCOMPLETE_SAVE" };
  const lines = text.slice(0, -1).split("\n");
  const trailer = TRAILER.exec(lines.pop() ?? "");
  if (trailer === null) return { ok: false, code: "INCOMPLETE_SAVE" };
  const headerLine = lines.shift();
  if (headerLine === undefined || headerLine === "") return { ok: false, code: "NO_HEADER" };
  if (lines.length !== Number(trailer[1])) return { ok: false, code: "INCOMPLETE_SAVE" };
  if (/["\r]/.test(text)) return { ok: false, code: "UNSUPPORTED_QUOTING" };
  const header = headerLine.split(",");
  if (new Set(header).size !== header.length || header[0] !== "id")
    return { ok: false, code: "BAD_HEADER" };
  const rows = lines.map((l) => l.split(","));
  if (rows.some((r) => r.length !== header.length)) return { ok: false, code: "RAGGED_ROW" };
  return { ok: true, header, rows };
}

export function verifyLedger(doc: PluginDocument, intent: LedgerIntent): OracleAnswer {
  const p = parseLedger(doc.bytes);
  if (!p.ok) return { status: "uncertain", code: p.code };
  const col = p.header.indexOf(intent.column);
  if (col < 0) return { status: "refuted", code: "TARGET_COLUMN_MISSING" };
  const matches = p.rows.filter((r) => r[0] === intent.id);
  if (matches.length > 1) return { status: "uncertain", code: "AMBIGUOUS_ROW" };
  const row = matches[0];
  if (row === undefined) return { status: "refuted", code: "TARGET_ROW_MISSING" };
  return row[col] === intent.value
    ? { status: "verified", code: "POSTCONDITION_HOLDS" }
    : { status: "refuted", code: "VALUE_MISMATCH" };
}

function columnLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function readLedger(doc: PluginDocument): ReaderAnswer {
  const p = parseLedger(doc.bytes);
  if (!p.ok) return { status: "uncertain", code: p.code };
  const cells: StateCell[] = [];
  [p.header, ...p.rows].forEach((row, r) => {
    row.forEach((v, c) => {
      const ref = `${columnLetter(c)}${r + 1}`;
      if (v === "") cells.push({ ref, value: null, valueKind: "empty", formula: false });
      else if (r > 0 && NUMBER.test(v))
        cells.push({ ref, value: Number(v), valueKind: "number", formula: false });
      else cells.push({ ref, value: v, valueKind: "string", formula: false });
    });
  });
  return { status: "ok", code: "READ_OK", state: { kind: "cells", cells } };
}

// ---------------------------------------------------------------------------
// Self-test cases (R5): one correct save and its seeded corruptions per case.
// ---------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);

export function renderLedger(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return `${[header.join(","), ...rows.map((r) => r.join(","))].join("\n")}\n#rows,${rows.length}\n`;
}

const HEADER = ["id", "payee", "amount", "category"] as const;

/** A deterministic ledger of `n` rows from `seed` (no randomness: the self-test is replayable). */
export function ledgerRows(seed: number, n: number): string[][] {
  const payees = ["Rent", "Grocer", "Utility", "Transit", "Bakery", "Clinic", "Library"];
  const cats = ["home", "food", "bills", "travel"];
  return Array.from({ length: n }, (_, i) => [
    String(i + 1),
    payees[(seed + i) % payees.length] as string,
    String(((seed * 37 + i * 53) % 900) + 10),
    cats[(seed + 2 * i) % cats.length] as string,
  ]);
}

function withCell(rows: readonly string[][], r: number, c: number, v: string): string[][] {
  return rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : [...row]));
}

export function selftestCases(): PluginSelfTestCase<LedgerIntent>[] {
  const specs = [
    { seed: 1, n: 5, row: 2, column: "amount", value: "455" },
    { seed: 4, n: 12, row: 0, column: "payee", value: "Hardware" },
    { seed: 9, n: 8, row: 7, column: "category", value: "gifts" },
  ];
  return specs.map((s, k) => {
    const before = ledgerRows(s.seed, s.n);
    const col = HEADER.indexOf(s.column as (typeof HEADER)[number]);
    const neighbour = s.row === s.n - 1 ? s.row - 1 : s.row + 1;
    const fileName = `ledger-${k + 1}.csv`;
    const doc = (rows: readonly string[][]) => ({
      fileName,
      bytes: enc(renderLedger(HEADER, rows)),
    });
    const correctText = renderLedger(HEADER, withCell(before, s.row, col, s.value));
    const correct = { fileName, bytes: enc(correctText) };
    return {
      id: `ledger-${k + 1}`,
      intent: { id: String(s.row + 1), column: s.column, value: s.value },
      correct,
      corruptions: [
        { cls: "edit-missing", doc: doc(before) },
        { cls: "wrong-value", doc: doc(withCell(before, s.row, col, `${s.value}0`)) },
        { cls: "wrong-target", doc: doc(withCell(before, neighbour, col, s.value)) },
        // A save cut off before its trailer line.
        {
          cls: "truncated",
          doc: { fileName, bytes: enc(correctText.slice(0, correctText.lastIndexOf("#rows"))) },
        },
        { cls: "missing-file", doc: { fileName, bytes: null } },
      ],
    };
  });
}

const plugin: PluginModule<LedgerIntent> = {
  oracle: verifyLedger,
  reader: readLedger,
  selftestCases,
};
export default plugin;
