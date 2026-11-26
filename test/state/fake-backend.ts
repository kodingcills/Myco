/**
 * An in-memory `StateBackend` for the hermetic state tests: one document held as sheets of
 * cell strings ("=..." is a formula). It knows nothing about files, which is the point: the
 * server must never need any.
 */
import { columnName, type GridRange, type SheetRef } from "../../src/state/api.ts";
import type {
  BackendResult,
  CellState,
  StateBackend,
  UiNode,
  UiTree,
  UiTreeLimits,
} from "../../src/state/backend.ts";

export interface FakeDoc {
  sheets: { name: string; rows: string[][] }[];
  modified: boolean;
  tree?: UiNode;
  /** The document holds a link to another file (external doc, DDE, area or sheet link). */
  links?: boolean;
}

function cell(text: string | undefined, ref: string): CellState {
  if (text === undefined || text === "") return { ref, kind: "empty", value: null, display: "" };
  if (text.startsWith("=")) {
    return { ref, kind: "formula", formula: text, formulaResult: "number", value: 0, display: "0" };
  }
  if (/^-?\d+(\.\d+)?$/.test(text))
    return { ref, kind: "number", value: Number(text), display: text };
  return { ref, kind: "text", value: text, display: text };
}

/**
 * A simplified model of the Linux reader: formula cells that call CELL or INFO. The real
 * reader also scans names, validation and non-built-in calls (state-host-paths.test.ts).
 */
function documentPathFunctions(doc: FakeDoc): boolean {
  return doc.sheets.some((s) =>
    s.rows.some((r) => r.some((c) => c.startsWith("=") && /(?:CELL|INFO)\s*\(/i.test(c))),
  );
}

/**
 * A simplified model of the reader's foreign-content scan (D7): a link, or a formula cell
 * with an external reference or an INDIRECT/DDE/WEBSERVICE call.
 */
function documentForeignContent(doc: FakeDoc): boolean {
  return (
    doc.links === true ||
    doc.sheets.some((s) =>
      s.rows.some((r) =>
        r.some(
          (c) => c.startsWith("=") && /'\s*#|#\s*\$|(?:INDIRECT|DDE|WEBSERVICE)\s*\(/i.test(c),
        ),
      ),
    )
  );
}

export function fakeBackend(doc: FakeDoc): StateBackend & { calls: string[] } {
  const calls: string[] = [];
  const sheetOf = (ref: SheetRef | null) => {
    if (ref === null) return doc.sheets[0] ? { index: 0, sheet: doc.sheets[0] } : null;
    const index = typeof ref === "number" ? ref : doc.sheets.findIndex((s) => s.name === ref);
    const sheet = doc.sheets[index];
    return sheet ? { index, sheet } : null;
  };
  return {
    kind: "fake",
    calls,
    async listSheets() {
      calls.push("listSheets");
      return {
        ok: true,
        data: {
          sheets: doc.sheets.map((s, index) => ({
            index,
            name: s.name,
            usedRange: s.rows.length
              ? `A1:${columnName(Math.max(...s.rows.map((r) => r.length)) - 1)}${s.rows.length}`
              : null,
          })),
          sheetCount: doc.sheets.length,
          truncated: false,
          documentForeignContent: documentForeignContent(doc),
        },
      };
    },
    async readRange(ref: SheetRef | null, range: GridRange) {
      calls.push("readRange");
      const found = sheetOf(ref);
      if (!found) return { ok: false, code: "UNKNOWN_SHEET" };
      const [c0, r0, c1, r1] = range;
      const rows: CellState[][] = [];
      for (let r = r0; r <= r1; r++) {
        const row: CellState[] = [];
        for (let c = c0; c <= c1; c++)
          row.push(cell(found.sheet.rows[r]?.[c], `${columnName(c)}${r + 1}`));
        rows.push(row);
      }
      return {
        ok: true,
        data: {
          sheet: { index: found.index, name: found.sheet.name },
          range: `${columnName(c0)}${r0 + 1}:${columnName(c1)}${r1 + 1}`,
          rows,
          documentPathFunctions: documentPathFunctions(doc),
          documentForeignContent: documentForeignContent(doc),
        },
      };
    },
    async documentStatus() {
      calls.push("documentStatus");
      return {
        ok: true,
        data: {
          modified: doc.modified,
          hasStorageLocation: true,
          readOnly: false,
          sheetCount: doc.sheets.length,
          activeSheet: doc.sheets[0]?.name ?? null,
        },
      };
    },
    async uiTree(limits: UiTreeLimits): Promise<BackendResult<UiTree>> {
      calls.push(`uiTree:${limits.maxDepth}:${limits.maxNodes}`);
      if (!doc.tree) return { ok: false, code: "UI_TREE_UNAVAILABLE" };
      return {
        ok: true,
        data: {
          tree: doc.tree,
          nodes: 1,
          truncated: false,
          documentPathFunctions: documentPathFunctions(doc),
          documentForeignContent: documentForeignContent(doc),
        },
      };
    },
  };
}

/**
 * A backend whose every method returns `data` as-is (to test the server's re-checks). An
 * object without `documentPathFunctions` gets `documentPathFunctions: false` added, unless
 * `omitFlag` is set, and likewise `documentForeignContent: false` unless `omitForeignFlag`
 * is set (to test that the server refuses a reply without either).
 */
export function rawBackend(
  data: unknown,
  opts: { omitFlag?: boolean; omitForeignFlag?: boolean } = {},
): StateBackend {
  const isObject = typeof data === "object" && data !== null && !Array.isArray(data);
  let body = data;
  if (isObject && !opts.omitFlag && !Object.hasOwn(data, "documentPathFunctions"))
    body = { ...(body as object), documentPathFunctions: false };
  if (isObject && !opts.omitForeignFlag && !Object.hasOwn(data, "documentForeignContent"))
    body = { ...(body as object), documentForeignContent: false };
  const give = async () => ({ ok: true as const, data: body as never });
  return { kind: "fake", listSheets: give, readRange: give, documentStatus: give, uiTree: give };
}

/** A backend whose every method throws `message`. */
export function throwingBackend(message: string): StateBackend {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return { kind: "fake", listSheets: fail, readRange: fail, documentStatus: fail, uiTree: fail };
}
