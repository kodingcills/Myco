/**
 * writer-doc-edit task family: the host-only Writer oracle's tasks (TIF-99 / M2-08).
 *
 * This module is the host-side half of the oracle: the fixture document, the intent
 * parameters, and the ground truth. It never reads a saved file. The Writer read path
 * (`src/verify/writer-reader.ts`) and the oracle (`src/verify/writer-oracle.ts`) consume
 * what it computes.
 *
 * Ground-truth discipline mirrors calc-record-edit (ADR-0005): every expected value is
 * computed from `fixtureSeed` + intent params on the host. No agent claim, screen text,
 * trace event or saved file can reach `groundTruth()`; its only input is the params
 * record, and it imports nothing from the read path (pinned by test/writer-oracle.test.ts).
 *
 * Four postcondition kinds, each a check on the saved file:
 *   - paragraph-text:  top-level paragraph #i has exactly this text;
 *   - heading-level:   the (unique) paragraph with this text is a heading of level L;
 *   - table-cell:      table #t, cell "B2" (Writer's cell naming), has exactly this text;
 *   - paragraph-style: top-level paragraph #i uses the paragraph style with this name.
 */

import type { TaskIntent } from "../core/verify.ts";
import { hash32 } from "./fixture.ts";

export const WRITER_TASK_ID = "writer-doc-edit";

// ---------------------------------------------------------------------------
// Document model (what a fixture is, and what the generator serialises)
// ---------------------------------------------------------------------------

/** A top-level paragraph. `style` is the paragraph style's display name. */
export interface WriterParagraphSpec {
  readonly kind: "paragraph";
  readonly text: string;
  readonly style: string;
  /** Outline level 1..9 for a heading; null for a body paragraph. */
  readonly headingLevel: number | null;
}

/** A simple table: `rows[r][c]` is the text of the cell named `<col letter><r+1>`. */
export interface WriterTableSpec {
  readonly kind: "table";
  readonly rows: readonly (readonly string[])[];
}

export type WriterBlockSpec = WriterParagraphSpec | WriterTableSpec;

export interface WriterDocSpec {
  readonly blocks: readonly WriterBlockSpec[];
}

/** Custom paragraph styles every fixture defines (both formats keep the display name). */
export const BODY_STYLE = "Myco Body";
export const NOTE_STYLE = "Myco Note";
export const CUSTOM_STYLES = [BODY_STYLE, NOTE_STYLE] as const;

export function headingStyle(level: number): string {
  return `Heading ${level}`;
}

// ---------------------------------------------------------------------------
// Deterministic fixture
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = ["The team", "Our vendor", "The pilot", "Finance", "The board", "Support"];
const VERBS = ["reviewed", "approved", "deferred", "measured", "updated", "flagged"];
const OBJECTS = ["the budget", "the schedule", "two risks", "the backlog", "the audit", "costs"];
const SECTIONS = ["Budget review", "Open risks", "Next steps", "Staffing plan"];
const ITEMS = ["Laptops", "Licences", "Travel", "Training", "Hosting", "Printing"];
const OWNERS = ["Ada", "Grace", "Linus", "Barbara", "Ken", "Edsger"];
const STATUSES = ["Open", "Blocked", "Planned", "Waiting"];

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T;
}

function sentence(r: () => number): string {
  return `${pick(r, SUBJECTS)} ${pick(r, VERBS)} ${pick(r, OBJECTS)} in week ${1 + Math.floor(r() * 52)}.`;
}

function body(text: string): WriterParagraphSpec {
  return { kind: "paragraph", text, style: BODY_STYLE, headingLevel: null };
}

function heading(text: string, level: number): WriterParagraphSpec {
  return { kind: "paragraph", text, style: headingStyle(level), headingLevel: level };
}

/** Block index of the fixture's lone level-2 heading and of the heading candidate. */
export const SECTION_HEADING_BLOCK = 3;
export const PROMOTE_CANDIDATE_BLOCK = 5;

/**
 * The fixture for a seed. Layout is fixed (so tasks can address it); text varies:
 *   0 H1 title · 1 P · 2 P · 3 H2 section · 4 P · 5 P (short, heading candidate)
 *   6 table 3x3 (header row Item/Owner/Status) · 7 P
 */
export function writerFixture(seed: string): WriterDocSpec {
  const r = mulberry32(hash32(`writer:${seed}`));
  const tag = `${seed}`.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24) || "seed";
  const rows: string[][] = [["Item", "Owner", "Status"]];
  for (let i = 0; i < 2; i++) rows.push([pick(r, ITEMS), pick(r, OWNERS), pick(r, STATUSES)]);
  return {
    blocks: [
      heading(`Project report ${tag}`, 1),
      body(sentence(r)),
      body(sentence(r)),
      heading(pick(r, SECTIONS), 2),
      body(sentence(r)),
      body(`Action items ${1 + Math.floor(r() * 9)}`),
      { kind: "table", rows },
      body(sentence(r)),
    ],
  };
}

/** Top-level paragraphs in document order (tables are not paragraphs). */
export function paragraphsOf(spec: WriterDocSpec): WriterParagraphSpec[] {
  return spec.blocks.filter((b): b is WriterParagraphSpec => b.kind === "paragraph");
}

export function tablesOf(spec: WriterDocSpec): WriterTableSpec[] {
  return spec.blocks.filter((b): b is WriterTableSpec => b.kind === "table");
}

// ---------------------------------------------------------------------------
// Intent parameters
// ---------------------------------------------------------------------------

export type WriterPostconditionKind =
  | "paragraph-text"
  | "heading-level"
  | "table-cell"
  | "paragraph-style";

export const WRITER_POSTCONDITION_KINDS: readonly WriterPostconditionKind[] = [
  "paragraph-text",
  "heading-level",
  "table-cell",
  "paragraph-style",
];

export type WriterDocEditParams =
  | {
      readonly fixtureSeed: string;
      readonly kind: "paragraph-text";
      readonly paragraph: number;
      readonly newText: string;
    }
  | {
      readonly fixtureSeed: string;
      readonly kind: "heading-level";
      readonly headingText: string;
      readonly level: number;
    }
  | {
      readonly fixtureSeed: string;
      readonly kind: "table-cell";
      readonly table: number;
      readonly cell: string;
      readonly newText: string;
    }
  | {
      readonly fixtureSeed: string;
      readonly kind: "paragraph-style";
      readonly paragraph: number;
      readonly style: string;
    };

/** Parses Writer's cell name ("B2") into zero-based row and column. */
export function parseCellName(name: string): { row: number; col: number } | undefined {
  const m = /^([A-Z])([1-9][0-9]*)$/.exec(name);
  if (m === null) return undefined;
  return { row: Number(m[2]) - 1, col: (m[1] as string).charCodeAt(0) - 65 };
}

export function cellName(row: number, col: number): string {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

function intParam(value: unknown): number {
  return typeof value === "number" ? value : Number(String(value ?? "NaN"));
}

/**
 * Normalises an untyped params record (the TaskIntent wire shape). Unknown kinds and
 * missing fields are not repaired here; `groundTruth()` rejects them, and the oracle
 * answers `uncertain` (ground truth not computable), as calc-record-edit does.
 */
export function normalizeWriterParams(params: Record<string, unknown>): WriterDocEditParams {
  const fixtureSeed = String(params.fixtureSeed ?? "");
  const kind = String(params.kind ?? "");
  switch (kind) {
    case "paragraph-text":
      return {
        fixtureSeed,
        kind,
        paragraph: intParam(params.paragraph),
        newText: String(params.newText ?? ""),
      };
    case "heading-level":
      return {
        fixtureSeed,
        kind,
        headingText: String(params.headingText ?? ""),
        level: intParam(params.level),
      };
    case "table-cell":
      return {
        fixtureSeed,
        kind,
        table: intParam(params.table),
        cell: String(params.cell ?? ""),
        newText: String(params.newText ?? ""),
      };
    case "paragraph-style":
      return {
        fixtureSeed,
        kind,
        paragraph: intParam(params.paragraph),
        style: String(params.style ?? ""),
      };
    default:
      throw new WriterGroundTruthError(`unknown writer postcondition kind ${JSON.stringify(kind)}`);
  }
}

export function writerIntentFor(params: WriterDocEditParams): TaskIntent {
  return { taskId: WRITER_TASK_ID, params: { ...params }, describe: describeParams(params) };
}

function describeParams(p: WriterDocEditParams): string {
  switch (p.kind) {
    case "paragraph-text":
      return `set paragraph ${p.paragraph + 1} to "${p.newText}" and save`;
    case "heading-level":
      return `make the paragraph "${p.headingText}" a level-${p.level} heading and save`;
    case "table-cell":
      return `set cell ${p.cell} of table ${p.table + 1} to "${p.newText}" and save`;
    case "paragraph-style":
      return `apply the paragraph style "${p.style}" to paragraph ${p.paragraph + 1} and save`;
  }
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

export class WriterGroundTruthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterGroundTruthError";
  }
}

/**
 * The expected postcondition, computed host-side. `previous` is what the fixture holds
 * at the target, so a task that would not change the document is rejected (it could
 * never tell an agent that did nothing from one that did the work).
 */
export type WriterGroundTruth =
  | {
      readonly kind: "paragraph-text";
      readonly paragraph: number;
      readonly expected: string;
      readonly previous: string;
    }
  | {
      readonly kind: "heading-level";
      readonly text: string;
      readonly expected: number;
      readonly previous: number | null;
    }
  | {
      readonly kind: "table-cell";
      readonly table: number;
      readonly cell: string;
      readonly row: number;
      readonly col: number;
      readonly expected: string;
      readonly previous: string;
    }
  | {
      readonly kind: "paragraph-style";
      readonly paragraph: number;
      readonly expected: string;
      readonly previous: string;
    };

function checkIndex(value: number, length: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    throw new WriterGroundTruthError(`${what} ${value} is not in the fixture (0..${length - 1})`);
  }
}

function checkText(value: string, what: string): void {
  if (value === "" || value !== value.trim() || /[\r\n\t]/.test(value)) {
    throw new WriterGroundTruthError(
      `${what} must be non-empty single-line text without edge spaces`,
    );
  }
}

export function groundTruth(params: WriterDocEditParams): WriterGroundTruth {
  if (params.fixtureSeed === "") throw new WriterGroundTruthError("fixtureSeed is empty");
  const fixture = writerFixture(params.fixtureSeed);
  const paragraphs = paragraphsOf(fixture);
  switch (params.kind) {
    case "paragraph-text": {
      checkIndex(params.paragraph, paragraphs.length, "paragraph");
      checkText(params.newText, "newText");
      const previous = (paragraphs[params.paragraph] as WriterParagraphSpec).text;
      if (previous === params.newText)
        throw new WriterGroundTruthError("newText equals the fixture text");
      if (paragraphs.some((p) => p.text === params.newText)) {
        throw new WriterGroundTruthError("newText duplicates another fixture paragraph");
      }
      return { kind: params.kind, paragraph: params.paragraph, expected: params.newText, previous };
    }
    case "heading-level": {
      const matches = paragraphs.filter((p) => p.text === params.headingText);
      if (matches.length !== 1) {
        throw new WriterGroundTruthError(
          `headingText must name exactly one fixture paragraph (found ${matches.length})`,
        );
      }
      if (!Number.isInteger(params.level) || params.level < 1 || params.level > 9) {
        throw new WriterGroundTruthError(`level ${params.level} is not an outline level 1..9`);
      }
      const previous = (matches[0] as WriterParagraphSpec).headingLevel;
      if (previous === params.level)
        throw new WriterGroundTruthError("level equals the fixture level");
      return { kind: params.kind, text: params.headingText, expected: params.level, previous };
    }
    case "table-cell": {
      const tables = tablesOf(fixture);
      checkIndex(params.table, tables.length, "table");
      const at = parseCellName(params.cell);
      if (at === undefined)
        throw new WriterGroundTruthError(`bad cell name ${JSON.stringify(params.cell)}`);
      const rows = (tables[params.table] as WriterTableSpec).rows;
      checkIndex(at.row, rows.length, "row");
      checkIndex(at.col, (rows[at.row] as readonly string[]).length, "column");
      checkText(params.newText, "newText");
      const previous = (rows[at.row] as readonly string[])[at.col] as string;
      if (previous === params.newText)
        throw new WriterGroundTruthError("newText equals the fixture text");
      return {
        kind: params.kind,
        table: params.table,
        cell: params.cell,
        row: at.row,
        col: at.col,
        expected: params.newText,
        previous,
      };
    }
    case "paragraph-style": {
      checkIndex(params.paragraph, paragraphs.length, "paragraph");
      if (!(CUSTOM_STYLES as readonly string[]).includes(params.style)) {
        throw new WriterGroundTruthError(
          `style ${JSON.stringify(params.style)} is not a fixture style`,
        );
      }
      const previous = (paragraphs[params.paragraph] as WriterParagraphSpec).style;
      if (previous === params.style)
        throw new WriterGroundTruthError("style equals the fixture style");
      return { kind: params.kind, paragraph: params.paragraph, expected: params.style, previous };
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic task generation and the reference end state
// ---------------------------------------------------------------------------

/** Indices (among top-level paragraphs) of the fixture's body paragraphs. */
function bodyParagraphIndices(spec: WriterDocSpec): number[] {
  return paragraphsOf(spec).flatMap((p, i) => (p.headingLevel === null ? [i] : []));
}

/** A deterministic task of `kind` for `seed`; always accepted by `groundTruth()`. */
export function writerTaskFor(seed: string, kind: WriterPostconditionKind): WriterDocEditParams {
  const r = mulberry32(hash32(`writer-task:${kind}:${seed}`));
  const fixture = writerFixture(seed);
  const bodies = bodyParagraphIndices(fixture);
  switch (kind) {
    case "paragraph-text":
      return {
        fixtureSeed: seed,
        kind,
        paragraph: pick(r, bodies),
        newText: `Revised note ${100_000 + Math.floor(r() * 900_000)}.`,
      };
    case "heading-level": {
      const promote = r() < 0.5;
      const block = fixture.blocks[
        promote ? PROMOTE_CANDIDATE_BLOCK : SECTION_HEADING_BLOCK
      ] as WriterParagraphSpec;
      return { fixtureSeed: seed, kind, headingText: block.text, level: promote ? 2 : 3 };
    }
    case "table-cell":
      return {
        fixtureSeed: seed,
        kind,
        table: 0,
        cell: cellName(1 + Math.floor(r() * 2), Math.floor(r() * 3)),
        newText: `Done-${100_000 + Math.floor(r() * 900_000)}`,
      };
    case "paragraph-style":
      return { fixtureSeed: seed, kind, paragraph: pick(r, bodies), style: NOTE_STYLE };
  }
}

/**
 * The fixture with the postcondition applied: the end state a correct agent leaves.
 * Used only to generate test documents; the oracle never compares against it.
 */
export function applyGroundTruth(spec: WriterDocSpec, gt: WriterGroundTruth): WriterDocSpec {
  let paragraphIndex = -1;
  let tableIndex = -1;
  const blocks = spec.blocks.map((block): WriterBlockSpec => {
    if (block.kind === "table") {
      tableIndex++;
      if (gt.kind !== "table-cell" || tableIndex !== gt.table) return block;
      return {
        kind: "table",
        rows: block.rows.map((row, r) =>
          row.map((text, c) => (r === gt.row && c === gt.col ? gt.expected : text)),
        ),
      };
    }
    paragraphIndex++;
    if (gt.kind === "paragraph-text" && paragraphIndex === gt.paragraph) {
      return { ...block, text: gt.expected };
    }
    if (gt.kind === "paragraph-style" && paragraphIndex === gt.paragraph) {
      return { ...block, style: gt.expected };
    }
    if (gt.kind === "heading-level" && block.text === gt.text) {
      return { ...block, headingLevel: gt.expected, style: headingStyle(gt.expected) };
    }
    return block;
  });
  return { blocks };
}
