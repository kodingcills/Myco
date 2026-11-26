/**
 * The backend seam for `myco.state/v1` (capability track I).
 *
 * A backend reads ONE live app/document: the one the harness bound it to when it built it
 * for one trial. It has read methods only; there is no write, open, path or trial argument
 * anywhere in this interface, so no tool can be routed to a different document through it.
 *
 * Backends today: `linux-uno` (headless LibreOffice Calc over Python-UNO, `./linux/uno.ts`)
 * and `fake` (tests). A Windows backend reading the guest's Calc over UIA/UNO plugs in here
 * by implementing the same four methods; nothing above this seam changes.
 */
import type { GridRange, SheetRef, StateCode } from "./api.ts";

export type BackendResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: StateCode };

export interface SheetSummary {
  readonly index: number;
  readonly name: string;
  readonly nameTruncated?: true;
  /** A1 range of the used area, or null for an empty sheet. */
  readonly usedRange: string | null;
}

/**
 * True if the document holds, or can pull in, content from outside itself: a formula
 * anywhere (cells, names, validation) with an external reference or an INDIRECT, DDE or
 * WEBSERVICE call, or any external-document, DDE, area or sheet link, or a database range
 * or pilot table importing from a data source. The server withholds the reply while it is
 * true, and refuses a reply without it (BACKEND_ERROR): docs/state/security.md, "Content
 * from other files" (PR #545 round 1, D7).
 */
export interface ForeignContentFlag {
  readonly documentForeignContent: boolean;
}

export interface SheetList extends ForeignContentFlag {
  readonly sheets: readonly SheetSummary[];
  readonly sheetCount: number;
  readonly truncated: boolean;
}

export interface CellState {
  readonly ref: string;
  readonly kind: "empty" | "number" | "text" | "formula";
  /** Number or text the cell holds (for a formula, its current result); null when empty or an error. */
  readonly value: number | string | null;
  /** The text the app displays for the cell. */
  readonly display: string;
  /** The formula as the app holds it, for `kind: "formula"`. */
  readonly formula?: string;
  readonly formulaResult?: "number" | "text" | "error";
  /** The display text or formula was longer than `maxCellTextChars` and was cut. */
  readonly truncated?: true;
}

export interface RangeRead extends ForeignContentFlag {
  readonly sheet: { readonly index: number; readonly name: string };
  readonly range: string;
  readonly rows: readonly (readonly CellState[])[];
  /**
   * True if ANY formula in the whole document (not only this range): formula cells on every
   * sheet, document- and sheet-scoped named expressions, and validation formulas, calls a
   * function that returns the document's own location (`CELL`, `INFO`) or any function
   * that is not built in (a Basic macro or extension add-in can return it too). The server
   * withholds the reply while it is true, and refuses a reply without it (BACKEND_ERROR):
   * docs/state/security.md, "Host paths".
   */
  readonly documentPathFunctions: boolean;
}

export interface DocumentStatus {
  /** The live document has edits not yet stored. */
  readonly modified: boolean;
  /** The document has a storage location (never reported itself). */
  readonly hasStorageLocation: boolean;
  readonly readOnly: boolean;
  readonly sheetCount: number;
  readonly activeSheet: string | null;
}

export interface UiNode {
  readonly role: string;
  readonly name: string;
  readonly childCount: number;
  readonly childrenOmitted?: "depth" | "nodes" | "width";
  readonly children?: readonly UiNode[];
}

export interface UiTree extends ForeignContentFlag {
  readonly tree: UiNode;
  readonly nodes: number;
  readonly truncated: boolean;
  /**
   * True if ANY formula in the whole document (not only this range): formula cells on every
   * sheet, document- and sheet-scoped named expressions, and validation formulas, calls a
   * function that returns the document's own location (`CELL`, `INFO`) or any function
   * that is not built in (a Basic macro or extension add-in can return it too). The server
   * withholds the reply while it is true, and refuses a reply without it (BACKEND_ERROR):
   * docs/state/security.md, "Host paths".
   */
  readonly documentPathFunctions: boolean;
}

export interface UiTreeLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export interface StateBackend {
  /** Which backend; reported in replies so a measurement can tell them apart. */
  readonly kind: "linux-uno" | "windows-uia" | "fake";
  listSheets(): Promise<BackendResult<SheetList>>;
  readRange(sheet: SheetRef | null, range: GridRange): Promise<BackendResult<RangeRead>>;
  documentStatus(): Promise<BackendResult<DocumentStatus>>;
  uiTree(limits: UiTreeLimits): Promise<BackendResult<UiTree>>;
}
