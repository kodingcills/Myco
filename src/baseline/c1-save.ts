/**
 * Saving the C1 baseline's document with the same semantics M1 uses.
 *
 * ## Why this exists
 *
 * Both arms are told to save. They did not save the same way, and C1's could not
 * succeed at all on a converted `.xlsx`.
 *
 * M1 declares `{ kind: "keyPress", keys: "ctrl+s" }` (`calc-record-edit.ts:163`)
 * but never sends that keystroke: `calc-adapter.ts:429` intercepts it and calls a
 * helper op which sends `{Ctrl}s` and then CLICKS the "Use Excel 2010-365
 * Spreadsheet Format" button in the dialog a CSV-converted `.xlsx` raises on
 * first save (`HELPER_SOURCE`, the `save` branch).
 *
 * C1 sent a raw `press_key` through Cua with no dialog handling, so the first and
 * only save attempt in the baseline's history came back `cua-action-refused`
 * (arm-003c row 0). That refusal is attributable to the harness, not the model.
 *
 * ## What this does instead
 *
 * Sends the same key and answers the same dialog, from the C1 side, over the
 * Myco agent transport the caller already holds. It is deliberately NOT a new
 * general agent channel: the trial gets one method, `save()`, and nothing else.
 *
 * The dialog answer is done by name match on the button's control name rather
 * than by clicking screenshot pixels, because that is what M1 does - matching by
 * pixels would be a different operation and would make the comparison depend on
 * the baseline finding a button it was never told about.
 */
import type { AgentClient } from "../win/agent-client.ts";

/** Guest path the helper is written to. Distinct from M1's, so the two cannot collide. */
const SAVE_HELPER_NAME = "myco_c1_save.py";

/**
 * Sends Ctrl+S and answers the format dialog. Prints one JSON line.
 *
 * Kept small and self-contained: it depends only on uiautomation and the frame
 * title, so it cannot drift from what M1's `save` branch does in the ways that
 * matter (send the key, then click the "Use Excel..." button if present).
 */
const SAVE_HELPER_SOURCE = `
import json, sys, time

def main():
    title_substr, out_file = sys.argv[1], sys.argv[2]
    rep = {"ok": False, "answeredDialog": False, "error": None}
    try:
        import uiautomation as auto
        # Find the Calc frame by title substring, matching M1's wait_frame.
        hwnd = None
        deadline = time.time() + 10
        while time.time() < deadline:
            root = auto.GetRootControl()
            for w in root.GetChildren():
                if title_substr and title_substr in (w.Name or ""):
                    hwnd = w.NativeWindowHandle
                    break
            if hwnd:
                break
            time.sleep(0.2)
        if not hwnd:
            raise RuntimeError("Calc frame not found")
        win = auto.ControlFromHandle(hwnd)
        win.SetActive()
        win.SetTopmost(False)
        auto.SendKeys("{Ctrl}s", interval=0.02, waitTime=1.5)
        # A converted .xlsx trips LibreOffice's "Non-standard file format"
        # question on first save. Answer it by keeping the current format.
        # No dialog -> nothing to do (idempotent).
        for _ in range(20):
            win = auto.ControlFromHandle(hwnd)
            btn = None
            for ctrl, _d in auto.WalkControl(win, maxDepth=10):
                if ctrl.ControlTypeName == "ButtonControl" and (ctrl.Name or "").startswith("Use Excel"):
                    btn = ctrl
                    break
            if btn is not None:
                btn.Click(simulateMove=False)
                rep["answeredDialog"] = True
                time.sleep(1.0)
                break
            time.sleep(0.5)
        rep["ok"] = True
    except Exception as exc:
        rep["error"] = "%s: %s" % (type(exc).__name__, exc)
    with open(out_file, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(rep))

main()
`;

/** Local sleep; the repo has no shared helper and one line beats a dependency. */
async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export interface SaveResult {
  ok: boolean;
  answeredDialog: boolean;
  error?: string;
}

/**
 * Perform a save against the guest's open Calc document.
 *
 * `titleNeedle` is matched as a substring of the window title, as M1 does, so a
 * stray second window cannot be saved by accident.
 */
export async function saveGuestDocument(options: {
  client: AgentClient;
  xlsxPath: string;
  helperDir?: string;
  timeoutMs?: number;
}): Promise<SaveResult> {
  const helperPath = `${options.helperDir ?? "C:\\myco\\runs"}\\${SAVE_HELPER_NAME}`;
  const timeoutMs = options.timeoutMs ?? 60_000;
  await options.client.writeFile(helperPath, Buffer.from(SAVE_HELPER_SOURCE, "utf8"));

  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const outFile = `${helperPath}.${nonce}.result.json`;
  // The needle is the file's basename: M1 uses titleNeedle(xlsxPath), which is
  // the tail of the path, because the window title carries the file name only.
  const needle = options.xlsxPath.split(/[\\/]/).pop() ?? options.xlsxPath;

  try {
    await options.client.launch([
      "C:\\Program Files\\LibreOffice\\program\\python.exe",
      helperPath,
      needle,
      outFile,
    ]);
  } catch (error) {
    return { ok: false, answeredDialog: false, error: `launch failed: ${String(error)}` };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      const bytes = await options.client.readFile(outFile);
      const parsed = JSON.parse(bytes.toString("utf8")) as SaveResult;
      return {
        ok: parsed.ok === true,
        answeredDialog: parsed.answeredDialog === true,
        ...(parsed.error ? { error: parsed.error } : {}),
      };
    } catch {
      // not written yet
    }
  }
  return { ok: false, answeredDialog: false, error: "helper timed out" };
}
