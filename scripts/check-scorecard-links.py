#!/usr/bin/env python3
"""Every trace link in the scorecard must resolve to a committed run.

  check-scorecard-links.py [SCORECARD]

The scorecard is the face of M1: a reader clicks a row and expects the viewer to
open that trial's verdict, evidence and timeline. A dangling link is worse than no
link — it looks like evidence and leads nowhere — which is the same class of defect
as citing a `schema-validation.log` that no commit ever contained.

Two link forms are accepted and both are checked:

  - an inline path:        `docs/research/experiments/m1-runs/<pack>/trial-<n>/`
  - a fragment deep link:  `...#?run=trial-<n>`  (the viewer's `run` key is the
                            top-level directory under the folder you open)

For each run directory the checker also asserts the two files the viewer actually
needs are present. `trace.jsonl` alone renders nothing; the viewer pairs it with
`result.json` (`viewer/src/data/loaders.ts`).

Exit 0 = every link resolves. Exit 1 = at least one does not, with each failure
named. Exit 2 = the scorecard could not be read.
"""

import re
import pathlib
import sys

# m1-runs/<pack>/trial-<n>  -- what a link must name.
RUN_LINK = re.compile(r"(?P<path>docs/research/experiments/m1-runs/[A-Za-z0-9._-]+/trial-\d+)")
# The viewer needs both of these; a directory with only one renders nothing.
REQUIRED = ("result.json", "trace.jsonl")


def main(argv: list[str]) -> int:
    card = pathlib.Path(argv[1] if len(argv) > 1 else "docs/m1-scorecard.md")
    root = pathlib.Path.cwd()
    if not card.is_file():
        print(f"scorecard not found: {card}", file=sys.stderr)
        return 2

    text = card.read_text(encoding="utf-8")
    links = [m.group("path") for m in RUN_LINK.finditer(text)]

    problems: list[str] = []
    for link in links:
        target = root / link
        if not target.is_dir():
            problems.append(f"dangling run link: {link}")
            continue
        for name in REQUIRED:
            if not (target / name).is_file():
                problems.append(f"{link} is missing {name} (the viewer renders neither alone)")

    if problems:
        for p in problems:
            print(f"FAIL {p}", file=sys.stderr)
        print(f"\n{len(problems)} problem(s) across {len(links)} link(s)", file=sys.stderr)
        return 1

    unique = sorted(set(links))
    print(f"scorecard trace links: {len(unique)} distinct run directories, all resolve")
    print(f"each carries: {', '.join(REQUIRED)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
