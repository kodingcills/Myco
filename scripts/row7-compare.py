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
                   --check additionally asserts that row 7 of docs/m1-scorecard.md quotes
                   these computed numbers: it reads the row, it does not trust constants.
                   The prior spend ($4.4807) and the cap total are NOT computed here; they
                   come from c1-arm-003d/ROW7-BUDGET-DECIDED.md.

                   --check reads only the `| 7 |` row, on purpose. The rest of row 7's
                   evidence (the "Row 7 slots" table, the $7.8521 total, "the other 18 of
                   the 27", the Wilson interval) is guarded by scripts/scorecard-check.py,
                   which recomputes each of those figures and also runs this --check in
                   process (TIF-225). Do not duplicate those claims here (TIF-211).

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
SCORECARD = ROOT / "docs/m1-scorecard.md"

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


ESCAPE_KEYS = ("esc", "escape")

# TIF-98: both arms of a comparison must start from the same base family
# (m1-state acceptance #7, docs/baseline/screenshot-agent.md §2). The Myco trial
# default moved to trial-base-v2, trial-base-v3 (2026-11-26), then trial-base-v4
# (2026-11-27); the baseline arms restore
# cua-c1-base, a clean-base derivative. A Myco row records the snapshot its reset
# reported ready on. A row with no `snapshot` key predates that field and ran on
# clean-base (the only default before 2026-11-26). A null snapshot means the reset
# never got to ready, so no guest state was compared on that row.
BASE_FAMILY = {
    "clean-base": "clean-base",
    "cua-c1-base": "clean-base",
    "trial-base-v2": "trial-base-v2",
    "trial-base-v3": "trial-base-v3",
    "trial-base-v4": "trial-base-v4",
}
BASELINE_SNAPSHOT = "cua-c1-base"  # src/baseline/c1-trial.ts RESET_SNAPSHOT
LEGACY_MYCO_SNAPSHOT = "clean-base"
# TIF-98 cold-boot floor (scripts/reset-trial-vm.sh default and floor; src/m2/evidence.ts).
COLD_MIN_GUEST_CPU = 100


def check_same_base(myco: dict, baseline: dict) -> dict:
    """Refuse (SystemExit) any index whose Myco row and baseline row come from different bases.

    Returns the null-snapshot rows it skipped (the reset never reached ready). Those are
    counted and reported, and a verified row with a null snapshot is refused: a verdict with
    no recorded starting state cannot be compared (#529 S1)."""
    null_rows = []
    for i in sorted(myco):
        b = baseline.get(i, {})
        base_snap = b.get("snapshot", BASELINE_SNAPSHOT)
        base_family = BASE_FAMILY.get(base_snap)
        if base_family is None:
            raise SystemExit(f"index {i}: baseline snapshot {base_snap!r} has no known base family")
        row = myco[i]
        snap = row["snapshot"] if "snapshot" in row else LEGACY_MYCO_SNAPSHOT
        if snap is None:
            if row.get("status") == "verified":
                raise SystemExit(f"index {i}: a verified Myco row with a null snapshot (no reset reached ready)")
            null_rows.append(i)
            continue
        if BASE_FAMILY.get(snap) != base_family:
            raise SystemExit(
                f"index {i}: Myco ran on {snap!r} but the baseline on {base_snap!r} "
                f"(base family {base_family!r}); a comparison needs both arms on the same base "
                "(run the Myco arm with MYCO_COMPARISON_RUN=1 MYCO_TRIAL_SNAPSHOT=clean-base)"
            )
    return {"nullSnapshot": len(null_rows), "nullSnapshotIndices": null_rows}


def check_boot_class(myco: dict) -> dict:
    """TIF-98 cold-boot check at the join. A Myco row's `resetBootClass` records whether its
    reset was a full cold boot. A row whose reset was not (`fast`), or a verified row whose
    record is present but null (no measured boot), is refused. A row with no `resetBootClass`
    key predates the check; those are counted and reported, never assumed cold."""
    unrecorded = []
    for i in sorted(myco):
        row = myco[i]
        if "resetBootClass" not in row:
            unrecorded.append(i)
            continue
        cls = row["resetBootClass"]
        if cls is None:
            if row.get("status") == "verified":
                raise SystemExit(f"index {i}: a verified Myco row with no measured reset boot (resetBootClass null)")
            continue
        if cls != "cold":
            raise SystemExit(f"index {i}: the Myco row's reset was a {cls!r} boot, not a full cold boot (TIF-98)")
        # Recompute from the recorded CPU against the committed floor, so a fast boot labelled
        # cold (or a cold label with no measurement) cannot pass (#546 round 1 D2).
        cpu = row.get("resetGuestCpuFirstSshS")
        if not isinstance(cpu, int) or cpu < COLD_MIN_GUEST_CPU:
            raise SystemExit(
                f"index {i}: labelled cold but its reset's guest CPU at the first ssh answer is {cpu!r}, "
                f"not >= {COLD_MIN_GUEST_CPU} s (TIF-98)"
            )
    return {"bootClassUnrecorded": len(unrecorded)}


def key_counts(actions: list[dict]) -> dict:
    """press_key totals for the extract. Key names compare case-insensitively, and the
    Escape key counts under either name xdotool-style agents send, `Escape` or `Esc`
    (TIF-211). r6's ledger only ever sends `Escape`, so its extract is unchanged."""
    keys = [str(a["arguments"].get("key", "")).strip().lower() for a in actions if a["tool"] == "press_key"]
    return {
        "pressKey": len(keys),
        "ctrlS": keys.count("ctrl+s"),
        "escape": sum(k in ESCAPE_KEYS for k in keys),
    }


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
        # Derived from the transcript, which the extract does not carry: does any
        # type_text enter the row's expected value, and how many Ctrl+S / Escape
        # presses. This is what the save-dialog mechanism claim is checked against.
        actions = row["transcript"]["actions"]
        out["typedExpected"] = any(
            a["tool"] == "type_text" and str(a["arguments"].get("text", "")).strip() == row["expected"]
            for a in actions
        )
        out["actions"] = len(actions)
        out.update(key_counts(actions))
        out["claims"] = row["transcript"]["claims"]
        out["deviations"] = [d for d in row["deviations"] if not d.startswith("cua-action-")]
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


def compare(check: bool, scorecard: Path = SCORECARD) -> int:
    doc = json.loads(EXTRACT.read_text())
    r6 = {r["index"]: r for r in doc["rows"]}
    v3 = {}
    for line in V3_TRIALS.read_text().splitlines():
        if line.strip():
            t = json.loads(line)
            v3[t["index"]] = t
    if sorted(r6) != list(range(30)) or sorted(v3) != list(range(30)):
        raise SystemExit(f"need indices 0..29 on both sides: r6 {sorted(r6)}, v3 {sorted(v3)}")
    nulls = check_same_base(v3, r6)
    boots = check_boot_class(v3)

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
    budget_rows = [r for r in r6.values() if r["verdictReason"] == "step-budget"]
    save_loop = sorted(r["index"] for r in budget_rows if r["typedExpected"] and r["ctrlS"] > 0)
    other_budget = sorted(r["index"] for r in budget_rows if not (r["typedExpected"] and r["ctrlS"] > 0))
    audited = sum(1 for r in r6.values() if r["audited"])
    asym = sum(1 for r in r6.values() if "step-budget-asymmetry" in r["deviations"])

    print()
    print(f"v3 status       : {dict(sorted(v3_tally.items()))}")
    print(f"r6 verdict      : {dict(sorted(r6_tally.items()))}")
    print(f"r6 verdictReason: {dict(sorted(r6_reason.items()))}")
    print(f"r6 falseSuccess : {r6_false}")
    print(f"pairs (v3, r6)  : {dict(sorted(pairs.items()))}")
    print(f"discordant      : Myco-only {myco_only}, baseline-only {base_only}, exact two-sided p = {p:.3g}")
    print(
        f"reset records   : snapshot null on {nulls['nullSnapshot']} Myco rows (none verified); "
        f"boot class unrecorded on {boots['bootClassUnrecorded']} Myco rows (recorded before the TIF-98 check)"
    )
    print(f"r6 scored spend : {micros} micros = ${micros / 1e6:.4f}")
    print(f"step-budget rows: {len(budget_rows)}; typed expected + >=1 Ctrl+S: {len(save_loop)}; other: {other_budget}")
    for i in other_budget:
        r = r6[i]
        print(f"  index {i}: typedExpected={r['typedExpected']} pressKey={r['pressKey']} actions={r['actions']}")
    print(f"audited rows    : {audited} of 30; step-budget-asymmetry deviation on {asym} of 30")
    print(f"source ledger   : {doc['source']} sha256 {doc['sourceSha256']}")

    if check:
        row7 = next(
            (l for l in scorecard.read_text().splitlines() if l.startswith("| 7 |")),
            "",
        )
        want = [
            f"**{v3_tally['verified']} verified, {v3_tally['refuted']} refuted**",
            f"**{r6_tally.get('verified', 0)} verified, {r6_tally['refuted']} refuted**",
            f"**`step-budget` {r6_reason['step-budget']}, `modified` {r6_reason['modified']}**",
            f"Myco-only success **{myco_only}**, baseline-only **{base_only}**",
            f"**p = {p:.1e}**".replace("e-0", "e-"),
            f"**{len(save_loop)} of the {len(budget_rows)}**",
            f"rows {other_budget[0]} and {other_budget[1]}" if len(other_budget) == 2 else "rows ?",
            f"falseSuccess {r6_false}/30, but {audited} of 30 audited",
            f"on all {asym} rows",
            f"${micros / 1e6:.4f} scored in r6",
            doc["sourceSha256"][:8],
        ]
        missing = [w for w in want if w not in row7]
        if missing:
            print(f"CHECK FAILED: row 7 of {scorecard.name} does not quote {missing}", file=sys.stderr)
            return 1
        print(f"CHECK OK: row 7 quotes all {len(want)} computed figures")
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
