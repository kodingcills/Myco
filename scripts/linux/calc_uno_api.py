#!/usr/bin/env python3
"""App-API route for the fast-path action router (track J): set one Calc cell
through LibreOffice's UNO object model and store the document.

Unlike `calc_actuator.py` (the GUI-equivalent route, which types through
Calc's input path with `.uno:EnterString`), this script calls the document
API directly: `XCell.setFormula` on the target cell, then `XStorable.store`.
`setFormula` applies Calc's own input recognition for numbers, dates and
currency in the document's locale, so the stored cell matches what a typed
entry would have produced for the fc-v1 column types.

It prints one JSON object describing what it did. It never decides whether the
task succeeded: completion is the gate's decision from the persisted bytes, and
the independent grader grades them. The report is a trace record only.

Usage:
  calc_uno_api.py --doc PATH --cell B12 --value TEXT [--no-save]
                  [--soffice soffice] [--timeout 60] [--profile-dir DIR]
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

CURRENCY = 8  # com.sun.star.util.NumberFormat.CURRENCY
CELL_RE = re.compile(r"^[A-Z]{1,3}[1-9][0-9]{0,6}$")


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--doc", required=True)
    p.add_argument("--cell", required=True)
    p.add_argument("--value", required=True)
    p.add_argument("--no-save", action="store_true")
    p.add_argument("--soffice", default="soffice")
    p.add_argument("--timeout", type=float, default=60.0)
    p.add_argument("--profile-dir", default=None)
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


def set_value(ctx, doc, cell, value):
    """Store `value` the way Calc's input recognition would, through the API.

    The document's number formatter detects a number, date or currency format for
    the text (`detectNumberFormat`); when it does, the cell gets the converted
    number and that format, so `$43446.57` stays a currency cell and `2024-08-10`
    a date cell. Text the formatter does not recognise is stored as a string.
    """
    formatter = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.util.NumberFormatter", ctx
    )
    formatter.attachNumberFormatsSupplier(doc)
    try:
        key = formatter.detectNumberFormat(0, value)
        number = formatter.convertStringToNumber(key, value)
    except Exception:
        cell.setString(value)
        return
    formats = doc.getNumberFormats()
    fmt = formats.getByKey(key)
    if fmt.Type & CURRENCY:
        # The detected currency format groups thousands ("$43,446.57"); a typed entry
        # keeps the digits as typed. Generate the same currency format with grouping
        # only when the text had it, and the decimals the text had.
        decimals = len(value.split(".", 1)[1]) if "." in value else 0
        code = formats.generateFormat(key, fmt.Locale, "," in value, False, decimals, 1)
        key = formats.queryKey(code, fmt.Locale, False)
        if key == -1:
            key = formats.addNew(code, fmt.Locale)
    cell.setValue(number)
    if key != 0:
        cell.NumberFormat = key


def main(argv):
    args = parse_args(argv)
    doc_path = os.path.abspath(args.doc)
    out = {"ok": False, "route": "api", "cell": args.cell, "typed": args.value}
    if not CELL_RE.match(args.cell):
        out["error"] = "bad-cell"
        print(json.dumps(out))
        return 2
    if not os.path.isfile(doc_path):
        out["error"] = "document-missing"
        print(json.dumps(out))
        return 2
    if args.value.startswith("="):
        # A formula is code, not a value: refused so the API route never evaluates
        # agent-supplied expressions (WEBSERVICE, external links) in Calc.
        out["error"] = "formula-refused"
        print(json.dumps(out))
        return 2
    import uno  # noqa: PLC0415

    base = args.profile_dir or tempfile.gettempdir()
    workdir = tempfile.mkdtemp(prefix="myco-calc-api-", dir=base)
    pipe = "myco-api-%s" % uuid.uuid4().hex
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
            raise RuntimeError("Calc could not open the document")
        sheet = doc.Sheets.getByIndex(0)
        cell = sheet.getCellRangeByName(args.cell)
        out["before"] = cell.getString()
        set_value(ctx, doc, cell, args.value)
        out["after"] = cell.getString()
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
