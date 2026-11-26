/**
 * The Linux actuator (TIF-269, M2-06): drives a real LibreOffice Calc,
 * headless, through `scripts/linux/calc_actuator.py` (Python-UNO).
 *
 * The script opens the workbook with a throwaway profile, types one value into
 * one cell through Calc's input path (`.uno:EnterString`), saves or not, and
 * closes. It reports what it did; the report is a trace record, never an input
 * to the verdict.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { SofficeOptions } from "./soffice.ts";
import { sofficeBinary } from "./soffice.ts";

export interface ActuatorReport {
  readonly ok: boolean;
  readonly cell?: string;
  readonly typed?: string;
  /** Cell text before typing, as Calc displayed it. */
  readonly before?: string;
  /** Cell text after typing, as Calc displayed it (the agent's "screen"). */
  readonly after?: string;
  readonly saved?: boolean;
  readonly error?: string;
}

export interface Actuator {
  act(docPath: string, cell: string, value: string, save: boolean): ActuatorReport;
}

export const ACTUATOR_SCRIPT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "linux",
  "calc_actuator.py",
);

export interface CalcActuatorOptions extends SofficeOptions {
  /** Python with LibreOffice's UNO bridge; defaults to `$MYCO_PYTHON` or `python3`. */
  readonly python?: string;
}

export function pythonBinary(options: CalcActuatorOptions = {}): string {
  return options.python ?? process.env.MYCO_PYTHON ?? "python3";
}

/** True when the Python interpreter can import LibreOffice's `uno` module. */
export function pythonUnoAvailable(options: CalcActuatorOptions = {}): boolean {
  const result = spawnSync(pythonBinary(options), ["-c", "import uno"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.status === 0;
}

export function calcActuator(options: CalcActuatorOptions = {}): Actuator {
  return {
    act(docPath, cell, value, save) {
      const argv = [
        ACTUATOR_SCRIPT,
        "--doc",
        docPath,
        "--cell",
        cell,
        "--value",
        value,
        "--soffice",
        sofficeBinary(options),
        "--timeout",
        String(Math.ceil((options.timeoutMs ?? 90_000) / 1000)),
      ];
      if (!save) argv.push("--no-save");
      const result = spawnSync(pythonBinary(options), argv, {
        encoding: "utf8",
        timeout: (options.timeoutMs ?? 90_000) + 30_000,
      });
      const lastLine = (result.stdout ?? "").trim().split("\n").pop() ?? "";
      try {
        const parsed = JSON.parse(lastLine) as ActuatorReport;
        if (typeof parsed.ok === "boolean") return parsed;
      } catch {
        // fall through to the failure report
      }
      const why = result.error?.message ?? ((result.stderr ?? "").trim() || "no report");
      return { ok: false, error: `actuator failed (exit ${String(result.status)}): ${why}` };
    },
  };
}
