#!/usr/bin/env python3
"""Every trace link in the scorecard must resolve to a committed run.

  check-scorecard-links.py [SCORECARD]

The scorecard is the face of M1: a reader clicks a row and expects the viewer to
open that trial's verdict, evidence and timeline. A dangling link is worse than no
link — it looks like evidence and leads nowhere — which is the same class of defect
as citing a `schema-validation.log` that no commit ever contained.

Two link forms are accepted and both are checked:

  - an inline path:        `docs/research/experiments/m1-runs/<pack>/trial-<n>/`
  - a fragment deep link:  `...#?run=<runId>`  (the viewer's `run` key is the run's
                            own `runId` from its `result.json`, not the folder name;
                            the fragment is checked against that artifact)

For each run directory the checker also asserts the two files the viewer actually
needs are present. `trace.jsonl` alone renders nothing; the viewer pairs it with
`result.json` (`viewer/src/data/loaders.ts`).

Exit 0 = every link resolves. Exit 1 = at least one does not, with each failure
named. Exit 2 = the scorecard could not be read.
"""

import json
import re
import pathlib
import sys

# m1-runs/<pack>/trial-<n>  -- what a link must name.
RUN_LINK = re.compile(r"(?P<path>docs/research/experiments/m1-runs/[A-Za-z0-9._-]+/trial-\d+)")
# The viewer needs both of these; a directory with only one renders nothing.
REQUIRED = ("result.json", "trace.jsonl")
# A scorecard row: label, run directory, and the viewer deep link.
ROW = re.compile(
    r"^\| (?P<label>[^|]+?) \| \[`(?P<path>docs/research/experiments/m1-runs/[^`]+)`\]\([^)]+\) \| "
    r"\[View\]\([^)]*#\?run=(?P<run>[^)\s]+)\) \|$"
)


def result_run_id(target: pathlib.Path) -> str | None:
    """The runId the viewer will key this run by, straight from its result.json."""
    result = target / "result.json"
    if not result.is_file():
        return None
    try:
        value = json.loads(result.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    run_id = value.get("runId")
    return run_id if isinstance(run_id, str) and run_id else None


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

    # A viewer link is only useful if its fragment names the run it sits beside: the
    # viewer keys a run by result.json's runId, so a wrong id opens the wrong trace
    # or nothing. Checked against the artifact, not against the row.
    seen_views = 0
    for line in text.splitlines():
        row = ROW.match(line)
        if not row:
            continue
        seen_views += 1
        target = root / row.group("path")
        expected = result_run_id(target)
        if expected is None:
            problems.append(f"{row.group('path')} has no runId in result.json to link to")
        elif row.group("run") != expected:
            problems.append(
                f"{row.group('label').strip()} links run={row.group('run')} "
                f"but its result.json says {expected}"
            )

    if seen_views != len(set(links)):
        problems.append(
            f"{len(set(links))} run link(s) but {seen_views} row(s) with a viewer link; "
            "every row must carry one"
        )

    if problems:
        for p in problems:
            print(f"FAIL {p}", file=sys.stderr)
        print(f"\n{len(problems)} problem(s) across {len(links)} link(s)", file=sys.stderr)
        return 1

    unique = sorted(set(links))
    print(f"scorecard trace links: {len(unique)} distinct run directories, all resolve")
    print(f"each carries: {', '.join(REQUIRED)}")
    print(f"viewer deep links: {seen_views}, every fragment matches its result.json runId")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
