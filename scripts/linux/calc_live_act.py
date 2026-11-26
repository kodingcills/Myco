#!/usr/bin/env python3
"""Act on a live headless Calc session (capability track I test harness; NOT a state tool).

The structured-state arm's acting channel on the Linux path, used by the $0 scripted-agent
end-to-end test: it connects as a UNO client to the trial's running soffice (named pipe) and
either types one value into one cell through Calc's input path (`.uno:EnterString`, as
`calc_actuator.py` does) or stores the document. It is never reachable through the
`myco-state` MCP server, which only reads (`calc_state.py`).

Usage:
  calc_live_act.py --pipe NAME type --cell B8 --value TEXT
  calc_live_act.py --pipe NAME save
  calc_live_act.py --pipe NAME quit     (close without storing, end soffice; harness teardown)
Prints one JSON object: {"ok": true, ...} or {"ok": false, "error": "..."}.
"""

import argparse
import json
import sys
import time


def prop(name, value):
    import uno  # noqa: PLC0415

    pv = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    pv.Name = name
    pv.Value = value
    return pv


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pipe", required=True)
    parser.add_argument("--timeout", type=float, default=30.0)
    sub = parser.add_subparsers(dest="op", required=True)
    typ = sub.add_parser("type")
    typ.add_argument("--cell", required=True)
    typ.add_argument("--value", required=True)
    sub.add_parser("save")
    sub.add_parser("quit")
    args = parser.parse_args(argv)
    import uno  # noqa: PLC0415

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local
    )
    deadline = time.monotonic() + args.timeout
    out = {"ok": False, "op": args.op}
    try:
        ctx = None
        while ctx is None:
            try:
                ctx = resolver.resolve(
                    "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % args.pipe
                )
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.2)
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        if args.op == "quit":
            enum = desktop.getComponents().createEnumeration()
            while enum.hasMoreElements():
                comp = enum.nextElement()
                try:
                    comp.setModified(False)
                    comp.close(True)
                except Exception:
                    pass
            try:
                desktop.terminate()
            except Exception:
                pass  # the bridge drops as soffice exits
            print(json.dumps({"ok": True, "op": "quit"}))
            return 0
        docs = []
        enum = desktop.getComponents().createEnumeration()
        while enum.hasMoreElements():
            comp = enum.nextElement()
            if comp.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
                docs.append(comp)
        if len(docs) != 1:
            raise RuntimeError("expected one open spreadsheet, found %d" % len(docs))
        doc = docs[0]
        if args.op == "type":
            sheet = doc.Sheets.getByIndex(0)
            cell = sheet.getCellRangeByName(args.cell)
            controller = doc.getCurrentController()
            controller.select(cell)
            dispatcher = ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.frame.DispatchHelper", ctx
            )
            dispatcher.executeDispatch(
                controller.getFrame(), ".uno:EnterString", "", 0,
                (prop("StringName", args.value),),
            )
            out["cell"] = args.cell
            out["after"] = cell.getString()
        else:
            doc.store()
        out["ok"] = True
    except Exception as exc:
        out["error"] = "%s: %s" % (type(exc).__name__, exc)
    print(json.dumps(out))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
