/**
 * The cross-app actuator on the Linux headless LibreOffice path (capability track P): the
 * scripted agent's hands for a real Calc and a real Writer, no VM.
 *
 *  - Calc: `scripts/linux/calc_actuator.py` (TIF-269), unchanged: open the sheet (CSV, the
 *    format the gate reads for Calc), type into one cell through `.uno:EnterString`, store
 *    in place (Calc keeps the CSV filter it loaded with).
 *  - Writer: `scripts/linux/writer_actuator.py`: open the report as Writer text (UTF-8, LF),
 *    put the cursor at the end of the labelled line, type through `.uno:InsertText`, store
 *    in place (Writer's "Text (encoded)" filter, which writes a leading BOM).
 *
 * Each script's JSON report is a trace record, never an input to a verdict.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { CrossAppActuator } from "../gate/cross-app-demo.ts";
import { type CalcActuatorOptions, calcActuator, pythonBinary } from "./actuator.ts";
import { sofficeBinary } from "./soffice.ts";

export const WRITER_ACTUATOR_SCRIPT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "linux",
  "writer_actuator.py",
);

export function libreOfficeCrossAppActuator(options: CalcActuatorOptions = {}): CrossAppActuator {
  const calc = calcActuator(options);
  const timeoutMs = options.timeoutMs ?? 90_000;
  return {
    name: "libreoffice",
    calcSet(sheetPath, ref, value) {
      const report = calc.act(sheetPath, ref, value, true);
      if (!report.ok || report.saved !== true)
        throw new Error(`Calc actuator failed: ${report.error ?? "not saved"}`);
    },
    writerAppend(reportPath, label, text) {
      const result = spawnSync(
        pythonBinary(options),
        [
          WRITER_ACTUATOR_SCRIPT,
          "--doc",
          reportPath,
          "--label",
          label,
          "--text",
          text,
          "--soffice",
          sofficeBinary(options),
          "--timeout",
          String(Math.ceil(timeoutMs / 1000)),
        ],
        { encoding: "utf8", timeout: timeoutMs + 30_000 },
      );
      const last = (result.stdout ?? "").trim().split("\n").pop() ?? "";
      let report: { ok?: unknown; saved?: unknown; error?: unknown } = {};
      try {
        report = JSON.parse(last) as typeof report;
      } catch {
        // fall through
      }
      if (report.ok !== true || report.saved !== true)
        throw new Error(
          `Writer actuator failed (exit ${String(result.status)}): ${String(report.error ?? (result.stderr || "no report"))}`,
        );
    },
  };
}
