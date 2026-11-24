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


# The verdict vocabulary is OWNED by scripts/m1-scorecard.py and by the typed writers
# (VerdictStatus in src/core/verify.ts, the Omission union in src/baseline/sweep.ts).
# It is not re-derived by substring matching here: a token like `not-verified` or
# `pre-verified` would have passed the old substring test while failing the
# authority's `== "verified"`. Equality is the rule, and it is the only rule.
PASSING = "verified"


def passed(verdict):
    """The authority's pass rule: exactly `verified`, nothing that contains it."""
    return verdict == PASSING


def has_verdict(verdict):
    """True only for a real verdict, i.e. something the arm actually decided.

    A missing index, a `reserved`/`omitted` ledger entry, or a non-verdict status such
    as `harness-error` or `seed-mismatch` is NOT a verdict and must not be paired as
    though it were a loss for that arm.
    """
    return verdict is not None and verdict in REAL_VERDICTS


# Every status that represents an actual decision by an arm's own judge.
REAL_VERDICTS = frozenset({"verified", "refuted", "uncertain"})

# Statuses that mean "no verdict was produced". Kept in step with m1-scorecard.py's
# vocabulary so the two scripts accept and reject the same files.
NON_VERDICT_STATUSES = frozenset(
    {
        "harness-error",
        "reset-failed",
        "deploy-failed",
        "token-failed",
        "param-error",
        "seed-mismatch",
    }
)


def myco_verdicts(path):
    """index -> verdict from the Myco sweep's flat trials.jsonl.

    A `seed-mismatch` DISQUALIFIES the arm rather than counting as a failure: the trial
    ran against the wrong fixture, so it is not a paired observation at all.
    """
    out = {}
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            index = record.get("index", record.get("trial"))
            if index is None:
                continue
            index = int(index)
            if not 0 <= index < EXPECTED_INDICES:
                raise SystemExit(f"{path}: invalid trial index {index} (expected 0..29)")
            if index in out:
                raise SystemExit(f"{path}: duplicate trial index {index}")
            status = record.get("status") or record.get("verdict")
            if status == "seed-mismatch":
                raise SystemExit(
                    f"{path}: index {index} is seed-mismatch - the arm ran against the "
                    "wrong fixture, so this pairing is DISQUALIFIED"
                )
            if status is not None and status not in REAL_VERDICTS | NON_VERDICT_STATUSES:
                raise SystemExit(f"{path}: invalid status {status!r} at index {index}")
            out[index] = status
    return out


def c1_verdicts(path):
    """index -> verdict from the C1 arm's accounting.json (row nested under `row`)."""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    # Require the real shape. An earlier version fell back to the whole document,
    # which accepted a file with no `c1` key and silently treated unrelated top-level
    # keys as the ledger - the same numbers, from the wrong object.
    if "c1" not in document or not isinstance(document["c1"], dict):
        raise SystemExit(
            f"{path}: expected an accounting.json with a `c1` object; "
            f"found keys {sorted(document)[:8]}"
        )
    ledger = document["c1"]
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

    # Completeness is derived, never assumed. A pair is only evidence if BOTH arms
    # produced a real verdict for that index. Anything else is reported, not silently
    # scored.
    #
    # Why this exists: a missing record counting as a failure is the right rule for a
    # single arm's rate - it can only make that arm look worse. In a PAIRED test the
    # same rule does something else entirely: every index the baseline never ran
    # becomes a `myco-only` pair, which ADDS TO b. So an empty baseline arm produced
    # `p = 3.7e-09` and `underpowered: False` on 29 discordant pairs, from no data at
    # all, and exited 0. A verifier found that before this shipped. m1-scorecard.py
    # prints INCOMPLETE in the same situation; this now does too.
    myco_missing = [i for i in range(EXPECTED_INDICES) if not has_verdict(myco.get(i))]
    c1_missing = [i for i in range(EXPECTED_INDICES) if not has_verdict(c1.get(i))]
    complete = not myco_missing and not c1_missing

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

    # A p-value is only reported for a COMPLETE pairing. An incomplete one still gets
    # its table and its counts - those are diagnostic - but the statistic is withheld
    # rather than computed over indices one arm never ran.
    p, detail = exact_sign_test(b, c) if complete else (None, {"withheld": "incomplete pairing"})
    return {
        "indices": EXPECTED_INDICES,
        "complete": complete,
        "myco_missing_verdict": myco_missing,
        "c1_missing_verdict": c1_missing,
        "myco_recorded": sum(1 for i in range(EXPECTED_INDICES) if has_verdict(myco.get(i))),
        "c1_recorded": sum(1 for i in range(EXPECTED_INDICES) if has_verdict(c1.get(i))),
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
    if not result["complete"]:
        lines.append("**INCOMPLETE PAIRING — the p-value is WITHHELD.**")
        lines.append("")
        lines.append(
            f"- indices with no Myco verdict: {len(result['myco_missing_verdict'])}"
            f"{' (' + ', '.join(map(str, result['myco_missing_verdict'][:12])) + ')' if result['myco_missing_verdict'] else ''}"
        )
        lines.append(
            f"- indices with no baseline verdict: {len(result['c1_missing_verdict'])}"
            f"{' (' + ', '.join(map(str, result['c1_missing_verdict'][:12])) + ')' if result['c1_missing_verdict'] else ''}"
        )
        lines.append("")
        lines.append(
            "A paired test needs a verdict on BOTH sides of every index. Where one side "
            "has none, that index is shown in the table but is not evidence, and no "
            "p-value is computed — an index one arm never ran would otherwise count as a "
            "win for the other."
        )
        lines.append("")
    lines.append("| | count |")
    lines.append("|---|---|")
    lines.append(f"| b — Myco pass, baseline fail | **{result['b_myco_only']}** |")
    lines.append(f"| c — baseline pass, Myco fail | **{result['c_baseline_only']}** |")
    lines.append(f"| both pass | {result['both_pass']} |")
    lines.append(f"| both fail | {result['both_fail']} |")

    p = result["p_two_sided"]
    lines.append("")
    if p is None and result["complete"]:
        lines.append("**Exact sign test: not computable — no discordant pairs.** An all-tied")
        lines.append("comparison is no evidence in either direction, not a significant result.")
    elif p is None:
        lines.append("**Exact sign test: WITHHELD — the pairing is incomplete.** See above.")
    else:
        # Never render a small p as 0.0000: that reads as "no chance" rather than
        # "below what four decimals can show", which is the same misreading the
        # all-ties rule exists to avoid.
        row_count = result["sign_test"].get("discordant", 0)
        # SCIENTIFIC NOTATION for small p, as the outer loop specified. `p < 0.0001`
        # was the first attempt and it is weaker than it looks: 3.7e-09 and 4.9e-05
        # both print identically, so two very different amounts of evidence read the
        # same. The actual value is always shown now.
        shown = f"p = {p:.3e}" if p < 0.001 else f"p = {p:.4f}"
        lines.append(
            f"**Exact sign test (two-sided): {shown}** over {row_count} "
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
    rather than asserted: (5,0) -> 2*1/2**5 = 0.0625, (6,0) -> 2*1/2**6 = 0.03125,
    (4,1) -> 2*(1+5)/2**5 = 0.375, (6,1) -> 2*(1+7)/2**7 = 0.125, (5,5) -> capped to
    1.0, and the all-tied case must be None rather than 0, because "no discordant
    pairs" is no evidence and a p of 0 would read as overwhelming evidence.
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

    # The guards a verifier round showed were UNCAUGHT by the previous self-test, and
    # whose absence produced a "significant" result from an empty baseline arm.
    for token, want in [
        ("verified", True),
        ("refuted", False),
        ("uncertain", False),
        ("harness-error", False),
        ("seed-mismatch", False),
        ("unverified", False),
        ("not-verified", False),
        ("verified-partial", False),
        ("pre-verified", False),
    ]:
        got = passed(token)
        if got != want:
            failures.append(f"passed({token!r}) = {got}, expected {want}")

    # has_verdict separates "decided" from "no verdict", which is what stops an index
    # one arm never ran from counting as a win for the other.
    for token, want in [
        ("verified", True),
        ("refuted", True),
        ("uncertain", True),
        ("harness-error", False),
        ("reserved", False),
        ("planner-failed", False),
        (None, False),
    ]:
        got = has_verdict(token)
        if got != want:
            failures.append(f"has_verdict({token!r}) = {got}, expected {want}")

    # The threshold: five discordant pairs cannot reach alpha=0.05, six can. If this
    # constant drifts, the underpowered statement silently stops being true.
    if exact_sign_test(5, 0)[0] < 0.05:
        failures.append(
            "threshold: (5,0) = 0.0625 must NOT reach significance, so 5 discordant "
            "pairs are genuinely underpowered"
        )
    if exact_sign_test(6, 0)[0] >= 0.05:
        failures.append("threshold: (6,0) = 0.03125 must reach significance")
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
    # Non-zero on an incomplete pairing: a caller piping this into a report must not
    # have to parse prose to learn the statistic is withheld.
    return 0 if result["complete"] else 3


if __name__ == "__main__":
    sys.exit(main())
