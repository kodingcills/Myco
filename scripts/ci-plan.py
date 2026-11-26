#!/usr/bin/env python3
"""Decide what CI runs for a change (test audit, TIF-265 follow-up).

The `ci plan (path classes)` job runs this and every required job reads its
outputs. It never removes a required check: required jobs always start and
report under their own names; the plan only decides which of their steps run.

Modes, strongest first:

  full      everything, exactly as before this planner existed
  targeted  typecheck + lint + build, the vitest files related to the change
            (`vitest run --changed <base>`), the core smoke set, every
            directory-scanning test, schema-validate
  docs      the core smoke set, every directory-scanning test, and the test files
            that name a changed doc

Only test-only and docs-only changes are ever narrowed. Every change under src/ or
viewer/src/ runs the full suite (verifier round 2 D7: guard tests that scan a source
directory, such as the hcu+shell import boundary and the hidden-split leak check, never
import the module they guard, so `vitest run --changed` cannot find them). And because a
guard can scan test/ or docs/ too, every directory-scanning test (see scanning_tests)
runs in targeted and docs mode, whatever changed.

Fail safe: anything not positively classified as safe to narrow forces `full`.
`full` is forced by

  - any event other than `pull_request` (pushes to main always run everything)
  - the `tier-2` or `full-ci` label
  - a PR title or a body line that states Tier 2 ("Tier: 2", "**Tier 2**", ...)
  - a changed path in a Tier 2 or tooling class (TIER2 / TOOLING below; all of
    scripts/ and src/benchmark/ are Tier 2)
  - any change under src/ or viewer/src/ (SOURCE)
  - TypeScript outside the NARROWABLE_TS allowlist (test/ and viewer/test/)
  - TypeScript a spawned script can reach: any scripts/**/*.ts imports it
    (transitively), or a file some source names outside an import reaches it, or
    some source names its file name outside an import (a spawn or an fs read that
    vitest's import graph cannot see)
  - a changed file of any other kind (yaml, json, py, sh, html, css, fixtures,
    binaries ...): vitest cannot see fs-read dependencies
  - a doc that a non-test source names (a script may check it)
  - a diff that could not be computed, or one over MAX_FILES files
  - no test sources could be read (the directory-scanning set would be empty)

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

# Tier 2 per CONTRIBUTING.md "Review tiers": scoring and verdicts, the gate and its
# evidence, benchmark grading and R1 evidence rules, trial cleanup and recovery, VM and
# guest control, locks, spend caps, secrets, schemas, evidence numbers. Guard tests are
# listed too: a change to a guard's test is Tier 2 as well. Every prefix here must match
# a tracked file (test_ci_plan.py checks), so a dead entry cannot claim coverage.
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
    "src/benchmark/",
    "src/oracle-selftest/",
    "src/foundry/grader/",
    "src/foundry/oracles/",
    "src/foundry/hidden-split/",
    "src/foundry/guard.ts",
    "src/baseline/secret-file.ts",
    # The run lock and the spend-ceiling enforcement live in sweep.ts.
    "src/baseline/sweep.ts",
    # Every script, whatever its language: tests run scripts as subprocesses (tsx, bash,
    # python), which vitest's import graph cannot follow, so `--changed` misses them.
    "scripts/",
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
    "test/benchmark/",
    "test/baseline/run-lock.test.ts",
    "test/baseline/spend-ceiling.test.ts",
    "test/baseline/secret-file.test.ts",
    # Directory-scanning guards (verifier round 2 D7): grader independence, the hidden
    # split, required instructions, the probe directory, home paths, claim isolation.
    "test/baseline/hcu-shell/import-boundary.test.ts",
    "test/baseline/import-graph.test.ts",
    "test/baseline/instruction-required.test.ts",
    "test/baseline/probe-directory.test.ts",
    "test/foundry/split.test.ts",
    "test/foundry/hidden-split.test.ts",
    "test/no-home-paths.test.ts",
    "test/claim-isolation.test.ts",
    "test/evidence.test.ts",
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
    "viewer/package.json",
    "viewer/vite",
    "viewer/tsconfig",
)

# Product source: every change here runs the full suite (verifier round 2 D7). Guard
# tests read these trees with readdirSync/globSync/ts.createSourceFile instead of
# importing them, so no import graph links a source file to the guard that checks it.
SOURCE = ("src/", "viewer/src/")

# The only TypeScript that may be narrowed with `vitest run --changed`: test files and
# test helpers. Even here, a file a spawned script can reach, or that any source names as
# a file outside an import, forces `full` (see spawn_reach / named_outside_imports).
NARROWABLE_TS = (
    "test/",
    "viewer/test/",
)
TS_EXT = (".ts", ".tsx", ".mts")

# Always run in targeted and docs mode: fast (about 5 s together) and they cover the
# evidence schema, claim isolation, gate integrity, verifier, recovery, faults and the
# R5 oracle self-test. Kept in sync with docs/ci.md (test_ci_plan.py pins both).
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

# `pnpm test` runs this file on its own in a forked pool, so `vitest run --changed`
# excludes it; targeted mode reruns it the same way when one of these paths changes.
LAUNCHER_TEST = "test/discovery/s0-live-launcher.test.ts"
LAUNCHER_PATHS = ("src/discovery/", "test/discovery/")

LINUX_PATH = (
    "src/linux/",
    "scripts/linux/",
    "scripts/linux-run.ts",
    "test/linux/",
    "src/setup/",
    "scripts/myco-init.ts",
    "test/init/",
)
M2 = ("src/m2/", "scripts/m2-", "test/m2/")

TIER2_STATEMENT = re.compile(r"^[\s>*_#-]*tier[\s*_]*[:=\-]?[\s*_]*2\b", re.IGNORECASE | re.MULTILINE)


SELF = "scripts/ci-plan.py"


@dataclass
class Plan:
    mode: str = "full"
    reasons: list[str] = field(default_factory=list)
    linux_path: bool = True
    m2: bool = True
    launcher: bool = True
    doc_tests: list[str] = field(default_factory=list)
    scanners: list[str] = field(default_factory=list)

    def outputs(self) -> dict[str, str]:
        return {
            "mode": self.mode,
            "reason": "; ".join(self.reasons)[:900],
            "linux_path": str(self.linux_path).lower(),
            "m2": str(self.m2).lower(),
            "launcher": str(self.launcher).lower(),
            "doc_tests": " ".join(self.doc_tests),
            "smoke": " ".join(SMOKE),
            "scanners": " ".join(self.scanners),
        }


def starts(path: str, prefixes: tuple[str, ...]) -> bool:
    return any(path.startswith(p) for p in prefixes)


def classify(path: str) -> str:
    """By path alone, one of: tier2, tooling, source, docs, ts, unknown. Only docs and ts
    can be narrowed; plan() still forces full for a ts file a spawned script can reach."""
    if starts(path, TIER2):
        return "tier2"
    if starts(path, TOOLING):
        return "tooling"
    if starts(path, SOURCE):
        return "source"
    if path.endswith(".md"):
        return "docs"
    if starts(path, NARROWABLE_TS) and path.endswith(TS_EXT):
        return "ts"
    return "unknown"


# Module specifiers: static and dynamic imports, re-exports, require(). vitest follows
# these, so a file named only here is safe to narrow; a file named anywhere else is not.
IMPORT_SPEC = re.compile(r"""(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"'\n]+)\2""")


def strip_imports(text: str) -> str:
    return IMPORT_SPEC.sub(lambda m: m.group(1) + m.group(2) + m.group(2), text)


def named_outside_imports(path: str, sources: dict[str, str]) -> str | None:
    """The first source (other than the file itself) that names `path`'s file name outside
    an import: a spawn, an fs read, a copied fixture. vitest cannot see that dependency."""
    base = os.path.basename(path)
    pat = re.compile(r"(?<![\w.-])" + re.escape(base) + r"(?![\w-])")
    for src, text in sorted(sources.items()):
        if src in (path, SELF):
            continue
        if base in text and pat.search(strip_imports(text)):
            return src
    return None


def resolve_import(importer: str, spec: str, files: set[str]) -> str | None:
    if not spec.startswith("."):
        return None
    target = os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    stem, ext = os.path.splitext(target)
    candidates = [target]
    if ext in (".js", ".mjs", ".cjs", ".jsx"):
        candidates += [stem + ".ts", stem + ".mts", stem + ".tsx"]
    candidates += [target + ".ts", target + "/index.ts"]
    for c in candidates:
        if c in files:
            return c
    return None


def spawn_reach(sources: dict[str, str]) -> dict[str, str]:
    """Every source file a subprocess could load, mapped to the entry point that reaches
    it. Entry points: every TypeScript file under scripts/, and every TypeScript file a
    source names outside an import (a test that runs `tsx src/x.ts`). Reached through
    relative imports, transitively."""
    files = set(sources)
    ts_files = sorted(f for f in files if f.endswith(TS_EXT))
    by_base: dict[str, list[str]] = {}
    for f in ts_files:
        by_base.setdefault(os.path.basename(f), []).append(f)
    entries: dict[str, str] = {f: f for f in ts_files if f.startswith("scripts/")}
    names = re.compile(r"(?<![\w.-])([\w.-]+\.(?:ts|mts|tsx))(?![\w-])")
    for src, text in sorted(sources.items()):
        if src == SELF:
            continue
        for name in set(names.findall(strip_imports(text))):
            for f in by_base.get(name, ()):
                if f != src:
                    entries.setdefault(f, f"{f} (named by {src})")
    reach = dict(entries)
    queue = list(entries)
    while queue:
        cur = queue.pop()
        for m in IMPORT_SPEC.finditer(sources.get(cur, "")):
            dep = resolve_import(cur, m.group(3), files)
            if dep and dep not in reach:
                reach[dep] = reach[cur]
                queue.append(dep)
    return reach


# A directory listing or a tree walk, in any language a test can run: node fs, globs, the
# TypeScript compiler's readDirectory, Python's os.walk/listdir/scandir/glob/pathlib, git's
# file listings, and find/rg/grep run as a subprocess.
SCAN_API = re.compile(
    r"\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|readDirectory|listdir|scandir|rglob|iterdir)\b"
    r"|\bos\.walk\b|\bls-files\b|\bls-tree\b|[\"'](?:find|rg|grep)[\"']"
)
TEST_FILE = re.compile(r"\.test\.(?:ts|tsx|mts)$")
SPAWNED_NAME = re.compile(r"(?<![\w.-])([\w.-]+\.(?:ts|mts|tsx|py|sh))(?![\w-])")
SPAWN_ROOTS = ("scripts/", "schemas/")


def scanning_tests(sources: dict[str, str]) -> list[str]:
    """Every test file (test/, viewer/test/) that lists or walks a directory, itself or
    through what it loads: its relative imports, transitively, and any scripts/ or
    schemas/ file it names outside an import (a script it spawns), with that script's own
    imports and spawns. A guard that scans src/, test/ or docs/ never imports what it
    scans, so `vitest run --changed` cannot select it; targeted and docs mode run all of
    these instead. Mechanical on purpose: a new scanning test joins without a list edit."""
    files = set(sources)
    by_base: dict[str, list[str]] = {}
    for f in files:
        if f.startswith(SPAWN_ROOTS):
            by_base.setdefault(os.path.basename(f), []).append(f)
    scans = {f for f, text in sources.items() if f != SELF and SCAN_API.search(text)}
    memo: dict[str, bool] = {}

    def reaches_scan(start: str) -> bool:
        seen, queue = {start}, [start]
        while queue:
            cur = queue.pop()
            if cur in scans or memo.get(cur):
                return True
            text = sources.get(cur, "")
            deps = [resolve_import(cur, m.group(3), files) for m in IMPORT_SPEC.finditer(text)]
            for name in set(SPAWNED_NAME.findall(strip_imports(text))):
                deps += by_base.get(name, [])
            for dep in deps:
                if dep and dep != SELF and dep not in seen:
                    seen.add(dep)
                    queue.append(dep)
        return False

    out = []
    for f in sorted(files):
        if is_test_file(f) and TEST_FILE.search(f):
            memo[f] = reaches_scan(f)
            if memo[f]:
                out.append(f)
    return out


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


def is_test_file(path: str) -> bool:
    return path.startswith(("test/", "viewer/test/")) and path.endswith(TS_EXT)


def doc_references(doc: str, sources: dict[str, str]) -> tuple[list[str], list[str]]:
    """Test files (root vitest can run them) and other files whose text names the doc."""
    tests, others = [], []
    for path, text in sources.items():
        if path == SELF:
            continue
        if names_doc(doc, text):
            (tests if is_test_file(path) else others).append(path)
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
    forcing = [f for f, c in classes.items() if c in ("tier2", "tooling", "source", "unknown")]
    if forcing:
        shown = ", ".join(f"{f} ({classes[f]})" for f in forcing[:5])
        more = f" and {len(forcing) - 5} more" if len(forcing) > 5 else ""
        p.reasons.append(f"full-suite path class: {shown}{more}")
        return p

    srcs = sources if sources is not None else {}
    if not any(is_test_file(f) for f in srcs):
        p.reasons.append("no test sources read (the directory-scanning guard set would be empty)")
        return p
    ts_changed = [f for f, c in classes.items() if c == "ts"]
    if ts_changed:
        reach = spawn_reach(srcs)
        for f in ts_changed:
            if f in reach:
                p.reasons.append(f"{f} is reachable from a spawned script: {reach[f]}")
                return p
            named = named_outside_imports(f, srcs)
            if named:
                p.reasons.append(f"{f} is named outside an import by {named} (spawned or read)")
                return p

    doc_tests: set[str] = set()
    for doc in (f for f, c in classes.items() if c == "docs"):
        tests, others = doc_references(doc, srcs)
        if others:
            p.reasons.append(f"{doc} is named by {others[0]} (a script may check it)")
            return p
        doc_tests.update(tests)

    p.linux_path = any(starts(f, LINUX_PATH) for f in files)
    p.m2 = any(starts(f, M2) for f in files)
    scanners = scanning_tests(srcs)
    p.launcher = any(starts(f, LAUNCHER_PATHS) for f in files) or LAUNCHER_TEST in scanners
    p.scanners = [f for f in scanners if f not in SMOKE and f != LAUNCHER_TEST]
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


SOURCE_ROOTS = ("test", "src", "scripts", "schemas", "viewer/src", "viewer/test", "viewer/e2e", "agent", "runtime")
SOURCE_EXT = (".ts", ".tsx", ".mts", ".py", ".sh", ".js", ".mjs", ".rs")
SKIP_DIRS = {"node_modules", "__pycache__", "target", ".venv", "dist"}


def read_sources(root: str) -> dict[str, str]:
    out: dict[str, str] = {}
    paths = [os.path.join(root, "package.json")]
    for top in SOURCE_ROOTS:
        for dirpath, dirs, names in os.walk(os.path.join(root, top)):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            paths += [os.path.join(dirpath, n) for n in names if n.endswith(SOURCE_EXT)]
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                out[os.path.relpath(path, root).replace(os.sep, "/")] = fh.read()
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
            fh.write(f"- linux path: {outputs['linux_path']}, m2: {outputs['m2']}, launcher: {outputs['launcher']}\n")
            fh.write(f"- directory-scanning tests: {len(result.scanners)}\n")
            if result.doc_tests:
                fh.write(f"- doc tests: {outputs['doc_tests']}\n")
            if files is not None:
                fh.write(f"- {len(files)} changed file(s)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
