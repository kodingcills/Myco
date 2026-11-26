#!/usr/bin/env python3
"""TEST ONLY: what an agent can do in Calc's GUI that the e2e's acting channel cannot type.

The structured-state e2e (test/linux/state-e2e.test.ts) uses this to put formulas in the
places the reader's layer-1 scan must cover besides formula cells (PR #527 round 3, D6):

  sheet-name NAME CONTENT     define a SHEET-scoped named expression on sheet 1
                              (Sheet > Named Ranges and Expressions > Manage, scope: Sheet1)
  drop-sheet-name NAME        remove it again
  basic-function NAME         a Basic function in My Macros/Standard returning
                              ThisComponent.URL (Tools > Macros > Edit Macros)
  drop-basic                  remove that module
  validation RANGE FORMULA    a list validation whose source is FORMULA (Data > Validity)
  drop-validation RANGE       back to "any value"
  clear CELL                  empty a cell of sheet 1

and the ways a document can pull another file's content in (PR #545 round 1, D7):

  formula CELL FORMULA        set a formula on sheet 1 (as typed in the GUI, where an
                              external reference such as '../fixture/fixture.csv'#$fixture.B2
                              resolves) and report what the cell then shows, so the test can
                              prove the content really is in the live document
  read CELL                   what a cell of sheet 1 shows now (test-side check only)
  sheet-link NAME URL         Sheet > Insert Sheet from File, Link: a new sheet NAME linked
                              to the CSV at URL
  area-link CELL URL AREA     Sheet > Link to External Data: AREA of the CSV at URL at CELL
  swap URL                    open URL (a CSV) and close the trial's document, so the one
                              spreadsheet open is another file

It is not part of the arm and is never on an agent's PATH; the arm's acting channel stays
scripts/linux/calc_live_act.py. Prints one JSON object; exception text is printed because
this runs only in tests, never in a trial.
"""

import argparse
import json
import sys
import time

MODULE = "MycoTaintProbe"


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pipe", required=True)
    parser.add_argument("op")
    parser.add_argument("args", nargs="*")
    args = parser.parse_args(argv)
    import uno  # noqa: PLC0415

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local
    )
    out = {"ok": False, "op": args.op}
    try:
        deadline = time.monotonic() + 30
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
        smgr = ctx.ServiceManager
        desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        docs = []
        enum = desktop.getComponents().createEnumeration()
        while enum.hasMoreElements():
            comp = enum.nextElement()
            if comp.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
                docs.append(comp)
        if len(docs) != 1:
            raise RuntimeError("expected one open spreadsheet, found %d" % len(docs))
        sheet = docs[0].Sheets.getByIndex(0)
        csv = "Text - txt - csv (StarCalc)"
        if args.op == "formula":
            cell = sheet.getCellRangeByName(args.args[0])
            cell.setFormula(args.args[1])
            docs[0].calculateAll()
            out["shows"] = cell.getString()
        elif args.op == "read":
            out["shows"] = sheet.getCellRangeByName(args.args[0]).getString()
        elif args.op == "sheet-link":
            name, url = args.args
            docs[0].Sheets.insertNewByName(name, docs[0].Sheets.getCount())
            linked = docs[0].Sheets.getByName(name)
            linked.link(url, "", csv, "44,34,76,1",
                        uno.Enum("com.sun.star.sheet.SheetLinkMode", "NORMAL"))
            out["shows"] = linked.getCellRangeByName("B2").getString()
        elif args.op == "area-link":
            cells, url, area = args.args
            at = sheet.getCellRangeByName(cells).getCellAddress()
            docs[0].AreaLinks.insertAtPosition(at, url, area, csv, "44,34,76,1")
            out["shows"] = sheet.getCellByPosition(at.Column + 1, at.Row + 1).getString()
        elif args.op == "swap":
            hidden = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
            hidden.Name = "Hidden"
            hidden.Value = True
            other = desktop.loadComponentFromURL(args.args[0], "_blank", 0, (hidden,))
            out["shows"] = other.Sheets.getByIndex(0).getCellRangeByName("B2").getString()
            docs[0].setModified(False)
            docs[0].close(True)
        elif args.op == "sheet-name":
            name, content = args.args
            where = uno.createUnoStruct("com.sun.star.table.CellAddress")
            sheet.NamedRanges.addNewByName(name, content, where, 0)
            out["sheetNames"] = list(sheet.NamedRanges.getElementNames())
            out["docNames"] = list(docs[0].NamedRanges.getElementNames())
        elif args.op == "drop-sheet-name":
            sheet.NamedRanges.removeByName(args.args[0])
        elif args.op in ("basic-function", "drop-basic"):
            libs = smgr.createInstanceWithContext(
                "com.sun.star.script.ApplicationScriptLibraryContainer", ctx
            )
            libs.loadLibrary("Standard")
            std = libs.getByName("Standard")
            if std.hasByName(MODULE):
                std.removeByName(MODULE)
            if args.op == "basic-function":
                name = args.args[0]
                std.insertByName(
                    MODULE,
                    "Function %s()\n  %s = ThisComponent.getURL()\nEnd Function\n" % (name, name),
                )
        elif args.op == "validation":
            cells, formula = args.args
            target = sheet.getCellRangeByName(cells)
            validation = target.Validation
            validation.Type = uno.Enum("com.sun.star.sheet.ValidationType", "LIST")
            validation.setFormula1(formula)
            target.Validation = validation
        elif args.op == "drop-validation":
            target = sheet.getCellRangeByName(args.args[0])
            validation = target.Validation
            validation.Type = uno.Enum("com.sun.star.sheet.ValidationType", "ANY")
            validation.setFormula1("")
            target.Validation = validation
        elif args.op == "clear":
            sheet.getCellRangeByName(args.args[0]).setFormula("")
        else:
            raise ValueError("unknown op")
        out["ok"] = True
    except Exception as exc:
        out["error"] = "%s: %s" % (type(exc).__name__, exc)
    print(json.dumps(out))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
