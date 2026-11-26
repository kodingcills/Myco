#!/usr/bin/env python3
"""Summarise load-gate-sample.sh output per state (TIF-218).

usage: load-gate-summary.py <samples.jsonl> [<samples.jsonl> ...]

Prints a Markdown table: for each state, n and the p50 / p95 / max of
  load1             host 1-minute load
  qemu_cores        the guest's QEMU CPU share in cores (qemu_pcpu / 100)
  load_minus_qemu   load1 - qemu_cores, floored at 0 (the host load the guest does not explain)
  mem_free_pct      memory_pressure's system-wide free percentage (p5 / p50 / min: low is bad)
  swap_free_mb      (p5 / p50 / min)
  swapouts/min      rate between consecutive samples of the same state (p50 / p95 / max)
Percentiles are nearest-rank on the sorted values. Every line is counted; a
line that does not parse is an error, not a skip.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime


def pct(values: list[float], p: float) -> float:
    """Nearest-rank percentile: the smallest value with at least p% of values <= it."""
    v = sorted(values)
    k = max(1, math.ceil(p / 100 * len(v)))
    return v[k - 1]


def ts(s: str) -> float:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").timestamp()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    rows: list[dict] = []
    for path in argv:
        with open(path, encoding="utf-8") as f:
            for i, line in enumerate(f, 1):
                if not line.strip():
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as e:
                    print(f"{path}:{i}: not JSON ({e})", file=sys.stderr)
                    return 1
    states: list[str] = []
    for r in rows:
        if r["state"] not in states:
            states.append(r["state"])

    print("| state | n | load1 p50 / p95 / max | qemu cores p50 / p95 / max | load - qemu p50 / p95 / max "
          "| mem free % p5 / p50 / min | swap free MB p5 / p50 / min | swapouts/min p50 / p95 / max |")
    print("|---|---|---|---|---|---|---|---|")
    for s in states:
        rs = [r for r in rows if r["state"] == s]
        load = [float(r["load1"]) for r in rs]
        qemu = [float(r["qemu_pcpu"]) / 100 for r in rs]
        net = [max(0.0, a - b) for a, b in zip(load, qemu)]
        mem = [float(r["mem_free_pct"]) for r in rs if r.get("mem_free_pct") is not None]
        swap = [float(r["swap_free_mb"]) for r in rs]
        rates = []
        for a, b in zip(rs, rs[1:]):
            dt = ts(b["ts_utc"]) - ts(a["ts_utc"])
            if dt > 0:
                rates.append((b["swapouts"] - a["swapouts"]) / dt * 60)

        def hi(v: list[float]) -> str:
            return f"{pct(v, 50):.2f} / {pct(v, 95):.2f} / {max(v):.2f}" if v else "n/a"

        def lo(v: list[float]) -> str:
            return f"{pct(v, 5):.0f} / {pct(v, 50):.0f} / {min(v):.0f}" if v else "n/a"

        print(f"| {s} | {len(rs)} | {hi(load)} | {hi(qemu)} | {hi(net)} | {lo(mem)} | {lo(swap)} | {hi(rates)} |")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
