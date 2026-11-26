/**
 * The `linux-uno` state backend (capability track I): reads a live headless LibreOffice
 * Calc over Python-UNO, through `scripts/linux/calc_state.py`.
 *
 * Bound at construction to ONE trial's soffice (its UNO pipe name, set by the harness) and
 * to ONE document in it (its RuntimeUID, read by the harness right after the trial's
 * document loaded). Each call spawns the reader once with a fixed argv (`--pipe <name>
 * --uid <uid>`) and sends the
 * already-validated request on stdin; the agent's input never reaches an argv, a path or a
 * shell. The reader prints `{ok, data}` or `{ok: false, code}`; anything else (a crash, a
 * timeout, a non-code) is BACKEND_ERROR, and stderr is kept for the operator only.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { type GridRange, isStateCode, type SheetRef, STATE_CAPS } from "../api.ts";
import type {
  BackendResult,
  DocumentStatus,
  RangeRead,
  SheetList,
  StateBackend,
  UiTree,
  UiTreeLimits,
} from "../backend.ts";

export const STATE_READER_SCRIPT = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "scripts",
  "linux",
  "calc_state.py",
);

/** The caps the reader applies itself; the server re-checks them. */
const READER_CAPS = {
  maxCells: STATE_CAPS.maxCells,
  maxCellTextChars: STATE_CAPS.maxCellTextChars,
  maxNameChars: STATE_CAPS.maxNameChars,
  maxSheets: STATE_CAPS.maxSheets,
  maxChildrenPerNode: STATE_CAPS.maxChildrenPerNode,
};

/** UNO pipe names the harness may bind: no separators, so never a path. */
export const UNO_PIPE_NAME = /^myco-state-[a-z0-9-]{8,64}$/;

/**
 * The trial document's RuntimeUID: a decimal load counter Calc assigns per soffice process.
 * No client can set it, and a reopened or different document gets a new one.
 */
export const DOC_UID = /^[1-9][0-9]{0,9}$/;

export interface LinuxUnoBackendOptions {
  /** The trial's soffice UNO pipe name (harness-chosen; must match `UNO_PIPE_NAME`). */
  readonly pipe: string;
  /** The trial document's RuntimeUID (harness-read; must match `DOC_UID`). */
  readonly docUid: string;
  /** Python with LibreOffice's UNO bridge; defaults to `$MYCO_PYTHON` or `python3`. */
  readonly python?: string;
  /** Per-call timeout, ms. */
  readonly timeoutMs?: number;
  readonly onDiagnostic?: (detail: string) => void;
}

export function linuxUnoBackend(options: LinuxUnoBackendOptions): StateBackend {
  if (!UNO_PIPE_NAME.test(options.pipe))
    throw new Error("myco-state: the UNO pipe name is not a harness-issued myco-state pipe");
  if (!DOC_UID.test(options.docUid))
    throw new Error("myco-state: the document uid is not a Calc RuntimeUID");
  const python = options.python ?? process.env.MYCO_PYTHON ?? "python3";
  const timeoutMs = options.timeoutMs ?? 20_000;

  function run<T>(request: Record<string, unknown>): Promise<BackendResult<T>> {
    return new Promise((done) => {
      const child = spawn(
        python,
        [
          STATE_READER_SCRIPT,
          "--pipe",
          options.pipe,
          "--uid",
          options.docUid,
          "--timeout",
          String(Math.ceil(timeoutMs / 1000)),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: BackendResult<T>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(result);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        options.onDiagnostic?.("reader timed out");
        finish({ ok: false, code: "BACKEND_ERROR" });
      }, timeoutMs + 5_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < 4 * STATE_CAPS.maxReplyBytes) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        options.onDiagnostic?.(`reader failed to start: ${error.message}`);
        finish({ ok: false, code: "BACKEND_ERROR" });
      });
      child.on("close", () => {
        const last = stdout.trim().split("\n").pop() ?? "";
        try {
          const parsed = JSON.parse(last) as {
            ok?: unknown;
            data?: unknown;
            code?: unknown;
            diag?: unknown;
          };
          if (parsed.ok === true && typeof parsed.data === "object" && parsed.data !== null)
            return finish({ ok: true, data: parsed.data as T });
          if (parsed.ok === false && isStateCode(parsed.code)) {
            // The reader's diag is an exception class name only; the operator sees it, the
            // agent never does (its reply carries the code alone).
            if (typeof parsed.diag === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(parsed.diag))
              options.onDiagnostic?.(`reader ${request.op}: ${parsed.code} (${parsed.diag})`);
            return finish({ ok: false, code: parsed.code });
          }
        } catch {
          // fall through
        }
        options.onDiagnostic?.(`reader gave no valid reply; stderr: ${stderr.trim().slice(-500)}`);
        finish({ ok: false, code: "BACKEND_ERROR" });
      });
      child.stdin.end(JSON.stringify({ ...request, caps: READER_CAPS }));
    });
  }

  return {
    kind: "linux-uno",
    listSheets: () => run<SheetList>({ op: "list_sheets" }),
    readRange: (sheet: SheetRef | null, range: GridRange) =>
      run<RangeRead>({ op: "read_range", sheet, range: [...range] }),
    documentStatus: () => run<DocumentStatus>({ op: "document_status" }),
    uiTree: (limits: UiTreeLimits) =>
      run<UiTree>({ op: "ui_tree", maxDepth: limits.maxDepth, maxNodes: limits.maxNodes }),
  };
}
