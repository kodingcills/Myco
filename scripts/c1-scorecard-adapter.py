#!/usr/bin/env python3
"""Turn a C1 baseline arm ledger into the trials.jsonl shape m1-scorecard.py reads.

  c1-scorecard-adapter.py ACCOUNTING_JSON [--out TRIALS_JSONL]

Why this exists: the C1 arm writes `accounting.json` (entry-per-index, with the
whole row nested under `row`), while `scripts/m1-scorecard.py` consumes the
Myco sweep's flat `trials.jsonl`. Rather than teach the generator a second
input shape — which would risk the two readers drifting — this projects one
into the other so the SAME counting rules apply to both arms.

Counting rules are the generator's, unchanged and not restated here: the
denominator is always 30, only `verified` passes, and an index with no record is
"not run". `omitted` and `reserved` entries carry no verdict, so they project to
a non-verdict status and are itemised rather than silently dropped.

Exit status is 0 whenever the ledger parsed, even if rows are missing: the
caller decides what an incomplete arm means.
"""

import json
import sys

# Every index the arm was meant to run. Fixed, so a short arm cannot shrink the
# denominator.
EXPECTED = range(30)

# Arm status -> the generator's non-verdict vocabulary. A verdict-bearing row
# keeps its own verdict; this map only covers entries that never produced one.
NO_VERDICT = {
    "omitted": "harness-error",
    "reserved": "harness-error",
}


def verdict_for(entry):
    """The generator's `status` for one ledger entry."""
    row = entry.get("row")
    if entry.get("status") == "scored" and row:
        return row.get("verdict") or "uncertain"
    return NO_VERDICT.get(entry.get("status"), "harness-error")


def manifest_run_ids(path):
    """index -> runId, from the frozen manifest.

    The arm row does not carry its own runId. The manifest does, and it is the
    same runId Myco's arm recorded (see docs/research/experiments/c1-parity.md),
    so sourcing it here is what binds the two arms together rather than
    inventing an identifier.
    """
    if not path:
        return {}
    try:
        rows = json.load(open(path)).get("rows") or []
    except (OSError, ValueError):
        return {}
    return {str(r.get("index")): r.get("runId") for r in rows}


def convert(ledger, run_ids=None):
    run_ids = run_ids or {}
    c1 = ledger.get("c1") or {}
    records = []
    for index in EXPECTED:
        entry = c1.get(str(index))
        if entry is None:
            continue  # not run: the generator counts the absence itself
        row = entry.get("row") or {}
        records.append(
            {
                "index": index,
                "fixtureSeed": (row.get("params") or {}).get("fixtureSeed"),
                "rowKey": (row.get("params") or {}).get("rowKey"),
                "column": (row.get("params") or {}).get("column"),
                "typed": (row.get("params") or {}).get("newValue"),
                "runId": row.get("runId") or run_ids.get(str(index)),
                "status": verdict_for(entry),
                # The arm's own verdict reason, kept so a reader can tell a
                # refuted trial from an infrastructure omission without
                # re-reading the ledger.
                "reason": row.get("verdictReason") or entry.get("reason"),
                "completed": entry.get("status") == "scored",
                "elapsedMs": row.get("elapsedMs"),
                "falseSuccess": row.get("falseSuccess"),
                # Carried so the baseline arm's own integrity checks are visible
                # next to Myco's.
                "cost": row.get("cost"),
                "modelCalls": row.get("modelCalls"),
                "driverDiagnostic": (row.get("driver") or {}).get("diagnostic"),
            }
        )
    return records


def main(argv):
    path = argv[1]
    out = None
    manifest = None
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    if "--manifest" in argv:
        manifest = argv[argv.index("--manifest") + 1]
    ledger = json.load(open(path))
    records = convert(ledger, manifest_run_ids(manifest))
    text = "\n".join(json.dumps(r, sort_keys=True) for r in records)
    if out:
        with open(out, "w") as handle:
            handle.write(text + "\n")
        print(f"wrote {len(records)} records to {out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
