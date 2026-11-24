#!/usr/bin/env python3
"""Pair a C1 baseline arm against the Myco M1-013 sweep, per trial index.

  paired-sign-test.py --myco TRIALS_JSONL --c1 ACCOUNTING_JSON [--json]

Why this exists, and why it is separate from `m1-scorecard.py`: that script answers
"how many of the 30 passed", which is a rate over one arm. Row 7's acceptance
criterion is not a rate — it is a **per-trial paired table plus the exact sign test
(b, c, p)**, and an explicit "underpowered at n=30" statement whenever the
discordant count is below 6. A rate cannot produce a p-value, and an unpaired
comparison of two rates hides exactly the structure that matters: which trials the
two arms disagree on, and in which direction.

The pairing is BY INDEX. Both arms were assigned the same 30 parameter sets in the
same order (proven 30/30 in docs/research/experiments/c1-parity.md), so index i in
one arm is the same task with the same fixture in the other. Pairing on anything
else — on `rowKey` or `cellRef`, say — would silently regroup trials if a
parameter set ever repeated.

Counting rules come from `m1-scorecard.py` and are NOT restated here: only
`verified` passes, and an index with no record counts as a failure of that arm
rather than being dropped from the denominator. That last rule is what keeps a
partial arm honest — a resume that scored 19 of 30 must not report a rate over 19.

The exact sign test is two-sided and computed by summing binomial tail
probabilities (no normal approximation, since n here is 30 at most). b = trials
Myco passed and the baseline did not; c = the reverse. Ties are indexed but not
counted, which is the standard rule and the conservative one.

Exit status is 0 whenever both inputs parsed, even when the arm is incomplete:
the caller decides what a short arm means. `--json` prints the same numbers
machine-readable.
"""

import argparse
import json
import math
import sys
from pathlib import Path

EXPECTED_INDICES = 30

# Below this many discordant pairs the exact test cannot reach significance at
# alpha=0.05 two-sided, so a p-value alone would overstate what n=30 can show.
UNDERPOWERED_BELOW = 6


def passed(verdict):
    """The generator's pass rule, and the only one: `verified`."""
    return "verified" in str(verdict) and "refuted" not in str(verdict) and "unverified" not in str(verdict)


def myco_verdicts(path):
    """index -> verdict from the Myco sweep's flat trials.jsonl."""
    out = {}
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            index = record.get("index", record.get("trial"))
            if index is None:
                continue
            out[int(index)] = record.get("status") or record.get("verdict") or "unknown"
    return out


def c1_verdicts(path):
    """index -> verdict from the C1 arm's accounting.json (row nested under `row`)."""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    ledger = document.get("c1", document)
    out = {}
    for key, entry in ledger.items():
        if not isinstance(entry, dict):
            continue
        index = entry.get("row", {}).get("index")
        if index is None:
            try:
                index = int(key)
            except (TypeError, ValueError):
                continue
        if entry.get("status") == "scored" and entry.get("row"):
            out[int(index)] = entry["row"].get("verdict") or "uncertain"
        else:
            # Not scored: no verdict exists, so it fails that arm's denominator
            # rather than being dropped. The reason is kept for the table.
            out[int(index)] = entry.get("reason") or entry.get("status") or "unknown"
    return out


def exact_sign_test(b, c):
    """Two-sided exact binomial p-value over the discordant pairs.

    Returns (p, detail) where p is None when there are no discordant pairs, since
    an all-tied comparison carries no evidence in either direction.
    """
    n = b + c
    if n == 0:
        return None, {"discordant": 0}

    # Two-sided exact: sum the probabilities of outcomes at least as extreme as
    # the observed split, under p=0.5.
    observed = min(b, c)
    total = 0.0
    for k in range(0, observed + 1):
        total += math.comb(n, k) * (0.5**n)
    p = min(1.0, 2 * total)
    return p, {
        "discordant": n,
        "b_myco_only": b,
        "c_baseline_only": c,
        "observed_smaller_tail": observed,
    }


def build(myco_path, c1_path):
    myco = myco_verdicts(myco_path)
    c1 = c1_verdicts(c1_path)

    rows = []
    b = c = ties_pass = ties_fail = 0
    for index in range(EXPECTED_INDICES):
        m = myco.get(index)
        s = c1.get(index)
        m_pass = m is not None and passed(m)
        s_pass = s is not None and passed(s)

        if m_pass and s_pass:
            cell, ties_pass = "both-pass", ties_pass + 1
        elif not m_pass and not s_pass:
            cell, ties_fail = "both-fail", ties_fail + 1
        elif m_pass and not s_pass:
            cell, b = "myco-only", b + 1
        else:
            cell, c = "baseline-only", c + 1

        rows.append(
            {
                "index": index,
                "myco": m if m is not None else "not-run",
                "baseline": s if s is not None else "not-run",
                "pair": cell,
            }
        )

    p, detail = exact_sign_test(b, c)
    return {
        "indices": EXPECTED_INDICES,
        "myco_recorded": len(myco),
        "c1_recorded": len(c1),
        "paired_rows": rows,
        "b_myco_only": b,
        "c_baseline_only": c,
        "both_pass": ties_pass,
        "both_fail": ties_fail,
        "p_two_sided": p,
        "sign_test": detail,
        "underpowered": (b + c) < UNDERPOWERED_BELOW,
        "underpowered_threshold": UNDERPOWERED_BELOW,
    }


def markdown(result):
    lines = []
    lines.append(f"Paired comparison over {result['indices']} trial indices")
    lines.append(
        f"Myco recorded {result['myco_recorded']}, C1 recorded {result['c1_recorded']}"
    )
    lines.append("")
    lines.append("| index | myco | baseline | pair |")
    lines.append("|---|---|---|---|")
    for row in result["paired_rows"]:
        lines.append(f"| {row['index']} | {row['myco']} | {row['baseline']} | {row['pair']} |")

    lines.append("")
    lines.append("| | count |")
    lines.append("|---|---|")
    lines.append(f"| b — Myco pass, baseline fail | **{result['b_myco_only']}** |")
    lines.append(f"| c — baseline pass, Myco fail | **{result['c_baseline_only']}** |")
    lines.append(f"| both pass | {result['both_pass']} |")
    lines.append(f"| both fail | {result['both_fail']} |")

    p = result["p_two_sided"]
    lines.append("")
    if p is None:
        lines.append("**Exact sign test: not computable — no discordant pairs.** An all-tied")
        lines.append("comparison is no evidence in either direction, not a significant result.")
    else:
        lines.append(
            f"**Exact sign test (two-sided): p = {p:.4f}** over {result['sign_test']['discordant']} "
            f"discordant pairs."
        )
    if result["underpowered"]:
        lines.append("")
        lines.append(
            f"**UNDERPOWERED at n={result['indices']}.** Only {result['sign_test'].get('discordant', 0)} "
            f"discordant pairs; fewer than {result['underpowered_threshold']} cannot reach "
            "significance at alpha=0.05 two-sided, so no p-value here supports a claim of difference. "
            "Report the table and this statement together, never the p-value alone."
        )
    return "\n".join(lines)


def self_test():
    """Pin the exact test against hand-computed values.

    These are the numbers that make the statistic trustworthy, so they are checked
    rather than asserted: (5,0) -> 2*(1+5)/2**6, (6,0) -> 2/2**6, (5,5) -> 1, and
    the all-tied case must be None rather than 0, because "no discordant pairs" is
    no evidence and a p of 0 would read as overwhelming evidence.
    """
    cases = [(5, 0, 0.0625), (6, 0, 0.03125), (5, 5, 1.0), (4, 1, 0.375), (6, 1, 0.125)]
    failures = []
    for b, c, expected in cases:
        p, _ = exact_sign_test(b, c)
        if p is None or abs(p - expected) > 1e-9:
            failures.append(f"b={b} c={c}: got {p}, expected {expected}")
    p, _ = exact_sign_test(0, 0)
    if p is not None:
        failures.append(f"all-tied: got {p}, expected None (no evidence either way)")
    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print(f"  {f}")
        return 1
    print(f"self-test ok: {len(cases) + 1} cases")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--self-test", action="store_true", help="check the exact test, then exit")
    parser.add_argument("--myco", help="Myco sweep trials.jsonl")
    parser.add_argument("--c1", help="C1 arm accounting.json")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    if not args.myco or not args.c1:
        parser.error("--myco and --c1 are required unless --self-test is given")

    result = build(args.myco, args.c1)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(markdown(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
