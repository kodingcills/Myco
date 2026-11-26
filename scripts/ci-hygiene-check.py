#!/usr/bin/env python3
"""Fail if any GitHub Actions workflow breaks Myco's public-CI hygiene rules.

  ci-hygiene-check.py [--root DIR]

M2-14 (plan label, Linear pending). The policy is in docs/ci.md ("Security posture")
and docs/security/public-release-safety.md. This script is its enforcement: CI runs it
in the `ci hygiene (workflows)` job. It reads every `.github/workflows/*.yml|*.yaml`
under --root (default: this repo) and every local action under `.github/actions/`
(`action.yml|action.yaml`), and reports each violation as

  VIOLATION <rule> <file>[ job <id>][ step <n>]: <what is wrong>

Rules:
  pull-request-target   no workflow is triggered by `pull_request_target`. It runs with
                        the base repo's secrets and a write token; with PR code checked
                        out that is a takeover. Myco uses `pull_request` only.
  runner                every job's `runs-on` resolves to GitHub-hosted labels only
                        (`ubuntu-*`, `macos-*`, `windows-*`). `self-hosted`, any other
                        label, a runner `group:`, and an expression the script cannot
                        resolve all fail. `${{ matrix.<key> }}` is resolved from the
                        job's literal `strategy.matrix` (values and `include`).
  workflow-run-write    a workflow triggered by `workflow_run` holds no write
                        permission, at the top level or in any job.
  top-level-permissions every workflow sets top-level `permissions` to `{}` or a mapping
                        whose values are all `read` or `none` (no `read-all`,
                        `write-all` or `write`). Without it the token gets the
                        repository default, which may be write.
  job-permissions       no job widens its token to `write`, `write-all` or `read-all`.
  unpinned-action       every `uses:` of a step or a reusable-workflow job is local
                        (`./...`), `docker://...@sha256:<64 hex>`, or
                        `owner/repo[/path]@<40-hex commit SHA>`. A tag or branch can be
                        moved to new code after review.
  pin-comment           a SHA-pinned `uses:` line carries a trailing `# <version>`
                        comment, so a reviewer can see what the SHA is.

Exit 0 with `CI HYGIENE OK: ...` when there is no violation, 1 with
`CI HYGIENE FAILED: <n> violations` otherwise, and 2 when there is nothing to check
(no workflow file) or a file does not parse.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field

import yaml

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HOSTED_LABEL = re.compile(r"^(ubuntu|macos|windows)-[A-Za-z0-9][A-Za-z0-9._-]*$")
MATRIX_EXPR = re.compile(r"^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$")
SHA_PIN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[^@\s]+)?@[0-9a-f]{40}$")
DOCKER_PIN = re.compile(r"^docker://[^@\s]+@sha256:[0-9a-f]{64}$")
USES_LINE = re.compile(r"^\s*(-\s+)?uses:\s*['\"]?([^\s'\"#]+)['\"]?\s*(#.*)?$")
READ_ONLY = {"read", "none"}


@dataclass
class Result:
    violations: list[str] = field(default_factory=list)
    workflows: int = 0
    actions: int = 0
    jobs: int = 0
    uses: int = 0

    def add(self, rule: str, where: str, msg: str) -> None:
        self.violations.append(f"VIOLATION {rule} {where}: {msg}")


def triggers(doc: dict) -> set[str]:
    # PyYAML reads the bare key `on` as the boolean True (YAML 1.1).
    on = doc.get("on", doc.get(True))
    if isinstance(on, str):
        return {on}
    if isinstance(on, list):
        return {str(t) for t in on}
    if isinstance(on, dict):
        return {str(t) for t in on}
    return set()


def has_write(perms: object) -> bool:
    if perms == "write-all":
        return True
    if isinstance(perms, dict):
        return any(v == "write" for v in perms.values())
    return False


def check_top_permissions(doc: dict, where: str, res: Result) -> None:
    if "permissions" not in doc:
        res.add("top-level-permissions", where, "no top-level `permissions`; set `contents: read`")
        return
    perms = doc["permissions"]
    if perms is None or perms == {}:
        return
    if isinstance(perms, dict):
        bad = {k: v for k, v in perms.items() if v not in READ_ONLY}
        if bad:
            res.add("top-level-permissions", where, f"not read-only: {sorted(bad.items())}")
        return
    res.add("top-level-permissions", where, f"`permissions: {perms}` is not least-privilege")


def check_job_permissions(job: dict, where: str, res: Result) -> None:
    if "permissions" not in job:
        return
    perms = job["permissions"]
    if perms in ("write-all", "read-all") or has_write(perms):
        res.add("job-permissions", where, f"job widens the token: `permissions: {perms}`")


def matrix_values(job: dict, key: str) -> list | None:
    matrix = (job.get("strategy") or {}).get("matrix")
    if not isinstance(matrix, dict):
        return None
    values = matrix.get(key)
    if values is not None and not isinstance(values, list):
        return None
    out = list(values or [])
    for entry in matrix.get("include") or []:
        if isinstance(entry, dict) and key in entry:
            out.append(entry[key])
    return out or None


def runner_labels(value: object) -> list[str] | None:
    """Flatten one runs-on value to its labels, or None if it is not a plain label set."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return list(value)
    return None


def check_runner(job: dict, where: str, res: Result) -> None:
    if "uses" in job:  # a reusable-workflow call has no runner of its own
        return
    runs_on = job.get("runs-on")
    if runs_on is None:
        res.add("runner", where, "job has no `runs-on`")
        return
    candidates: list[object] = [runs_on]
    if isinstance(runs_on, str) and "${{" in runs_on:
        m = MATRIX_EXPR.match(runs_on.strip())
        values = matrix_values(job, m.group(1)) if m else None
        if values is None:
            res.add("runner", where, f"cannot resolve `runs-on: {runs_on}` to GitHub-hosted labels")
            return
        candidates = values
    for cand in candidates:
        labels = runner_labels(cand)
        if labels is None:
            res.add("runner", where, f"`runs-on: {cand}` is not a GitHub-hosted label (runner group?)")
            continue
        for label in labels:
            if not HOSTED_LABEL.match(label):
                res.add("runner", where, f"`{label}` is not a GitHub-hosted runner label")


def check_uses(ref: object, where: str, res: Result) -> None:
    res.uses += 1
    if not isinstance(ref, str):
        res.add("unpinned-action", where, f"`uses: {ref}` is not a string")
        return
    if ref.startswith("./"):
        return
    if ref.startswith("docker://"):
        if not DOCKER_PIN.match(ref):
            res.add("unpinned-action", where, f"`{ref}` is not pinned to an image digest")
        return
    if not SHA_PIN.match(ref):
        res.add("unpinned-action", where, f"`{ref}` is not pinned to a full commit SHA")


def check_pin_comments(text: str, rel: str, res: Result) -> None:
    for n, line in enumerate(text.splitlines(), 1):
        m = USES_LINE.match(line)
        if m and re.search(r"@[0-9a-f]{40}$", m.group(2)):
            comment = (m.group(3) or "").lstrip("#").strip()
            if not comment:
                res.add("pin-comment", f"{rel}:{n}", f"`{m.group(2)}` has no `# <version>` comment")


def check_steps(steps: object, where: str, res: Result) -> None:
    for i, step in enumerate(steps or [], 1):
        if isinstance(step, dict) and "uses" in step:
            check_uses(step["uses"], f"{where} step {i}", res)


def load(path: str, rel: str) -> tuple[dict, str]:
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError(f"{rel}: does not parse: {exc}") from exc
    if not isinstance(doc, dict):
        raise ValueError(f"{rel}: not a mapping")
    return doc, text


def check_workflow(path: str, rel: str, res: Result) -> None:
    doc, text = load(path, rel)
    res.workflows += 1
    on = triggers(doc)
    if "pull_request_target" in on:
        res.add("pull-request-target", rel, "triggered by `pull_request_target`; use `pull_request`")
    check_top_permissions(doc, rel, res)
    jobs = doc.get("jobs") or {}
    if "workflow_run" in on:
        holders = [rel] if has_write(doc.get("permissions")) or "permissions" not in doc else []
        holders += [
            f"{rel} job {jid}" for jid, job in jobs.items()
            if isinstance(job, dict) and has_write(job.get("permissions"))
        ]
        for where in holders:
            res.add("workflow-run-write", where, "`workflow_run` workflow may hold a write token")
    for jid, job in jobs.items():
        where = f"{rel} job {jid}"
        res.jobs += 1
        if not isinstance(job, dict):
            res.add("runner", where, "job is not a mapping")
            continue
        check_job_permissions(job, where, res)
        check_runner(job, where, res)
        if "uses" in job:
            check_uses(job["uses"], where, res)
        check_steps(job.get("steps"), where, res)
    check_pin_comments(text, rel, res)


def check_action(path: str, rel: str, res: Result) -> None:
    doc, text = load(path, rel)
    res.actions += 1
    runs = doc.get("runs") or {}
    if isinstance(runs, dict):
        check_steps(runs.get("steps"), rel, res)
        image = runs.get("image")
        if isinstance(image, str) and image.startswith("docker://"):
            check_uses(image, rel, res)
    check_pin_comments(text, rel, res)


def discover(root: str) -> tuple[list[str], list[str]]:
    wf_dir = os.path.join(root, ".github", "workflows")
    workflows = sorted(
        os.path.join(wf_dir, f) for f in (os.listdir(wf_dir) if os.path.isdir(wf_dir) else [])
        if f.endswith((".yml", ".yaml"))
    )
    actions: list[str] = []
    act_dir = os.path.join(root, ".github", "actions")
    for dirpath, _dirs, files in os.walk(act_dir):
        actions += [os.path.join(dirpath, f) for f in files if f in ("action.yml", "action.yaml")]
    return workflows, sorted(actions)


def run(root: str) -> tuple[int, Result, str]:
    res = Result()
    workflows, actions = discover(root)
    if not workflows:
        return 2, res, f"no workflow files under {os.path.join(root, '.github', 'workflows')}"
    try:
        for path in workflows:
            check_workflow(path, os.path.relpath(path, root), res)
        for path in actions:
            check_action(path, os.path.relpath(path, root), res)
    except (ValueError, OSError) as exc:
        return 2, res, str(exc)
    return (1 if res.violations else 0), res, ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=REPO_ROOT, help="repository root (default: this repo)")
    args = ap.parse_args(argv)
    code, res, error = run(args.root)
    if code == 2:
        print(f"CI HYGIENE ERROR: {error}", file=sys.stderr)
        return 2
    for v in res.violations:
        print(v, file=sys.stderr)
    if res.violations:
        print(f"CI HYGIENE FAILED: {len(res.violations)} violations")
        return 1
    print(
        f"CI HYGIENE OK: {res.workflows} workflow files, {res.actions} local actions, "
        f"{res.jobs} jobs, {res.uses} uses references checked"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
