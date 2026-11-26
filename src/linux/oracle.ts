/**
 * The Linux path's oracle (TIF-269, M2-06): a verdict from the saved workbook.
 *
 * Inputs are exactly two: the path of the file the app saved, and the task
 * intent. The expected value comes from host-side ground truth (fixture seed +
 * intent params, ADR-0005). Nothing the agent or the actuator said is an input:
 * this function has no parameter that could carry a claim.
 *
 * The comparison is the M1 family verifier (`calcRecordEditVerifier`) over the
 * M1 CSV reader (`readCsvSpreadsheet`), the same code check (c) of the Windows
 * UNO verifier delegates to. Only the acquisition differs: the saved workbook is
 * converted by a local headless soffice instead of one in the guest.
 *
 * Three-valued, as everywhere in Myco (ADR-0002): a missing, truncated or
 * otherwise unreadable file is `uncertain` ("could not look"), never `refuted`
 * and never `verified`.
 */

import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCsvSpreadsheet } from "../core/filepersist.ts";
import type { PersistedState, TaskIntent, Verdict } from "../core/verify.ts";
import { calcRecordEditVerifier, normalizeParams } from "../tasks/calc-record-edit.ts";
import { groundTruth } from "../tasks/intent.ts";
import { type SofficeOptions, xlsxToCsvBytes } from "./soffice.ts";

/** Reads a saved workbook as CSV bytes. The default uses local headless soffice. */
export type SavedWorkbookReader = (xlsxPath: string) => Buffer;

export interface OracleResult {
  readonly verdict: Verdict;
  /** The cell the intent targets (A1, header row = 1), when ground truth is computable. */
  readonly cellRef: string | null;
  /** Value ground truth expects in that cell. */
  readonly expected: string | null;
  /** Value read from the saved file, or null when the file could not be read. */
  readonly observed: string | null;
}

/** Every `.xlsx` is a ZIP: local file header magic. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function startsWithZipMagic(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    return n === 4 && head.equals(ZIP_MAGIC);
  } finally {
    closeSync(fd);
  }
}

function parseCsv(bytes: Buffer, xlsxPath: string): PersistedState {
  const dir = mkdtempSync(join(tmpdir(), "myco-linux-oracle-"));
  try {
    const tmp = join(dir, "saved.csv");
    writeFileSync(tmp, bytes);
    return { ...readCsvSpreadsheet(tmp), filePath: xlsxPath };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function sofficeReader(options: SofficeOptions = {}): SavedWorkbookReader {
  return (xlsxPath) => xlsxToCsvBytes(xlsxPath, options);
}

/** Verdict for a calc-record-edit intent, from the saved workbook only. */
export function verifySavedWorkbook(
  xlsxPath: string,
  intent: TaskIntent,
  read: SavedWorkbookReader = sofficeReader(),
): OracleResult {
  let cellRef: string;
  let expected: string;
  try {
    const gt = groundTruth(normalizeParams(intent.params));
    cellRef = gt.cellRef;
    expected = gt.expectedValue;
  } catch (error) {
    return {
      verdict: {
        status: "uncertain",
        reasons: [`could not look: ${error instanceof Error ? error.message : String(error)}`],
      },
      cellRef: null,
      expected: null,
      observed: null,
    };
  }
  const couldNotLook = (why: string): OracleResult => ({
    verdict: { status: "uncertain", reasons: [`could not look: ${why}`] },
    cellRef,
    expected,
    observed: null,
  });
  if (!existsSync(xlsxPath)) {
    return couldNotLook(`saved workbook missing at ${xlsxPath}`);
  }
  if (!startsWithZipMagic(xlsxPath)) {
    return couldNotLook(`${xlsxPath} is not an Office Open XML container (no ZIP header)`);
  }
  let state: PersistedState;
  try {
    state = parseCsv(read(xlsxPath), xlsxPath);
  } catch (error) {
    return couldNotLook(
      `saved workbook unreadable — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    verdict: calcRecordEditVerifier.verify(state, intent),
    cellRef,
    expected,
    observed: state.cells[cellRef] ?? null,
  };
}
