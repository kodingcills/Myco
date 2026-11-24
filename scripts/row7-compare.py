#!/usr/bin/env python3
"""Row 7: C1 arm-003 r6 (screenshot agent) against Myco sweep v3, row by row.

Two subcommands.

  extract LEDGER   Read r6's full ledger (~/Projects/myco-runs/c1-r6/accounting.json,
                   ~485 KB with transcripts) and write the committed extract
                   docs/research/experiments/c1-arm-003/r6/ledger-extract.json. The
                   extract keeps the graded fields and drops transcripts and usage. It
                   records the source file's sha256, so anyone with the ledger can
                   regenerate it byte for byte.

  compare          (default) Read the committed extract and Myco v3's committed
                   docs/research/experiments/m1-013-sweep-v3/trials.jsonl, pair them by
                   index, refuse unless every pair names the same task (fixtureSeed,
                   rowKey, column, value), then print the paired table, both tallies,
                   and the exact two-sided sign test on the discordant pairs.
                   --check additionally asserts the numbers quoted in docs/m1-scorecard.md.

The graded field is `row.verdict` / `row.verdictReason`, set by judge()
(src/baseline/index.ts) and written by c1-trial.ts. It is NOT `mycoVerdict`, which
sweep.ts copies from the pinned sweep-v3.json (TIF-207); the extract never carries it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from math import comb
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRACT = ROOT / "docs/research/experiments/c1-arm-003/r6/ledger-extract.json"
V3_TRIALS = ROOT / "docs/research/experiments/m1-013-sweep-v3/trials.jsonl"

ROW_FIELDS = (
    "index",
    "cellRef",
    "expected",
    "instruction",
    "verdict",
    "verdictReason",
    "falseSuccess",
    "audited",
    "independentValuePresent",
    "steps",
    "stepBudget",
    "budgetExhausted",
)


def extract(ledger_path: Path) -> None:
    raw = ledger_path.read_bytes()
    ledger = json.loads(raw)
    rows = []
    for key in sorted(ledger["c1"], key=int):
        entry = ledger["c1"][key]
        row = entry["row"]
        if row["index"] != int(key):
            raise SystemExit(f"ledger key {key} carries row index {row['index']}")
        out = {f: row[f] for f in ROW_FIELDS}
        out.update(row["params"])  # fixtureSeed, rowKey, column, newValue
        out["ledgerStatus"] = entry["status"]
        out["micros"] = entry["micros"]
        rows.append(out)
    doc = {
        "source": str(ledger_path).replace(str(Path.home()), "~"),
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "sourceBytes": len(raw),
        "manifestSha256": ledger["manifestSha256"],
        "identity": ledger["identity"],
        "c2Rows": len(ledger["c2"]),
        "gradedField": "row.verdict / row.verdictReason (never mycoVerdict, TIF-207)",
        "rows": rows,
    }
    EXTRACT.parent.mkdir(parents=True, exist_ok=True)
    EXTRACT.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    print(f"wrote {EXTRACT.relative_to(ROOT)}: {len(rows)} rows from {doc['sourceSha256']}")


def sign_test_two_sided(a: int, b: int) -> float:
    n = a + b
    k = min(a, b)
    return min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2**n)


def compare(check: bool) -> int:
    doc = json.loads(EXTRACT.read_text())
    r6 = {r["index"]: r for r in doc["rows"]}
    v3 = {}
    for line in V3_TRIALS.read_text().splitlines():
        if line.strip():
            t = json.loads(line)
            v3[t["index"]] = t
    if sorted(r6) != list(range(30)) or sorted(v3) != list(range(30)):
        raise SystemExit(f"need indices 0..29 on both sides: r6 {sorted(r6)}, v3 {sorted(v3)}")

    pairs = Counter()
    print("idx  seed         record    column  value            v3        r6 verdict / reason")
    for i in range(30):
        a, b = v3[i], r6[i]
        task_v3 = (a["fixtureSeed"], a["rowKey"], a["column"], a["typed"])
        task_r6 = (b["fixtureSeed"], b["rowKey"], b["column"], b["newValue"])
        if task_v3 != task_r6:
            raise SystemExit(f"index {i}: different tasks {task_v3} vs {task_r6}")
        if b["expected"] != b["newValue"]:
            raise SystemExit(f"index {i}: r6 expected {b['expected']!r} != newValue")
        pairs[(a["status"], b["verdict"])] += 1
        print(
            f"{i:>3}  {a['fixtureSeed']:<12} {a['rowKey']:<9} {a['column']:<7} "
            f"{a['typed']:<16} {a['status']:<9} {b['verdict']} / {b['verdictReason']}"
        )

    v3_tally = Counter(t["status"] for t in v3.values())
    r6_tally = Counter(r["verdict"] for r in r6.values())
    r6_reason = Counter(r["verdictReason"] for r in r6.values())
    r6_false = sum(1 for r in r6.values() if r["falseSuccess"])
    micros = sum(r["micros"] for r in r6.values())
    myco_only = pairs[("verified", "refuted")] + pairs[("verified", "uncertain")]
    base_only = pairs[("refuted", "verified")] + pairs[("uncertain", "verified")]
    p = sign_test_two_sided(myco_only, base_only)

    print()
    print(f"v3 status       : {dict(sorted(v3_tally.items()))}")
    print(f"r6 verdict      : {dict(sorted(r6_tally.items()))}")
    print(f"r6 verdictReason: {dict(sorted(r6_reason.items()))}")
    print(f"r6 falseSuccess : {r6_false}")
    print(f"pairs (v3, r6)  : {dict(sorted(pairs.items()))}")
    print(f"discordant      : Myco-only {myco_only}, baseline-only {base_only}, exact two-sided p = {p:.3g}")
    print(f"r6 scored spend : {micros} micros = ${micros / 1e6:.4f}")
    print(f"source ledger   : {doc['source']} sha256 {doc['sourceSha256']}")

    if check:
        want = {
            "v3": {"verified": 29, "refuted": 1},
            "r6": {"refuted": 30},
            "reason": {"step-budget": 29, "modified": 1},
            "falseSuccess": 0,
            "pairs": {("verified", "refuted"): 29, ("refuted", "refuted"): 1},
            "micros": 3371350,
        }
        got = {
            "v3": dict(v3_tally),
            "r6": dict(r6_tally),
            "reason": dict(r6_reason),
            "falseSuccess": r6_false,
            "pairs": dict(pairs),
            "micros": micros,
        }
        bad = [k for k in want if want[k] != got[k]]
        if bad:
            print(f"CHECK FAILED on {bad}: want {want}, got {got}", file=sys.stderr)
            return 1
        print("CHECK OK: the numbers in docs/m1-scorecard.md row 7 match the committed artifacts")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    ex = sub.add_parser("extract")
    ex.add_argument("ledger", type=Path)
    cp = sub.add_parser("compare")
    cp.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.cmd == "extract":
        extract(args.ledger)
        return 0
    return compare(getattr(args, "check", False))


if __name__ == "__main__":
    sys.exit(main())
