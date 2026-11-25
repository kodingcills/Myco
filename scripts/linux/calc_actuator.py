#!/usr/bin/env python3
"""Headless LibreOffice Calc actuator for the Linux path (TIF-269).

Opens a spreadsheet in a headless soffice with a throwaway profile, types one
value into one cell the way a user's input would land, optionally saves, and
closes. It prints one JSON object describing what it did. It never decides
whether the task succeeded: that is the oracle's job, from the saved file.

Usage:
  calc_actuator.py --doc PATH --cell B100 --value TEXT [--no-save]
                   [--soffice soffice] [--timeout 60]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--doc", required=True)
    p.add_argument("--cell", required=True)
    p.add_argument("--value", required=True)
    p.add_argument("--no-save", action="store_true")
    p.add_argument("--soffice", default="soffice")
    p.add_argument("--timeout", type=float, default=60.0)
    return p.parse_args(argv)


def connect(pipe, deadline):
    import uno  # noqa: PLC0415 - only importable where LibreOffice's Python bridge is installed

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local
    )
    last = None
    while time.monotonic() < deadline:
        try:
            return resolver.resolve(
                "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe
            )
        except Exception as exc:  # NoConnectException until soffice is listening
            last = exc
            time.sleep(0.25)
    raise RuntimeError("soffice did not accept a UNO connection in time: %s" % last)


def prop(name, value):
    import uno  # noqa: PLC0415

    pv = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    pv.Name = name
    pv.Value = value
    return pv


def main(argv):
    args = parse_args(argv)
    doc_path = os.path.abspath(args.doc)
    if not os.path.isfile(doc_path):
        print(json.dumps({"ok": False, "error": "document not found: %s" % doc_path}))
        return 2
    import uno  # noqa: PLC0415

    workdir = tempfile.mkdtemp(prefix="myco-calc-actuator-")
    pipe = "myco-%s" % uuid.uuid4().hex
    profile_url = uno.systemPathToFileUrl(os.path.join(workdir, "profile"))
    proc = subprocess.Popen(
        [
            args.soffice,
            "--headless",
            "--invisible",
            "--norestore",
            "--nologo",
            "--nodefault",
            "-env:UserInstallation=%s" % profile_url,
            "--accept=pipe,name=%s;urp;" % pipe,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + args.timeout
    out = {"ok": False, "doc": doc_path, "cell": args.cell, "typed": args.value}
    code = 1
    try:
        ctx = connect(pipe, deadline)
        desktop = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", ctx
        )
        doc = desktop.loadComponentFromURL(
            uno.systemPathToFileUrl(doc_path), "_blank", 0, (prop("Hidden", True),)
        )
        if doc is None:
            raise RuntimeError("Calc could not open %s" % doc_path)
        sheet = doc.Sheets.getByIndex(0)
        cell = sheet.getCellRangeByName(args.cell)
        out["before"] = cell.getString()
        # Type the value through Calc's input path (.uno:EnterString on the
        # selected cell), the same path a keyboard entry takes, so Calc's own
        # number/date/currency recognition applies as it would for a user.
        controller = doc.getCurrentController()
        controller.select(cell)
        dispatcher = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.DispatchHelper", ctx
        )
        dispatcher.executeDispatch(
            controller.getFrame(), ".uno:EnterString", "", 0, (prop("StringName", args.value),)
        )
        out["after"] = cell.getString()
        out["modifiedBeforeSave"] = bool(doc.isModified())
        if not args.no_save:
            doc.store()
        out["saved"] = not args.no_save
        out["modifiedAtClose"] = bool(doc.isModified())
        doc.close(True)
        out["ok"] = True
        code = 0
    except Exception as exc:
        out["error"] = "%s: %s" % (type(exc).__name__, exc)
    finally:
        try:
            if "desktop" in locals():
                desktop.terminate()
        except Exception:
            pass  # the bridge drops as soffice exits
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        shutil.rmtree(workdir, ignore_errors=True)
    print(json.dumps(out))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
