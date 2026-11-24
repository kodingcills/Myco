#!/usr/bin/env python3
"""Self-test for scripts/check-scorecard-links.py, in a throwaway tree.

Runs the checker against synthetic scorecards so the two assertions it adds for
TIF-172 are proven to fail when the defect is present:

  1. a row whose viewer fragment names a different run's runId must FAIL;
  2. a row with no viewer link at all must FAIL (the count mismatch);
and the clean case must PASS.

  python3 test/scorecard-links.selftest.py
"""

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
CHECKER = REPO / "scripts" / "check-scorecard-links.py"


def write_trial(root: pathlib.Path, pack: str, n: int, run_id: str) -> str:
    rel = f"docs/research/experiments/m1-runs/{pack}/trial-{n}"
    trial = root / rel
    trial.mkdir(parents=True, exist_ok=True)
    (trial / "result.json").write_text(json.dumps({"runId": run_id}), encoding="utf-8")
    (trial / "trace.jsonl").write_text("", encoding="utf-8")
    return rel


def card(rows: list[tuple[str, str, str | None]]) -> str:
    """rows: (label, run path, viewer runId or None for a missing link)."""
    lines = ["## Trial traces", "", "| Trial | Run directory | Viewer |", "|---|---|---|"]
    for label, path, rid in rows:
        link = f"[View](viewer/dist/myco-viewer.html#?run={rid})" if rid else "—"
        lines.append(f"| {label} | [`{path}`]({path}/) | {link} |")
    return "\n".join(lines) + "\n"


def run_checker(root: pathlib.Path) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(CHECKER)],
        cwd=root,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    root = pathlib.Path(tempfile.mkdtemp(prefix="scorecard-links-"))
    try:
        (root / "docs").mkdir(parents=True)
        a = write_trial(root, "m1-013", 0, "id-aaa")
        b = write_trial(root, "m1-013", 1, "id-bbb")
        card_path = root / "docs" / "m1-scorecard.md"

        # 1. The clean case must pass.
        card_path.write_text(card([("A", a, "id-aaa"), ("B", b, "id-bbb")]), encoding="utf-8")
        code, out = run_checker(root)
        if code != 0:
            print(f"FAIL clean case should pass, got {code}\n{out}", file=sys.stderr)
            return 1
        print("1. clean case passes")

        # 2. A fragment naming another run's id must fail.
        card_path.write_text(card([("A", a, "id-bbb"), ("B", b, "id-bbb")]), encoding="utf-8")
        code, out = run_checker(root)
        if code == 0:
            print(f"FAIL a wrong runId was accepted\n{out}", file=sys.stderr)
            return 1
        if "but its result.json says id-aaa" not in out:
            print(f"FAIL the wrong-runId failure did not name the artifact\n{out}", file=sys.stderr)
            return 1
        print("2. a fragment for the wrong run fails, and names the artifact it disagrees with")

        # 3. A row with no viewer link must fail.
        card_path.write_text(card([("A", a, "id-aaa"), ("B", b, None)]), encoding="utf-8")
        code, out = run_checker(root)
        if code == 0:
            print(f"FAIL a missing viewer link was accepted\n{out}", file=sys.stderr)
            return 1
        if "every row must carry one" not in out:
            print(f"FAIL the missing-link failure did not say why\n{out}", file=sys.stderr)
            return 1
        print("3. a row with no viewer link fails")

        # 4. A run with no runId cannot be linked, and that is reported.
        c = write_trial(root, "m1-013", 2, "unused")
        (root / c / "result.json").write_text("{}", encoding="utf-8")
        card_path.write_text(card([("C", c, "id-xxx")]), encoding="utf-8")
        code, out = run_checker(root)
        if code == 0 or "has no runId in result.json" not in out:
            print(f"FAIL a runId-less run was not reported\n{out}", file=sys.stderr)
            return 1
        print("4. a run whose result.json has no runId is reported, not silently skipped")

        print("scorecard-links selftest OK: 4 cases, both TIF-172 assertions proven")
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
