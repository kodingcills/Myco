import base64
import os
import struct
import tempfile
import threading
import zlib
from ntpath import basename as _basename

from .backend import OpsBackend


def _png_chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def _png(width, height, rgb):
    scanline = b"\x00" + bytes(rgb) * width
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(scanline * height))
        + _png_chunk(b"IEND", b"")
    )


class FakeProcess:
    def __init__(self, pid, argv, cwd):
        self.pid = pid
        self.argv = argv
        self.cwd = cwd
        self.alive = True


class FakeWindow:
    def __init__(self, argv0, title, controls=None):
        self.argv0 = argv0
        self.title = title
        self.controls = controls or []
        self.pid = None


class FakeBackend(OpsBackend):
    """Scriptable in-memory desktop: fake windows, fake UIA tree, fake files, crash-on-command."""

    def __init__(self, root=None):
        self._root = root or tempfile.mkdtemp(prefix="myco-fake-")
        self._next_pid = 2000
        self._processes = {}
        self._windows = []
        self._crash_on = set()
        self._cell_values = {}
        self._lock = threading.Lock()

    # --- test scripting ---

    def add_window(self, argv0, title, controls=None):
        window = FakeWindow(argv0, title, controls or [])
        self._windows.append(window)
        return window

    def set_cell_values(self, values):
        self._cell_values.update(values)

    def crash_on(self, op_name):
        self._crash_on.add(op_name)

    # --- ops ---

    def ping(self):
        return {"backend": "fake"}

    def session_info(self):
        return {
            "session_id": 1,
            "window_station": "WinSta0",
            "desktop": "Default",
            "user": "myco",
        }

    def launch(self, argv, cwd=None):
        if "launch" in self._crash_on:
            raise RuntimeError("fake crash on launch")
        pid = self._next_pid
        self._next_pid += 1
        with self._lock:
            self._processes[pid] = FakeProcess(pid, argv, cwd)
            for window in self._windows:
                if _basename(window.argv0) == _basename(argv[0]) and window.pid is None:
                    window.pid = pid
        return {"pid": pid, "argv": argv}

    def uia_tree(self, pid=None, title=None, depth=8):
        if "uia_tree" in self._crash_on:
            raise RuntimeError("fake crash on uia_tree")
        if depth < 0:
            raise ValueError("depth must be >= 0")
        with self._lock:
            windows = [
                w for w in self._windows
                if w.pid is not None
                and (pid is None or w.pid == pid)
                and (title is None or w.title == title)
            ]
            return {"windows": [self._node(w, depth) for w in windows]}

    def _node(self, window, depth):
        node = {
            "pid": window.pid,
            "title": window.title,
            "control_type": "Window",
            "runtime_id": [1, window.title],
            "children": [],
        }
        if depth > 0:
            node["children"] = [
                {
                    "control_type": control["control_type"],
                    "name": control["name"],
                    "runtime_id": [1, window.title, control["name"]],
                }
                for control in window.controls
            ]
        return node

    def uia_invoke(self, runtime_id, action, value=None, keys=None, cell=None):
        if "uia_invoke" in self._crash_on:
            raise RuntimeError("fake crash on uia_invoke")
        if action not in ("invoke", "select", "set_value", "keys"):
            raise ValueError("action must be invoke, select, set_value or keys")
        if len(runtime_id) < 3:
            raise KeyError("runtime_id must be [1, <window>, <control>]")
        _, window_title, control_name = runtime_id[:3]
        window = next(
            (w for w in self._windows if w.title == window_title and w.pid is not None),
            None,
        )
        if window is None:
            raise KeyError("no live window with that runtime id")
        control = next((c for c in window.controls if c["name"] == control_name), None)
        if control is None:
            raise KeyError("no control with that runtime id")
        return {"delivered": True}

    def screenshot(self, pid=None, rect=None):
        if "screenshot" in self._crash_on:
            raise RuntimeError("fake crash on screenshot")
        if rect is not None and len(rect) != 4:
            raise ValueError("rect must be [x, y, w, h]")
        if pid is not None:
            with self._lock:
                process = self._processes.get(pid)
            if process is None or not process.alive:
                raise KeyError(f"no alive process {pid}")
        return {"png_b64": base64.b64encode(_png(4, 4, (40, 60, 120))).decode()}

    def read_file(self, path):
        resolved = self.resolve(path)
        if not os.path.isfile(resolved):
            raise FileNotFoundError(path)
        with open(resolved, "rb") as fh:
            return {"data_b64": base64.b64encode(fh.read()).decode()}

    def write_file(self, path, data_b64):
        try:
            data = base64.b64decode(data_b64, validate=True)
        except Exception:
            raise ValueError("data_b64 is not valid base64")
        resolved = self.resolve(path)
        os.makedirs(os.path.dirname(resolved) or ".", exist_ok=True)
        with open(resolved, "wb") as fh:
            fh.write(data)
        return {"bytes": len(data)}

    def kill(self, pid=None, image_name=None):
        with self._lock:
            targets = [
                p for p in self._processes.values()
                if (pid is not None and p.pid == pid)
                or (image_name is not None and _basename(p.argv[0]) == image_name)
            ]
            for process in targets:
                process.alive = False
            for window in self._windows:
                if window.pid in {p.pid for p in targets}:
                    window.pid = None
            return {"killed": [p.pid for p in targets]}

    def uno_eval(self, call, sheet=None, cell=None, socket=None):
        if socket is None:
            raise ConnectionError("UNO socket not reachable")
        return {"call": call, "sheet": sheet, "cell": cell,
                "value": self._cell_values.get(cell)}

    # --- helpers ---

    def resolve(self, path):
        return os.path.normpath(os.path.join(self._root, path))
