/**
 * Windows AppAdapter for LibreOffice Calc over the myco-agent ops
 * (M1-013 / TIF-17: M1-006 shapes wired to the live agent).
 *
 * Division of channels (docs/env/windows.md §"The LibreOffice UIA finding"):
 * - Actuation: UIA + keyboard through the guest agent — the proven VM smoke
 *   flow: MSAA wake before enumerating (LibreOffice's UIA tree is lazy),
 *   `bring_to_front` before keystrokes (scheduled-task windows don't get
 *   foreground), Name Box jump + keyboard entry (ValuePattern.SetValue never
 *   commits). Descriptors go stale after every mutation, so the helper
 *   re-finds the frame and Name Box for each action instead of caching them.
 * - Observation: cell values come from UNO readback of the live document;
 *   the MSAA→UIA proxy is lossy for cell contents, so UNO is the only
 *   authoritative value source. Only the cells the program's guards actually
 *   need are read (target cell + its record's key cell) — observations run
 *   after every step, so reading the whole fixture would be quadratic.
 *
 * The adapter deploys a one-shot guest helper script (`myco_uia_act.py`) via
 * write_file + launch because the merged agent ops have no keystroke and no
 * MSAA-wake primitive; the helper is a pure executor (one JSON command in,
 * one JSON result file out) and holds no policy (ADR-0001).
 */

import {
  type Action,
  type ActResult,
  type AdapterCapabilities,
  type AppAdapter,
  StaleRefError,
  UnknownRefError,
} from "../core/adapter.ts";
import type { AppState, StateNode } from "../core/state.ts";
import type { AgentClient, UnoEvalResult } from "./agent-client.ts";

export interface WindowsAdapterOptions {
  client: AgentClient;
  /** Guest path of the .xlsx the trial edits. */
  xlsxPath: string;
  /** UNO accept socket of the live Calc instance, e.g. "2002". */
  unoSocket: string;
  /**
   * Cell refs the program's guards read (target cell + key cell). The
   * adapter observes exactly these — nothing else — on every observe().
   */
  observedCells: readonly string[];
  /** Guest dir the actuator helper script is written to. */
  helperDir?: string;
  /** Timeout for one helper actuation, ms. */
  helperTimeoutMs?: number;
}

const HELPER_NAME = "myco_uia_act.py";

/**
 * Guest-side one-shot actuator (runs under LibreOffice's bundled Python so it
 * can import uiautomation; deployed by the adapter over write_file).
 *
 * Commands (argv: <json> <resultPath>), result {ok: true, ...} | {ok: false, error}:
 *   focus    — poll for the Calc frame by title substring, wake the MSAA
 *              bridge (AccessibleObjectFromWindow OBJID_CLIENT), bring the
 *              frame to the foreground.
 *   nametype — find frame, wake, find the Name Box (first ComboBox), click,
 *              select-all, type <cell> + Enter (jump), then if text is
 *              non-empty type <text> + Enter (commit via keyboard —
 *              ValuePattern.SetValue never commits).
 *   keys     — send a uiautomation SendKeys combo ({Ctrl}s …).
 */
const HELPER_SOURCE = `
import ctypes, json, sys, time

u32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32

def find_frame(substr):
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, _):
        c = ctypes.create_unicode_buffer(64)
        u32.GetClassNameW(h, c, 64)
        if c.value != "SALFRAME" or not u32.IsWindowVisible(h):
            return True
        b = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(h, b, 512)
        if substr in b.value:
            found.append(h)
        return True
    u32.EnumWindows(cb, 0)
    return found[0] if found else None

def wait_frame(substr, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        hwnd = find_frame(substr)
        if hwnd:
            return hwnd
        time.sleep(0.5)
    return None

def bring_to_front(hwnd):
    # Smoke-test parity (smoke_calc_uia.py): Esc dismisses Start/Search
    # flyouts that hold the foreground; Alt tap grants the caller foreground
    # rights; AttachThreadInput (user32!) + SetForegroundWindow then
    # verifies. Scheduled-task windows don't get foreground otherwise.
    for _ in range(10):
        fg = u32.GetForegroundWindow()
        if fg == hwnd:
            return True
        fg_class = ctypes.create_unicode_buffer(128)
        u32.GetClassNameW(fg, fg_class, 128)
        if fg_class.value in ("Windows.UI.Core.CoreWindow", "Shell_TrayWnd", "Xaml_WindowedPopupClass"):
            u32.keybd_event(0x1B, 0, 0, 0)
            u32.keybd_event(0x1B, 0, 2, 0)
            time.sleep(0.4)
        u32.keybd_event(0x12, 0, 0, 0)
        u32.keybd_event(0x12, 0, 2, 0)
        ft = u32.GetWindowThreadProcessId(fg, None)
        me = k32.GetCurrentThreadId()
        u32.AttachThreadInput(me, ft, True)
        u32.ShowWindow(hwnd, 9)
        u32.BringWindowToTop(hwnd)
        u32.SetForegroundWindow(hwnd)
        u32.SetFocus(hwnd)
        u32.AttachThreadInput(me, ft, False)
        time.sleep(0.3)
    return u32.GetForegroundWindow() == hwnd

def wake_a11y(hwnd):
    import comtypes.client
    comtypes.client.GetModule("oleacc.dll")
    from comtypes.gen.Accessibility import IAccessible
    acc = ctypes.POINTER(IAccessible)()
    ctypes.oledll.oleacc.AccessibleObjectFromWindow(
        hwnd, 0xFFFFFFFC, ctypes.byref(IAccessible._iid_), ctypes.byref(acc))
    return acc.accChildCount

def main():
    cmd = json.loads(sys.argv[1])
    out = sys.argv[2]
    rep = {"ok": False}
    try:
        if cmd["op"] == "focus":
            hwnd = wait_frame(cmd["title"], 30)
            if not hwnd:
                raise RuntimeError("Calc frame not found within 30s")
            rep["msaa_children"] = wake_a11y(hwnd)
            rep["foreground"] = bring_to_front(hwnd)
            rep["ok"] = bool(rep["foreground"])
        elif cmd["op"] == "nametype":
            import uiautomation as auto
            hwnd = wait_frame(cmd["title"], 10)
            if not hwnd:
                raise RuntimeError("Calc frame not found")
            wake_a11y(hwnd)
            win = auto.ControlFromHandle(hwnd)
            # The Name Box is the ComboBox inside the "Formula Tool Bar"
            # (the VM smoke test's proven identification — the first
            # ComboBox in the tree is not necessarily it).
            namebox = None
            for ctrl, _d in auto.WalkControl(win, maxDepth=12):
                if ctrl.ControlTypeName != "ComboBoxControl":
                    continue
                parent = ctrl.GetParentControl()
                for _ in range(8):
                    if parent is None:
                        break
                    if parent.ControlTypeName == "ToolBarControl" and parent.Name == "Formula Tool Bar":
                        namebox = ctrl
                        break
                    parent = parent.GetParentControl()
                if namebox:
                    break
            if namebox is None:
                raise RuntimeError("Name Box not found in UIA tree")
            if not bring_to_front(hwnd):
                raise RuntimeError("could not bring Calc to foreground")
            namebox.Click(simulateMove=False)
            time.sleep(0.3)
            auto.SendKeys("{Ctrl}a", waitTime=0.1)
            auto.SendKeys(cmd["cell"] + "{Enter}", waitTime=0.3)
            if cmd.get("text"):
                auto.SendKeys(cmd["text"] + "{Enter}", interval=0.02, waitTime=0.4)
            rep["ok"] = True
        elif cmd["op"] == "save":
            import uiautomation as auto
            hwnd = wait_frame(cmd["title"], 10)
            if not hwnd:
                raise RuntimeError("Calc frame not found")
            if not bring_to_front(hwnd):
                raise RuntimeError("could not bring Calc to foreground")
            auto.SendKeys("{Ctrl}s", interval=0.02, waitTime=1.5)
            # A CSV-converted .xlsx trips LibreOffice's "Non-standard file
            # format" question dialog on first save: answer it by clicking
            # "Use Excel 2010–365 Spreadsheet Format" (keep the current
            # format). No dialog → nothing to do (idempotent).
            for _ in range(20):
                win = auto.ControlFromHandle(hwnd)
                btn = None
                for ctrl, _d in auto.WalkControl(win, maxDepth=10):
                    if ctrl.ControlTypeName == "ButtonControl" and ctrl.Name.startswith("Use Excel"):
                        btn = ctrl
                        break
                if btn is not None:
                    btn.Click(simulateMove=False)
                    time.sleep(1.0)
                    break
                time.sleep(0.5)
            rep["ok"] = True
        elif cmd["op"] == "keys":
            import uiautomation as auto
            hwnd = wait_frame(cmd["title"], 10)
            if not hwnd:
                raise RuntimeError("Calc frame not found")
            if not bring_to_front(hwnd):
                raise RuntimeError("could not bring Calc to foreground")
            auto.SendKeys(cmd["keys"], interval=0.02, waitTime=cmd.get("wait", 0.4))
            rep["ok"] = True
        else:
            raise RuntimeError("unknown op " + cmd["op"])
    except Exception as e:
        rep["error"] = repr(e)
    with open(out, "w") as fh:
        json.dump(rep, fh)

main()
`;

interface HelperResult {
  ok: boolean;
  error?: string;
}

/** Window title needle: Calc shows "<basename> - LibreOffice Calc". */
function titleNeedle(xlsxPath: string): string {
  return xlsxPath.replaceAll("\\", "/").split("/").pop() ?? "";
}

export class WindowsCalcAdapter implements AppAdapter {
  readonly #client: AgentClient;
  #xlsxPath: string;
  readonly #unoSocket: string;
  readonly #observedCells: readonly string[];
  readonly #helperPath: string;
  readonly #helperTimeoutMs: number;
  #stateVersion = 0;
  #calcPid: number | null = null;
  #helperDeployed = false;
  #refs = new Map<string, { nodeId: string; refVersion: number }>();

  constructor(options: WindowsAdapterOptions) {
    this.#client = options.client;
    this.#xlsxPath = options.xlsxPath;
    this.#unoSocket = options.unoSocket;
    this.#observedCells = options.observedCells;
    this.#helperPath = `${options.helperDir ?? "C:\\myco\\runs"}\\${HELPER_NAME}`;
    this.#helperTimeoutMs = options.helperTimeoutMs ?? 30_000;
  }

  /** Set after the fixture convert lands (guest path known post-convert). */
  setXlsxPath(path: string): void {
    this.#xlsxPath = path;
  }

  capabilities(): AdapterCapabilities {
    return { ids: ["win-uia-calc-v1"] };
  }

  /** Symbolic refs: the id is the node id; version-bound for staleness checks. */
  issueRef(nodeId: string): string | null {
    const ref = `winref:${this.#stateVersion}:${nodeId}`;
    this.#refs.set(ref, { nodeId, refVersion: this.#stateVersion });
    return ref;
  }

  /**
   * Observe: UNO readback of the guard-relevant cells + XModifiable state.
   * Throws on UNO failure (agent converts to OP_FAILED): a dead document is
   * an observation error, not an empty state — never guess.
   */
  async observe(): Promise<AppState> {
    const nodes: StateNode[] = [];
    for (const cell of this.#observedCells) {
      // No sheet name: the agent falls back to the ActiveSheet, which for a
      // converted single-document fixture is the fixture sheet (a converted
      // CSV names its sheet after the file, not "Sheet1").
      const result = await this.#uno({ call: "get_string", cell });
      nodes.push({
        id: cell,
        role: "cell",
        name: cell,
        value: unoString(result),
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        enabled: true,
        visible: true,
      });
    }
    const modified = await this.#isModified();
    this.#stateVersion += 1;
    return {
      stateVersion: this.#stateVersion,
      capturedAt: new Date().toISOString(),
      facts: {
        documentPath: this.#xlsxPath,
        dirty: modified,
        focusedNodeId: null,
      },
      nodes,
    };
  }

  async act(action: Action): Promise<ActResult> {
    switch (action.kind) {
      case "click":
      case "typeText":
      case "setValue": {
        const nodeId = this.#resolveRef(action.ref);
        const text =
          action.kind === "click" ? "" : action.kind === "typeText" ? action.text : action.value;
        const result = await this.#runHelper({
          op: "nametype",
          title: titleNeedle(this.#xlsxPath),
          cell: nodeId,
          text,
        });
        if (!result.ok) {
          return {
            outcome: "failed",
            details: `nametype on ${nodeId}: ${result.error ?? "failed"}`,
          };
        }
        this.#stateVersion += 1;
        return {
          outcome: "delivered_unverified",
          details:
            text === ""
              ? `jumped to ${nodeId} via Name Box`
              : `typed "${text}" into ${nodeId} via Name Box + keyboard`,
          stateVersionAfter: this.#stateVersion,
        };
      }
      case "keyPress": {
        const keys = sendKeysFor(action.keys);
        const result =
          action.keys === "ctrl+s"
            ? // Ctrl+S on a converted .xlsx raises the "Non-standard file
              // format" dialog; the save op answers it (keep Excel format).
              await this.#runHelper({ op: "save", title: titleNeedle(this.#xlsxPath) })
            : await this.#runHelper({
                op: "keys",
                title: titleNeedle(this.#xlsxPath),
                keys,
              });
        if (!result.ok) {
          return {
            outcome: "failed",
            details: `keyPress ${action.keys}: ${result.error ?? "failed"}`,
          };
        }
        if (action.keys === "ctrl+s") {
          // The save is asynchronous in the app: XModifiable stays true for
          // a moment after Ctrl+S. Poll (bounded) until the document is
          // clean, so the step's not-dirty postcondition sees the settled
          // state instead of the in-flight one.
          const deadline = Date.now() + 20_000;
          for (;;) {
            let modified: boolean;
            try {
              modified = await this.#isModified();
            } catch {
              break; // the runner's postcondition observation reports the error
            }
            if (!modified) break;
            if (Date.now() >= deadline) break;
            await sleep(400);
          }
        }
        this.#stateVersion += 1;
        return {
          outcome: "delivered_unverified",
          details: `sent ${action.keys} to Calc`,
          stateVersionAfter: this.#stateVersion,
        };
      }
      case "waitFor":
        this.#stateVersion += 1;
        return {
          outcome: "delivered_unverified",
          details: "waitFor dispatched; predicate checked by runner",
          stateVersionAfter: this.#stateVersion,
        };
      default:
        return {
          outcome: "failed",
          details: `unknown action kind ${String((action as { kind: unknown }).kind)}`,
        };
    }
  }

  /**
   * Symbolic refs carry the node id directly; string refs are looked up and
   * version-checked (stale after any mutation — descriptors always re-found).
   */
  #resolveRef(ref: string | { nodeId: string }): string {
    if (typeof ref !== "string") return ref.nodeId;
    const entry = this.#refs.get(ref);
    if (!entry) throw new UnknownRefError(ref);
    if (entry.refVersion !== this.#stateVersion) {
      throw new StaleRefError(ref, entry.refVersion, this.#stateVersion);
    }
    return entry.nodeId;
  }

  async #isModified(): Promise<boolean> {
    const result = await this.#uno({ call: "is_modified" });
    return unoModified(result);
  }

  /**
   * uno_eval with a bounded retry for transient bridge disposal. LibreOffice
   * disposes a URP bridge when a client disconnects (the agent opens one
   * resolver connection per call), so an occasional DisposedException is
   * expected, not fatal. A real failure (app dead, UNO unreachable)
   * exhausts the retries and surfaces the underlying error.
   */
  async #uno(params: { call: string; cell?: string }): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return (await this.#client.unoEval({
          ...params,
          socket: this.#unoSocket,
        })) as unknown as Record<string, unknown>;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("DisposedException")) throw error;
        await sleep(400);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Launch Calc with the fixture and the UNO accept socket, then block until
   * the window is observable (frame found, MSAA bridge woken, foreground).
   * Called by the integration runner before the program's first step.
   */
  async launchCalc(): Promise<number> {
    await this.#deployHelper();
    // A running soffice instance swallows new launches: soffice.exe delegates
    // to the existing process, so --accept is ignored and UNO would read the
    // previous document. Kill any stray instance first (idempotent).
    try {
      await this.#client.kill({ image_name: "soffice.bin" });
      await sleep(1000);
    } catch {
      // no stray instance — fine
    }
    const pid = await this.#client.launch([
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      `--accept=socket,host=127.0.0.1,port=${this.#unoSocket};urp;`,
      "--norestore",
      "--nologo",
      this.#xlsxPath,
    ]);
    this.#calcPid = pid;
    const result = await this.#runHelper({ op: "focus", title: titleNeedle(this.#xlsxPath) });
    if (!result.ok) {
      throw new Error(`Calc window never became observable: ${result.error ?? "focus failed"}`);
    }
    // The UNO accept socket comes up asynchronously with the document; a
    // observe() before it listens fails with NoConnect. Poll read-only until
    // the bridge answers (bounded — a dead UNO still fails the trial, just
    // not instantly).
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        // Probe with a cell readback, not is_modified: the frame window (and
        // even the StartCenter component) answers is_modified before the
        // document has a controller; get_string on a fixture cell only
        // succeeds once the sheet is loaded.
        await this.#client.unoEval({
          call: "get_string",
          cell: this.#observedCells[0],
          socket: this.#unoSocket,
        });
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(
            `UNO bridge on socket ${this.#unoSocket} never answered: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await sleep(500);
      }
    }
    return pid;
  }

  get calcPid(): number | null {
    return this.#calcPid;
  }

  async #deployHelper(): Promise<void> {
    if (this.#helperDeployed) return;
    await this.#client.writeFile(this.#helperPath, Buffer.from(HELPER_SOURCE, "utf8"));
    this.#helperDeployed = true;
  }
  async #runHelper(cmd: Record<string, unknown>): Promise<HelperResult> {
    await this.#deployHelper();
    // Unique result file per invocation: a shared name would let the poll
    // read the PREVIOUS invocation's result before the new helper run has
    // written anything (observed live as a silent no-op race).
    const nonceId = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const outFile = `${this.#helperPath}.${nonceId}.result.json`;
    await this.#client.launch([
      "C:\\Program Files\\LibreOffice\\program\\python.exe",
      this.#helperPath,
      JSON.stringify(cmd),
      outFile,
    ]);
    const deadline = Date.now() + this.#helperTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      try {
        const bytes = await this.#client.readFile(outFile);
        return JSON.parse(bytes.toString("utf8")) as HelperResult;
      } catch {
        // result file not written yet — keep polling
      }
    }
    return { ok: false, error: `helper timed out after ${this.#helperTimeoutMs}ms` };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map the closed keyPress vocabulary onto uiautomation SendKeys syntax. */
export function sendKeysFor(keys: string): string {
  switch (keys) {
    case "ctrl+s":
      return "{Ctrl}s";
    case "ctrl+w":
      return "{Ctrl}w";
    case "ctrl+q":
      return "{Ctrl}q";
    default:
      throw new Error(`unsupported key press: ${keys}`);
  }
}

/**
 * Normalize the deployed agent's `uno_eval` result shape. The agent returns
 * `{call, cell, value}` (pinned by its own tests, agent/tests/test_agent.py);
 * early host drafts read `{get_string, is_modified}` keys. Accept both so the
 * host runs against either shape. A missing string reads as "" — an empty
 * cell and an unreadable one are distinguishable by the thrown OP_FAILED.
 */
export function unoString(result: UnoEvalResult | Record<string, unknown>): string {
  const raw = result as Record<string, unknown>;
  if (typeof raw.get_string === "string") return raw.get_string;
  if (typeof raw.value === "string") return raw.value;
  return "";
}

export function unoModified(result: UnoEvalResult | Record<string, unknown>): boolean {
  const raw = result as Record<string, unknown>;
  if (typeof raw.is_modified === "boolean") return raw.is_modified;
  if (typeof raw.value === "boolean") return raw.value;
  if (raw.value === 1 || raw.value === "True") return true;
  return false;
}
