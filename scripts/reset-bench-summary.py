#!/usr/bin/env python3
"""Summarise reset-bench.sh JSONL rows into a Markdown table (TIF-98).

usage: reset-bench-summary.py <label>=<file.jsonl>[,<file.jsonl>...] ...

Every row in every file is counted: failed resets are listed, never dropped.
Per label it prints median / min / max of each phase, the reset total, first
ssh answer, and (for cycle rows) deploy and session_info times and outcomes.
Output is deterministic for the same inputs, so the evidence pack's
summary.md can be rebuilt byte-identical and diffed.
"""

from __future__ import annotations

import json
import statistics
import sys

PHASES = ["stop", "restore", "start", "ready", "clock", "total"]


def load(paths: list[str]) -> list[dict]:
    rows: list[dict] = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            rows.extend(json.loads(line) for line in f if line.strip())
    return rows


def stats(values: list[float]) -> str:
    if not values:
        return "n/a"
    med = statistics.median(values)
    med_s = f"{med:g}"
    return f"{med_s} ({min(values):g}-{max(values):g})"


def column(rows: list[dict], get) -> list[float]:
    out = []
    for r in rows:
        v = get(r)
        if v is not None:
            out.append(v)
    return out


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    groups: list[tuple[str, list[dict]]] = []
    for arg in argv:
        label, _, files = arg.partition("=")
        if not files:
            print(f"bad argument {arg!r}: want label=file.jsonl", file=sys.stderr)
            return 2
        groups.append((label, load(files.split(","))))

    print("Median (min-max) seconds per phase. n = rows counted; every row is counted.\n")
    header = ["label", "n", "ok"] + PHASES + ["stability", "first ssh answer", "load1 at start", "host swap MB"]
    print("| " + " | ".join(header) + " |")
    print("|" + "---|" * len(header))
    for label, rows in groups:
        ok = sum(1 for r in rows if r["reset_rc"] == 0 and r.get("ready_check_rc") == 0)
        cells = [label, str(len(rows)), str(ok)]
        for ph in PHASES:
            cells.append(stats(column(rows, lambda r, ph=ph: r["phases_s"].get(ph))))
        # Stability phase = readiness gate time after the first ssh answer.
        cells.append(
            stats(
                column(
                    rows,
                    lambda r: (r["phases_s"]["ready"] - r["first_ssh_answer_s"])
                    if r.get("first_ssh_answer_s") is not None and "ready" in r["phases_s"]
                    else None,
                )
            )
        )
        cells.append(stats(column(rows, lambda r: r.get("first_ssh_answer_s"))))
        cells.append(stats(column(rows, lambda r: r.get("load1_at_start"))))
        cells.append(stats(column(rows, lambda r: r.get("host_swap_used_mb_at_start"))))
        print("| " + " | ".join(cells) + " |")

    cycles = [(label, [r for r in rows if r["mode"] == "cycle"]) for label, rows in groups]
    cycles = [(label, rows) for label, rows in cycles if rows]
    if cycles:
        print("\nReset -> deploy -> session_info cycles.\n")
        print("| label | run | reset s | deploy rc | deploy s | session_info rc | session_info s | session_id | window_station | desktop |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for label, rows in cycles:
            for r in rows:
                si = r.get("session_info") or {}
                print(
                    f"| {label} | {r['run']} | {r['reset_s']} | {r['deploy_rc']} | {r['deploy_s']} | "
                    f"{r['session_info_rc']} | {r['session_info_s']} | {si.get('session_id', 'n/a')} | "
                    f"{si.get('window_station', 'n/a')} | {si.get('desktop', 'n/a')} |"
                )

    failed = [(label, r) for label, rows in groups for r in rows if r["reset_rc"] != 0 or r.get("ready_check_rc") not in (0,)]
    print(f"\nFailed or unchecked rows: {len(failed)}")
    for label, r in failed:
        print(f"- {label} run {r['run']}: reset_rc={r['reset_rc']} ready_check_rc={r.get('ready_check_rc')}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
