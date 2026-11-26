#!/usr/bin/env python3
"""Read-only structured state of a live headless Calc (capability track I, myco.state/v1).

Connects as a UNO client to the soffice the harness started for ONE trial (named pipe
given by the harness, never by the agent), finds the one spreadsheet document loaded
there, performs ONE read operation and prints one JSON object on stdout:

  {"ok": true, "data": {...}}         or         {"ok": false, "code": "CODE"}

Rules this script keeps (test/state/state-scope.test.ts enforces the first two):

- it only reads: no setter, no dispatch, no store, no close, no load;
- it takes no file path: the document is the one already open in the trial's soffice,
  and its URL/location is never printed;
- every failure is a code; exception text (which can carry host paths) is never printed;
- every output is bounded by the caps passed in the request, re-checked by the TS server.

Usage (the request is one JSON object on stdin):
  calc_state.py --pipe NAME [--timeout 20]
  stdin: {"op": "list_sheets" | "used_range" | "read_range" | "document_status" | "ui_tree", ...}
"""

import argparse
import json
import sys
import time

OPS = ("list_sheets", "used_range", "read_range", "document_status", "ui_tree")

# Roles reported by name; anything else is "other". Resolved through UNO constants at runtime.
ROLE_NAMES = (
    "ALERT", "BUTTON", "CANVAS", "CHECK_BOX", "COLUMN_HEADER", "COMBO_BOX", "DIALOG",
    "DOCUMENT", "DOCUMENT_SPREADSHEET", "EDIT_BAR", "FILLER", "FRAME", "GROUP_BOX", "HEADER",
    "LABEL", "LIST", "LIST_ITEM", "MENU", "MENU_BAR", "MENU_ITEM", "PAGE_TAB", "PAGE_TAB_LIST",
    "PANEL", "PARAGRAPH", "PUSH_BUTTON", "ROOT_PANE", "ROW_HEADER", "SCROLL_BAR", "SCROLL_PANE",
    "SEPARATOR", "SPLIT_PANE", "STATUS_BAR", "TABLE", "TABLE_CELL", "TEXT", "TOOL_BAR",
    "TOGGLE_BUTTON", "WINDOW", "UNKNOWN",
)


class Refusal(Exception):
    """A coded refusal: only the code ever reaches stdout."""

    def __init__(self, code):
        Exception.__init__(self, code)
        self.code = code


def connect(pipe, deadline):
    import uno  # noqa: PLC0415 - LibreOffice's Python bridge

    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local
    )
    while time.monotonic() < deadline:
        try:
            return resolver.resolve(
                "uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe
            )
        except Exception:  # NoConnectException until soffice listens
            time.sleep(0.2)
    raise Refusal("DOCUMENT_UNAVAILABLE")


def the_document(ctx):
    desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    docs = []
    enum = desktop.getComponents().createEnumeration()
    while enum.hasMoreElements():
        comp = enum.nextElement()
        try:
            if comp.supportsService("com.sun.star.sheet.SpreadsheetDocument"):
                docs.append(comp)
        except Exception:
            continue
    if len(docs) != 1:
        # None loaded yet, or more than one: the reader never guesses which is the trial's.
        raise Refusal("DOCUMENT_UNAVAILABLE")
    return docs[0]


def col_name(index):
    name = ""
    index += 1
    while index > 0:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def a1(col, row):
    return "%s%d" % (col_name(col), row + 1)


def utf16_units(text):
    """Length as the TS server counts it (JavaScript `string.length`: UTF-16 code units)."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def clip(text, limit):
    """Cut `text` to at most `limit` UTF-16 code units, never inside a surrogate pair.

    The server re-checks every string against the same cap in UTF-16 units; counting code
    points here would let a cell of astral characters (emoji) pass the reader and fail the
    server's re-check, so the whole range read would be refused (BACKEND_ERROR).
    """
    if utf16_units(text) <= limit:
        return text, False
    out = []
    units = 0
    for ch in text:
        width = 2 if ord(ch) > 0xFFFF else 1
        if units + width > limit:
            break
        out.append(ch)
        units += width
    return "".join(out), True


def sheet_of(doc, ref):
    sheets = doc.getSheets()
    names = list(sheets.getElementNames())
    if ref is None:
        return sheets.getByIndex(0), 0, names[0]
    if isinstance(ref, int) and not isinstance(ref, bool):
        if 0 <= ref < len(names):
            return sheets.getByIndex(ref), ref, names[ref]
        raise Refusal("UNKNOWN_SHEET")
    if isinstance(ref, str) and ref in names:
        index = names.index(ref)
        return sheets.getByIndex(index), index, ref
    raise Refusal("UNKNOWN_SHEET")


def used_area(sheet):
    cursor = sheet.createCursor()
    cursor.gotoStartOfUsedArea(False)
    start = cursor.getRangeAddress()
    cursor.gotoEndOfUsedArea(False)
    end = cursor.getRangeAddress()
    first_cell = sheet.getCellByPosition(start.StartColumn, start.StartRow)
    if (
        start.StartColumn == end.EndColumn
        and start.StartRow == end.EndRow
        and first_cell.getType().value == "EMPTY"
    ):
        return None
    return "%s:%s" % (a1(start.StartColumn, start.StartRow), a1(end.EndColumn, end.EndRow))


def op_list_sheets(doc, req):
    sheets = doc.getSheets()
    names = list(sheets.getElementNames())
    limit = req["caps"]["maxSheets"]
    name_cap = req["caps"]["maxNameChars"]
    out = []
    for index, name in enumerate(names[:limit]):
        shown, cut = clip(name, name_cap)
        entry = {"index": index, "name": shown, "usedRange": used_area(sheets.getByIndex(index))}
        if cut:
            entry["nameTruncated"] = True
        out.append(entry)
    return {"sheets": out, "sheetCount": len(names), "truncated": len(names) > limit}


def op_used_range(doc, req):
    sheet, index, name = sheet_of(doc, req.get("sheet"))
    return {"sheet": {"index": index, "name": clip(name, req["caps"]["maxNameChars"])[0]},
            "usedRange": used_area(sheet)}


def cell_state(cell, ref, text_cap):
    kind = cell.getType().value  # EMPTY | VALUE | TEXT | FORMULA
    display, cut = clip(cell.getString(), text_cap)
    state = {"ref": ref, "display": display}
    if kind == "EMPTY":
        state["kind"] = "empty"
        state["value"] = None
    elif kind == "VALUE":
        state["kind"] = "number"
        state["value"] = cell.getValue()
    elif kind == "TEXT":
        state["kind"] = "text"
        state["value"] = display
    else:
        state["kind"] = "formula"
        formula, fcut = clip(cell.getFormula(), text_cap)
        state["formula"] = formula
        cut = cut or fcut
        if cell.getError() != 0:
            state["formulaResult"] = "error"
            state["value"] = None
        elif cell.FormulaResultType2 == 1:  # com.sun.star.sheet.FormulaResult.VALUE
            state["formulaResult"] = "number"
            state["value"] = cell.getValue()
        else:
            state["formulaResult"] = "text"
            state["value"] = display
    if cut:
        state["truncated"] = True
    return state


def op_read_range(doc, req):
    sheet, index, name = sheet_of(doc, req.get("sheet"))
    c0, r0, c1, r1 = req["range"]  # validated and capped by the TS server
    if (c1 - c0 + 1) * (r1 - r0 + 1) > req["caps"]["maxCells"]:
        raise Refusal("RANGE_TOO_LARGE")
    text_cap = req["caps"]["maxCellTextChars"]
    rows = []
    for row in range(r0, r1 + 1):
        rows.append([cell_state(sheet.getCellByPosition(col, row), a1(col, row), text_cap)
                     for col in range(c0, c1 + 1)])
    return {"sheet": {"index": index, "name": clip(name, req["caps"]["maxNameChars"])[0]},
            "range": "%s:%s" % (a1(c0, r0), a1(c1, r1)), "rows": rows}


def op_document_status(doc, req):
    sheets = doc.getSheets()
    active = None
    try:
        active_sheet = doc.getCurrentController().getActiveSheet()
        active = clip(active_sheet.getName(), req["caps"]["maxNameChars"])[0]
    except Exception:
        active = None
    return {
        # True while the live document has edits that are not yet stored.
        "modified": bool(doc.isModified()),
        # Whether the document has a storage location; the location itself is never reported.
        "hasStorageLocation": bool(doc.hasLocation()),
        "readOnly": bool(doc.isReadonly()),
        "sheetCount": sheets.getCount(),
        "activeSheet": active,
    }


def role_table():
    import uno  # noqa: PLC0415

    table = {}
    for name in ROLE_NAMES:
        try:
            table[uno.getConstantByName("com.sun.star.accessibility.AccessibleRole." + name)] = (
                name.lower()
            )
        except Exception:
            continue
    return table


def op_ui_tree(doc, req):
    caps = req["caps"]
    max_depth = req["maxDepth"]
    max_nodes = req["maxNodes"]
    per_node = caps["maxChildrenPerNode"]
    name_cap = caps["maxNameChars"]
    roles = role_table()
    try:
        window = doc.getCurrentController().getFrame().getContainerWindow()
        root = window.getAccessibleContext()
    except Exception:
        raise Refusal("UI_TREE_UNAVAILABLE")
    if root is None:
        raise Refusal("UI_TREE_UNAVAILABLE")
    truncated = False

    def make(ctx):
        name, _ = clip(ctx.getAccessibleName() or "", name_cap)
        return {"role": roles.get(ctx.getAccessibleRole(), "other"), "name": name,
                "childCount": max(0, ctx.getAccessibleChildCount())}

    # Breadth-first, so the node budget covers the top levels before any deep branch.
    try:
        tree = make(root)
    except Exception:
        # No accessibility implementation behind the window (e.g. a headless build without
        # the a11y bridge): the tree is "where available", so this is a code, not a crash.
        raise Refusal("UI_TREE_UNAVAILABLE")
    count = 1
    queue = [(root, tree, 0)]
    head = 0
    while head < len(queue):
        ctx, out, depth = queue[head]
        head += 1
        children = out["childCount"]
        if children == 0:
            continue
        if depth >= max_depth:
            out["childrenOmitted"] = "depth"
            truncated = True
            continue
        kids = []
        for i in range(min(children, per_node)):
            if count >= max_nodes:
                out["childrenOmitted"] = "nodes"
                truncated = True
                break
            try:
                child = ctx.getAccessibleChild(i).getAccessibleContext()
            except Exception:
                continue
            if child is None:
                continue
            entry = make(child)
            count += 1
            kids.append(entry)
            queue.append((child, entry, depth + 1))
        if children > per_node and "childrenOmitted" not in out:
            out["childrenOmitted"] = "width"
            truncated = True
        out["children"] = kids
    return {"tree": tree, "nodes": count, "truncated": truncated}


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pipe", required=True)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args(argv)
    try:
        req = json.loads(sys.stdin.read())
        if not isinstance(req, dict) or req.get("op") not in OPS:
            raise Refusal("INVALID_REQUEST")
        ctx = connect(args.pipe, time.monotonic() + args.timeout)
        doc = the_document(ctx)
        data = globals()["op_" + req["op"]](doc, req)
        print(json.dumps({"ok": True, "data": data}))
        return 0
    except Refusal as refusal:
        print(json.dumps({"ok": False, "code": refusal.code}))
        return 3
    except Exception as exc:  # never print the message: it can carry host paths
        print(json.dumps({"ok": False, "code": "BACKEND_ERROR", "diag": type(exc).__name__}))
        return 4


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
