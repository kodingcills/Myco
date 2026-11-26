/**
 * Track R on the Linux path: the real LibreOffice Calc recorder and replayer, through
 * `scripts/linux/calc_recorder.py` (Python-UNO; same prerequisites as docs/product/linux-path.md).
 *
 *  - `calcRecorderSource`: a `DemonstrationSource` whose events are Calc's own (an
 *    XModifyListener diffed into app-level cell changes, and document save events). In
 *    human mode Calc opens a visible window and the recording lasts until the operator
 *    closes the document or stops the recorder. With `script`, a scripted "human" drives
 *    the same document through Calc's dispatcher (tests, demo).
 *  - `calcReplayActuator`: a `WorkflowActuator` that types each edit through Calc's input
 *    path and saves as CSV.
 *
 * The document path goes to the script on argv (it must open the file); the script never
 * prints it, and only the allowlisted event fields reach the recorder. Script stderr is
 * discarded, so an error message holding a path cannot reach a recording or a report.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pythonBinary } from "../linux/actuator.ts";
import { sofficeBinary } from "../linux/soffice.ts";
import type { WorkflowActuator } from "./replay.ts";
import type { DemonstrationSource, HumanStep } from "./scripted-human.ts";
import type { SourceEvent } from "./types.ts";

export const RECORDER_SCRIPT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "linux",
  "calc_recorder.py",
);

export interface CalcRecorderOptions {
  /** The CSV document to record on. Calc edits and saves it in place. */
  readonly docPath: string;
  /** No window (tests). The human mode needs a display. */
  readonly headless?: boolean;
  /** A scripted human's steps; omit for a real human demonstration. */
  readonly script?: readonly HumanStep[];
  readonly timeoutMs?: number;
}

export class CalcRecorderError extends Error {
  override readonly name = "CalcRecorderError";
}

export function calcRecorderSource(options: CalcRecorderOptions): DemonstrationSource {
  return {
    demonstrate(push) {
      const work = mkdtempSync(join(tmpdir(), "myco-rec-src-"));
      const argv = [
        RECORDER_SCRIPT,
        "record",
        "--doc",
        options.docPath,
        "--soffice",
        sofficeBinary(),
        "--timeout",
        String(Math.ceil((options.timeoutMs ?? 90_000) / 1000)),
      ];
      if (options.headless) argv.push("--headless");
      if (options.script) {
        const steps = join(work, "steps.json");
        writeFileSync(steps, JSON.stringify(options.script));
        argv.push("--script", steps);
      }
      return new Promise<Uint8Array>((done, fail) => {
        const child = spawn(pythonBinary(), argv, { stdio: ["ignore", "pipe", "ignore"] });
        let failed: string | undefined;
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (typeof event !== "object" || event === null) return;
          const type = (event as { type?: unknown }).type;
          if (type === "error") failed = "the Calc recorder reported an error";
          else if (type === "cell-changed" || type === "saved") push(event as SourceEvent);
        });
        child.on("error", () => {
          failed = "the Calc recorder could not start";
        });
        child.on("close", (code) => {
          rmSync(work, { recursive: true, force: true });
          if (failed !== undefined || code !== 0) {
            fail(new CalcRecorderError(failed ?? `the Calc recorder exited ${String(code)}`));
            return;
          }
          try {
            done(new Uint8Array(readFileSync(options.docPath)));
          } catch {
            fail(new CalcRecorderError("the saved document could not be read"));
          }
        });
      });
    },
  };
}

export function calcReplayActuator(options: { timeoutMs?: number } = {}): WorkflowActuator {
  return {
    name: "libreoffice-calc-uno",
    run(docPath, edits) {
      const work = mkdtempSync(join(tmpdir(), "myco-replay-act-"));
      try {
        const file = join(work, "edits.json");
        writeFileSync(file, JSON.stringify(edits));
        const result = spawnSync(
          pythonBinary(),
          [
            RECORDER_SCRIPT,
            "replay",
            "--doc",
            docPath,
            "--edits",
            file,
            "--soffice",
            sofficeBinary(),
            "--timeout",
            String(Math.ceil((options.timeoutMs ?? 90_000) / 1000)),
          ],
          { encoding: "utf8", timeout: (options.timeoutMs ?? 90_000) + 30_000 },
        );
        const last = (result.stdout ?? "").trim().split("\n").pop() ?? "";
        try {
          const parsed = JSON.parse(last) as { ok?: unknown; error?: unknown };
          if (parsed.ok === true) return { ok: true };
          return {
            ok: false,
            error: typeof parsed.error === "string" ? parsed.error : "replay failed",
          };
        } catch {
          return { ok: false, error: `replay exited ${String(result.status)}` };
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
