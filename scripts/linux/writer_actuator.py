#!/usr/bin/env python3
"""Headless LibreOffice Writer actuator for the cross-app Linux path (capability track P).

Opens a plain-text report in a headless Writer with a throwaway profile, puts the view
cursor at the end of the paragraph whose text starts with LABEL (the line a user would
click), types TEXT there through Writer's input path (.uno:InsertText), optionally saves
in place (the document's own "Text (encoded)" UTF-8 filter), and closes. It prints one
JSON object describing what it did. It never decides whether the task succeeded: that is
the gate's job, from the saved file.

Usage:
  writer_actuator.py --doc PATH --label "EMP-0003 qty:" --text " 4242" [--no-save]
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
    p.add_argument("--label", required=True)
    p.add_argument("--text", required=True)
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

    workdir = tempfile.mkdtemp(prefix="myco-writer-actuator-")
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
    out = {"ok": False, "doc": doc_path, "label": args.label, "typed": args.text}
    code = 1
    try:
        ctx = connect(pipe, deadline)
        desktop = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", ctx
        )
        # Load as Writer text, UTF-8, LF: the report's own format, so store() writes it back.
        doc = desktop.loadComponentFromURL(
            uno.systemPathToFileUrl(doc_path),
            "_blank",
            0,
            (
                prop("Hidden", True),
                prop("FilterName", "Text (encoded)"),
                prop("FilterOptions", "UTF8,LF"),
            ),
        )
        if doc is None:
            raise RuntimeError("Writer could not open %s" % doc_path)
        target = None
        paragraphs = doc.getText().createEnumeration()
        while paragraphs.hasMoreElements():
            par = paragraphs.nextElement()
            if par.getString().startswith(args.label):
                target = par
                break
        if target is None:
            raise RuntimeError("no paragraph starts with %r" % args.label)
        out["before"] = target.getString()
        controller = doc.getCurrentController()
        view_cursor = controller.getViewCursor()
        view_cursor.gotoRange(target.getEnd(), False)
        dispatcher = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.DispatchHelper", ctx
        )
        dispatcher.executeDispatch(
            controller.getFrame(), ".uno:InsertText", "", 0, (prop("Text", args.text),)
        )
        out["after"] = target.getString()
        if not args.no_save:
            doc.store()
        out["saved"] = not args.no_save
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
