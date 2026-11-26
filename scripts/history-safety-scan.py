#!/usr/bin/env python3
"""Whole-history safety scan of a Myco clone: secrets and host paths, counts only.

  history-safety-scan.py --repo PATH [--gitleaks BIN] [--main REF] [--json OUT]

M2-14 (plan label, Linear pending). Run it on a fresh MIRROR clone so every ref is
scanned: branches, tags and GitHub's refs/pull/* (a mirror fetches them all):

  git clone --mirror https://github.com/kodingcills/Myco myco.git
  python3 scripts/history-safety-scan.py --repo myco.git --gitleaks ./gitleaks

What it reports, and what it never prints:

- Secrets. gitleaks `git` mode over `--all` refs, always with `--redact` and
  `--ignore-gitleaks-allow` and the default rules, twice: once over non-merge commits
  (gitleaks' default) and once with `-m` so merge commits are diffed against each parent
  too. Only the rule id, file path, line number and commit SHA of each finding are kept;
  the report file is read from a private temp dir and deleted. No secret value, match or
  line text is ever read into the output.
  A third pass runs gitleaks `dir` over every blob reachable from any ref (one file per
  blob), so content is covered whichever commits the `git` mode chooses to diff, and a
  fourth over the tracked tree at the main ref. For each commit with a finding it counts
  the branches, tags and PR refs that contain it.
- Host paths. Lines ADDED by any non-merge commit on any ref that hold a macOS home path
  (a `Users` directory, an account name, a slash), a `/private/tmp/claude-*` scratch path
  or a `/var/folders/` temp path. Per pattern: commits, commits also on the main ref,
  added lines, the number of distinct account names (never the names) and the files.
  The tree at the main ref is grepped the same way. Matched text is never printed.

Exit status is 0 whatever was found (this is a report, not a gate; the per-PR gate is
CI's `secret scan (gitleaks)` job), 2 on a usage or tool error.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import subprocess
import sys
import tempfile

# Escaped slashes so this file never matches the repo's own home-path test.
HOST_PATTERNS: dict[str, re.Pattern[str]] = {
    "macos-home": re.compile(r"\/Users\/([^/\s'\"`<>]+)\/"),
    "private-tmp-claude": re.compile(r"\/private\/tmp\/claude-"),
    "var-folders": re.compile(r"\/var\/folders\/"),
}

# The only gitleaks report fields this script keeps. Secret, Match, Line and the
# entropy are never read.
GITLEAKS_FIELDS = ("RuleID", "File", "StartLine", "Commit")


def account_class(name: str) -> str:
    """Bucket a matched account name without ever reporting the name itself."""
    if name == "myco":
        return "guest-vm-user"  # the Windows trial VM's own user (a C: drive path)
    if set(name) <= {"."}:
        return "elided"  # already elided to `...` in quoted output
    return "other"  # a real host account name


def git(repo: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", repo, *args], check=True, capture_output=True, text=True, errors="replace"
    ).stdout


def ref_counts(repo: str) -> dict[str, int]:
    counts: collections.Counter[str] = collections.Counter()
    for ref in git(repo, "for-each-ref", "--format=%(refname)").split():
        parts = ref.split("/")
        counts[parts[1] if len(parts) > 2 else ref] += 1
    return dict(sorted(counts.items()))


def on_main(repo: str, main: str) -> set[str]:
    return set(git(repo, "rev-list", main).split())


def run_gitleaks(binary: str, repo: str, log_opts: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="history-scan-") as tmp:
        report = os.path.join(tmp, "report.json")
        proc = subprocess.run(
            [
                binary, "git", "--redact", "--no-banner", "--ignore-gitleaks-allow",
                f"--log-opts={log_opts}", "--report-format", "json", "--report-path", report,
                repo,
            ],
            capture_output=True, text=True, errors="replace",
        )
        # gitleaks exits 1 when it finds leaks; anything else non-zero is a tool error.
        if proc.returncode not in (0, 1) or not os.path.exists(report):
            raise RuntimeError(f"gitleaks failed (exit {proc.returncode})")
        scanned = re.search(r"(\d+) commits scanned", proc.stdout + proc.stderr)
        with open(report, encoding="utf-8") as fh:
            raw = json.load(fh)
        findings = [{k: f[k] for k in GITLEAKS_FIELDS} for f in raw]
        del raw
    return {"commits_scanned": int(scanned.group(1)) if scanned else None, "findings": findings}


def run_gitleaks_blobs(binary: str, repo: str) -> dict:
    """gitleaks `dir` over every blob reachable from any ref, one file per blob.

    A cross-check that does not depend on which commits gitleaks' `git` mode diffs: each
    distinct file version ever reachable is scanned once. Findings map back to every
    path the blob was seen at.
    """
    listing = git(repo, "rev-list", "--all", "--objects", "--filter=object:type=blob")
    paths: dict[str, set[str]] = collections.defaultdict(set)
    for line in listing.splitlines():
        sha, _, path = line.partition(" ")
        if path:
            paths[sha].add(path)
    with tempfile.TemporaryDirectory(prefix="history-scan-") as tmp:
        blob_dir = os.path.join(tmp, "blobs")
        os.makedirs(blob_dir)
        cat = subprocess.run(
            ["git", "-C", repo, "cat-file", "--batch"], input="\n".join(paths).encode() + b"\n",
            capture_output=True, check=True,
        ).stdout
        pos = 0
        for _ in range(len(paths)):
            header_end = cat.index(b"\n", pos)
            sha, _kind, size = cat[pos:header_end].decode().split()
            start = header_end + 1
            with open(os.path.join(blob_dir, sha), "wb") as fh:
                fh.write(cat[start:start + int(size)])
            pos = start + int(size) + 1
        del cat
        report = os.path.join(tmp, "report.json")
        proc = subprocess.run(
            [binary, "dir", "--redact", "--no-banner", "--ignore-gitleaks-allow",
             "--report-format", "json", "--report-path", report, blob_dir],
            capture_output=True, text=True, errors="replace",
        )
        if proc.returncode not in (0, 1) or not os.path.exists(report):
            raise RuntimeError(f"gitleaks dir failed (exit {proc.returncode})")
        with open(report, encoding="utf-8") as fh:
            raw = json.load(fh)
        findings = [
            {"RuleID": f["RuleID"], "Blob": os.path.basename(f["File"]), "StartLine": f["StartLine"]}
            for f in raw
        ]
        del raw
    return {
        "blobs_scanned": len(paths),
        "count": len(findings),
        "by_rule": dict(collections.Counter(f["RuleID"] for f in findings)),
        "by_path": dict(collections.Counter(p for f in findings for p in sorted(paths[f["Blob"]]))),
        "blobs": sorted(
            (f["Blob"], ",".join(sorted(paths[f["Blob"]])), f["StartLine"]) for f in findings
        ),
    }


def containing_refs(repo: str, commit: str) -> dict:
    """How many refs of each kind (heads, tags, pull) contain a commit; names if 3 or fewer."""
    refs = git(repo, "for-each-ref", "--contains", commit, "--format=%(refname)").split()
    counts = collections.Counter(ref.split("/")[1] for ref in refs)
    out: dict = dict(sorted(counts.items()))
    if len(refs) <= 3:
        out["names"] = sorted(refs)
    out["date"] = git(repo, "log", "-1", "--format=%cs", commit).strip()
    return out


def run_gitleaks_tree(binary: str, repo: str, main: str) -> dict:
    """gitleaks `dir` over the tracked tree at the main ref (`git archive`)."""
    with tempfile.TemporaryDirectory(prefix="history-scan-") as tmp:
        tree = os.path.join(tmp, "tree")
        os.makedirs(tree)
        archive = subprocess.run(["git", "-C", repo, "archive", main], capture_output=True, check=True)
        subprocess.run(["tar", "-x", "-C", tree], input=archive.stdout, check=True)
        files = sum(len(fs) for _d, _s, fs in os.walk(tree))
        report = os.path.join(tmp, "report.json")
        proc = subprocess.run(
            [binary, "dir", "--redact", "--no-banner", "--ignore-gitleaks-allow",
             "--report-format", "json", "--report-path", report, tree],
            capture_output=True, text=True, errors="replace",
        )
        if proc.returncode not in (0, 1) or not os.path.exists(report):
            raise RuntimeError(f"gitleaks dir failed (exit {proc.returncode})")
        with open(report, encoding="utf-8") as fh:
            raw = json.load(fh)
        findings = [
            {"RuleID": f["RuleID"], "File": os.path.relpath(f["File"], tree), "StartLine": f["StartLine"]}
            for f in raw
        ]
        del raw
    return {
        "files_scanned": files,
        "count": len(findings),
        "findings": sorted((f["RuleID"], f["File"], f["StartLine"]) for f in findings),
    }


def summarize_findings(findings: list[dict], main_commits: set[str]) -> dict:
    return {
        "count": len(findings),
        "by_rule": dict(collections.Counter(f["RuleID"] for f in findings)),
        "by_path": dict(collections.Counter(f["File"] for f in findings)),
        "commits": sorted(
            {(f["Commit"], f["File"], f["StartLine"], f["Commit"] in main_commits) for f in findings}
        ),
    }


def scan_host_paths(repo: str, main_commits: set[str]) -> dict:
    """Count added lines matching each host-path pattern across all non-merge commits."""
    stats = {
        name: {
            "commits": set(), "added_lines": 0, "accounts": collections.Counter(),
            "files": collections.Counter(),
        }
        for name in HOST_PATTERNS
    }
    proc = subprocess.Popen(
        ["git", "-C", repo, "log", "--all", "--no-merges", "-p", "-U0", "--no-color",
         "--no-ext-diff", "--format=COMMIT %H"],
        stdout=subprocess.PIPE, text=True, errors="replace",
    )
    assert proc.stdout is not None
    commit, path = "", ""
    for line in proc.stdout:
        if line.startswith("COMMIT "):
            commit, path = line[7:].strip(), ""
        elif line.startswith("+++ "):
            target = line[4:].rstrip("\n")
            path = target[2:] if target.startswith("b/") else target
        elif line.startswith("+") and path:
            text = line[1:]
            for name, pattern in HOST_PATTERNS.items():
                hits = pattern.findall(text)
                if not hits:
                    continue
                s = stats[name]
                s["commits"].add(commit)
                s["added_lines"] += 1
                s["files"][path] += 1
                if name == "macos-home":
                    s["accounts"].update(hits)
    if proc.wait() != 0:
        raise RuntimeError("git log failed")
    out = {}
    for name, s in stats.items():
        out[name] = {
            "commits": len(s["commits"]),
            "commits_on_main": len(s["commits"] & main_commits),
            "added_lines": s["added_lines"],
            "files": dict(sorted(s["files"].items())),
        }
        if name == "macos-home":
            out[name]["distinct_account_names"] = len(s["accounts"])
            classes: dict[str, dict[str, int]] = {}
            for acct, n in s["accounts"].items():
                c = classes.setdefault(account_class(acct), {"distinct": 0, "matches": 0})
                c["distinct"] += 1
                c["matches"] += n
            out[name]["account_classes"] = dict(sorted(classes.items()))
    return out


def scan_tree(repo: str, main: str) -> dict:
    out = {}
    for name, pattern in HOST_PATTERNS.items():
        files: collections.Counter[str] = collections.Counter()
        listing = git(repo, "ls-tree", "-r", "-z", "--name-only", main).split("\0")
        for path in filter(None, listing):
            blob = subprocess.run(
                ["git", "-C", repo, "cat-file", "blob", f"{main}:{path}"],
                capture_output=True, check=True,
            ).stdout.decode("latin-1")
            n = sum(1 for line in blob.split("\n") if pattern.search(line))
            if n:
                files[path] = n
        out[name] = {"lines": sum(files.values()), "files": dict(sorted(files.items()))}
    return out


def render(report: dict) -> str:
    lines = ["HISTORY SAFETY SCAN (counts only; no values, matches or account names)"]
    lines.append(f"main ref: {report['main']} at {report['main_sha']}")
    lines.append("refs: " + ", ".join(f"{k} {v}" for k, v in report["refs"].items()))
    c = report["commits"]
    lines.append(f"commits on all refs: {c['all']} ({c['non_merge']} non-merge, {c['merge']} merge)")
    for key, label in (("gitleaks", "non-merge commits"), ("gitleaks_merges", "with -m (merges too)")):
        g = report.get(key)
        if g is None:
            continue
        lines.append(
            f"gitleaks, all refs, {label}: {g['count']} findings in {g['commits_scanned']} commits scanned"
        )
        for rule, n in sorted(g["by_rule"].items()):
            lines.append(f"  rule {rule}: {n}")
        for path, n in sorted(g["by_path"].items()):
            lines.append(f"  path {path}: {n}")
        for sha, path, line, main in g["commits"]:
            lines.append(f"  commit {sha} {path}:{line} on-main={'yes' if main else 'no'}")
    b = report.get("gitleaks_blobs")
    if b is not None:
        lines.append(
            f"gitleaks dir, every blob reachable from any ref: {b['count']} findings in "
            f"{b['blobs_scanned']} blobs scanned"
        )
        for rule, n in sorted(b["by_rule"].items()):
            lines.append(f"  rule {rule}: {n}")
        for path, n in sorted(b["by_path"].items()):
            lines.append(f"  path {path}: {n}")
        for sha, blob_paths, line in b["blobs"]:
            lines.append(f"  blob {sha} {blob_paths}:{line}")
    for sha, refs in report.get("finding_commit_refs", {}).items():
        counts = ", ".join(f"{k} {v}" for k, v in refs.items() if k not in ("names", "date"))
        names = f" ({' '.join(refs['names'])})" if "names" in refs else ""
        lines.append(f"  refs containing {sha} (committed {refs['date']}): {counts}{names}")
    tr = report.get("gitleaks_tree")
    if tr is not None:
        lines.append(f"gitleaks dir, tree at main: {tr['count']} findings in {tr['files_scanned']} files")
        for rule, path, line in tr["findings"]:
            lines.append(f"  rule {rule} {path}:{line}")
    for name, s in report["host_paths_history"].items():
        extra = (
            f", {s['distinct_account_names']} distinct account names"
            if "distinct_account_names" in s else ""
        )
        lines.append(
            f"host path {name}, history: {s['commits']} commits ({s['commits_on_main']} on main), "
            f"{s['added_lines']} added lines, {len(s['files'])} files{extra}"
        )
        for cls, c in s.get("account_classes", {}).items():
            lines.append(f"  account class {cls}: {c['distinct']} distinct, {c['matches']} matches")
        for path, n in s["files"].items():
            lines.append(f"  file {path}: {n}")
    for name, s in report["host_paths_tree"].items():
        lines.append(f"host path {name}, tree at main: {s['lines']} lines in {len(s['files'])} files")
        for path, n in s["files"].items():
            lines.append(f"  file {path}: {n}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True, help="a clone (ideally `git clone --mirror`)")
    ap.add_argument("--gitleaks", help="gitleaks binary; omit to skip the secret scan")
    ap.add_argument("--main", default="refs/heads/main", help="the main ref (default refs/heads/main)")
    ap.add_argument("--json", help="also write the report as JSON to this path")
    args = ap.parse_args(argv)
    try:
        main_sha = git(args.repo, "rev-parse", "--verify", args.main).strip()
        main_commits = on_main(args.repo, args.main)
        report: dict = {
            "main": args.main,
            "main_sha": main_sha,
            "refs": ref_counts(args.repo),
            "commits": {
                "all": len(git(args.repo, "rev-list", "--all").split()),
                "non_merge": len(git(args.repo, "rev-list", "--all", "--no-merges").split()),
                "merge": len(git(args.repo, "rev-list", "--all", "--merges").split()),
            },
        }
        if args.gitleaks:
            for key, opts in (("gitleaks", "--all"), ("gitleaks_merges", "--all -m")):
                res = run_gitleaks(args.gitleaks, args.repo, opts)
                report[key] = {
                    "commits_scanned": res["commits_scanned"],
                    **summarize_findings(res["findings"], main_commits),
                }
            report["gitleaks_blobs"] = run_gitleaks_blobs(args.gitleaks, args.repo)
            report["gitleaks_tree"] = run_gitleaks_tree(args.gitleaks, args.repo, args.main)
            shas = sorted({c[0] for c in report["gitleaks"]["commits"]})
            report["finding_commit_refs"] = {sha: containing_refs(args.repo, sha) for sha in shas}
        report["host_paths_history"] = scan_host_paths(args.repo, main_commits)
        report["host_paths_tree"] = scan_tree(args.repo, args.main)
    except (subprocess.CalledProcessError, RuntimeError, OSError) as exc:
        print(f"history-safety-scan: {exc}", file=sys.stderr)
        return 2
    print(render(report))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, default=list)
    return 0


if __name__ == "__main__":
    sys.exit(main())
