#!/usr/bin/env python3
"""Decide what CI runs for a change (test audit, TIF-265 follow-up).

The `ci plan (path classes)` job runs this and every required job reads its
outputs. It never removes a required check: required jobs always start and
report under their own names; the plan only decides which of their steps run.

Modes, strongest first:

  full      everything, exactly as before this planner existed
  targeted  typecheck + lint + build, the vitest files related to the change
            (`vitest run --changed <base>`), the core smoke set, schema-validate
  docs      the core smoke set plus the test files that name a changed doc

Fail safe: anything not positively classified as safe to narrow forces `full`.
`full` is forced by

  - any event other than `pull_request` (pushes to main always run everything)
  - the `tier-2` or `full-ci` label
  - a PR title or a body line that states Tier 2 ("Tier: 2", "**Tier 2**", ...)
  - a changed path in a Tier 2 or tooling class (TIER2 / TOOLING below)
  - a changed file of a kind the planner does not know (yaml, json, py, sh,
    fixtures, binaries ...): vitest cannot see fs-read dependencies
  - a doc that src/ or scripts/ names (a script may check it)
  - a diff that could not be computed, or one over MAX_FILES files

Standard library only. `python3 scripts/ci-plan.py --help` for local use.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

MAX_FILES = 300
FULL_LABELS = {"tier-2", "full-ci"}

# Tier 2 per CONTRIBUTING.md "Review tiers": scoring and verdicts, trial cleanup and
# recovery, VM and guest control, locks, spend caps, secrets, schemas, evidence numbers.
# Guard tests are listed too: a change to a guard's test is Tier 2 as well.
TIER2 = (
    "schemas/",
    "src/core/",
    "src/verify/",
    "src/gate/",
    "src/integrity/",
    "src/win/",
    "src/integration/",
    "src/faults/",
    "src/m2/",
    "src/pilot/",
    "src/oracle-selftest/",
    "src/benchmark/grade/",
    "src/foundry/grader/",
    "src/foundry/oracles/",
    "src/foundry/hidden-split/",
    "src/foundry/guard.ts",
    "src/baseline/secret-file.ts",
    "src/baseline/spend-ceiling",
    "src/baseline/run-lock",
    "scripts/spend-ceiling.ts",
    "agent/",
    "runtime/",
    "foundry/",
    "benchmark/",
    "docs/research/",
    "docs/m1-scorecard.md",
    "docs/m2-scorecard.md",
    "test/gate/",
    "test/integrity/",
    "test/oracle-selftest/",
    "test/fault-classes/",
    "test/m2/",
    "test/faults.test.ts",
    "test/vm-lock.test.ts",
    "test/run-live-vm-lock.test.ts",
    "test/scorecard-check.test.ts",
)

# Shared tooling: a change here can change what every test means.
TOOLING = (
    ".github/",
    ".githooks/",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig",
    "vitest.config.ts",
    "biome.json",
    "test/setup/",
    "test/ci-hygiene/",
    "scripts/ci-plan.py",
    "scripts/ci-hygiene",
    "viewer/package.json",
    "viewer/vite",
    "viewer/tsconfig",
)

# Roots whose TypeScript the vitest module graph sees, so `--changed` can follow them.
TS_ROOTS = ("src/", "test/", "scripts/", "viewer/src/", "viewer/test/")
TS_EXT = (".ts", ".tsx", ".mts")

# Always run in targeted and docs mode: fast (about 5 s together) and they cover the
# evidence schema, claim isolation, gate integrity, verifier, recovery, faults and the
# R5 oracle self-test. Kept in sync with docs/ci.md.
SMOKE = (
    "test/claim-isolation.test.ts",
    "test/eval.test.ts",
    "test/evidence.test.ts",
    "test/faults.test.ts",
    "test/no-home-paths.test.ts",
    "test/recovery.test.ts",
    "test/runner.test.ts",
    "test/verify.test.ts",
    "test/baseline/import-graph.test.ts",
    "test/gate/gate.test.ts",
    "test/integrity/isolation.test.ts",
    "test/oracle-selftest/selftest.test.ts",
)

LINUX_PATH = (
    "src/linux/",
    "scripts/linux/",
    "scripts/linux-run.ts",
    "test/linux/",
    "src/setup/",
    "scripts/myco-init.ts",
    "test/init/",
)
M2 = ("src/m2/", "scripts/m2-", "test/m2/", "docs/research/experiments/m2-")

TIER2_STATEMENT = re.compile(r"^[\s>*_#-]*tier[\s*_]*[:=\-]?[\s*_]*2\b", re.IGNORECASE | re.MULTILINE)


@dataclass
class Plan:
    mode: str = "full"
    reasons: list[str] = field(default_factory=list)
    linux_path: bool = True
    m2: bool = True
    doc_tests: list[str] = field(default_factory=list)

    def outputs(self) -> dict[str, str]:
        return {
            "mode": self.mode,
            "reason": "; ".join(self.reasons)[:900],
            "linux_path": str(self.linux_path).lower(),
            "m2": str(self.m2).lower(),
            "doc_tests": " ".join(self.doc_tests),
            "smoke": " ".join(SMOKE),
        }


def starts(path: str, prefixes: tuple[str, ...]) -> bool:
    return any(path.startswith(p) for p in prefixes)


def classify(path: str) -> str:
    """One of: tier2, tooling, docs, ts, viewer, unknown."""
    if starts(path, TIER2):
        return "tier2"
    if starts(path, TOOLING):
        return "tooling"
    if path.endswith(".md"):
        return "docs"
    if starts(path, TS_ROOTS) and path.endswith(TS_EXT):
        return "ts"
    if path.startswith("viewer/") and not path.startswith("viewer/public/"):
        return "viewer"
    return "unknown"


GENERIC_DOC_NAMES = {"README.md", "index.md", "CHANGELOG.md"}


def names_doc(doc: str, text: str) -> bool:
    """True if `text` names `doc`: its full path, or its basename (paths are often built
    with join("docs", "x", "name.md")). A generic basename such as README.md counts only
    when its parent directory's name appears too."""
    if doc in text:
        return True
    base = os.path.basename(doc)
    if base not in text:
        return False
    if base not in GENERIC_DOC_NAMES:
        return True
    parent = os.path.basename(os.path.dirname(doc))
    return bool(parent) and parent in text


def doc_references(doc: str, sources: dict[str, str]) -> tuple[list[str], list[str]]:
    """Test files and non-test files whose text names the doc."""
    tests, others = [], []
    for path, text in sources.items():
        if names_doc(doc, text):
            (tests if path.startswith("test/") else others).append(path)
    return sorted(tests), sorted(others)


def plan(
    event: str,
    files: list[str] | None,
    labels: list[str],
    title: str = "",
    body: str = "",
    sources: dict[str, str] | None = None,
) -> Plan:
    p = Plan()
    if event != "pull_request":
        p.reasons.append(f"event {event or 'unknown'}: full on every non-PR run")
        return p
    hit = sorted(FULL_LABELS & set(labels))
    if hit:
        p.reasons.append(f"label {', '.join(hit)}")
        return p
    if TIER2_STATEMENT.search(title or "") or TIER2_STATEMENT.search(body or ""):
        p.reasons.append("PR title or body states Tier 2")
        return p
    if files is None:
        p.reasons.append("changed files unknown")
        return p
    if not files:
        p.reasons.append("no changed files reported")
        return p
    if len(files) > MAX_FILES:
        p.reasons.append(f"{len(files)} changed files (> {MAX_FILES})")
        return p

    classes = {f: classify(f) for f in files}
    forcing = [f for f, c in classes.items() if c in ("tier2", "tooling", "unknown")]
    if forcing:
        shown = ", ".join(f"{f} ({classes[f]})" for f in forcing[:5])
        more = f" and {len(forcing) - 5} more" if len(forcing) > 5 else ""
        p.reasons.append(f"full-suite path class: {shown}{more}")
        return p

    srcs = sources if sources is not None else {}
    doc_tests: set[str] = set()
    for doc in (f for f, c in classes.items() if c == "docs"):
        tests, others = doc_references(doc, srcs)
        if others:
            p.reasons.append(f"{doc} is named by {others[0]} (a script may check it)")
            return p
        doc_tests.update(tests)

    p.linux_path = any(starts(f, LINUX_PATH) for f in files)
    p.m2 = any(starts(f, M2) for f in files)
    p.doc_tests = sorted(doc_tests)
    if all(c == "docs" for c in classes.values()):
        p.mode = "docs"
        p.reasons.append(f"docs only ({len(files)} file(s)); {len(p.doc_tests)} doc test(s)")
    else:
        p.mode = "targeted"
        counts: dict[str, int] = {}
        for c in classes.values():
            counts[c] = counts.get(c, 0) + 1
        p.reasons.append("targeted: " + ", ".join(f"{n} {c}" for c, n in sorted(counts.items())))
    return p


def read_sources(root: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for top in ("test", "src", "scripts", "schemas"):
        for dirpath, _dirs, names in os.walk(os.path.join(root, top)):
            if "node_modules" in dirpath or "__pycache__" in dirpath:
                continue
            for name in names:
                if not name.endswith((".ts", ".tsx", ".py", ".sh", ".mts", ".js")):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    with open(path, encoding="utf-8") as fh:
                        out[os.path.relpath(path, root)] = fh.read()
                except (OSError, UnicodeDecodeError):
                    continue
    return out


def changed_files(base: str, root: str) -> list[str] | None:
    if not base or not re.fullmatch(r"[0-9a-f]{7,40}", base):
        return None
    try:
        out = subprocess.run(
            ["git", "diff", "--name-only", "--no-renames", base, "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return [line for line in out.splitlines() if line]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default=os.environ.get("EVENT_NAME", ""))
    ap.add_argument("--base", default=os.environ.get("BASE_SHA", ""), help="diff base (PR base SHA)")
    ap.add_argument("--labels", default=os.environ.get("PR_LABELS", "[]"), help="JSON array of label names")
    ap.add_argument("--title", default=os.environ.get("PR_TITLE", ""))
    ap.add_argument("--body", default=os.environ.get("PR_BODY", ""))
    ap.add_argument("--files", nargs="*", help="changed files (skips git diff)")
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = ap.parse_args(argv)

    try:
        labels = [str(x) for x in json.loads(args.labels or "[]")]
    except (json.JSONDecodeError, TypeError):
        labels = []
    files = args.files if args.files is not None else changed_files(args.base, args.root)
    result = plan(args.event, files, labels, args.title, args.body, read_sources(args.root))
    outputs = result.outputs()

    for key, value in outputs.items():
        print(f"{key}={value}")
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as fh:
            for key, value in outputs.items():
                fh.write(f"{key}={value.replace(chr(10), ' ')}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"### CI plan: `{result.mode}`\n\n- {outputs['reason']}\n")
            fh.write(f"- linux path: {outputs['linux_path']}, m2: {outputs['m2']}\n")
            if result.doc_tests:
                fh.write(f"- doc tests: {outputs['doc_tests']}\n")
            if files is not None:
                fh.write(f"- {len(files)} changed file(s)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
