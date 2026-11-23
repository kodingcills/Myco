#!/usr/bin/env python3
"""Commit per-trial traces so every scorecard row links to a viewable run.

  build-scorecard-runs.py --source DIR --pack NAME --out DIR [--indices 0,1,2]

Copies `result.json` + `trace.jsonl` for each trial into a stable, committed
layout the viewer can open:

    <out>/<pack>/trial-<index>/result.json
    <out>/<pack>/trial-<index>/trace.jsonl

The directory name is what the viewer's `#?run=<name>` hash resolves against
(`viewer/src/store.ts:67` keys on the top-level directory), so each trial gets its
own directory rather than a shared one.

**Screenshots are deliberately excluded.** A run directory in /tmp is ~8 MB because
of per-step PNGs; `result.json` + `trace.jsonl` is ~8 KB. The viewer renders the
verdict, the evidence and the timeline from those two files alone
(`viewer/src/data/loaders.ts:33` looks for `trace.jsonl` and pairs it with
`result.json`), so committing 8 MB per trial would buy nothing a reader can see.

Refuses to write a trial that has no `trace.jsonl` — a missing trace must fail
loudly here rather than become a dangling link in the scorecard.
"""

import argparse
import json
import pathlib
import shutil
import sys

KEEP = ("result.json", "trace.jsonl")


def find_trials(source: pathlib.Path) -> dict[int, pathlib.Path]:
    """index -> the directory holding that trial's result.json/trace.jsonl."""
    found: dict[int, pathlib.Path] = {}
    for trace in source.rglob("trace.jsonl"):
        run_dir = trace.parent
        # <source>/<index>/<runId>/trace.jsonl  -- the index is the trial number.
        try:
            index = int(run_dir.parent.name)
        except ValueError:
            continue
        if "result.json" not in {p.name for p in run_dir.iterdir()}:
            continue
        # Later sources win only if the earlier one lacked the trial.
        found.setdefault(index, run_dir)
    return found


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--pack", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--indices", default="")
    args = ap.parse_args(argv)

    source = pathlib.Path(args.source)
    if not source.is_dir():
        print(f"source not found: {source}", file=sys.stderr)
        return 2

    trials = find_trials(source)
    wanted = (
        [int(i) for i in args.indices.split(",") if i.strip()]
        if args.indices
        else sorted(trials)
    )

    missing = [i for i in wanted if i not in trials]
    if missing:
        print(f"REFUSING: no trace.jsonl for trial(s) {missing}", file=sys.stderr)
        return 1

    written = []
    for index in wanted:
        dest = pathlib.Path(args.out) / args.pack / f"trial-{index}"
        dest.mkdir(parents=True, exist_ok=True)
        for name in KEEP:
            shutil.copy(trials[index] / name, dest / name)
        written.append(index)

    print(f"{args.pack}: wrote {len(written)} trials to {args.out}/{args.pack}")
    print(json.dumps({"pack": args.pack, "indices": written}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
