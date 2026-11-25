"""Tests for scripts/ci-hygiene-check.py (M2-14, plan label, Linear pending).

Run: python3 -m unittest discover -s test/ci-hygiene -v

Each test seeds one violation into an otherwise clean workflow and asserts the checker
fails with that rule, so every rule is shown to bite; the clean fixture and this repo's
real workflows must pass.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(REPO_ROOT, "scripts", "ci-hygiene-check.py")

spec = importlib.util.spec_from_file_location("ci_hygiene_check", SCRIPT)
assert spec and spec.loader
chk = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = chk  # dataclasses look their module up here
spec.loader.exec_module(chk)

SHA = "11d5960a326750d5838078e36cf38b85af677262"

CLEAN = f"""\
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  check:
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest]
        include:
          - os: windows-2022
    runs-on: ${{{{ matrix.os }}}}
    steps:
      - uses: actions/checkout@{SHA} # v4.4.0
        with:
          persist-credentials: false
      - uses: ./.github/actions/local
      - run: echo hi
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: docker://alpine@sha256:{"a" * 64}
  call:
    uses: octo/repo/.github/workflows/reuse.yml@{SHA} # v1.0.0
"""


def write_tree(root: str, workflows: dict[str, str], actions: dict[str, str] | None = None) -> None:
    wf = os.path.join(root, ".github", "workflows")
    os.makedirs(wf, exist_ok=True)
    for name, text in workflows.items():
        with open(os.path.join(wf, name), "w", encoding="utf-8") as fh:
            fh.write(textwrap.dedent(text))
    for name, text in (actions or {}).items():
        d = os.path.join(root, ".github", "actions", name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "action.yml"), "w", encoding="utf-8") as fh:
            fh.write(textwrap.dedent(text))


def check(workflow: str, actions: dict[str, str] | None = None):
    with tempfile.TemporaryDirectory() as root:
        write_tree(root, {"ci.yml": workflow}, actions)
        return chk.run(root)


def mutate(old: str, new: str, base: str = CLEAN) -> str:
    assert old in base, old
    return base.replace(old, new, 1)


class CleanInputs(unittest.TestCase):
    def test_clean_fixture_passes(self):
        code, res, err = check(CLEAN)
        self.assertEqual(res.violations, [])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual((res.workflows, res.jobs, res.uses), (1, 3, 4))

    def test_this_repo_passes(self):
        code, res, _ = chk.run(REPO_ROOT)
        self.assertEqual(res.violations, [])
        self.assertEqual(code, 0)
        self.assertGreaterEqual(res.workflows, 1)
        self.assertGreater(res.uses, 0)

    def test_cli_ok_line_and_exit_code(self):
        p = subprocess.run([sys.executable, SCRIPT], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertRegex(p.stdout, r"^CI HYGIENE OK: \d+ workflow files")

    def test_no_workflows_is_an_error_not_a_pass(self):
        with tempfile.TemporaryDirectory() as root:
            code, _, err = chk.run(root)
        self.assertEqual(code, 2)
        self.assertIn("no workflow files", err)

    def test_unparseable_workflow_is_an_error(self):
        code, _, err = check("on: [push\n")
        self.assertEqual(code, 2)
        self.assertIn("does not parse", err)


class Violations(unittest.TestCase):
    def assertRule(self, workflow: str, rule: str, actions: dict[str, str] | None = None):
        code, res, err = check(workflow, actions)
        self.assertEqual(err, "")
        self.assertEqual(code, 1, f"expected a {rule} violation")
        rules = {v.split()[1] for v in res.violations}
        self.assertIn(rule, rules, res.violations)
        return res.violations

    # pull_request_target, in each trigger syntax
    def test_pull_request_target_mapping(self):
        self.assertRule(mutate("  pull_request:\n", "  pull_request_target:\n"), "pull-request-target")

    def test_pull_request_target_list_and_string(self):
        head = "on:\n  push:\n    branches: [main]\n  pull_request:\n"
        self.assertRule(mutate(head, "on: [push, pull_request_target]\n"), "pull-request-target")
        self.assertRule(mutate(head, "on: pull_request_target\n"), "pull-request-target")
        self.assertRule(mutate(head, '"on": pull_request_target\n'), "pull-request-target")

    # runners
    def test_self_hosted_string(self):
        self.assertRule(mutate("runs-on: ubuntu-24.04", "runs-on: self-hosted"), "runner")

    def test_self_hosted_label_list(self):
        self.assertRule(
            mutate("runs-on: ubuntu-24.04", "runs-on: [self-hosted, macOS, ARM64]"), "runner"
        )

    def test_self_hosted_mixed_with_hosted_label(self):
        self.assertRule(mutate("runs-on: ubuntu-24.04", "runs-on: [ubuntu-latest, self-hosted]"), "runner")

    def test_runner_group(self):
        self.assertRule(
            mutate("runs-on: ubuntu-24.04", "runs-on:\n      group: mac-mini\n      labels: [x]"),
            "runner",
        )

    def test_self_hosted_through_matrix(self):
        self.assertRule(mutate("[macos-latest, ubuntu-latest]", "[macos-latest, self-hosted]"), "runner")
        self.assertRule(mutate("- os: windows-2022", "- os: tiffany-mac"), "runner")

    def test_unresolvable_runner_expression(self):
        self.assertRule(
            mutate("runs-on: ubuntu-24.04", "runs-on: ${{ inputs.runner }}"), "runner"
        )
        self.assertRule(
            mutate("os: [macos-latest, ubuntu-latest]", "os: ${{ fromJSON(inputs.oses) }}"), "runner"
        )

    def test_missing_runs_on(self):
        self.assertRule(mutate("    runs-on: ubuntu-24.04\n", ""), "runner")

    # pinning
    def test_unpinned_tag(self):
        self.assertRule(mutate(f"actions/checkout@{SHA} # v4.4.0", "actions/checkout@v4"), "unpinned-action")

    def test_unpinned_branch_and_short_sha(self):
        self.assertRule(mutate(f"actions/checkout@{SHA}", "actions/checkout@main"), "unpinned-action")
        self.assertRule(mutate(f"actions/checkout@{SHA}", f"actions/checkout@{SHA[:7]}"), "unpinned-action")

    def test_unpinned_reusable_workflow(self):
        self.assertRule(mutate(f"reuse.yml@{SHA} # v1.0.0", "reuse.yml@v1"), "unpinned-action")

    def test_docker_tag(self):
        self.assertRule(mutate(f"alpine@sha256:{'a' * 64}", "alpine:3.20"), "unpinned-action")

    def test_unpinned_in_local_composite_action(self):
        action = """\
        name: local
        runs:
          using: composite
          steps:
            - uses: actions/setup-node@v4
        """
        self.assertRule(CLEAN, "unpinned-action", {"local": action})

    def test_pin_without_version_comment(self):
        self.assertRule(mutate(f"actions/checkout@{SHA} # v4.4.0", f"actions/checkout@{SHA}"), "pin-comment")

    # permissions
    def test_missing_top_level_permissions(self):
        self.assertRule(mutate("permissions:\n  contents: read\n", ""), "top-level-permissions")

    def test_write_all_read_all_and_write_scope(self):
        for perms in ("permissions: write-all\n", "permissions: read-all\n",
                      "permissions:\n  contents: write\n"):
            with self.subTest(perms=perms):
                self.assertRule(
                    mutate("permissions:\n  contents: read\n", perms), "top-level-permissions"
                )

    def test_empty_permissions_is_fine(self):
        code, res, _ = check(mutate("permissions:\n  contents: read\n", "permissions: {}\n"))
        self.assertEqual((code, res.violations), (0, []))

    def test_job_widens_token(self):
        self.assertRule(
            mutate("  lint:\n", "  lint:\n    permissions:\n      pull-requests: write\n"),
            "job-permissions",
        )

    # workflow_run
    def test_workflow_run_with_job_write(self):
        wf = mutate("  pull_request:\n", "  workflow_run:\n    workflows: [CI]\n")
        wf = mutate("  lint:\n", "  lint:\n    permissions:\n      contents: write\n", wf)
        self.assertRule(wf, "workflow-run-write")

    def test_workflow_run_with_default_token(self):
        wf = mutate("  pull_request:\n", "  workflow_run:\n    workflows: [CI]\n")
        wf = mutate("permissions:\n  contents: read\n", "", wf)
        self.assertRule(wf, "workflow-run-write")

    def test_workflow_run_read_only_is_allowed(self):
        wf = mutate("  pull_request:\n", "  workflow_run:\n    workflows: [CI]\n")
        code, res, _ = check(wf)
        self.assertEqual((code, res.violations), (0, []))

    def test_cli_reports_violation_lines_and_exit_1(self):
        with tempfile.TemporaryDirectory() as root:
            write_tree(root, {"bad.yml": mutate("  pull_request:\n", "  pull_request_target:\n")})
            p = subprocess.run([sys.executable, SCRIPT, "--root", root], capture_output=True, text=True)
        self.assertEqual(p.returncode, 1)
        self.assertIn("VIOLATION pull-request-target .github/workflows/bad.yml", p.stderr)
        self.assertIn("CI HYGIENE FAILED: 1 violations", p.stdout)


if __name__ == "__main__":
    unittest.main()
