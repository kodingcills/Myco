/**
 * Headless LibreOffice on a Linux host (TIF-269, M2-06).
 *
 * The Windows path converts the fixture CSV to `.xlsx` in the guest
 * (`src/integration/windows-fixture.ts`) and reads the saved workbook back by a
 * headless `--convert-to csv` (`src/verify/uno-verifier.ts`, check (c)). This
 * module does the same two conversions on the local machine, with the same
 * isolation rules:
 *
 * - a throwaway user profile per call (`-env:UserInstallation`), so a convert
 *   never touches, or waits on, another soffice's profile lock;
 * - a fresh output directory per call, so a convert can never return an earlier
 *   run's output;
 * - for the readback, an explicit import filter, so a file that is not an
 *   Office Open XML workbook is refused instead of being auto-detected and
 *   imported anyway (an `.ods` renamed to `.xlsx` would otherwise be read).
 *
 * soffice exits 0 even when it cannot load the source, so success is decided by
 * the output file existing, never by the exit code.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/** CSV export options the Windows verifier uses (comma, double quote, UTF-8, cell text as shown). */
export const CSV_EXPORT_FILTER =
  "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,0";

/**
 * Import filter for the saved workbook: an `.xlsx` only, never a text import.
 *
 * It must be "Calc MS Excel 2007 XML", the filter soffice auto-detects for the
 * `.xlsx` Calc itself saved. "Calc Office Open XML" (the ISO/IEC 29500 variant)
 * also loads it but reads every date one day late (2024-06-21 comes back as
 * 2024-06-22 on LibreOffice 24.2), which turns a correct date edit into a false
 * refutation. Found by this path's date-column test.
 */
export const XLSX_IMPORT_FILTER = "Calc MS Excel 2007 XML";

export class SofficeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SofficeError";
  }
}

export interface SofficeOptions {
  /** soffice binary; defaults to `$MYCO_SOFFICE` or `soffice` on PATH. */
  readonly binary?: string;
  /** Per-conversion timeout, ms. */
  readonly timeoutMs?: number;
}

export function sofficeBinary(options: SofficeOptions = {}): string {
  return options.binary ?? process.env.MYCO_SOFFICE ?? "soffice";
}

/** True when `soffice --version` runs and names LibreOffice. */
export function sofficeVersion(options: SofficeOptions = {}): string | null {
  const result = spawnSync(sofficeBinary(options), ["--version"], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const line = result.stdout.trim().split("\n")[0] ?? "";
  return /LibreOffice/.test(line) ? line : null;
}

/**
 * Run one headless conversion of `source` into a fresh directory and return the
 * path of the produced file. Throws {@link SofficeError} when nothing was produced.
 */
function convert(
  source: string,
  convertTo: string,
  outExt: string,
  extraArgs: readonly string[],
  options: SofficeOptions,
): { outPath: string; cleanup: () => void } {
  if (!existsSync(source)) {
    throw new SofficeError(`source file missing: ${source}`);
  }
  const work = mkdtempSync(join(tmpdir(), "myco-soffice-"));
  const profile = join(work, "profile");
  const outDir = join(work, "out");
  mkdirSync(outDir);
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  const result = spawnSync(
    sofficeBinary(options),
    [
      "--headless",
      "--norestore",
      "--nologo",
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      ...extraArgs,
      "--convert-to",
      convertTo,
      "--outdir",
      outDir,
      source,
    ],
    { encoding: "utf8", timeout: options.timeoutMs ?? 120_000 },
  );
  const stem = basename(source).replace(/\.[^.]+$/, "");
  const outPath = join(outDir, `${stem}.${outExt}`);
  if (!existsSync(outPath)) {
    cleanup();
    const why = result.error
      ? result.error.message
      : (result.stderr ?? "").trim().split("\n").pop() || `exit ${String(result.status)}`;
    throw new SofficeError(`soffice produced no ${outExt} for ${source}: ${why}`);
  }
  return { outPath, cleanup };
}

/** Convert the fixture CSV into an `.xlsx` workbook and return its bytes. */
export function csvToXlsxBytes(csvPath: string, options: SofficeOptions = {}): Buffer {
  const { outPath, cleanup } = convert(csvPath, "xlsx", "xlsx", [], options);
  try {
    return readFileSync(outPath);
  } finally {
    cleanup();
  }
}

/**
 * Read a saved workbook back as CSV bytes, through the Office Open XML import
 * filter only. A truncated, random or non-xlsx file produces no CSV and throws.
 */
export function xlsxToCsvBytes(xlsxPath: string, options: SofficeOptions = {}): Buffer {
  const { outPath, cleanup } = convert(
    xlsxPath,
    CSV_EXPORT_FILTER,
    "csv",
    [`--infilter=${XLSX_IMPORT_FILTER}`],
    options,
  );
  try {
    return readFileSync(outPath);
  } finally {
    cleanup();
  }
}
