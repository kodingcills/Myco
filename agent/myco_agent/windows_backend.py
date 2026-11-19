import base64
import os
import subprocess

from . import AGENT_VERSION
from .protocol import OpError


class WindowsBackend:
    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("WindowsBackend requires Windows")

    def ping(self):
        return {"backend": "windows", "agent_version": AGENT_VERSION}

    def session_info(self):
        import ctypes
        from ctypes import wintypes

        pid = os.getpid()
        session_id = wintypes.DWORD()
        ctypes.windll.kernel32.ProcessIdToSessionId(pid, ctypes.byref(session_id))
        import win32service  # noqa: F401  (window station via pywin32 below)
        import win32ts

        station = win32ts.GetProcessWindowStation()
        desktop = win32ts.GetUserObjectInformation(station, 1)
        user = os.environ.get("USERNAME", "")
        return {
            "session_id": session_id.value,
            "window_station": desktop and "WinSta0",
            "desktop": desktop or "Default",
            "user": user,
        }

    def launch(self, argv, cwd=None):
        import pythoncom
        from win32com.shell import shell  # noqa: F401

        pythoncom.CoInitialize()
        creationflags = subprocess.CREATE_NEW_CONSOLE
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            creationflags=creationflags,
            close_fds=False,
            shell=False,
        )
        return {"pid": process.pid, "argv": argv}

    def uia_tree(self, pid=None, title=None, depth=8):
        import uiautomation as auto

        roots = []
        if pid is not None:
            for control in auto.GetRootControl().GetChildren():
                if control.ProcessId == pid:
                    roots.append(control)
        elif title is not None:
            roots = auto.GetRootControl().GetChildren()
            roots = [c for c in roots if title in c.Name]
        else:
            roots = auto.GetRootControl().GetChildren()

        return {"windows": [self._node(c, depth) for c in roots]}

    def _node(self, control, depth):
        node = {
            "pid": control.ProcessId,
            "title": control.Name or "",
            "control_type": control.ControlTypeName,
            "runtime_id": [int(x) for x in control.GetRuntimeId()],
            "children": [],
        }
        if depth > 0:
            for child in control.GetChildren():
                node["children"].append(self._node(child, depth - 1))
        return node

    def uia_invoke(self, runtime_id, action, value=None):
        import uiautomation as auto

        window = None
        for control in auto.GetRootControl().GetChildren():
            if int(control.ProcessId) == runtime_id[0]:
                window = control
                break
        if window is None:
            raise OpError("OP_FAILED", "control not found")
        if action == "invoke":
            control.Invoke()
        elif action == "select":
            control.Select()
        else:
            control.GetValuePattern().SetValue(value)
        return {"delivered": True}

    def screenshot(self, pid=None, rect=None):
        import io

        from PIL import ImageGrab

        image = ImageGrab.grab(all_screens=True)
        if rect is not None:
            image = image.crop((rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return {"png_b64": base64.b64encode(buffer.getvalue()).decode()}

    def read_file(self, path):
        with open(path, "rb") as fh:
            return {"data_b64": base64.b64encode(fh.read()).decode()}

    def write_file(self, path, data_b64):
        data = base64.b64decode(data_b64)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return {"bytes": len(data)}

    def kill(self, pid=None, image_name=None):
        import subprocess as sp

        killed = []
        if pid is not None:
            sp.run(["taskkill", "/PID", str(pid), "/F", "/T"], capture_output=True)
            killed.append(pid)
        if image_name is not None:
            sp.run(["taskkill", "/IM", image_name, "/F", "/T"], capture_output=True)
            killed.append(image_name)
        return {"killed": killed}

    def uno_eval(self, call, sheet=None, cell=None, socket=None):
        if socket is None:
            raise ConnectionError("UNO socket not reachable")
        import uno  # LibreOffice bundled Python
        from com.sun.star.beans import PropertyValue  # noqa: F401

        localContext = uno.getComponentContext()
        resolver = localContext.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", localContext
        )
        ctx = resolver.resolve(
            f"uno:socket,host=127.0.0.1,port={socket};urp;StarOffice.ComponentContext"
        )
        desktop = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", ctx
        )
        model = desktop.getCurrentComponent()
        sheet_obj = model.Sheets.getByName(sheet) if sheet else model.CurrentController.ActiveSheet
        if call == "is_modified":
            return {"call": call, "value": model.isModified()}
        cell_obj = sheet_obj.getCellRangeByName(cell)
        if call == "get_value":
            return {"call": call, "cell": cell, "value": cell_obj.getValue()}
        if call == "get_string":
            return {"call": call, "cell": cell, "value": cell_obj.getString()}
        return {"call": call, "cell": cell, "value": cell_obj.getError()}
