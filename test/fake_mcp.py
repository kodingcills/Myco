#!/usr/bin/env python3
"""Stub MCP server for testing scripts/rt020-proof.py without a VM."""
import json, os, sys, tempfile
TOOLS = ["create", "observe", "act", "evidence", "reset", "destroy"]
fail = os.environ.get("FAKE_FAIL")  # tool name to fail
d = tempfile.mkdtemp()
trace, result = os.path.join(d, "trace.jsonl"), os.path.join(d, "result.json")
open(trace, "w").write('{"type":"action"}\n')
json.dump({"recordKind": "session"}, open(result, "w"))
destroyed = []
def text(o, err=False): return {"content": [{"type": "text", "text": json.dumps(o)}], "isError": err}
for line in sys.stdin:
    r = json.loads(line); m = r["method"]; i = r["id"]
    if m == "initialize": res = {"protocolVersion": "2024-11-05"}
    elif m == "tools/list": res = {"tools": [{"name": t} for t in TOOLS]}
    else:
        n, a = r["params"]["name"], r["params"]["arguments"]
        if n == fail: res = text({"ok": False, "error": "boom"}, True)
        elif n == "observe": res = text({"ok": True, "state_version": 1, "screenshot": "/x.png",
            "a11y_tree": {"nodes": [{"name": "sanity-entry", "ref": "r1"}]}})
        elif n == "act": res = text({"ok": True, "outcome": {"kind": "delivered_verified"}})
        elif n == "evidence": res = text({"ok": True, "trace": trace, "result": result})
        else:
            if n == "destroy": open(os.environ.get("FAKE_LOG", os.devnull), "a").write("destroy\n")
            res = text({"ok": True})
    print(json.dumps({"jsonrpc": "2.0", "id": i, "result": res}), flush=True)
