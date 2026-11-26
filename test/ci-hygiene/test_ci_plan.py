"""Tests for scripts/ci-plan.py and the targeted-CI wiring in ci.yml (test audit).

Run: python3 -m unittest discover -s test/ci-hygiene -v

Two halves:
  - the planner's decisions, one per path class, including every fail-safe route to `full`
  - the workflow: the five required check names exist unchanged, required jobs are never
    skipped at the job level, the secret scan is independent of the plan, and every
    required job falls back to the full suite when the plan job did not succeed.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(REPO_ROOT, "scripts", "ci-plan.py")
CI = os.path.join(REPO_ROOT, ".github", "workflows", "ci.yml")

spec = importlib.util.spec_from_file_location("ci_plan", SCRIPT)
assert spec and spec.loader
cp = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cp
spec.loader.exec_module(cp)

# Branch protection on main requires exactly these. Renaming one leaves a required
# check pending forever, so a rename must fail here first.
REQUIRED = {
    "check (macos-latest)",
    "check (ubuntu-latest)",
    "myco-agent tests (ubuntu-latest)",
    "runtime guest agent tests (ubuntu-latest)",
    "secret scan (gitleaks)",
}

SOURCES = {
    "test/baseline/task-text.test.ts": 'readFileSync(join(process.cwd(), "docs/architecture/m1.md"))',
    "scripts/check-scorecard-links.py": "open('docs/eval-runbook.md')",
}


def pr(files, labels=(), title="", body=""):
    return cp.plan("pull_request", list(files), list(labels), title, body, SOURCES)


class Decisions(unittest.TestCase):
    def test_docs_only_runs_smoke_and_doc_tests_only(self):
        p = pr(["docs/product/vision.md", "CHANGELOG.md"])
        self.assertEqual(p.mode, "docs")
        self.assertEqual(p.doc_tests, [])
        self.assertFalse(p.linux_path)
        self.assertFalse(p.m2)

    def test_a_doc_a_test_reads_pulls_that_test_in(self):
        p = pr(["docs/architecture/m1.md"])
        self.assertEqual(p.mode, "docs")
        self.assertEqual(p.doc_tests, ["test/baseline/task-text.test.ts"])

    def test_generic_doc_names_need_their_directory(self):
        # A nested README.md is named only when its directory is named too...
        sources = {"scripts/x.ts": 'join(dir, "README.md")'}
        p = cp.plan("pull_request", ["docs/gate/README.md"], [], "", "", sources)
        self.assertEqual((p.mode, p.doc_tests), ("docs", []))
        sources = {"scripts/x.ts": 'join("docs", "gate", "README.md")'}
        self.assertEqual(cp.plan("pull_request", ["docs/gate/README.md"], [], "", "", sources).mode, "full")
        # ...while the root README.md's full path is its basename, so naming it counts.
        sources = {"scripts/x.ts": 'join(dir, "README.md")'}
        self.assertEqual(cp.plan("pull_request", ["README.md"], [], "", "", sources).mode, "full")

    def test_a_doc_a_script_reads_forces_full(self):
        self.assertEqual(pr(["docs/eval-runbook.md"]).mode, "full")

    def test_src_gate_is_tier2(self):
        p = pr(["src/gate/gate.ts"])
        self.assertEqual(p.mode, "full")
        self.assertIn("tier2", p.reasons[0])

    def test_src_benchmark_is_targeted_but_grading_is_tier2(self):
        self.assertEqual(pr(["src/benchmark/taskset.ts"]).mode, "targeted")
        self.assertEqual(pr(["src/benchmark/grade/sheet.ts"]).mode, "full")

    def test_test_only_change_is_targeted_unless_a_guard_test(self):
        self.assertEqual(pr(["test/benchmark/taskset.test.ts"]).mode, "targeted")
        self.assertEqual(pr(["test/gate/gate.test.ts"]).mode, "full")
        self.assertEqual(pr(["test/integrity/isolation.test.ts"]).mode, "full")

    def test_workflow_and_tooling_changes_force_full(self):
        for f in (
            ".github/workflows/ci.yml",
            "package.json",
            "pnpm-lock.yaml",
            "vitest.config.ts",
            "tsconfig.json",
            "biome.json",
            "test/setup/yield-to-event-loop.ts",
            "scripts/ci-plan.py",
        ):
            self.assertEqual(pr([f]).mode, "full", f)

    def test_tier2_signals_force_full(self):
        self.assertEqual(pr(["src/benchmark/taskset.ts"], labels=["tier-2"]).mode, "full")
        self.assertEqual(pr(["src/benchmark/taskset.ts"], labels=["full-ci"]).mode, "full")
        for body in ("Tier: 2", "**Tier 2**", "## Tier\nTier 2 (locks)", "- tier 2"):
            self.assertEqual(pr(["src/benchmark/taskset.ts"], body=body).mode, "full", body)
        self.assertEqual(pr(["src/benchmark/taskset.ts"], title="Tier 2: x").mode, "full")

    def test_tier1_body_stays_targeted(self):
        body = "Tier 1. A rewrite touching a guard's test would be Tier 2."
        self.assertEqual(pr(["src/benchmark/taskset.ts"], body=body).mode, "targeted")

    def test_tier2_machine_paths(self):
        for f in (
            "schemas/ledger-row.ts",
            "src/core/runner.ts",
            "src/win/agent-client.ts",
            "src/pilot/launch.ts",
            "src/baseline/secret-file.ts",
            "src/baseline/spend-ceiling.ts",
            "agent/myco_agent/server.py",
            "runtime/crates/agent/src/main.rs",
            "foundry/hidden-commitment.json",
            "docs/research/experiments/x/report.json",
            "docs/m1-scorecard.md",
        ):
            self.assertEqual(pr([f]).mode, "full", f)

    def test_unknown_kinds_force_full(self):
        for f in ("tasks/todo-save.yaml", "scripts/vm-lock.sh", "test/fixtures/x.xlsx", "Makefile"):
            self.assertEqual(pr([f]).mode, "full", f)

    def test_non_pr_events_and_unknown_diffs_force_full(self):
        self.assertEqual(cp.plan("push", ["docs/a.md"], [], "", "", SOURCES).mode, "full")
        self.assertEqual(cp.plan("workflow_dispatch", ["docs/a.md"], [], "", "", SOURCES).mode, "full")
        self.assertEqual(cp.plan("pull_request", None, [], "", "", SOURCES).mode, "full")
        self.assertEqual(cp.plan("pull_request", [], [], "", "", SOURCES).mode, "full")
        many = [f"src/benchmark/f{i}.ts" for i in range(cp.MAX_FILES + 1)]
        self.assertEqual(pr(many).mode, "full")

    def test_side_jobs_follow_their_paths(self):
        self.assertTrue(pr(["src/linux/calc.ts"]).linux_path)
        self.assertTrue(pr(["test/init/init.test.ts"]).linux_path)
        self.assertFalse(pr(["src/benchmark/taskset.ts"]).linux_path)
        self.assertTrue(pr(["scripts/m2-r1-dryrun.ts"]).m2)
        self.assertFalse(pr(["scripts/m2-r1-dryrun.ts"]).linux_path)

    def test_bad_base_sha_means_unknown_diff(self):
        self.assertIsNone(cp.changed_files("", REPO_ROOT))
        self.assertIsNone(cp.changed_files("origin/main; rm -rf /", REPO_ROOT))

    def test_smoke_files_exist(self):
        for f in cp.SMOKE:
            self.assertTrue(os.path.isfile(os.path.join(REPO_ROOT, f)), f)


def check_names(jobs):
    names = {}
    for key, job in jobs.items():
        name = job.get("name", key)
        oses = (job.get("strategy") or {}).get("matrix", {}).get("os")
        if oses and "${{ matrix.os }}" in name:
            for os_ in oses:
                names[name.replace("${{ matrix.os }}", os_)] = key
        elif oses:
            for os_ in oses:
                names[f"{name} ({os_})"] = key
        else:
            names[name] = key
    return names


class Workflow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(CI, encoding="utf-8") as fh:
            cls.doc = yaml.safe_load(fh)
        cls.jobs = cls.doc["jobs"]
        cls.names = check_names(cls.jobs)

    def required_jobs(self):
        return {self.names[n] for n in REQUIRED}

    def test_required_check_names_are_unchanged(self):
        missing = REQUIRED - set(self.names)
        self.assertEqual(missing, set())

    def test_required_jobs_never_skip_at_job_level(self):
        for key in self.required_jobs():
            cond = self.jobs[key].get("if")
            self.assertIn(cond, (None, "${{ !cancelled() }}"), key)

    def test_secret_scan_is_independent_of_the_plan(self):
        job = self.jobs[self.names["secret scan (gitleaks)"]]
        self.assertNotIn("needs", job)
        self.assertNotIn("if", job)

    def test_required_plan_consumers_fall_back_to_full(self):
        for key in self.required_jobs():
            job = self.jobs[key]
            if "needs" not in job:
                continue
            first = job["steps"][0] if key == "check" else next(
                s for s in job["steps"] if s.get("name") == "CI plan"
            )
            self.assertEqual(first.get("name"), "CI plan", key)
            self.assertEqual(first["env"]["PLAN_RESULT"], "${{ needs.plan.result }}", key)
            self.assertIn('"$PLAN_RESULT"', first["run"], key)

    def test_full_mode_runs_the_unchanged_full_suite(self):
        steps = {s.get("name"): s for s in self.jobs["check"]["steps"]}
        self.assertEqual(steps["Test"]["run"], "pnpm test")
        self.assertEqual(steps["Test"]["if"], "env.MODE == 'full'")
        for name in ("Typecheck", "Lint", "Build"):
            self.assertEqual(steps[name]["if"], "env.MODE != 'docs'", name)

    def test_label_events_rerun_ci(self):
        on = self.doc.get("on") or self.doc.get(True)
        self.assertEqual(
            set(on["pull_request"]["types"]),
            {"opened", "synchronize", "reopened", "labeled", "unlabeled"},
        )


if __name__ == "__main__":
    unittest.main()
