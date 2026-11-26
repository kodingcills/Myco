#!/usr/bin/env python3
"""Compare what the oracle read on two trial bases (TIF-98 follow-up).

usage: base-parity-compare.py <out-dir> <base-a> <base-b>

Reads <out-dir>/<base>/{normal-*,kill-*}.json written by scripts/base-parity.sh.
For each trial label present on both bases it compares the oracle's view:
verdict status, verdict reasons, the fixture fingerprint, and (kill mode)
whether the fault landed. Run ids, paths and timings are ignored because they
differ by construction. Prints a Markdown table and exits 0 only when every
label matches and every corrupted control is non-verified on both bases.
"""

from __future__ import annotations

import glob
import json
import os
import sys


def view(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    start = raw.find("{")
    if start < 0:
        return {"error": "no JSON report"}
    r = json.loads(raw[start:])
    v = r.get("verdict") or {}
    out = {
        "status": v.get("status"),
        "reasons": v.get("reasons"),
        "fixture": r.get("fixtureFingerprint") or r.get("fixture"),
        "completed": r.get("completed"),
    }
    c = r.get("corruption")
    if c is not None:
        out["fault_applied"] = c.get("applied")
    return out


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    out, a, b = argv
    labels = sorted(
        {os.path.basename(p)[:-5] for p in glob.glob(os.path.join(out, a, "*-*.json"))}
        & {os.path.basename(p)[:-5] for p in glob.glob(os.path.join(out, b, "*-*.json"))}
        - {"session-info"}
    )
    if not labels:
        print("no trial labels on both bases", file=sys.stderr)
        return 1
    ok = True
    print(f"| trial | {a} status | {b} status | oracle view identical |")
    print("|---|---|---|---|")
    for label in labels:
        va = view(os.path.join(out, a, label + ".json"))
        vb = view(os.path.join(out, b, label + ".json"))
        same = va == vb
        if label.startswith("kill-") and "verified" in (va.get("status"), vb.get("status")):
            ok = False
        ok = ok and same
        print(f"| {label} | {va.get('status')} | {vb.get('status')} | {'yes' if same else 'NO'} |")
        if not same:
            print(f"\n{label} differs:\n- {a}: {json.dumps(va)}\n- {b}: {json.dumps(vb)}\n")
    print(f"\nparity: {'PASS' if ok else 'FAIL'} ({len(labels)} trials)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
