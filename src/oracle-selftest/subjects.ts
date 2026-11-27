/**
 * Self-test subjects (M2-09 / R5): the hand-written oracles on main, each with its seeded
 * cases. Each oracle is called through its real read path on a real file, so the self-test
 * exercises what runs, not a re-implementation.
 *
 *  - `calc-record-edit/csv`: M1's persisted-state verifier (`calcRecordEditVerifier` over
 *    `readCsvSpreadsheet`), with the eval harness's rule that a `PersistedStateReadError` is
 *    `uncertain` (`src/core/eval.ts`).
 *  - `calc-record-edit/gate-xlsx`: the same gate family on its xlsx read path
 *    (`persistedFormat: "xlsx"`, `src/gate/xlsx-document.ts`; TIF-274 prerequisite), on the
 *    calc cases saved as workbooks plus the container classes.
 *  - `writer-doc-edit`: the host-only Writer oracle (`verifyWriterFile`, TIF-99), all four
 *    postcondition kinds, in both `.docx` and `.odt`.
 *
 * The whole-document Calc gate and the multi-step Calc family (TIF-270, #485) join as
 * subjects when they land; agent-written oracles join through the same `OracleUnderTest`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistedStateReadError, readCsvSpreadsheet } from "../core/filepersist.ts";
import type { TaskIntent } from "../core/verify.ts";
import { calcRecordEditFamily } from "../gate/families.ts";
import { calcRecordEditVerifier, intentFor } from "../tasks/calc-record-edit.ts";
import { XLSX_MAIN_SHEET, xlsxEntriesFromCsv, xlsxFromCsv } from "../tasks/calc-xlsxgen.ts";
import { DATA_COLUMNS, generateFixture } from "../tasks/fixture.ts";
import { type CalcRecordEditParams, generateParameterSets } from "../tasks/intent.ts";
import {
  applyGroundTruth,
  BODY_STYLE,
  groundTruth,
  NOTE_STYLE,
  paragraphsOf,
  WRITER_POSTCONDITION_KINDS,
  type WriterDocSpec,
  type WriterGroundTruth,
  writerFixture,
  writerIntentFor,
  writerTaskFor,
} from "../tasks/writer-doc-edit.ts";
import {
  flippedByte,
  partiallySaved,
  truncated,
  type WriterFormat,
  withoutMainPart,
  writeWriterDocument,
  writeZip,
} from "../tasks/writer-docgen.ts";
import { verifyWriterFile } from "../verify/writer-oracle.ts";
import type {
  CorruptionClass,
  Draw,
  OracleUnderTest,
  SavedDocument,
  SelfTestCase,
} from "./types.ts";

export type { Draw } from "./types.ts";

/** Write `doc` to a fresh temp dir, run `read` on its path, and clean up. */
function withFile<T>(doc: SavedDocument, read: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "myco-oracle-selftest-"));
  try {
    const path = join(dir, doc.fileName);
    if (doc.bytes !== null) writeFileSync(path, doc.bytes);
    return read(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// calc-record-edit (M1), CSV persisted path
// ---------------------------------------------------------------------------

export const calcRecordEditOracle: OracleUnderTest<CalcRecordEditParams> = {
  name: "calc-record-edit/csv",
  version: "m1",
  // Target-only by design: collateral damage is TIF-270's whole-document check. CSV has no
  // integrity marker, so a truncation that keeps the target row is invisible to it.
  claims: new Set<CorruptionClass>(["edit-missing", "wrong-value", "wrong-target", "missing-file"]),
  verify(doc, params) {
    return withFile(doc, (path) => {
      try {
        const v = calcRecordEditVerifier.verify(readCsvSpreadsheet(path), intentFor(params));
        // Codes from the status only: the verifier's reasons name the file path.
        const code =
          v.status === "verified"
            ? "postcondition-holds"
            : v.status === "refuted"
              ? "value-mismatch"
              : "could-not-look";
        return { status: v.status, code };
      } catch (error) {
        if (error instanceof PersistedStateReadError)
          return { status: "uncertain", code: `read-${error.cause}` };
        throw error;
      }
    });
  },
};

/**
 * The gate's `calc-record-edit` family (version 2, TIF-270 / #485), over the same CSV bytes:
 * a whole-document diff against the pristine fixture plus the edit. The adapter follows the
 * gate's documented contract (`src/gate/gate.ts`): a missing file, and a `decide` that
 * throws (including unreadable bytes), are `uncertain`.
 */
export const calcGateOracle: OracleUnderTest<CalcRecordEditParams> = {
  name: "calc-record-edit/gate",
  version: `gate-family-${calcRecordEditFamily.version}`,
  claims: new Set<CorruptionClass>([
    "edit-missing",
    "wrong-value",
    "wrong-target",
    "collateral",
    "truncated",
    "missing-file",
  ]),
  verify(doc, params) {
    if (doc.bytes === null) return { status: "uncertain", code: "state-missing" };
    try {
      const out = calcRecordEditFamily.decide(doc.bytes, { ...params }, "oracle-selftest");
      const code =
        out.status === "verified"
          ? "postcondition-holds"
          : out.status === "refuted"
            ? (out.codes ?? []).join("+") || "refuted"
            : "oracle-uncertain";
      return { status: out.status, code };
    } catch {
      return { status: "uncertain", code: "oracle-threw" };
    }
  },
};

/**
 * The same whole-document gate family on its xlsx read path (TIF-274 prerequisite):
 * `persistedFormat: "xlsx"`, the saved workbook read by `src/gate/xlsx-document.ts`. A
 * workbook is a container with CRCs and XML, so it also claims the container classes.
 */
export const calcGateXlsxOracle: OracleUnderTest<CalcRecordEditParams> = {
  name: "calc-record-edit/gate-xlsx",
  version: `gate-family-${calcRecordEditFamily.version}`,
  claims: new Set<CorruptionClass>([
    "edit-missing",
    "wrong-value",
    "wrong-target",
    "collateral",
    "truncated",
    "corrupt-byte",
    "partial-save",
    "missing-main-part",
    "missing-file",
  ]),
  verify(doc, params) {
    return calcGateOracle.verify(doc, {
      ...params,
      persistedFormat: "xlsx",
    } as CalcRecordEditParams);
  },
};

/** Offset of a byte inside the worksheet entry's compressed data (a flip there fails the CRC). */
function insideMainSheet(bytes: Uint8Array): number {
  const name = new TextEncoder().encode(XLSX_MAIN_SHEET);
  for (let i = 0; i + 30 + name.length < bytes.length; i++) {
    if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b || bytes[i + 2] !== 3 || bytes[i + 3] !== 4)
      continue;
    const n = (bytes[i + 26] as number) | ((bytes[i + 27] as number) << 8);
    if (n === name.length && name.every((b, k) => bytes[i + 30 + k] === b)) {
      const extra = (bytes[i + 28] as number) | ((bytes[i + 29] as number) << 8);
      return i + 30 + n + extra + 8;
    }
  }
  throw new Error("self-test workbook has no worksheet entry");
}

/** The calc cases as workbooks (`xlsxFromCsv`), plus the container classes. */
export function calcXlsxCases(count = 10): SelfTestCase<CalcRecordEditParams>[] {
  const asXlsx = (doc: SavedDocument): SavedDocument => ({
    fileName: "doc.xlsx",
    bytes: doc.bytes === null ? null : xlsxFromCsv(new TextDecoder().decode(doc.bytes)),
  });
  return calcCases(count).map((c) => {
    const correct = asXlsx(c.correct);
    const csv = new TextDecoder().decode(c.correct.bytes as Uint8Array);
    const bytes = correct.bytes as Uint8Array;
    const entries = xlsxEntriesFromCsv(csv);
    const corruptions = c.corruptions.map(({ cls, doc }) => ({
      cls,
      doc:
        cls === "truncated" ? { fileName: "doc.xlsx", bytes: truncated(bytes, 0.5) } : asXlsx(doc),
    }));
    return {
      id: `${c.id}-xlsx`,
      intent: c.intent,
      correct,
      corruptions: [
        ...corruptions,
        {
          cls: "corrupt-byte" as const,
          doc: { fileName: "doc.xlsx", bytes: flippedByte(bytes, insideMainSheet(bytes)) },
        },
        {
          cls: "partial-save" as const,
          doc: {
            fileName: "doc.xlsx",
            bytes: writeZip(
              entries.map((e) =>
                e.name === XLSX_MAIN_SHEET
                  ? { ...e, data: e.data.slice(0, Math.floor(e.data.length / 2)) }
                  : e,
              ),
            ),
          },
        },
        {
          cls: "missing-main-part" as const,
          doc: {
            fileName: "doc.xlsx",
            bytes: writeZip(entries.filter((e) => e.name !== XLSX_MAIN_SHEET)),
          },
        },
      ],
    };
  });
}

function editCsv(
  csv: string,
  edits: ReadonlyArray<{ rowKey: string; column: string; value: string }>,
): string {
  const rows = csv
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const header = rows[0] as string[];
  for (const e of edits) {
    const col = header.indexOf(e.column);
    const row = rows.findIndex((r, i) => i > 0 && r[0] === e.rowKey);
    if (col < 1 || row < 1) throw new Error(`self-test fixture has no ${e.rowKey}/${e.column}`);
    (rows[row] as string[])[col] = e.value;
  }
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

/**
 * A bound on every draw loop: a broken random source (one that repeats itself) fails closed
 * with an error instead of looping forever. An honest source needs a handful of draws.
 */
export const MAX_DRAWS = 1000;
export const NO_USABLE_DRAW = "the random source gives no usable draw";

export function calcCases(count = 10): SelfTestCase<CalcRecordEditParams>[] {
  const seeds = Array.from(
    { length: 10 },
    (_, i) => `oracle-selftest-${String(i + 1).padStart(2, "0")}`,
  );
  return calcCasesFor(generateParameterSets(seeds).slice(0, count), "doc.csv");
}

const VALUE_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-_/$";
const DIGITS = "0123456789";

function randomString(draw: Draw, alphabet: string, min: number, max: number): string {
  const len = min + draw(max - min + 1);
  let s = "";
  for (let k = 0; k < len; k++) s += alphabet[draw(alphabet.length)];
  return s;
}

/** Two cell values no reasonable reader takes for the same value (case, spaces, numbers). */
function sameCell(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  const nx = Number(x.replace(/^\$/, ""));
  const ny = Number(y.replace(/^\$/, ""));
  return x !== "" && y !== "" && Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
}

/**
 * A random cell value unlike every value in `avoid`: an edit of `base` (a character added,
 * dropped or replaced, or a number moved by a random amount), random digits, a random word,
 * or another cell of the same sheet. Wide on purpose: a check that lies only on values the
 * self-test cannot draw has little room left (track C, D1 round 2 of #590).
 */
function randomValue(draw: Draw, base: string, cells: readonly string[], avoid: string[]): string {
  for (let tries = 0; tries < MAX_DRAWS; tries++) {
    let v: string;
    const kind = draw(6);
    if (kind === 0) {
      const at = draw(base.length + 1);
      v = base.slice(0, at) + VALUE_CHARS[draw(VALUE_CHARS.length)] + base.slice(at);
    } else if (kind === 1) {
      const at = draw(base.length);
      v = base.slice(0, at) + base.slice(at + 1);
    } else if (kind === 2) {
      const at = draw(base.length);
      v = base.slice(0, at) + VALUE_CHARS[draw(VALUE_CHARS.length)] + base.slice(at + 1);
    } else if (kind === 3) {
      const n = Number(base.replace(/^\$/, ""));
      const delta = (1 + draw(10_000)) * (draw(2) === 0 ? 1 : -1);
      v = Number.isFinite(n) ? String(n + delta) : randomString(draw, DIGITS, 1, 9);
    } else if (kind === 4) {
      v = draw(2) === 0 ? randomString(draw, DIGITS, 1, 9) : randomString(draw, VALUE_CHARS, 1, 16);
    } else {
      v = cells[draw(cells.length)] as string;
    }
    // One CSV cell, no edge spaces (a reader may trim them), unlike every value to avoid.
    if (/^\S(?:[^,"\r\n]{0,62}\S)?$/.test(v) && !avoid.some((a) => sameCell(a, v))) return v;
  }
  throw new Error(NO_USABLE_DRAW);
}

/**
 * The value-class corruptions of one calc case drawn from host-side randomness: a random wrong
 * value, the value written to a random other cell, and 1-3 random other cells changed to
 * random values. With fixed corruptions, the check's author (who knows the task's intent)
 * could compute every self-test document in advance and lie on anything else.
 */
function drawnValueCorruptions(
  draw: Draw,
  p: CalcRecordEditParams,
  fixture: { readonly csv: string; readonly header: string[]; readonly rows: string[][] },
  correct: string,
): { wrongValue: string; wrongTarget: string; collateral: string } {
  const columns = fixture.header.slice(1);
  const target = fixture.rows.find((r) => r[0] === p.rowKey) as string[];
  const original = target[fixture.header.indexOf(p.column)] as string;
  const cells = fixture.rows.flatMap((r) => r.slice(1));
  /** A random data cell other than the target whose value differs from `unlike`. */
  const otherCell = (unlike: (cur: string) => boolean) => {
    for (let tries = 0; tries < MAX_DRAWS; tries++) {
      const row = fixture.rows[draw(fixture.rows.length)] as string[];
      const column = columns[draw(columns.length)] as string;
      const cur = row[fixture.header.indexOf(column)] as string;
      if ((row[0] !== p.rowKey || column !== p.column) && !unlike(cur))
        return { rowKey: row[0] as string, column, cur };
    }
    throw new Error(NO_USABLE_DRAW);
  };
  const wrong = randomValue(draw, p.newValue, cells, [p.newValue, original]);
  const moved = otherCell((cur) => sameCell(cur, p.newValue));
  const edits = new Map<string, { rowKey: string; column: string; value: string }>();
  for (let k = 1 + draw(3); k > 0; k--) {
    const c = otherCell(() => false);
    edits.set(`${c.rowKey}/${c.column}`, {
      rowKey: c.rowKey,
      column: c.column,
      value: randomValue(draw, c.cur, cells, [c.cur]),
    });
  }
  return {
    wrongValue: editCsv(fixture.csv, [{ rowKey: p.rowKey, column: p.column, value: wrong }]),
    wrongTarget: editCsv(fixture.csv, [
      { rowKey: moved.rowKey, column: moved.column, value: p.newValue },
    ]),
    collateral: editCsv(correct, [...edits.values()]),
  };
}

/**
 * The single errors a calc-record-edit document can carry, combined in pairs by the drawn
 * self-test (#610 item 1): `wrong-value` (the target holds a wrong value), `wrong-target` (the
 * target keeps its original value and the new value lands in another cell), `cell` (1 to 3
 * other cells changed), `row-insert` (a row with a fresh key added) and `row-delete` (a row
 * other than the target's removed).
 */
export const CALC_ERRORS = [
  "wrong-value",
  "wrong-target",
  "cell",
  "row-insert",
  "row-delete",
] as const;
export type CalcError = (typeof CALC_ERRORS)[number];

/** Every pair of distinct single errors: the drawn two-error documents, one of each per case. */
export const CALC_ERROR_PAIRS: ReadonlyArray<readonly [CalcError, CalcError]> = CALC_ERRORS.flatMap(
  (a, i) => CALC_ERRORS.slice(i + 1).map((b) => [a, b] as const),
);

/**
 * Wrong values outside `randomValue`'s grammar, one of each per case (#610 item 1): over 64
 * characters, CSV-quoted (the quoted text may hold a comma or a space), with an edge space, and
 * a negative number at or below -20000.
 */
export const CALC_ODD_VALUES = ["long", "quoted", "space-edged", "large-negative"] as const;
export type CalcOddValue = (typeof CALC_ODD_VALUES)[number];

/** The R5 class a document carrying `errors` belongs to: the target's own error decides it. */
function classOf(errors: ReadonlySet<CalcError>): CorruptionClass {
  if (errors.has("wrong-value")) return "wrong-value";
  if (errors.has("wrong-target")) return "wrong-target";
  return "collateral";
}

/** A wrong target value of the given out-of-grammar shape, its text unlike every `avoid`. */
function oddValue(draw: Draw, shape: CalcOddValue, avoid: string[]): string {
  for (let tries = 0; tries < MAX_DRAWS; tries++) {
    let shown: string;
    let read: string;
    if (shape === "long") {
      shown = randomString(draw, VALUE_CHARS, 65, 200);
      read = shown;
    } else if (shape === "quoted") {
      const inner = randomString(draw, `${VALUE_CHARS} ,`, 1, 24);
      shown = `"${inner}"`;
      read = inner;
    } else if (shape === "space-edged") {
      read = randomString(draw, VALUE_CHARS, 1, 16);
      const edge = draw(3);
      shown = `${edge === 1 ? "" : " "}${read}${edge === 0 ? "" : " "}`;
    } else {
      shown = `-${2 + draw(8)}${randomString(draw, DIGITS, 4, 11)}`;
      read = shown;
    }
    // A wrong value whichever way a reader takes it: as written, unquoted or trimmed.
    if (read.trim() !== "" && ![shown, read].some((v) => avoid.some((a) => sameCell(a, v))))
      return shown;
  }
  throw new Error(NO_USABLE_DRAW);
}

/**
 * One document carrying exactly the single errors in `errors`, every one drawn from `draw`:
 * the wrong value, the cell the new value moves to, the changed cells and their values, the
 * inserted row (its key, values and position) and the deleted row. The errors never undo each
 * other or add a third: changed cells avoid the target and the moved cell and never take the
 * new value (that would be a wrong target too), and the deleted row is one no other error
 * touched.
 */
function compoundCsv(
  draw: Draw,
  p: CalcRecordEditParams,
  fixture: { readonly csv: string; readonly header: string[]; readonly rows: string[][] },
  correct: string,
  errors: ReadonlySet<CalcError>,
): string {
  const header = fixture.header;
  const columns = header.slice(1);
  const col = header.indexOf(p.column);
  const original = (fixture.rows.find((r) => r[0] === p.rowKey) as string[])[col] as string;
  const cells = fixture.rows.flatMap((r) => r.slice(1));
  const rows = correct
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  const target = rows.find((r, i) => i > 0 && r[0] === p.rowKey) as string[];
  const touched = new Set<string>([p.rowKey]);
  const busy = new Set<string>([`${p.rowKey}/${p.column}`]);
  /** A random data cell no earlier error used whose current value `ok` accepts. */
  const freeCell = (ok: (cur: string) => boolean) => {
    for (let tries = 0; tries < MAX_DRAWS; tries++) {
      const row = rows[1 + draw(rows.length - 1)] as string[];
      const column = columns[draw(columns.length)] as string;
      const at = `${row[0]}/${column}`;
      const cur = row[header.indexOf(column)] as string;
      if (!busy.has(at) && ok(cur)) {
        busy.add(at);
        touched.add(row[0] as string);
        return { row, c: header.indexOf(column), cur };
      }
    }
    throw new Error(NO_USABLE_DRAW);
  };
  if (errors.has("wrong-value"))
    target[col] = randomValue(draw, p.newValue, cells, [p.newValue, original]);
  else if (errors.has("wrong-target")) target[col] = original;
  if (errors.has("wrong-target")) {
    const m = freeCell((cur) => !sameCell(cur, p.newValue));
    m.row[m.c] = p.newValue;
  }
  if (errors.has("cell"))
    for (let k = 1 + draw(3); k > 0; k--) {
      const e = freeCell(() => true);
      e.row[e.c] = randomValue(draw, e.cur, cells, [e.cur, p.newValue]);
    }
  if (errors.has("row-delete")) {
    const free = rows.flatMap((r, i) => (i > 0 && !touched.has(r[0] as string) ? [i] : []));
    if (free.length === 0) throw new Error(NO_USABLE_DRAW);
    rows.splice(free[draw(free.length)] as number, 1);
  }
  if (errors.has("row-insert")) {
    const keys = new Set(fixture.rows.map((r) => (r[0] as string).trim().toLowerCase()));
    let key: string | undefined;
    for (let tries = 0; key === undefined && tries < MAX_DRAWS; tries++) {
      const k =
        draw(2) === 0
          ? `EMP-${randomString(draw, DIGITS, 4, 4)}`
          : `${VALUE_CHARS[draw(62)]}${randomString(draw, VALUE_CHARS, 0, 11)}`;
      if (!keys.has(k.toLowerCase())) key = k;
    }
    if (key === undefined) throw new Error(NO_USABLE_DRAW);
    const fresh = [key, ...columns.map(() => cells[draw(cells.length)] as string)];
    rows.splice(1 + draw(rows.length), 0, fresh);
  }
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

/**
 * The drawn corruptions beyond one error per document (#610 item 1): a two-error document for
 * every pair of `CALC_ERRORS`, a document for each single structural error (`row-insert`,
 * `row-delete`), and a wrong value of each `CALC_ODD_VALUES` shape. Drawn afresh per case from
 * host-side randomness, like the single-error corruptions; never built without a `draw`.
 */
function drawnWideCorruptions(
  draw: Draw,
  p: CalcRecordEditParams,
  fixture: { readonly csv: string; readonly header: string[]; readonly rows: string[][] },
  correct: string,
): { cls: CorruptionClass; text: string }[] {
  const original = (fixture.rows.find((r) => r[0] === p.rowKey) as string[])[
    fixture.header.indexOf(p.column)
  ] as string;
  const sets: ReadonlySet<CalcError>[] = [
    ...CALC_ERROR_PAIRS.map((pair) => new Set<CalcError>(pair)),
    new Set<CalcError>(["row-insert"]),
    new Set<CalcError>(["row-delete"]),
  ];
  return [
    ...sets.map((errors) => ({
      cls: classOf(errors),
      text: compoundCsv(draw, p, fixture, correct, errors),
    })),
    ...CALC_ODD_VALUES.map((shape) => ({
      cls: "wrong-value" as const,
      text: editCsv(fixture.csv, [
        {
          rowKey: p.rowKey,
          column: p.column,
          value: oddValue(draw, shape, [p.newValue, original]),
        },
      ]),
    })),
  ];
}

/**
 * The calc-record-edit R5 cases for the given intents, every document (clean and corrupted)
 * named `fileName`. `calcCases` is this over the fixed public seeds, with fixed corruptions
 * (`draw` absent). Agent-written checks (track C) pass `draw`, a host-side random source: then
 * the wrong value, the wrong target, the collateral cells and values and the truncation point
 * are drawn afresh for every case, so a check's author cannot compute the self-test documents
 * from the task's intent. With `draw` and `wide`, every case also carries the wider drawn
 * corruptions of `drawnWideCorruptions` (two errors, out-of-grammar values, inserted and
 * deleted rows) after its six single-error ones; track C asks for them on one bound-task case
 * per proposal, since each is one sandboxed run. Throws when an intent does not locate a
 * record and column.
 */
export function calcCasesFor(
  params: readonly CalcRecordEditParams[],
  fileName: string,
  draw?: Draw,
  wide = false,
): SelfTestCase<CalcRecordEditParams>[] {
  return params.map((p, i) => {
    const fixture = generateFixture(p.fixtureSeed);
    const correct = editCsv(fixture.csv, [
      { rowKey: p.rowKey, column: p.column, value: p.newValue },
    ]);
    const doc = (text: string | null): SavedDocument => ({
      fileName,
      bytes: text === null ? null : utf8(text),
    });
    const bytes = utf8(correct);
    let wrongValue: string;
    let wrongTarget: string;
    let collateral: string;
    let cut: Uint8Array;
    let extra: { cls: CorruptionClass; text: string }[] = [];
    if (draw === undefined) {
      const names = DATA_COLUMNS.map((c) => c.name);
      const neighbour = names[(names.indexOf(p.column) + 1) % names.length] as string;
      const otherKey = fixture.rows.find((r) => r[0] !== p.rowKey)?.[0] as string;
      wrongValue = editCsv(fixture.csv, [
        { rowKey: p.rowKey, column: p.column, value: `${p.newValue}9` },
      ]);
      wrongTarget = editCsv(fixture.csv, [
        { rowKey: p.rowKey, column: neighbour, value: p.newValue },
      ]);
      collateral = editCsv(correct, [
        { rowKey: otherKey, column: "name", value: "Collateral Edit" },
      ]);
      cut = truncated(bytes, 0.5);
    } else {
      ({ wrongValue, wrongTarget, collateral } = drawnValueCorruptions(draw, p, fixture, correct));
      cut = bytes.slice(0, 1 + draw(bytes.length - 1));
      if (wide) extra = drawnWideCorruptions(draw, p, fixture, correct);
    }
    return {
      id: `calc-${String(i + 1).padStart(2, "0")}`,
      intent: p,
      correct: doc(correct),
      corruptions: [
        { cls: "edit-missing", doc: doc(fixture.csv) },
        { cls: "wrong-value", doc: doc(wrongValue) },
        { cls: "wrong-target", doc: doc(wrongTarget) },
        { cls: "collateral", doc: doc(collateral) },
        { cls: "truncated", doc: { fileName, bytes: cut } },
        { cls: "missing-file", doc: doc(null) },
        // After the six above, so the first corruption of each class stays the single-error one.
        ...extra.map((w) => ({ cls: w.cls, doc: doc(w.text) })),
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// writer-doc-edit (TIF-99), .docx and .odt
// ---------------------------------------------------------------------------

export const writerOracle: OracleUnderTest<TaskIntent> = {
  name: "writer-doc-edit",
  version: "1",
  // Target-only, like M1's Calc verifier: other content is not compared.
  claims: new Set<CorruptionClass>([
    "edit-missing",
    "wrong-value",
    "wrong-target",
    "truncated",
    "corrupt-byte",
    "partial-save",
    "missing-main-part",
    "missing-file",
  ]),
  verify(doc, intent) {
    return withFile(doc, (path) => {
      const v = verifyWriterFile(path, intent);
      return { status: v.status, code: v.code };
    });
  },
};

/** The same edit with a different value. */
function wrongValue(gt: WriterGroundTruth): WriterGroundTruth {
  switch (gt.kind) {
    case "paragraph-text":
    case "table-cell":
      return { ...gt, expected: `${gt.expected} Wrong` };
    case "heading-level":
      return { ...gt, expected: gt.expected === 9 ? 8 : gt.expected + 1 };
    case "paragraph-style":
      return { ...gt, expected: gt.expected === NOTE_STYLE ? BODY_STYLE : NOTE_STYLE };
  }
}

/** The right value, applied to a neighbouring target. */
function wrongTarget(gt: WriterGroundTruth, spec: WriterDocSpec): WriterGroundTruth {
  const paragraphs = paragraphsOf(spec);
  const neighbourParagraph = (p: number) => (p + 1 < paragraphs.length ? p + 1 : p - 1);
  switch (gt.kind) {
    case "paragraph-text":
    case "paragraph-style":
      return { ...gt, paragraph: neighbourParagraph(gt.paragraph) };
    case "table-cell": {
      const col = gt.col === 0 ? 1 : gt.col - 1;
      return { ...gt, col, cell: `${String.fromCharCode(65 + col)}${gt.row + 1}` };
    }
    case "heading-level": {
      const other = paragraphs.find((p) => p.text !== gt.text && p.headingLevel === null);
      return { ...gt, text: other?.text ?? gt.text };
    }
  }
}

/** The correct document with one other paragraph's text changed. */
function withCollateral(spec: WriterDocSpec, gt: WriterGroundTruth): WriterDocSpec {
  const paragraphs = paragraphsOf(spec);
  const target = gt.kind === "paragraph-text" || gt.kind === "paragraph-style" ? gt.paragraph : -1;
  const victim = paragraphs.findIndex(
    (p, i) => i !== target && p.headingLevel === null && ("text" in gt ? p.text !== gt.text : true),
  );
  let seen = -1;
  return {
    blocks: spec.blocks.map((b) => {
      if (b.kind !== "paragraph") return b;
      seen++;
      return seen === victim ? { ...b, text: `${b.text} (collateral)` } : b;
    }),
  };
}

export function writerCases(
  seeds: readonly string[] = ["ws-1", "ws-2", "ws-3"],
): SelfTestCase<TaskIntent>[] {
  const cases: SelfTestCase<TaskIntent>[] = [];
  for (const seed of seeds) {
    for (const kind of WRITER_POSTCONDITION_KINDS) {
      for (const format of ["docx", "odt"] as const satisfies readonly WriterFormat[]) {
        const params = writerTaskFor(seed, kind);
        const gt = groundTruth(params);
        const fixture = writerFixture(seed);
        const correctSpec = applyGroundTruth(fixture, gt);
        const write = (spec: WriterDocSpec) => writeWriterDocument(spec, format);
        const correct = write(correctSpec);
        const doc = (bytes: Uint8Array | null): SavedDocument => ({
          fileName: `doc.${format}`,
          bytes,
        });
        cases.push({
          id: `writer-${seed}-${kind}-${format}`,
          intent: writerIntentFor(params),
          correct: doc(correct),
          corruptions: [
            { cls: "edit-missing", doc: doc(write(fixture)) },
            { cls: "wrong-value", doc: doc(write(applyGroundTruth(fixture, wrongValue(gt)))) },
            {
              cls: "wrong-target",
              doc: doc(write(applyGroundTruth(fixture, wrongTarget(gt, fixture)))),
            },
            { cls: "collateral", doc: doc(write(withCollateral(correctSpec, gt))) },
            { cls: "truncated", doc: doc(truncated(correct, 0.5)) },
            { cls: "corrupt-byte", doc: doc(flippedByte(correct, Math.floor(correct.length / 2))) },
            { cls: "partial-save", doc: doc(partiallySaved(correctSpec, format, 0.5)) },
            { cls: "missing-main-part", doc: doc(withoutMainPart(correctSpec, format)) },
            { cls: "missing-file", doc: doc(null) },
          ],
        });
      }
    }
  }
  return cases;
}
