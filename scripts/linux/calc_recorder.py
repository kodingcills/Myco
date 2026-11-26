#!/usr/bin/env python3
"""LibreOffice Calc demonstration recorder and workflow replayer (Myco track R).

record: opens a CSV document in Calc (a visible window unless --headless), with every
  column loaded as text so the saved CSV round-trips exactly, and attaches Calc's own
  listeners: an XModifyListener (each modification is diffed against the previous sheet
  snapshot and reported as app-level cell changes) and an XDocumentEventListener (saves).
  It prints one JSON object per line on stdout:
    {"type": "ready"}
    {"type": "cell-changed", "cell": "B8", "value": "..."}
    {"type": "saved", "via": "app"}
    {"type": "stopped"}
  It never prints the document path, window titles, key text or clipboard contents.
  Human mode (default) waits until the operator closes the document or stops the
  recorder (SIGINT/SIGTERM). --script STEPS.json instead plays a scripted "human" through
  Calc's dispatcher on the same document, so the listeners record exactly as they would
  for a person (tests and demo only).

replay: opens the CSV the same way, types each edit through Calc's input path
  (.uno:EnterString), saves as CSV and closes. Prints {"ok": true} or {"ok": false,
  "error": "..."}.

Usage:
  calc_recorder.py record --doc PATH [--headless] [--script STEPS.json] [--soffice soffice]
                          [--timeout 60]
  calc_recorder.py replay --doc PATH --edits EDITS.json [--soffice soffice] [--timeout 60]
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

CSV_FILTER = "Text - txt - csv (StarCalc)"
# Import: comma, double quote, UTF-8, from line 1, columns 1-64 as Text (format 2), no
# special-number detection. Export: the same separators, cell content as stored.
IMPORT_OPTIONS = "44,34,76,1,%s,0,false,false" % "/".join(
    "%d/2" % c for c in range(1, 65)
)
EXPORT_OPTIONS = "44,34,76,1,,0,false,true,true"


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def prop(name, value):
    import uno  # noqa: PLC0415

    pv = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    pv.Name = name
    pv.Value = value
    return pv


def col_letters(c):
    name = ""
    c += 1
    while c > 0:
        c, rem = divmod(c - 1, 26)
        name = chr(65 + rem) + name
    return name


def start_soffice(binary, headless, workdir):
    import uno  # noqa: PLC0415

    pipe = "myco-rec-%s" % uuid.uuid4().hex
    argv = [
        binary,
        "--norestore",
        "--nologo",
        "--nodefault",
        "-env:UserInstallation=%s" % uno.systemPathToFileUrl(os.path.join(workdir, "profile")),
        "--accept=pipe,name=%s;urp;" % pipe,
    ]
    if headless:
        argv[1:1] = ["--headless", "--invisible"]
    proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return proc, pipe


def connect(pipe, deadline):
    import uno  # noqa: PLC0415

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local
    )
    last = None
    while time.monotonic() < deadline:
        try:
            return resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
        except Exception as exc:  # NoConnectException until soffice listens
            last = exc
            time.sleep(0.25)
    raise RuntimeError("soffice did not accept a UNO connection in time: %s" % type(last).__name__)


def load_csv(desktop, path, hidden):
    import uno  # noqa: PLC0415

    doc = desktop.loadComponentFromURL(
        uno.systemPathToFileUrl(path),
        "_blank",
        0,
        (
            prop("FilterName", CSV_FILTER),
            prop("FilterOptions", IMPORT_OPTIONS),
            prop("Hidden", hidden),
        ),
    )
    if doc is None:
        raise RuntimeError("Calc could not open the document")
    return doc


def save_csv(doc, path):
    import uno  # noqa: PLC0415

    doc.storeAsURL(
        uno.systemPathToFileUrl(path),
        (prop("FilterName", CSV_FILTER), prop("FilterOptions", EXPORT_OPTIONS), prop("Overwrite", True)),
    )


def snapshot(sheet):
    cursor = sheet.createCursor()
    cursor.gotoEndOfUsedArea(False)
    addr = cursor.getRangeAddress()
    rng = sheet.getCellRangeByPosition(0, 0, addr.EndColumn, addr.EndRow)
    out = {}
    for r, row in enumerate(rng.getDataArray()):
        for c, value in enumerate(row):
            if not isinstance(value, str):
                # A number Calc parsed: report the text it shows, never the raw float.
                value = rng.getCellByPosition(c, r).getString()
            if value != "":
                out[(r, c)] = value
    return out


def type_into(ctx, doc, ref, text):
    sheet = doc.Sheets.getByIndex(0)
    cell = sheet.getCellRangeByName(ref)
    controller = doc.getCurrentController()
    controller.select(cell)
    dispatcher = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.DispatchHelper", ctx
    )
    dispatcher.executeDispatch(
        controller.getFrame(), ".uno:EnterString", "", 0, (prop("StringName", text),)
    )


def record(args):
    import unohelper  # noqa: PLC0415
    from com.sun.star.document import XDocumentEventListener  # noqa: PLC0415
    from com.sun.star.util import XModifyListener  # noqa: PLC0415

    doc_path = os.path.abspath(args.doc)
    if not os.path.isfile(doc_path):
        emit({"type": "error", "error": "document not found"})
        return 2
    workdir = tempfile.mkdtemp(prefix="myco-calc-recorder-")
    proc, pipe = start_soffice(args.soffice, args.headless, workdir)
    deadline = time.monotonic() + args.timeout
    closed = threading.Event()
    lock = threading.Lock()
    code = 1
    try:
        ctx = connect(pipe, deadline)
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        doc = load_csv(desktop, doc_path, args.headless)
        sheet = doc.Sheets.getByIndex(0)
        state = {"snap": snapshot(sheet)}

        class Modify(unohelper.Base, XModifyListener):
            def modified(self, event):
                with lock:
                    now = snapshot(sheet)
                    keys = sorted(set(now) | set(state["snap"]))
                    for key in keys:
                        if now.get(key, "") != state["snap"].get(key, ""):
                            r, c = key
                            emit({"type": "cell-changed", "cell": "%s%d" % (col_letters(c), r + 1), "value": now.get(key, "")})
                    state["snap"] = now

            def disposing(self, event):
                closed.set()

        class DocEvents(unohelper.Base, XDocumentEventListener):
            def documentEventOccured(self, event):
                if event.EventName in ("OnSaveDone", "OnSaveAsDone"):
                    emit({"type": "saved", "via": "app"})
                elif event.EventName in ("OnUnload", "OnPrepareUnload"):
                    closed.set()

            def disposing(self, event):
                closed.set()

        doc.addModifyListener(Modify())
        doc.addDocumentEventListener(DocEvents())
        emit({"type": "ready"})
        if args.script:
            with open(args.script, encoding="utf-8") as fh:
                steps = json.load(fh)
            for step in steps:
                if step.get("do") in ("type", "type-gui-only"):
                    type_into(ctx, doc, step["cell"], step["text"])
                elif step.get("do") == "save":
                    save_csv(doc, doc_path)
                time.sleep(0.05)
            doc.close(True)
        else:
            stop = threading.Event()
            signal.signal(signal.SIGINT, lambda *_: stop.set())
            signal.signal(signal.SIGTERM, lambda *_: stop.set())
            while not stop.is_set() and not closed.is_set():
                time.sleep(0.2)
            if not closed.is_set():
                doc.close(True)
        emit({"type": "stopped"})
        code = 0
    except Exception as exc:
        emit({"type": "error", "error": type(exc).__name__})
    finally:
        try:
            if "desktop" in locals():
                desktop.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        shutil.rmtree(workdir, ignore_errors=True)
    return code


def replay(args):
    doc_path = os.path.abspath(args.doc)
    if not os.path.isfile(doc_path):
        emit({"ok": False, "error": "document not found"})
        return 2
    with open(args.edits, encoding="utf-8") as fh:
        edits = json.load(fh)
    workdir = tempfile.mkdtemp(prefix="myco-calc-replay-")
    proc, pipe = start_soffice(args.soffice, True, workdir)
    code = 1
    try:
        ctx = connect(pipe, time.monotonic() + args.timeout)
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        doc = load_csv(desktop, doc_path, True)
        for edit in edits:
            type_into(ctx, doc, edit["cell"], edit["value"])
        save_csv(doc, doc_path)
        doc.close(True)
        emit({"ok": True})
        code = 0
    except Exception as exc:
        emit({"ok": False, "error": type(exc).__name__})
    finally:
        try:
            if "desktop" in locals():
                desktop.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        shutil.rmtree(workdir, ignore_errors=True)
    return code


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="mode", required=True)
    rec = sub.add_parser("record")
    rec.add_argument("--doc", required=True)
    rec.add_argument("--headless", action="store_true")
    rec.add_argument("--script")
    rec.add_argument("--soffice", default="soffice")
    rec.add_argument("--timeout", type=float, default=60.0)
    rep = sub.add_parser("replay")
    rep.add_argument("--doc", required=True)
    rep.add_argument("--edits", required=True)
    rep.add_argument("--soffice", default="soffice")
    rep.add_argument("--timeout", type=float, default=60.0)
    args = p.parse_args(argv)
    return record(args) if args.mode == "record" else replay(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
