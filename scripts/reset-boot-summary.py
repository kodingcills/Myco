#!/usr/bin/env python3
"""Summarise trial resets as cold or fast boots (TIF-98 fast-reset guard).

usage: reset-boot-summary.py <reset.log> [<reset.log> ...]

Reads each log's `wait-guest-ready: first ssh answer after Ns (guest CPU Ms)`
lines (a guarded reset that cycled has two) and its `reset-trial-vm: timing
... total=T` line, and prints one Markdown row per boot, then the range of each
class. A boot is "cold" when its guest CPU at the first ssh answer is at least
COLD_MIN_GUEST_CPU, the default of MYCO_COLD_MIN_GUEST_CPU in
scripts/reset-trial-vm.sh; otherwise "fast". A log with no first-ssh line is an
error, not a skip.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

COLD_MIN_GUEST_CPU = 100
FIRST = re.compile(r"^wait-guest-ready: first ssh answer after (\d+)s \(guest CPU (\d+)s\)", re.M)
TOTAL = re.compile(r"^reset-trial-vm: timing .* total=(\d+)$", re.M)


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__, file=sys.stderr)
        return 2
    rows = []
    for p in paths:
        text = Path(p).read_text()
        # One file may hold several resets (a bench extract): each reset's boots are the
        # first-ssh lines before its own `timing` line.
        start = 0
        resets = 0
        for t in TOTAL.finditer(text):
            boots = FIRST.findall(text[start : t.start()])
            if not boots:
                print(f"{p}: a timing line with no first-ssh line before it", file=sys.stderr)
                return 1
            resets += 1
            for n, (ssh, cpu) in enumerate(boots, 1):
                cls = "cold" if int(cpu) >= COLD_MIN_GUEST_CPU else "fast"
                rows.append((f"{p}#{resets}" if text.count("reset-trial-vm: timing") > 1 else p, n, int(ssh), int(cpu), t.group(1), cls))
            start = t.end()
        if resets == 0:
            print(f"{p}: no reset (no timing line)", file=sys.stderr)
            return 1
    print("| log | boot | first ssh s | guest CPU at first ssh s | reset total s | class |")
    print("|---|---|---|---|---|---|")
    for p, n, ssh, cpu, total, cls in rows:
        print(f"| {p} | {n} | {ssh} | {cpu} | {total} | {cls} |")
    print()
    print(f"Threshold: cold when guest CPU at the first ssh answer >= {COLD_MIN_GUEST_CPU} s.")
    print()
    print("| class | boots | first ssh s min-max | guest CPU s min-max |")
    print("|---|---|---|---|")
    for cls in ("cold", "fast"):
        sel = [r for r in rows if r[5] == cls]
        if sel:
            print(
                f"| {cls} | {len(sel)} | {min(r[2] for r in sel)}-{max(r[2] for r in sel)} "
                f"| {min(r[3] for r in sel)}-{max(r[3] for r in sel)} |"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
