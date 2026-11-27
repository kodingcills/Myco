/**
 * Regenerate the committed third-party-written Calc workbooks (TIF-274 prerequisite, round 2
 * D3): real `.xlsx` files written by LibreOffice Calc (the live VM's app) and by openpyxl, so
 * the gate's xlsx reader is pinned against mainstream writers, not only our own generator.
 *
 *   <state>.lo.xlsx           = soffice --convert-to xlsx <state>.csv  (Calc's CSV import, then
 *                               its "Calc Office Open XML" export: exactly what Calc writes)
 *   roundtrip-exact.lo.xlsx   = soffice --convert-to xlsx of our generator's exact workbook
 *                               (Calc opening an .xlsx and saving it again)
 *   <state>.openpyxl.xlsx     = openpyxl writes the CSV's cells (ints as numbers, ISO dates as
 *                               dates in yyyy-mm-dd, `$` amounts as numbers in "$"#,##0.00);
 *                               openpyxl declares `xmlns:r` on each <sheet>, not on the root
 *   exact-text.openpyxl.xlsx  = openpyxl, every cell as text (inline strings)
 *
 * The documents are the probe seed's (`test/gate/calc-probes.ts`): the exact edit
 * (EMP-0003 qty = 4242), the pristine fixture (edit missing) and a collateral change.
 * CI has neither LibreOffice nor openpyxl, so these files carry that coverage into
 * `test/gate/xlsx-writers.test.ts`, which checks each file's SHA-256 against the manifest
 * and then its verdict on the gate and the independent grader. Re-running yields different
 * bytes (both writers stamp dates) but the same verdicts.
 *
 *   pnpm exec tsx scripts/calc-xlsx-writer-fixtures.ts [soffice-binary] [python3-binary]
 *
 * Uses a throwaway LibreOffice profile and work dir in a private temp dir; touches nothing
 * else. The Python helper runs isolated (`-I`) from a file in that temp dir.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { documentCsv } from "../src/gate/calc-document.ts";
import { xlsxFromCsv } from "../src/tasks/calc-xlsxgen.ts";

export const XLSX_WRITER_SEED = "probe-seed";
const EDIT = { rowKey: "EMP-0003", column: "qty", newValue: "4242" };
const OUT = join(import.meta.dirname, "..", "test", "fixtures", "calc-xlsx-writers");
const soffice = process.argv[2] ?? "soffice";
const python = process.argv[3] ?? "python3";

const OPENPYXL = `
import csv, datetime, sys, openpyxl
src, out, mode = sys.argv[1], sys.argv[2], sys.argv[3]
wb = openpyxl.Workbook()
ws = wb.active
for r, row in enumerate(csv.reader(open(src, newline="")), start=1):
    for c, v in enumerate(row, start=1):
        if v == "":
            continue
        cell = ws.cell(row=r, column=c)
        if mode == "typed" and v.isdigit():
            cell.value = int(v)
        elif mode == "typed" and len(v) == 10 and v[4] == "-" and v[7] == "-":
            cell.value = datetime.date.fromisoformat(v)
            cell.number_format = "yyyy-mm-dd"
        elif mode == "typed" and v.startswith("$"):
            cell.value = float(v[1:])
            cell.number_format = '"$"#,##0.00'
        else:
            cell.value = v
wb.save(out)
`;

const exact = documentCsv(XLSX_WRITER_SEED, [EDIT]);
const pristine = documentCsv(XLSX_WRITER_SEED, []);
// Collateral: EMP-0002's name changed as well as the target.
const collateral = exact.replace("EMP-0002,Dara Ito,", "EMP-0002,Dara Itoh,");
if (collateral === exact) throw new Error("the collateral edit did not apply");

const work = mkdtempSync(join(tmpdir(), "myco-calc-xlsx-writers-"));
try {
  const profile = pathToFileURL(join(work, "profile")).href;
  const lo = (input: string, outDir: string): void => {
    execFileSync(
      soffice,
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=${profile}`,
        "--convert-to",
        "xlsx",
        "--outdir",
        outDir,
        input,
      ],
      { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 },
    );
  };
  const helper = join(work, "openpyxl_write.py");
  writeFileSync(helper, OPENPYXL);
  const opx = (csvPath: string, out: string, mode: "typed" | "text"): void => {
    execFileSync(python, ["-I", helper, csvPath, out, mode], {
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 60_000,
    });
  };
  const sofficeVersion = execFileSync(soffice, ["--version"], { encoding: "utf8" }).trim();
  const openpyxlVersion = execFileSync(
    python,
    ["-I", "-c", "import openpyxl; print(openpyxl.__version__)"],
    { encoding: "utf8" },
  ).trim();

  mkdirSync(OUT, { recursive: true });
  const files: Record<string, { sha256: string; writer: string; from: string }> = {};
  const keep = (src: string, name: string, writer: string, from: string) => {
    copyFileSync(src, join(OUT, name));
    files[name] = {
      sha256: createHash("sha256").update(readFileSync(src)).digest("hex"),
      writer,
      from,
    };
  };

  for (const [state, csv] of [
    ["exact", exact],
    ["pristine", pristine],
    ["collateral", collateral],
  ] as const) {
    const dir = join(work, state);
    mkdirSync(dir, { recursive: true });
    const csvPath = join(dir, `${state}.csv`);
    writeFileSync(csvPath, csv);
    lo(csvPath, dir);
    keep(join(dir, `${state}.xlsx`), `${state}.lo.xlsx`, "libreoffice", `${state}.csv`);
    opx(csvPath, join(dir, `${state}.openpyxl.xlsx`), "typed");
    keep(join(dir, `${state}.openpyxl.xlsx`), `${state}.openpyxl.xlsx`, "openpyxl", `${state}.csv`);
  }
  const textDir = join(work, "text");
  mkdirSync(textDir, { recursive: true });
  writeFileSync(join(textDir, "exact.csv"), exact);
  opx(join(textDir, "exact.csv"), join(textDir, "exact-text.xlsx"), "text");
  keep(join(textDir, "exact-text.xlsx"), "exact-text.openpyxl.xlsx", "openpyxl", "exact.csv");

  const rtDir = join(work, "roundtrip");
  const rtOut = join(rtDir, "out");
  mkdirSync(rtOut, { recursive: true });
  writeFileSync(join(rtDir, "roundtrip-exact.xlsx"), xlsxFromCsv(exact));
  lo(join(rtDir, "roundtrip-exact.xlsx"), rtOut);
  keep(
    join(rtOut, "roundtrip-exact.xlsx"),
    "roundtrip-exact.lo.xlsx",
    "libreoffice",
    "xlsxFromCsv(exact)",
  );

  const manifest = {
    seed: XLSX_WRITER_SEED,
    edit: EDIT,
    soffice: sofficeVersion,
    openpyxl: openpyxlVersion,
    generator: "scripts/calc-xlsx-writer-fixtures.ts",
    files,
  };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${Object.keys(files).length} workbooks to ${OUT}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
