/**
 * Mutations of a REAL LibreOffice workbook (`test/fixtures/calc-xlsx-writers/exact.lo.xlsx`,
 * written by `soffice --convert-to xlsx`, see the manifest), and the two judges run on the
 * same bytes: the gate (createGate + fileEvidenceReader, the real read path) and the
 * independent grader (`src/benchmark/grade`, its own zip and XML reading).
 *
 * Shared by the part-name tests, the #503 probe table (P01-P53) and the differential
 * property test. The intent is EMP-0003 qty := 4242, so C4 is the target; the fixture
 * verifies and the grader passes it.
 */
import { grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { readZipEntries } from "../../src/gate/xlsx-document.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { writeZip } from "../../src/tasks/writer-docgen.ts";
import { COLUMN_TYPES } from "./calc-probes.ts";
import { tempRoot, writeState } from "./helpers.ts";
import { WRITERS_MANIFEST, writerBytes } from "./xlsx-writer-files.ts";

export const LO_BASE = "exact.lo.xlsx";
export const WORKBOOK = "xl/workbook.xml";
export const SHEET1 = "xl/worksheets/sheet1.xml";
export const SST = "xl/sharedStrings.xml";
export const STYLES = "xl/styles.xml";
export const WB_RELS = "xl/_rels/workbook.xml.rels";
export const ROOT_RELS = "_rels/.rels";
export const TYPES = "[Content_Types].xml";
export const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** A LibreOffice fixture's entries as text, in archive order. */
export function loParts(file = LO_BASE): [string, string][] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return [...readZipEntries(writerBytes(file))].map(([n, d]) => [n, decoder.decode(d)]);
}

const BASE = loParts();

/** The base fixture's text for `name`. */
export function loText(name: string): string {
  const found = BASE.find(([n]) => n === name);
  if (!found) throw new Error(`no part ${name}`);
  return found[1];
}

/**
 * Rebuild the base fixture with parts replaced (string), removed (null) or added (names not
 * in the base are appended, in order).
 */
export function loWith(patch: Readonly<Record<string, string | null>>): Uint8Array {
  const out: { name: string; data: Uint8Array }[] = [];
  const enc = new TextEncoder();
  for (const [name, text] of BASE) {
    const next = name in patch ? patch[name] : text;
    if (next !== null && next !== undefined) out.push({ name, data: enc.encode(next) });
  }
  for (const [name, text] of Object.entries(patch))
    if (text !== null && !BASE.some(([n]) => n === name))
      out.push({ name, data: enc.encode(text) });
  return writeZip(out);
}

/** Replace exactly one occurrence of `from` in part `name` (throws if it is not there once). */
export function loEdit(name: string, from: string | RegExp, to: string): Uint8Array {
  return loWith({ [name]: editOnce(loText(name), from, to) });
}

export function editOnce(text: string, from: string | RegExp, to: string): string {
  const count =
    typeof from === "string"
      ? text.split(from).length - 1
      : (text.match(new RegExp(from.source, `${from.flags.replace("g", "")}g`)) ?? []).length;
  if (count !== 1) throw new Error(`edit target found ${count} times: ${String(from)}`);
  return text.replace(from, to);
}

/** The edit every helper here uses unless told otherwise (EMP-0003 qty := 4242). */
export type LoEdit = typeof WRITERS_MANIFEST.edit;

/** The gate's verdict and reason codes on `bytes`, through the real read path. */
export async function gateOn(bytes: Uint8Array, edit: LoEdit = WRITERS_MANIFEST.edit) {
  const root = tempRoot();
  writeState(root, "r", "sheet.xlsx", bytes);
  const result = await createGate({
    tasks: buildRegistry([
      {
        id: "lo",
        family: "calc-record-edit",
        stateFile: "sheet.xlsx",
        spec: {
          fixtureSeed: WRITERS_MANIFEST.seed,
          ...edit,
          persistedFormat: "xlsx",
        },
      },
    ]),
    reader: fileEvidenceReader(root),
    assignment: { taskId: "lo", runId: "r" },
  }).check({ taskId: "lo", runId: "r" });
  return { verdict: result.verdict, reasonCodes: result.reasonCodes, reasons: result.reasons };
}

const FIXTURE_CSV = Buffer.from(generateFixture(WRITERS_MANIFEST.seed).csv);

/** The independent grader's status on `bytes`. */
export function graderOn(bytes: Uint8Array, edit: LoEdit = WRITERS_MANIFEST.edit): string {
  return grade({
    fixtureCsv: FIXTURE_CSV,
    fixtureSha256: sha256(FIXTURE_CSV),
    persisted: { format: "xlsx", bytes },
    intent: edit,
    columnTypes: COLUMN_TYPES,
  }).status;
}
