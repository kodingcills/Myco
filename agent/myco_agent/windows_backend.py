"""Real Windows backend. All Windows-only imports are lazy, inside methods, so
the package imports and tests cleanly on macOS/Linux.

UIA is driven through `uiautomation` (yinkaisheng) whose COM client
(CUIAutomation8) is upgraded per call-thread to IUIAutomation2 with
SetConnectionTimeout/SetTransactionTimeout applied before any query
(ADR-0003), so a killed or wedged app produces a bounded COM error instead of
an unbounded hang. Timeouts are configurable via
MYCO_UIA_CONNECT_TIMEOUT_MS / MYCO_UIA_TRANSACTION_TIMEOUT_MS (defaults
5000/10000).

Screenshots use raw GDI BitBlt + GDI+ PNG encoding (PIL is not installed in
the guest and is not an agent dependency).
"""

import base64
import ctypes
import os
import subprocess
import threading

from . import AGENT_VERSION
from .protocol import OpError

DEFAULT_CONNECT_TIMEOUT_MS = 5_000
DEFAULT_TRANSACTION_TIMEOUT_MS = 10_000
MAX_ELEMENTS = 3_000          # hard element cap (ADR-0003 observation shape)
MAX_WINDOWS = 8               # hard top-level window cap per uia_tree
MAX_SEARCH_DEPTH = 14         # runtime-id search depth

_OBJID_CLIENT = 0xFFFFFFFC    # the window's client-area MSAA object


def _env_ms(name, default):
    try:
        return max(0, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _connect_timeout_ms():
    return _env_ms("MYCO_UIA_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS)


def _transaction_timeout_ms():
    return _env_ms("MYCO_UIA_TRANSACTION_TIMEOUT_MS", DEFAULT_TRANSACTION_TIMEOUT_MS)


# --------------------------------------------------------------------- user32

def _u32():
    import ctypes.wintypes as wintypes

    u32 = ctypes.WinDLL("user32", use_last_error=True)
    u32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(ctypes.c_uint)]
    u32.GetWindowThreadProcessId.restype = ctypes.c_uint
    return u32


def _window_title(u32, hwnd):
    buf = ctypes.create_unicode_buffer(512)
    u32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def _window_class(u32, hwnd):
    buf = ctypes.create_unicode_buffer(128)
    u32.GetClassNameW(hwnd, buf, 128)
    return buf.value


def _top_windows():
    """All visible top-level windows: [(hwnd, pid, title, class_name)]."""
    u32 = _u32()
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        if u32.IsWindowVisible(hwnd):
            pid = ctypes.c_uint()
            u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            found.append(
                (hwnd, pid.value, _window_title(u32, hwnd), _window_class(u32, hwnd))
            )
        return True

    u32.EnumWindows(cb, 0)
    return found


def _user_object_name(handle):
    """GetUserObjectInformationW(UOI_NAME) for a window-station/desktop handle."""
    import ctypes.wintypes as wintypes

    u32 = ctypes.windll.user32
    length = wintypes.DWORD()
    u32.GetUserObjectInformationW(handle, 1, None, 0, ctypes.byref(length))  # 1 = UOI_NAME
    buf = ctypes.create_unicode_buffer(length.value // 2 + 1)
    if not u32.GetUserObjectInformationW(handle, 1, buf, length.value, ctypes.byref(length)):
        raise OpError("OP_FAILED", "GetUserObjectInformationW failed")
    return buf.value


def _is_timeout_error(exc):
    """COM/UIA timeout shapes (UIA_E_TIMEOUT lives under 0x80131505; comtypes
    surfaces HRESULTs as COMError with the hex value in .hresult)."""
    if isinstance(exc, TimeoutError):
        return True
    hresult = getattr(exc, "hresult", None)
    if isinstance(getattr(hresult, "value", None), int):
        hresult = hresult.value
    if isinstance(hresult, int) and hresult & 0xFFFFFFFF == 0x80131505:
        return True
    return "timeout" in str(exc).lower()


# ------------------------------------------------------------------- backend

class WindowsBackend:
    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("WindowsBackend requires Windows")
        self._thread_state = threading.local()

    # ----- UIA plumbing -----

    def _uia_thread(self):
        """uiautomation's COM client scoped to this thread, upgraded to
        IUIAutomation2 with both timeouts set before any query. Sits inside
        UIAutomationInitializerInThread, which CoInitializes COM per thread.

        The timeouts are re-read from env each call, so config changes after
        agent start are honoured on every thread.
        """
        import uiautomation as auto
        from comtypes.gen.UIAutomationClient import IUIAutomation2

        with auto.UIAutomationInitializerInThread():
            client = auto._AutomationClient.instance().IUIAutomation.QueryInterface(
                IUIAutomation2
            )
            client.SetConnectionTimeout(_connect_timeout_ms())
            client.SetTransactionTimeout(_transaction_timeout_ms())
            try:
                yield client
            finally:
                pass  # context manager uninitializes COM for this thread

    def _uia_call(self, fn, what):
        """Run fn(client) inside the timeout-configured thread UIA client;
        relabel bounded COM failures as TIMEOUT with elapsed time. Whatever
        fn raises surfaces as OP_FAILED (protocol.handle_request); the server
        always answers — a hung app cannot hang the agent."""
        import time

        start = time.monotonic()
        gen = self._uia_thread()
        try:
            client = next(gen)
            try:
                return fn(client)
            except OpError:
                raise
            except Exception as exc:
                elapsed = time.monotonic() - start
                budget = (_connect_timeout_ms() + _transaction_timeout_ms()) / 1000.0
                if _is_timeout_error(exc) or elapsed >= budget * 0.5:
                    raise OpError(
                        "OP_FAILED",
                        "UIA %s: TIMEOUT after %.1fs: %s: %s"
                        % (what, elapsed, type(exc).__name__, exc),
                    ) from exc
                raise OpError(
                    "OP_FAILED",
                    "UIA %s failed after %.1fs: %s: %s"
                    % (what, elapsed, type(exc).__name__, exc),
                ) from exc
        finally:
            gen.close()

    # ----- MSAA wake + foreground (guest findings 1 & 2) -----

    def _wake_msaa(self, hwnd):
        """One AccessibleObjectFromWindow(hwnd, OBJID_CLIENT): until a client
        makes an MSAA call, LibreOffice builds no accessibility bridge and UIA
        sees only the title bar. Harmless for other apps."""
        import comtypes
        import comtypes.client

        comtypes.client.GetModule("oleacc.dll")
        from comtypes.gen.Accessibility import IAccessible

        acc = ctypes.POINTER(IAccessible)()
        hr = ctypes.oledll.oleacc.AccessibleObjectFromWindow(
            hwnd, _OBJID_CLIENT, ctypes.byref(IAccessible._iid_), ctypes.byref(acc)
        )
        if hr != 0:
            raise OpError("OP_FAILED", "AccessibleObjectFromWindow failed hr=%s" % hr)

    def _bring_to_front(self, hwnd, timeout_s=8.0):
        """Reliable foreground for a scheduled-task-launched window: dismiss
        shell flyouts (Esc), Alt tap to earn SetForegroundWindow rights,
        AttachThreadInput to the current foreground thread, then verify.
        Patterened on C:\\myco\\bin\\smoke_calc_uia.py."""
        import time

        u32 = _u32()
        k32 = ctypes.windll.kernel32
        deadline = time.monotonic() + timeout_s
        while True:
            fg = u32.GetForegroundWindow()
            if fg == hwnd:
                return {"ok": True}
            if time.monotonic() > deadline:
                return {"ok": False, "foreground": _window_title(u32, fg) or hex(fg or 0)}
            if _window_class(u32, fg) in (
                "Windows.UI.Core.CoreWindow",
                "Shell_TrayWnd",
                "Xaml_WindowedPopupClass",
            ):
                u32.keybd_event(0x1B, 0, 0, 0)  # Esc down: dismiss Start/Search flyout
                u32.keybd_event(0x1B, 0, 2, 0)  # Esc up
                time.sleep(0.4)
            u32.keybd_event(0x12, 0, 0, 0)     # Alt down
            u32.keybd_event(0x12, 0, 2, 0)     # Alt up
            fg_thread = u32.GetWindowThreadProcessId(fg, None)
            me = k32.GetCurrentThreadId()
            u32.AttachThreadInput(me, fg_thread, True)
            try:
                u32.ShowWindow(hwnd, 9)        # SW_RESTORE
                u32.BringWindowToTop(hwnd)
                u32.SetForegroundWindow(hwnd)
                u32.SetFocus(hwnd)
            finally:
                u32.AttachThreadInput(me, fg_thread, False)
            time.sleep(0.3)

    # ----- ops -----

    def ping(self):
        return {"backend": "windows", "agent_version": AGENT_VERSION}

    def session_info(self):
        import ctypes.wintypes as wintypes

        pid = os.getpid()
        session_id = wintypes.DWORD()
        if not ctypes.windll.kernel32.ProcessIdToSessionId(pid, ctypes.byref(session_id)):
            raise OpError("OP_FAILED", "ProcessIdToSessionId failed")
        u32 = ctypes.windll.user32
        station = u32.GetProcessWindowStation()
        desktop = u32.GetThreadDesktop(ctypes.windll.kernel32.GetCurrentThreadId())
        computer = os.environ.get("COMPUTERNAME", "")
        user = os.environ.get("USERNAME", "")
        return {
            "session_id": session_id.value,
            "window_station": _user_object_name(station),
            "desktop": _user_object_name(desktop),
            "user": "%s\\%s" % (computer, user) if computer and user else user,
        }

    def launch(self, argv, cwd=None):
        creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
        try:
            process = subprocess.Popen(
                list(argv), cwd=cwd, creationflags=creationflags,
                close_fds=False, shell=False,
            )
        except OSError as exc:
            raise OpError("OP_FAILED", "launch %r: %s" % (argv, exc)) from exc
        return {"pid": process.pid, "argv": list(argv)}

    def _find_windows(self, pid=None, title=None):
        out = []
        for hwnd, wpid, wtitle, _cls in _top_windows():
            if not wtitle:
                continue  # untitled helper windows are never the target
            if pid is not None and wpid != pid:
                continue
            if title is not None and title not in wtitle:
                continue
            out.append((hwnd, wpid, wtitle))
        return out

    def uia_tree(self, pid=None, title=None, depth=8):
        if depth < 0:
            raise OpError("BAD_REQUEST", "depth must be >= 0")
        if pid is None and title is None:
            matches = [w[:3] for w in _top_windows() if w[2]]
        else:
            matches = self._find_windows(pid=pid, title=title)
        windows = []
        for hwnd, _wpid, _wtitle in matches[:MAX_WINDOWS]:
            self._wake_msaa(hwnd)  # LibreOffice bridge wake; no-op elsewhere
            windows.append(
                self._uia_call(lambda h=hwnd: self._window_node(h, depth), "uia_tree")
            )
        return {"windows": windows}

    def _window_node(self, hwnd, depth):
        import uiautomation as auto

        control = auto.ControlFromHandle(hwnd)
        if control is None:
            raise OpError("OP_FAILED", "ControlFromHandle empty for hwnd %s" % hwnd)
        count = [0]

        def build(ctrl, remaining):
            count[0] += 1
            if count[0] > MAX_ELEMENTS:
                return None  # hard cap; parent records "truncated": true
            rid = ctrl.GetRuntimeId()
            node = {
                "pid": int(ctrl.ProcessId),
                "title": ctrl.Name or "",
                "name": ctrl.Name or "",
                "control_type": ctrl.ControlTypeName,
                "runtime_id": [int(x) for x in rid],
                "children": [],
            }
            if remaining > 0:
                for child in ctrl.GetChildren():
                    built = build(child, remaining - 1)
                    if built is None:
                        node["truncated"] = True
                        break
                    node["children"].append(built)
            return node

        node = build(control, depth)
        node["element_count"] = count[0]
        return node

    def _control_by_runtime_id(self, runtime_id):
        """Find the element whose RuntimeId matches exactly across visible
        top-level windows' subtrees. Returns (control, top_hwnd)."""
        import uiautomation as auto

        rid = [int(x) for x in runtime_id]
        searched = [0]

        def walk(ctrl, remaining):
            searched[0] += 1
            if searched[0] > MAX_ELEMENTS * 4:
                return None
            try:
                if [int(x) for x in ctrl.GetRuntimeId()] == rid:
                    return ctrl
            except Exception:
                pass  # dead element mid-walk: treat as non-match, keep walking
            if remaining <= 0:
                return None
            for child in ctrl.GetChildren():
                found = walk(child, remaining - 1)
                if found is not None:
                    return found
            return None

        for hwnd, _wpid, _wtitle in [w[:3] for w in _top_windows() if w[2]][:MAX_WINDOWS]:
            control = auto.ControlFromHandle(hwnd)
            if control is None:
                continue
            found = walk(control, MAX_SEARCH_DEPTH)
            if found is not None:
                return found, hwnd
        raise OpError(
            "OP_FAILED",
            "control not found for runtime_id %r (searched %d elements)"
            % (rid, searched[0]),
        )

    def uia_invoke(self, runtime_id, action, value=None):
        def run(_client):
            import uiautomation as auto

            control, hwnd = self._control_by_runtime_id(runtime_id)
            front = self._bring_to_front(hwnd)
            if not front.get("ok"):
                raise OpError(
                    "OP_FAILED",
                    "could not get foreground (held by %r); action not delivered"
                    % front.get("foreground"),
                )
            if action == "invoke":
                control.Invoke()
            elif action == "select":
                control.Select()
            else:  # set_value
                if value is None:
                    raise OpError("BAD_REQUEST", "set_value requires value")
                try:
                    control.GetValuePattern().SetValue(value)
                except Exception:
                    # No ValuePattern through the MSAA->UIA bridge (typical for
                    # the LibreOffice Name Box): deliver by focus + keyboard.
                    control.SetFocus()
                    auto.SendKeys("{Ctrl}a", waitTime=0.05)
                    auto.SendKeys(_sendkeys_escape(value), interval=0.01, waitTime=0.1)
                    auto.SendKeys("{Enter}", waitTime=0.1)
            return {"delivered": True}

        return self._uia_call(run, "uia_invoke(%s)" % action)

    def screenshot(self, pid=None, rect=None):
        if rect is not None and (
            len(rect) != 4 or any(not isinstance(v, int) for v in rect)
        ):
            raise OpError("BAD_REQUEST", "rect must be [x, y, w, h] integers")
        png = _gdi_screenshot(pid=pid, rect=rect)
        return {"png_b64": base64.b64encode(png).decode()}

    def read_file(self, path):
        try:
            with open(path, "rb") as fh:
                return {"data_b64": base64.b64encode(fh.read()).decode()}
        except OSError as exc:
            raise OpError("OP_FAILED", "read_file %s: %s" % (path, exc)) from exc

    def write_file(self, path, data_b64):
        try:
            data = base64.b64decode(data_b64, validate=True)
        except Exception as exc:
            raise OpError("BAD_REQUEST", "data_b64 is not valid base64") from exc
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        try:
            with open(path, "wb") as fh:
                fh.write(data)
        except OSError as exc:
            raise OpError("OP_FAILED", "write_file %s: %s" % (path, exc)) from exc
        return {"bytes": len(data)}

    def kill(self, pid=None, image_name=None):
        killed = []
        if pid is not None:
            proc = subprocess.run(
                ["taskkill", "/PID", str(pid), "/F", "/T"], capture_output=True, text=True
            )
            if proc.returncode == 0:
                killed.append(pid)
        if image_name is not None:
            before = self._pids_of_image(image_name)
            if before:
                subprocess.run(
                    ["taskkill", "/IM", image_name, "/F", "/T"],
                    capture_output=True, text=True,
                )
                after = self._pids_of_image(image_name)
                killed.extend(sorted(set(before) - set(after)))
        return {"killed": killed}

    @staticmethod
    def _pids_of_image(image_name):
        proc = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq %s" % image_name, "/FO", "CSV", "/NH"],
            capture_output=True, text=True,
        )
        pids = []
        for line in proc.stdout.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) >= 2 and parts[1].isdigit():
                pids.append(int(parts[1]))
        return pids

    def uno_eval(self, call, sheet=None, cell=None, socket=None):
        if socket is None:
            raise OpError("OP_FAILED", "UNO socket not reachable (socket param required)")
        try:
            import uno  # pyuno in the guest's ARM64 Python (verified, M1-008)
        except ImportError as exc:
            raise OpError("OP_FAILED", "pyuno unavailable: %s" % exc) from exc
        local_context = uno.getComponentContext()
        resolver = local_context.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", local_context
        )
        ctx = resolver.resolve(
            "uno:socket,host=127.0.0.1,port=%s;urp;StarOffice.ComponentContext" % socket
        )
        desktop = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", ctx
        )
        model = desktop.getCurrentComponent()
        if call == "is_modified":
            return {"call": call, "value": bool(model.isModified())}
        sheet_obj = (
            model.Sheets.getByName(sheet)
            if sheet
            else model.CurrentController.ActiveSheet
        )
        cell_obj = sheet_obj.getCellRangeByName(cell)
        if call == "get_value":
            return {"call": call, "cell": cell, "value": cell_obj.getValue()}
        if call == "get_string":
            return {"call": call, "cell": cell, "value": cell_obj.getString()}
        return {"call": call, "cell": cell, "value": cell_obj.getError()}


# ----------------------------------------------------------------- keyboard

_SENDKEYS_SPECIAL = set("{}()+%^~[]")


def _sendkeys_escape(text):
    """Escape uiautomation.SendKeys metacharacters so literal text is typed."""
    return "".join(
        ("{%s}" % ch) if ch in _SENDKEYS_SPECIAL else ch for ch in str(text)
    )


# ---------------------------------------------------------------- screenshot

def _window_rect(u32, hwnd):
    import ctypes.wintypes as wintypes

    class RECT(ctypes.Structure):
        _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                    ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

    rc = RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(rc))
    return (rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top)


def _gdi_screenshot(pid=None, rect=None):
    """In-session GDI capture: BitBlt the (optionally pid- or rect-clipped)
    screen into an HBITMAP, encode PNG via GDI+ (no PIL in the guest)."""
    u32 = ctypes.windll.user32
    g32 = ctypes.windll.gdi32

    if rect is not None:
        x, y, w, h = rect
    else:
        x = u32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
        y = u32.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
        w = u32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
        h = u32.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN
    if w <= 0 or h <= 0:
        raise OpError("OP_FAILED", "empty capture area")

    if pid is not None:
        boxes = [
            _window_rect(u32, hwnd)
            for hwnd, wpid, wtitle, _c in _top_windows()
            if wpid == pid and wtitle
        ]
        if boxes:
            x0 = min(b[0] for b in boxes) - 8
            y0 = min(b[1] for b in boxes) - 8
            x1 = max(b[0] + b[2] for b in boxes) + 8
            y1 = max(b[1] + b[3] for b in boxes) + 8
            if rect is None:
                x, y, w, h = x0, y0, x1 - x0, y1 - y0
            else:
                x = max(x, x0)
                y = max(y, y0)
                w = min(x + w, x1) - x
                h = min(y + h, y1) - y
                if w <= 0 or h <= 0:
                    raise OpError("OP_FAILED", "rect does not intersect pid windows")

    hdc_screen = u32.GetDC(None)
    hdc_mem = g32.CreateCompatibleDC(hdc_screen)
    hbmp = g32.CreateCompatibleBitmap(hdc_screen, w, h)
    if not hbmp:
        u32.ReleaseDC(None, hdc_screen)
        g32.DeleteDC(hdc_mem)
        raise OpError("OP_FAILED", "CreateCompatibleBitmap failed")
    g32.SelectObject(hdc_mem, hbmp)
    try:
        if not g32.BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, x, y, 0x00CC0020):  # SRCCOPY
            raise OpError("OP_FAILED", "BitBlt failed")
        return _hbitmap_to_png(hbmp)
    finally:
        g32.DeleteObject(hbmp)
        g32.DeleteDC(hdc_mem)
        u32.ReleaseDC(None, hdc_screen)


class _GDIPLUS_GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


# GDI+ built-in PNG encoder clsid {557CF406-1A04-11D3-9A73-0000F81EF32E}
_PNG_ENCODER_CLSID = _GDIPLUS_GUID(
    0x557CF406, 0x1A04, 0x11D3,
    (ctypes.c_ubyte * 8)(0x9A, 0x73, 0x00, 0x00, 0xF8, 0x1E, 0xF3, 0x2E),
)


class _GDIPLUS_STARTUP_INPUT(ctypes.Structure):
    _fields_ = [("GdiplusVersion", ctypes.c_uint32),
                ("DebugEventCallback", ctypes.c_void_p),
                ("SuppressBackgroundThread", ctypes.c_int),
                ("SuppressExternalCodecs", ctypes.c_int)]


def _hbitmap_to_png(hbmp):
    """HBITMAP -> PNG bytes via the GDI+ flat API and an HGLOBAL IStream read
    back through its vtable (no PIL, no generated COM interfaces)."""
    from ctypes import (HRESULT, WINFUNCTYPE, byref, c_longlong, c_ulong,
                        c_ulonglong, c_void_p)

    gdiplus = ctypes.WinDLL("gdiplus")
    ole32 = ctypes.windll.ole32

    token = c_ulong()
    startup = _GDIPLUS_STARTUP_INPUT()
    startup.GdiplusVersion = 1
    if gdiplus.GdiplusStartup(byref(token), byref(startup), None) != 0:
        raise OpError("OP_FAILED", "GdiplusStartup failed")
    try:
        stream = c_void_p()
        if ole32.CreateStreamOnHGlobal(None, True, byref(stream)) != 0:
            raise OpError("OP_FAILED", "CreateStreamOnHGlobal failed")
        bmp = c_void_p()
        status = gdiplus.GdipCreateBitmapFromHBITMAP(hbmp, None, byref(bmp))
        if status != 0:
            raise OpError("OP_FAILED", "GdipCreateBitmapFromHBITMAP hr=%d" % status)
        try:
            status = gdiplus.GdipSaveImageToStream(bmp, stream, byref(_PNG_ENCODER_CLSID), None)
            if status != 0:
                raise OpError("OP_FAILED", "GdipSaveImageToStream hr=%d" % status)
            return _istream_read_all(stream)
        finally:
            gdiplus.GdipDisposeImage(bmp)
    finally:
        gdiplus.GdiplusShutdown(token)


def _istream_read_all(stream):
    """Read an IStream* to exhaustion via vtable calls (after IUnknown slots
    0-2: Read is slot 3, Seek is slot 5, Release slot 2)."""
    from ctypes import (HRESULT, WINFUNCTYPE, POINTER, byref, c_longlong,
                        c_ulong, c_ulonglong, c_void_p, cast)

    addr = cast(stream, POINTER(c_void_p)).value  # interface ptr -> its vtable
    vtbl = (c_void_p * 24).from_address(addr)

    read_fn = WINFUNCTYPE(HRESULT, c_void_p, c_void_p, c_ulong, POINTER(c_ulong))(vtbl[3])
    seek_fn = WINFUNCTYPE(HRESULT, c_void_p, c_longlong, c_ulong, POINTER(c_ulonglong))(vtbl[5])
    release_fn = WINFUNCTYPE(c_ulong, c_void_p)(vtbl[2])

    newpos = c_ulonglong()
    hr = seek_fn(stream, 0, 0, byref(newpos))  # STREAM_SEEK_SET to start
    if hr != 0:
        release_fn(stream)
        raise OpError("OP_FAILED", "IStream.Seek hr=%d" % hr)

    chunks = []
    try:
        while True:
            buf = ctypes.create_string_buffer(65536)
            got = c_ulong()
            hr = read_fn(stream, buf, len(buf), byref(got))
            if hr != 0:
                raise OpError("OP_FAILED", "IStream.Read hr=%d" % hr)
            if got.value == 0:
                break
            chunks.append(buf.raw[: got.value])
    finally:
        release_fn(stream)
    return b"".join(chunks)
