#!/usr/bin/env python3
"""Rewrite the scorecard's trial table with a viewer deep link per row.

  python3 scripts/scorecard-viewer-links.py [--check]

Each row keeps its run-directory link and gains a `View` link whose fragment is
`#?run=<runId>`, taken from that directory's own `result.json`. The viewer's `run`
key IS the `runId` (`viewer/src/store.ts` sets a run's key to `result.json`'s
runId once the result parses), so the fragment must name the id, not the folder.

`--check` rewrites nothing and exits non-zero if the table is not already in the
generated form, so CI can hold the table to what the artifacts say.
"""

import json
import pathlib
import re
import sys

TABLE_ROW = re.compile(
    r"^\| (?P<label>[^|]+?) \| \[`(?P<path>docs/research/experiments/m1-runs/[^`]+)`\]\((?P<href>[^)]+)\)"
    r"(?: \| \[View\]\([^)]*\))? \|$"
)
# The two-column header this script replaces, and the three-column one it writes.
OLD_HEADER = "| Trial | Run directory |\n|---|---|"
NEW_HEADER = "| Trial | Run directory | Viewer |\n|---|---|---|"
# The viewer is a single static file; the deep link is its fragment.
VIEWER = "viewer/dist/myco-viewer.html"


def rows(root: pathlib.Path):
    for line in (root / "docs" / "m1-scorecard.md").read_text(encoding="utf-8").splitlines():
        m = TABLE_ROW.match(line)
        if m:
            yield m


def run_id(root: pathlib.Path, path: str) -> str | None:
    result = root / path / "result.json"
    if not result.is_file():
        return None
    try:
        value = json.loads(result.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    run_id = value.get("runId")
    return run_id if isinstance(run_id, str) and run_id else None


def main(argv: list[str]) -> int:
    check = "--check" in argv[1:]
    root = pathlib.Path.cwd()
    card = root / "docs" / "m1-scorecard.md"
    text = card.read_text(encoding="utf-8")

    problems: list[str] = []
    rebuilt: list[str] = []
    count = 0
    for line in text.splitlines():
        m = TABLE_ROW.match(line)
        if not m:
            rebuilt.append(line)
            continue
        path = m.group("path")
        rid = run_id(root, path)
        if rid is None:
            problems.append(f"{path} has no runId in result.json, so no viewer link can be built")
            rebuilt.append(line)
            continue
        count += 1
        # The link selects this run in the viewer; the viewer cannot read a folder on its
        # own (gui-spec §5: no runtime network), so the row keeps the directory link beside
        # it and the column header says to open that folder.
        rebuilt.append(
            f"| {m.group('label')} | [`{path}`]({m.group('href')}) | "
            f"[View]({VIEWER}#?run={rid}) |"
        )

    wanted = "\n".join(rebuilt) + ("\n" if text.endswith("\n") else "")
    # The table gains a third column, so its header and rule must match.
    if OLD_HEADER in wanted:
        wanted = wanted.replace(OLD_HEADER, NEW_HEADER, 1)
    elif NEW_HEADER not in wanted:
        problems.append("the trial table header is neither the two- nor the three-column form")
    if problems:
        for p in problems:
            print(f"FAIL {p}", file=sys.stderr)
        return 1
    if check:
        if wanted != text:
            print("FAIL docs/m1-scorecard.md is not in generated form; run this script", file=sys.stderr)
            return 1
        print(f"scorecard viewer links: {count} row(s), each fragment matches its result.json runId")
        return 0
    card.write_text(wanted, encoding="utf-8")
    print(f"scorecard viewer links: wrote {count} row(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
