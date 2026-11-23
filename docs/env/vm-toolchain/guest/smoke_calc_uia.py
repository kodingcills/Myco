"""Myco VM smoke test, GUI half. Must run in the INTERACTIVE desktop session (use run-interactive.ps1).
Opens C:\\myco\\smoke\\smoke.ods in LibreOffice Calc, wakes LibreOffice's accessibility bridge (MSAA
AccessibleObjectFromWindow; without it UIA only sees the title bar), enumerates the window through UI Automation,
writes VALUE into A1 via the Name Box + keyboard, saves (Ctrl+S), reads the cell back through UIA, and quits.
Report: C:\\myco\\smoke\\uia_report.json"""
import ctypes, json, subprocess, sys, time, traceback
from pathlib import Path
SOFFICE = r"C:\Program Files\LibreOffice\program\soffice.exe"
DOC = Path(r"C:\myco\smoke\smoke.ods"); OUT = Path(r"C:\myco\smoke\uia_report.json")
VALUE = sys.argv[1] if len(sys.argv) > 1 else "myco-smoke-42"
rep = {"value": VALUE, "steps": []}
def step(_s, **kw): rep["steps"].append({"t": round(time.time(), 3), "step": _s, **kw})
u32 = ctypes.windll.user32
def title(h):
    b = ctypes.create_unicode_buffer(512); u32.GetWindowTextW(h, b, 512); return b.value
def find_frame():
    found = []
    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, _):
        c = ctypes.create_unicode_buffer(64); u32.GetClassNameW(h, c, 64)
        if c.value == "SALFRAME" and DOC.name in title(h) and u32.IsWindowVisible(h): found.append(h)
        return True
    u32.EnumWindows(cb, 0); return found[0] if found else None
def cls(h):
    c = ctypes.create_unicode_buffer(128); u32.GetClassNameW(h, c, 128); return c.value
def bring_to_front(hwnd):
    """Reliable foreground for a window launched from a scheduled task (Windows foreground-lock rules):
    synthesize an Alt tap (grants the caller foreground rights), attach to the current foreground thread, then SetForegroundWindow."""
    k32 = ctypes.windll.kernel32
    before = u32.GetForegroundWindow()
    for attempt in range(10):
        fg = u32.GetForegroundWindow()
        if fg == hwnd: return {"ok": True, "attempts": attempt, "before": [title(before), cls(before)]}
        if cls(fg) in ("Windows.UI.Core.CoreWindow", "Shell_TrayWnd", "Xaml_WindowedPopupClass"):
            u32.keybd_event(0x1B, 0, 0, 0); u32.keybd_event(0x1B, 0, 2, 0); time.sleep(0.4)  # Esc: dismiss Start/Search flyout
        u32.keybd_event(0x12, 0, 0, 0); u32.keybd_event(0x12, 0, 2, 0)   # Alt down/up
        ft = u32.GetWindowThreadProcessId(fg, None); me = k32.GetCurrentThreadId()
        u32.AttachThreadInput(me, ft, True)
        u32.ShowWindow(hwnd, 9); u32.BringWindowToTop(hwnd); u32.SetForegroundWindow(hwnd); u32.SetFocus(hwnd)
        u32.AttachThreadInput(me, ft, False)
        time.sleep(0.3)
    fg = u32.GetForegroundWindow()
    return {"ok": fg == hwnd, "attempts": 10, "before": [title(before), cls(before)], "now": [title(fg), cls(fg)]}
def wake_a11y(hwnd):
    import comtypes.client; comtypes.client.GetModule("oleacc.dll")
    from comtypes.gen.Accessibility import IAccessible
    acc = ctypes.POINTER(IAccessible)()
    ctypes.oledll.oleacc.AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC, ctypes.byref(IAccessible._iid_), ctypes.byref(acc))
    return acc.accChildCount
try:
    import uiautomation as auto
    proc = subprocess.Popen([SOFFICE, "--calc", "--norestore", "--nologo", str(DOC)]); step("launched")
    hwnd = None
    for _ in range(120):
        hwnd = find_frame()
        if hwnd: break
        time.sleep(0.5)
    if not hwnd: raise RuntimeError("Calc frame window not found")
    step("window_found", hwnd=hwnd, title=title(hwnd))
    step("a11y_woken", msaa_client_children=wake_a11y(hwnd))
    win = auto.ControlFromHandle(hwnd)
    n = 0; types = {}
    for ctrl, depth in auto.WalkControl(win, maxDepth=12):
        n += 1; types[ctrl.ControlTypeName] = types.get(ctrl.ControlTypeName, 0) + 1
        if n > 3000: break
    step("uia_enumerated", element_count=n, by_type=types)
    namebox = win.ComboBoxControl(searchDepth=12, AutomationId="") if False else None
    for ctrl, depth in auto.WalkControl(win, maxDepth=12):
        if ctrl.ControlTypeName == "ComboBoxControl" and ctrl.GetParentControl() and True:
            # the Name Box is the ComboBox inside the "Formula Tool Bar"
            p = ctrl
            for _ in range(8):
                p = p.GetParentControl()
                if p is None: break
                if p.ControlTypeName == "ToolBarControl" and p.Name == "Formula Tool Bar": namebox = ctrl; break
        if namebox: break
    if not namebox: raise RuntimeError("Name Box not found in UIA tree")
    step("name_box", current=namebox.Name, rect=str(namebox.BoundingRectangle))
    f = bring_to_front(hwnd); step("foreground", **f)
    if not f["ok"]: raise RuntimeError("could not bring Calc to the foreground: %r" % (f,))
    namebox.Click(simulateMove=False); time.sleep(0.3)
    auto.SendKeys("{Ctrl}a", waitTime=0.1); auto.SendKeys("A1{Enter}", waitTime=0.3)
    auto.SendKeys(VALUE + "{Enter}", interval=0.01, waitTime=0.3)
    step("typed")
    auto.SendKeys("{Ctrl}s", waitTime=1.5)
    extra = [title(h) for h in [u32.GetForegroundWindow()] if h != hwnd]
    step("saved", foreground_after_save=extra)
    # In-app readback through UIA: the cell A1 element under the sheet table
    a1 = None
    for ctrl, depth in auto.WalkControl(win, maxDepth=14):
        if ctrl.ControlTypeName in ("DataItemControl", "CustomControl", "EditControl") and ctrl.Name.startswith("A1"):
            a1 = ctrl; break
    if a1:
        val = None
        try: val = a1.GetValuePattern().Value
        except Exception: pass
        step("uia_cell_A1", name=a1.Name, value_pattern=val, type=a1.ControlTypeName)
    else:
        step("uia_cell_A1", found=False)
    auto.SendKeys("{Ctrl}q", waitTime=1)
    try: proc.wait(timeout=20)
    except Exception: pass
    step("quit", frame_still_open=bool(find_frame()))
    rep["ok"] = True
except Exception as e:
    rep["ok"] = False; rep["error"] = repr(e); rep["trace"] = traceback.format_exc()
OUT.write_text(json.dumps(rep, indent=2))
