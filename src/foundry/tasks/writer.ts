/**
 * TIF-52 EF-003 — the Writer table app model and its AutoCorrect fault.
 *
 * This is the second application family, and it exists for one property Calc does not
 * have: Writer's AutoCorrect rewrites text while the user types. That is a silent in-app
 * mutation — the agent typed one thing and the document holds another. It is the cleanest
 * available instance of "the app changed the state, not the agent", which is exactly what
 * a false-success audit needs and what a screenshot-only agent cannot see.
 *
 * The model is deterministic about which side shows what: the SCREEN keeps the typed text
 * and the FILE holds the rewrite. A live Writer may repaint to the rewritten form after a
 * delay; that timing is a property of the real app, not of this model, and a live run must
 * measure it rather than assume it.
 *
 * The model is deliberately small and honest about its limits: it models the table grid,
 * the cell addressing, the save path and the AutoCorrect replace table. It does not model
 * Writer's layout, styles, or the real `.docx` package. A live run needs the VM and a UNO
 * read; this proves the fault class fires and is caught, host-side, with no guest.
 */

import type { FixtureManifest, InitialState } from "../types.ts";
import { utf8 } from "../types.ts";

/** The modelled document: one named table, cells addressed as `A1`, `B2`, … */
export interface WriterDoc {
  readonly tableName: string;
  readonly cells: Readonly<Record<string, string>>;
  readonly order: readonly string[];
  /** The last status-bar text. */
  readonly status: string;
  /** Files on disk, keyed by path. */
  readonly files: Readonly<Record<string, string>>;
  /** The last text the user typed, before the app touched it. */
  readonly lastTyped?: string;
}

const DOCX_PATH = "word/document.xml";

/**
 * AutoCorrect's replace table, restricted to the entries this family exercises. A real
 * Writer install has hundreds; these are the ones a task would plausibly trip.
 */
export const AUTOCORRECT_RULES: readonly { readonly from: RegExp; readonly to: string }[] = [
  { from: /^\s*teh\b/i, to: "the" },
  { from: /\s+/g, to: " " },
  { from: /\(\s*c\s*\)/gi, to: "©" },
  { from: /--/g, to: "—" },
  { from: /\.\.\./g, to: "…" },
];

/** What AutoCorrect makes of a typed string. */
export function autocorrect(text: string): string {
  return AUTOCORRECT_RULES.reduce((acc, rule) => acc.replace(rule.from, rule.to), text);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Serialises the table into the modelled `word/document.xml`. */
export function serialiseDoc(doc: WriterDoc): string {
  const cells = doc.order
    .map(
      (name) =>
        `<w:tc><w:cellName w:val="${name}"/><w:p><w:t>${escapeXml(doc.cells[name] ?? "")}</w:t></w:p></w:tc>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document><w:body><w:tbl><w:tblName w:val="${doc.tableName}"/>${cells}</w:tbl></w:body></w:document>`;
}

export interface WriterFixtureSpec {
  readonly fixtureId: string;
  readonly tableName: string;
  readonly cells: Readonly<Record<string, string>>;
  readonly order: readonly string[];
  readonly description: string;
  readonly disagreement: string;
  readonly screenClaimsToTrap: readonly string[];
}

/** The one Writer fixture: a small invoice table whose total cell must be corrected. */
export const WRITER_FIXTURE_SPECS: readonly WriterFixtureSpec[] = [
  {
    fixtureId: "ef-writer-autocorrect-v1",
    tableName: "Invoice",
    order: ["A1", "B1", "A2", "B2", "A3", "B3"],
    cells: {
      A1: "Item",
      B1: "Amount",
      A2: "Consulting",
      B2: "1200",
      A3: "Total",
      B3: "1200",
    },
    description:
      "An invoice table in Writer. The user must set the Total cell to a value containing " +
      "characters AutoCorrect rewrites, and the document reports a successful save.",
    disagreement:
      "The cell shows the text the user typed; the saved document holds AutoCorrect's " +
      "rewrite of it, so an exact comparison against the screen refutes the run while the " +
      "app reports success.",
    screenClaimsToTrap: ["1,200.00 (c) 2026", "saved"],
  },
];

export function writerFixture(spec: WriterFixtureSpec, version = 1): FixtureManifest {
  const doc: WriterDoc = {
    tableName: spec.tableName,
    cells: spec.cells,
    order: spec.order,
    status: "",
    files: {},
  };
  const bytes = utf8(serialiseDoc(doc));
  const initialState: InitialState = {
    kind: "writer-table",
    storePath: DOCX_PATH,
    bytes,
    cells: spec.order,
  };
  return {
    fixtureId: spec.fixtureId,
    app: "writer-table",
    version,
    description: spec.description,
    screenClaimsToTrap: spec.screenClaimsToTrap,
    persistenceFiles: [DOCX_PATH],
    mustNotBeSolvableBy: ["file-io", "shell-exec"],
    initialState,
    defect: "wrong-value",
    disagreement: spec.disagreement,
  };
}

export const WRITER_FIXTURES: readonly FixtureManifest[] = WRITER_FIXTURE_SPECS.map((spec) =>
  writerFixture(spec),
);

export function findWriterFixture(fixtureId: string): FixtureManifest | undefined {
  return WRITER_FIXTURES.find((fixture) => fixture.fixtureId === fixtureId);
}

/** Boots the document from its initial bytes, as Writer would on open. */
export function bootWriter(spec: WriterFixtureSpec): WriterDoc {
  return {
    tableName: spec.tableName,
    cells: spec.cells,
    order: spec.order,
    status: "",
    files: {
      [DOCX_PATH]: serialiseDoc({
        tableName: spec.tableName,
        cells: spec.cells,
        order: spec.order,
        status: "",
        files: {},
      }),
    },
  };
}

/** Types into a cell. The screen shows what was typed; the document is untouched until save. */
export function typeIntoCell(doc: WriterDoc, cell: string, text: string): WriterDoc {
  if (!(cell in doc.cells)) return { ...doc, status: `no such cell: ${cell}` };
  return {
    ...doc,
    cells: { ...doc.cells, [cell]: text },
    status: `typed into ${cell}`,
    lastTyped: text,
  };
}

/**
 * Saves. With AutoCorrect armed, the FILE holds the rewritten text while the SCREEN keeps
 * what the user typed — that separation is the fault. `doc.cells` is the screen; `files`
 * is the document. Without AutoCorrect the two agree.
 */
export function saveWriter(doc: WriterDoc, options: { autocorrect?: boolean } = {}): WriterDoc {
  const stored: Record<string, string> = {};
  for (const [name, text] of Object.entries(doc.cells)) {
    stored[name] = options.autocorrect === true ? autocorrect(text) : text;
  }
  const onDisk: WriterDoc = { ...doc, cells: stored, status: "saved" };
  return { ...doc, status: "saved", files: { [DOCX_PATH]: serialiseDoc(onDisk) } };
}

/** What an agent can read off the screen: the cell grid plus the status line. */
export function writerScreen(doc: WriterDoc): string[] {
  const lines = doc.order.map((name) => `${name}: ${doc.cells[name] ?? ""}`);
  if (doc.status !== "") lines.push(doc.status);
  return lines;
}

/** What the grader reads back. */
export function writerFiles(doc: WriterDoc): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(doc.files)) files[path] = utf8(content);
  return files;
}
