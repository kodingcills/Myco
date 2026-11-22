/**
 * HIDDEN SPLIT — TIF-52 EF-003: the LibreOffice Writer table app.
 *
 * Writer is the second application family for one reason worth more than a second
 * dataset: its AutoCorrect rewrites text while the user types (docs/research/findings/
 * m2-03-second-app-selection.md §2.1), which is a silent in-app state mutation Calc
 * cannot produce. A verifier that compares the screen to the intent therefore disagrees
 * with the file for a reason the agent never typed.
 *
 * The persisted format modelled here is a saved `.docx` table as the Foundry reads it:
 * the same `word/document.xml` `w:tbl` / `w:tc` structure the repo already plans to
 * parse host-side (m2-03 §2.1, the `[INFERENCE]` row). Cells are addressed by name
 * (`A1`, `B2`), which is exactly how `XTextTable.getCellByName` addresses them live, so
 * the same task survives the move from this model to a real UNO read.
 *
 * Everything here is answer derivation and therefore hidden (contract §6).
 */

import type { InitialState, OracleCheck, StateOracle, TaskIntent } from "../types.ts";
import { decodeBytes, FoundryReadError, utf8 } from "../types.ts";

/** The subset of `word/document.xml` this oracle reads: a grid of text cells. */
export interface WriterTable {
  readonly tableName: string;
  /** Cell name -> text, in row-major order. */
  readonly cells: Readonly<Record<string, string>>;
  /** Cell names in document order, so position is part of the contract. */
  readonly order: readonly string[];
}

const DOCX_PATH = "word/document.xml";

/** Decodes the modelled document: one `<w:tbl>`, cells carrying `<w:t>` text. */
function parseWriterTable(files: Readonly<Record<string, Uint8Array>>): WriterTable {
  const bytes = files[DOCX_PATH];
  if (bytes === undefined) {
    throw new FoundryReadError("missing", `${DOCX_PATH} is absent; the document was never saved`);
  }
  const xml = decodeBytes(bytes);
  const tableName = /<w:tblName[^>]*w:val="([^"]+)"/.exec(xml)?.[1];
  if (tableName === undefined)
    throw new FoundryReadError("corrupt", "no table name in the document");
  const order: string[] = [];
  const cells: Record<string, string> = {};
  for (const match of xml.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)) {
    const body = match[1] ?? "";
    const name = /<w:cellName[^>]*w:val="([^"]+)"/.exec(body)?.[1];
    if (name === undefined) throw new FoundryReadError("corrupt", "a cell has no name");
    const text = [...body.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? "").join("");
    if (name in cells) throw new FoundryReadError("corrupt", `duplicate cell ${name}`);
    cells[name] = text;
    order.push(name);
  }
  if (order.length === 0) throw new FoundryReadError("corrupt", "the document has no cells");
  return { tableName, cells, order };
}

/** Serialises a table back into the modelled document. */
export function serialiseWriterTable(table: WriterTable): Uint8Array {
  const cells = table.order
    .map(
      (name) =>
        `<w:tc><w:cellName w:val="${name}"/><w:p><w:t>${escapeXml(table.cells[name] ?? "")}</w:t></w:p></w:tc>`,
    )
    .join("");
  return utf8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document><w:body><w:tbl><w:tblName w:val="${table.tableName}"/>${cells}</w:tbl></w:body></w:document>`,
  );
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isWriterInitial(
  initial: InitialState,
): initial is Extract<InitialState, { kind: "writer-table" }> {
  return initial.kind === "writer-table";
}

/**
 * Expected end state: the named cell holds the text the user asked for, and every other
 * cell is untouched. AutoCorrect is deliberately NOT modelled — the honest expectation is
 * what the user asked for, and the fault is what makes the file disagree with it.
 */
function expectedWriterTable(intent: TaskIntent, initial: InitialState): WriterTable {
  if (intent.kind !== "writer.set-cell") {
    throw new FoundryReadError(
      "unreadable",
      `writer oracle cannot evaluate a ${intent.kind} intent`,
    );
  }
  if (!isWriterInitial(initial)) {
    throw new FoundryReadError("unreadable", `writer oracle got a ${initial.kind} initial state`);
  }
  const current = parseWriterTable({ [DOCX_PATH]: initial.bytes });
  if (!(intent.cell in current.cells)) {
    throw new FoundryReadError(
      "unreadable",
      `intent names a cell the document does not hold: ${intent.cell}`,
    );
  }
  if (intent.table !== current.tableName) {
    throw new FoundryReadError(
      "unreadable",
      `intent names table ${intent.table}, document holds ${current.tableName}`,
    );
  }
  return { ...current, cells: { ...current.cells, [intent.cell]: intent.value } };
}

function compareWriter(actual: WriterTable, expected: WriterTable): OracleCheck[] {
  const checks: OracleCheck[] = [];
  checks.push({
    name: "writer:table",
    passed: actual.tableName === expected.tableName,
    reason:
      actual.tableName === expected.tableName ? "same table" : `wrong table ${actual.tableName}`,
    weight: 0,
  });
  const sameOrder = actual.order.join("\u0000") === expected.order.join("\u0000");
  checks.push({
    name: "writer:shape",
    passed: sameOrder,
    reason: sameOrder ? "cell grid unchanged" : `grid changed: ${actual.order.join(",")}`,
    weight: 0,
  });
  for (const [name, text] of Object.entries(expected.cells)) {
    const got = actual.cells[name];
    checks.push({
      name: `writer:cell:${name}`,
      passed: got === text,
      reason:
        got === text
          ? "exact text"
          : `expected ${JSON.stringify(text)}, stored ${JSON.stringify(got ?? null)}`,
      weight: 0,
    });
  }
  const weight = checks.length === 0 ? 0 : 1 / checks.length;
  return checks.map((check) => ({ ...check, weight }));
}

export const WRITER_ORACLE_VERSION = 1;

export function writerStateOracle(): StateOracle {
  return {
    app: "writer-table",
    version: WRITER_ORACLE_VERSION,
    read: parseWriterTable,
    expected: expectedWriterTable,
    compare: (actual, expected) => compareWriter(actual as WriterTable, expected as WriterTable),
  };
}
