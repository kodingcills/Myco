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
import re
import subprocess
import sys
import tempfile
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

# One directory-scanning guard test: the planner refuses to narrow when it can find none.
GUARD = {"test/guard.test.ts": 'readdirSync(join(ROOT, "src"), { recursive: true })'}

SOURCES = {
    **GUARD,
    "test/baseline/task-text.test.ts": 'readFileSync(join(process.cwd(), "docs/architecture/m1.md"))',
    "scripts/check-scorecard-links.py": "open('docs/eval-runbook.md')",
}


def pr(files, labels=(), title="", body=""):
    return cp.plan("pull_request", list(files), list(labels), title, body, SOURCES)


def with_guard(files, sources):
    return cp.plan("pull_request", list(files), [], "", "", {**GUARD, **sources})


def classify_reason(p):
    """The class named in a full-suite path-class reason, e.g. 'tier2'."""
    m = re.search(r"\((tier2|tooling|source|unknown)\)", " ".join(p.reasons))
    return m.group(1) if m else None


def tracked_files():
    out = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, check=True, capture_output=True, text=True)
    return out.stdout.splitlines()


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
        p = with_guard(["docs/gate/README.md"], sources)
        self.assertEqual((p.mode, p.doc_tests), ("docs", []))
        sources = {"scripts/x.ts": 'join("docs", "gate", "README.md")'}
        self.assertEqual(with_guard(["docs/gate/README.md"], sources).mode, "full")
        # ...while the root README.md's full path is its basename, so naming it counts.
        sources = {"scripts/x.ts": 'join(dir, "README.md")'}
        self.assertEqual(with_guard(["README.md"], sources).mode, "full")

    def test_a_doc_a_script_names_only_by_basename_forces_full(self):
        # Verifier round 2 O7: with the basename branch gone, these dropped to `docs`.
        sources = {"scripts/x.ts": 'join(ROOT, "docs", "architecture", "runtime.md")'}
        p = with_guard(["docs/architecture/runtime.md"], sources)
        self.assertEqual(p.mode, "full")
        self.assertIn("scripts/x.ts", p.reasons[0])
        self.assertTrue(cp.names_doc("docs/architecture/runtime.md", 'join("docs", "architecture", "runtime.md")'))
        self.assertFalse(cp.names_doc("docs/architecture/runtime.md", 'join("docs", "architecture")'))

    def test_a_doc_a_script_reads_forces_full(self):
        self.assertEqual(pr(["docs/eval-runbook.md"]).mode, "full")

    def test_src_gate_is_tier2(self):
        p = pr(["src/gate/gate.ts"])
        self.assertEqual(p.mode, "full")
        self.assertIn("tier2", p.reasons[0])

    def test_all_of_src_benchmark_and_scripts_is_tier2(self):
        # Verifier round 1 D1: R1 evidence rules, gated rows, the gate's stdio entry, the
        # grader CLI, the M2 evidence gate and the run lock were all `targeted`.
        for f in (
            "src/benchmark/taskset-binding.ts",
            "src/benchmark/gated-rows.ts",
            "src/benchmark/grade/sheet.ts",
            "scripts/myco-gate.ts",
            "scripts/benchmark-grade.ts",
            "scripts/m2-evidence-check.ts",
            "scripts/new-script.ts",
            "src/baseline/sweep.ts",
        ):
            p = pr([f])
            self.assertEqual((p.mode, classify_reason(p)), ("full", "tier2"), f)

    def test_test_only_change_is_targeted_unless_a_guard_test(self):
        self.assertEqual(pr(["test/tasks/intent.test.ts"]).mode, "targeted")
        for f in (
            "test/gate/gate.test.ts",
            "test/integrity/isolation.test.ts",
            "test/benchmark/taskset.test.ts",
            "test/evidence.test.ts",
            "test/baseline/run-lock.test.ts",
            "test/baseline/spend-ceiling.test.ts",
            "test/baseline/secret-file.test.ts",
        ):
            self.assertEqual(pr([f]).mode, "full", f)

    def test_typescript_outside_the_allowlist_forces_full(self):
        # TypeScript outside test/ and viewer/test/ is never narrowed.
        for f in ("examples/x.ts", "x.ts", "viewer/e2e/viewer.pw.ts"):
            self.assertEqual((pr([f]).mode, cp.classify(f)), ("full", "unknown"), f)
        self.assertEqual(pr(["test/tasks/intent.test.ts"]).mode, "targeted")
        self.assertEqual(pr(["viewer/test/x.test.ts"]).mode, "targeted")

    def test_every_source_change_forces_full(self):
        # Verifier round 2 D7: guard tests scan src/ instead of importing it, so no
        # src/ or viewer/src/ change is narrowed, a new subtree or file included.
        for f in (
            "src/tasks/intent.ts",
            "src/baseline/hcu-shell/ledger.ts",
            "src/baseline/hcu-shell/zz-new.ts",
            "src/foundry/baseline/compare.ts",
            "src/newarea/x.ts",
            "src/x.ts",
            "src/x.json",
            "viewer/src/main.ts",
            "viewer/src/zz-new.tsx",
        ):
            p = pr([f])
            self.assertEqual((p.mode, classify_reason(p)), ("full", "source"), f)

    def test_viewer_non_typescript_forces_full(self):
        # vitest cannot see an html or css dependency.
        for f in ("viewer/index.html", "viewer/src/styles.css", "viewer/fixtures/head-to-head.json"):
            self.assertEqual(pr([f]).mode, "full", f)

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
        t = "test/tasks/intent.test.ts"
        self.assertEqual(pr([t]).mode, "targeted")
        self.assertEqual(pr([t], labels=["tier-2"]).mode, "full")
        self.assertEqual(pr([t], labels=["full-ci"]).mode, "full")
        for body in ("Tier: 2", "**Tier 2**", "## Tier\nTier 2 (locks)", "- tier 2"):
            self.assertEqual(pr([t], body=body).mode, "full", body)
        self.assertEqual(pr([t], title="Tier 2: x").mode, "full")

    def test_tier1_body_stays_targeted(self):
        body = "Tier 1. A rewrite touching a guard's test would be Tier 2."
        self.assertEqual(pr(["test/tasks/intent.test.ts"], body=body).mode, "targeted")

    def test_tier2_machine_paths(self):
        for f in (
            "schemas/ledger-row.ts",
            "src/core/runner.ts",
            "src/win/agent-client.ts",
            "src/baseline/secret-file.ts",
            "src/baseline/sweep.ts",
            "scripts/spend-ceiling.ts",
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
        many = [f"test/tasks/f{i}.test.ts" for i in range(cp.MAX_FILES + 1)]
        self.assertEqual(pr(many).mode, "full")
        self.assertEqual(pr(many[: cp.MAX_FILES]).mode, "targeted")

    def test_side_jobs_follow_their_paths(self):
        self.assertTrue(pr(["src/linux/calc.ts"]).linux_path)
        self.assertTrue(pr(["test/init/init.test.ts"]).linux_path)
        self.assertTrue(pr(["test/linux/x.test.ts"]).linux_path)
        self.assertFalse(pr(["test/tasks/intent.test.ts"]).linux_path)
        self.assertFalse(pr(["test/tasks/intent.test.ts"]).m2)
        # Full mode keeps every side job on (the job-level ifs read the mode too).
        self.assertTrue(pr(["scripts/m2-r1-dryrun.ts"]).m2)
        self.assertTrue(pr(["scripts/m2-r1-dryrun.ts"]).linux_path)
        # D6: the forked launcher test reruns in targeted mode when discovery changes.
        self.assertTrue(pr(["test/discovery/s0-live-launcher.test.ts"]).launcher)
        self.assertTrue(pr(["test/discovery/replay.test.ts"]).launcher)
        self.assertFalse(pr(["test/tasks/intent.test.ts"]).launcher)
        self.assertEqual(pr(["test/discovery/replay.test.ts"]).outputs()["launcher"], "true")
        self.assertEqual(pr(["test/tasks/intent.test.ts"]).outputs()["launcher"], "false")
        # src/discovery/ is source: full, which runs the launcher with `pnpm test`.
        self.assertEqual(pr(["src/discovery/decision.ts"]).mode, "full")
        # The launcher lists its run directory, so when it is a scanning test it always runs.
        sources = {cp.LAUNCHER_TEST: "readdirSync(runDir)"}
        p = with_guard(["test/tasks/intent.test.ts"], sources)
        self.assertEqual((p.mode, p.launcher), ("targeted", True))
        self.assertNotIn(cp.LAUNCHER_TEST, p.scanners)

    def test_bad_base_sha_means_unknown_diff(self):
        self.assertIsNone(cp.changed_files("", REPO_ROOT))
        self.assertIsNone(cp.changed_files("origin/main; rm -rf /", REPO_ROOT))

    def test_smoke_files_exist(self):
        for f in cp.SMOKE:
            self.assertTrue(os.path.isfile(os.path.join(REPO_ROOT, f)), f)

    def test_smoke_set_is_pinned_and_documented(self):
        # Verifier round 2 O9: dropping test/gate/gate.test.ts from SMOKE survived.
        self.assertEqual(cp.SMOKE, SMOKE_PINNED)
        with open(os.path.join(REPO_ROOT, "docs", "ci.md"), encoding="utf-8") as fh:
            text = fh.read()
        section = text.split("**Core smoke set**", 1)[1].split("\n\n", 1)[0]
        self.assertEqual(tuple(re.findall(r"`(test/[^`]+)`", section)), SMOKE_PINNED)
        p = pr(["test/tasks/intent.test.ts"])
        self.assertEqual(p.outputs()["smoke"], " ".join(SMOKE_PINNED))


SMOKE_PINNED = (
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
    "test/leak-guard/leak-guard.test.ts",
    "test/leak-guard/detect.property.test.ts",
    "test/leak-guard/routing.test.ts",
)


# Every file under these roots must force the full suite (the brief: gate, integrity,
# evidence, benchmark, m2, schemas, scripts and .github always run everything).
ALWAYS_FULL_ROOTS = (
    "src/gate/",
    "src/integrity/",
    "src/benchmark/",
    "src/m2/",
    "src/core/",
    "schemas/",
    "scripts/",
    ".github/",
    "agent/",
    "runtime/",
    "test/gate/",
    "test/integrity/",
    "test/benchmark/",
    "test/m2/",
)


class PathClassesAgainstTheRepo(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = tracked_files()

    def test_every_file_under_a_tier2_root_forces_full(self):
        bad = []
        for f in self.files:
            if f.startswith(ALWAYS_FULL_ROOTS) and cp.classify(f) not in ("tier2", "tooling"):
                bad.append(f)
        self.assertEqual(bad, [])
        # Probe a path that does not exist yet in each root, too.
        for root in ALWAYS_FULL_ROOTS:
            self.assertIn(cp.classify(root + "zz-new-file.ts"), ("tier2", "tooling"), root)

    def test_no_dead_prefixes(self):
        # Verifier round 1 D5: a prefix that matches no tracked file claims coverage it
        # does not give (src/pilot/, src/baseline/run-lock, ...).
        for name in ("TIER2", "TOOLING", "SOURCE", "NARROWABLE_TS", "LINUX_PATH", "M2", "LAUNCHER_PATHS", "SMOKE"):
            for prefix in getattr(cp, name):
                self.assertTrue(any(f.startswith(prefix) for f in self.files), f"{name}: {prefix}")
        self.assertIn(cp.LAUNCHER_TEST, self.files)

    def test_run_lock_and_spend_ceiling_modules_are_tier2(self):
        # The run lock lives in src/baseline/sweep.ts; the guard tests import it.
        seen = set()
        for test in ("test/baseline/run-lock.test.ts", "test/baseline/spend-ceiling.test.ts"):
            with open(os.path.join(REPO_ROOT, test), encoding="utf-8") as fh:
                text = fh.read()
            # Value imports only: `import type` pulls in no lock or ceiling code.
            for spec in re.findall(r"""^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']""", text, re.M | re.S):
                if spec.startswith("."):
                    target = os.path.normpath(os.path.join(os.path.dirname(test), spec))
                    if target.startswith(("src/", "scripts/")):
                        seen.add(target)
                        self.assertEqual(cp.classify(target), "tier2", f"{test} imports {target}")
            self.assertEqual(cp.classify(test), "tier2")
        self.assertEqual(seen, {"src/baseline/sweep.ts", "scripts/spend-ceiling.ts"})


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


class ChangedFiles(unittest.TestCase):
    def test_a_move_out_of_a_tier2_path_lists_the_old_path(self):
        # Verifier round 1 M6: without --no-renames, a move out of src/gate/ would list
        # only the new (narrowable) path.
        with tempfile.TemporaryDirectory() as d:
            git(d, "init", "-q")
            git(d, "config", "user.email", "t@example.invalid")
            git(d, "config", "user.name", "t")
            os.makedirs(os.path.join(d, "src", "gate"))
            os.makedirs(os.path.join(d, "src", "tasks"))
            with open(os.path.join(d, "src", "gate", "cli.ts"), "w") as fh:
                fh.write("export const verdict = 'refuted';\n" * 20)
            git(d, "add", "-A")
            git(d, "commit", "-qm", "base")
            base = git(d, "rev-parse", "HEAD").strip()
            git(d, "mv", "src/gate/cli.ts", "src/tasks/cli.ts")
            git(d, "commit", "-qm", "move")
            files = cp.changed_files(base, d)
            self.assertIn("src/gate/cli.ts", files)
            self.assertIn("src/tasks/cli.ts", files)
            self.assertEqual(cp.plan("pull_request", files, [], "", "", {}).mode, "full")


class SpawnedDependencies(unittest.TestCase):
    """Verifier round 1 D2: a test that runs a script as a subprocess is invisible to
    vitest's import graph, so a change it alone covers must force the full suite."""

    # src/ is always full now, so the narrowable files these rules guard are test helpers.
    SOURCES = {
        **GUARD,
        "scripts/run-thing.ts": 'import { go } from "../test/tasks/runner.ts";\ngo();\n',
        "test/tasks/runner.ts": 'import { helper } from "./helper.ts";\nexport const go = helper;\n',
        "test/tasks/helper.ts": "export const helper = () => 1;\n",
        "test/tasks/spawned.ts": "console.log(1);\n",
        "test/tasks/plain.ts": "export const plain = 1;\n",
        "test/tasks/spawn.test.ts": 'spawnSync("tsx", [join(ROOT, "test", "tasks", "spawned.ts")]);\n',
        "test/tasks/plain.test.ts": 'import { plain } from "./plain.ts";\n',
    }

    def plan(self, files):
        return cp.plan("pull_request", files, [], "", "", self.SOURCES)

    def test_a_module_a_script_imports_transitively_forces_full(self):
        for f in ("test/tasks/runner.ts", "test/tasks/helper.ts"):
            p = self.plan([f])
            self.assertEqual(p.mode, "full", f)
            self.assertIn("spawned script", p.reasons[0])
            self.assertIn("scripts/run-thing.ts", p.reasons[0])

    def test_a_file_a_test_names_outside_an_import_forces_full(self):
        p = self.plan(["test/tasks/spawned.ts"])
        self.assertEqual(p.mode, "full")
        self.assertIn("test/tasks/spawn.test.ts", p.reasons[0])

    def test_a_deleted_file_a_test_still_names_forces_full(self):
        sources = {k: v for k, v in self.SOURCES.items() if k != "test/tasks/spawned.ts"}
        self.assertEqual(cp.plan("pull_request", ["test/tasks/spawned.ts"], [], "", "", sources).mode, "full")

    def test_a_module_only_imported_stays_targeted(self):
        self.assertEqual(self.plan(["test/tasks/plain.ts"]).mode, "targeted")
        self.assertEqual(self.plan(["test/tasks/plain.test.ts"]).mode, "targeted")

    def test_import_specifiers_resolve_like_node(self):
        files = {"src/a/b.ts", "src/a/index.ts", "src/c.ts"}
        self.assertEqual(cp.resolve_import("src/x/y.ts", "../a/b.js", files), "src/a/b.ts")
        self.assertEqual(cp.resolve_import("src/x/y.ts", "../a/b.ts", files), "src/a/b.ts")
        self.assertEqual(cp.resolve_import("src/x/y.ts", "../a", files), "src/a/index.ts")
        self.assertEqual(cp.resolve_import("src/x/y.ts", "../c", files), "src/c.ts")
        self.assertIsNone(cp.resolve_import("src/x/y.ts", "node:fs", files))

    def test_the_real_gate_cli_false_verified_mutation_is_full(self):
        # The verifier's proof: a false VERIFIED in scripts/myco-gate.ts was `targeted`,
        # and `vitest run --changed` found no tests.
        srcs = cp.read_sources(REPO_ROOT)
        self.assertEqual(cp.plan("pull_request", ["scripts/myco-gate.ts"], [], "", "", srcs).mode, "full")

    def test_every_src_module_a_real_script_imports_is_reached(self):
        srcs = cp.read_sources(REPO_ROOT)
        reach = cp.spawn_reach(srcs)
        direct = set()
        for path, text in srcs.items():
            if path.startswith("scripts/") and path.endswith(".ts"):
                for m in cp.IMPORT_SPEC.finditer(text):
                    dep = cp.resolve_import(path, m.group(3), set(srcs))
                    if dep:
                        direct.add(dep)
        self.assertTrue(any(d.startswith("src/") for d in direct))
        self.assertEqual(sorted(direct - set(reach)), [])
        for dep in sorted(direct):
            self.assertEqual(cp.plan("pull_request", [dep], [], "", "", srcs).mode, "full", dep)


# Directory-scanning guards that must run on every PR, whatever it changes. Each reads a
# tree (src/, test/, docs/, the git index) instead of importing what it checks.
REPO_GUARDS = (
    "test/baseline/hcu-shell/import-boundary.test.ts",  # hcu+shell arm never reaches grader code
    "test/foundry/split.test.ts",  # EF-002: nothing outside the hidden roots imports them
    "test/foundry/hidden-split.test.ts",
    "test/baseline/instruction-required.test.ts",
    "test/baseline/probe-directory.test.ts",
    "test/benchmark/independence.test.ts",  # grader independence
    "test/no-home-paths.test.ts",
    "test/leak-guard/leak-guard.test.ts",  # TIF-98 shared leak guard (tracked files, writers)
    "test/claim-isolation.test.ts",
    "test/baseline/secret-file.test.ts",
    "test/sai/harness.test.ts",
)

# The verifier's own detector, written independently of scripts/ci-plan.py SCAN_API.
DIRECT_SCAN = re.compile(r"readdirSync|readdir\(|globSync|opendirSync|ls-files|os\.walk|os\.listdir")


class DirectoryScanningGuards(unittest.TestCase):
    """Verifier round 2 D7: a grader-independence violation passed targeted CI, because the
    guard scans a directory and never imports the module it guards."""

    @classmethod
    def setUpClass(cls):
        cls.srcs = cp.read_sources(REPO_ROOT)
        cls.files = tracked_files()
        cls.scanners = set(cp.scanning_tests(cls.srcs))
        # Probe paths built at run time, so no source names them (naming one forces full).
        tag = "zz" + "probe" + str(os.getpid())
        cls.new_test = f"test/tasks/{tag}.test.ts"
        cls.new_doc = f"docs/{tag}.md"

    def real(self, files):
        return cp.plan("pull_request", files, [], "", "", self.srcs)

    def test_the_three_d7_probes_run_the_full_suite(self):
        # 1. ledger.ts imports knownTaskSet (TIF-267 grader code); 2. a new hcu-shell file
        # imports src/tasks/intent.ts; 3. compare.ts re-exports the blind oracle.
        for files in (
            ["src/baseline/hcu-shell/ledger.ts"],
            ["src/baseline/hcu-shell/peek.ts"],
            ["src/foundry/baseline/compare.ts"],
            ["src/baseline/hcu-shell/ledger.ts", "docs/product/vision.md"],
        ):
            p = self.real(files)
            self.assertEqual(p.mode, "full", files)
            self.assertIn("(source)", p.reasons[0], files)

    def test_every_tracked_source_file_runs_the_full_suite(self):
        bad = [f for f in self.files if f.startswith(("src/", "viewer/src/")) and cp.classify(f) not in ("tier2", "source")]
        self.assertEqual(bad, [])

    def test_repo_guards_are_found_and_their_changes_are_tier2(self):
        for g in REPO_GUARDS:
            self.assertIn(g, self.files, g)
            self.assertTrue(g in self.scanners or g in cp.SMOKE, g)
        for g in REPO_GUARDS[:8]:
            self.assertEqual(cp.classify(g), "tier2", g)

    def test_every_test_that_lists_a_directory_is_a_scanner(self):
        # Kills a narrowed SCAN_API: every test file that directly lists a directory, by
        # an independent detector, must be selected.
        direct = [
            f
            for f, text in self.srcs.items()
            if cp.is_test_file(f) and cp.TEST_FILE.search(f) and DIRECT_SCAN.search(text)
        ]
        self.assertGreater(len(direct), 15)
        self.assertEqual(sorted(set(direct) - self.scanners), [])

    def test_a_test_only_change_runs_every_scanning_guard(self):
        p = self.real([self.new_test])
        self.assertEqual(p.mode, "targeted", p.reasons)
        ran = set(cp.SMOKE) | set(p.scanners) | ({cp.LAUNCHER_TEST} if p.launcher else set())
        self.assertEqual(sorted(self.scanners - ran), [])
        for g in REPO_GUARDS:
            self.assertIn(g, ran, g)
        self.assertEqual(p.outputs()["scanners"], " ".join(p.scanners))

    def test_a_docs_only_change_runs_every_scanning_guard(self):
        p = self.real([self.new_doc])
        self.assertEqual(p.mode, "docs", p.reasons)
        ran = set(cp.SMOKE) | set(p.scanners)
        for g in REPO_GUARDS:
            self.assertIn(g, ran, g)

    def test_scanners_are_found_through_imports_and_spawned_scripts(self):
        sources = {
            "test/a.test.ts": 'import { list } from "./helpers/list.ts";\n',
            "test/helpers/list.ts": 'export const list = (d) => fs.readdirSync(d);\n',
            "test/b.test.ts": 'spawnSync("python3", [join(ROOT, "scripts", "scan-docs.py")]);\n',
            "scripts/scan-docs.py": "for root, _, names in os.walk('docs'): pass\n",
            "test/c.test.ts": 'execFileSync("git", ["ls-files", "-z"]);\n',
            "test/d.test.ts": 'import { x } from "../src/x.ts";\n',
            "src/x.ts": 'export const x = globSync("**/*.ts");\n',
            "test/e.test.ts": 'import { plain } from "./plain.ts";\n',
            "test/plain.ts": "export const plain = 1;\n",
            "viewer/test/f.test.ts": 'await readdir(folder, { withFileTypes: true });\n',
            "test/helpers/list.test.helper.ts": "readdirSync(x)\n",
        }
        self.assertEqual(
            cp.scanning_tests(sources),
            ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "viewer/test/f.test.ts"],
        )
        p = cp.plan("pull_request", ["test/e.test.ts"], [], "", "", sources)
        self.assertEqual(p.mode, "targeted")
        self.assertEqual(p.scanners, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "viewer/test/f.test.ts"])
        p = cp.plan("pull_request", ["docs/zz.md"], [], "", "", sources)
        self.assertEqual((p.mode, len(p.scanners)), ("docs", 5))

    def test_docs_a_source_names_only_by_basename_run_the_full_suite(self):
        # Verifier round 2 O7, against the real repo.
        for doc in (
            "docs/architecture/m2-fault-classes.md",
            "docs/architecture/runtime.md",
            "docs/env/vm-toolchain/README.md",
            "viewer/DEVIATIONS.md",
        ):
            self.assertIn(doc, self.files, doc)
            self.assertEqual(self.real([doc]).mode, "full", doc)

    def test_no_readable_test_sources_runs_the_full_suite(self):
        for sources in ({}, None, {"scripts/x.ts": "x"}):
            p = cp.plan("pull_request", ["docs/zz.md"], [], "", "", sources)
            self.assertEqual(p.mode, "full", sources)
            self.assertIn("no test sources", p.reasons[0])


class Sources(unittest.TestCase):
    def test_read_sources_covers_viewer_agent_and_runtime(self):
        srcs = cp.read_sources(REPO_ROOT)
        for prefix in ("viewer/test/", "viewer/src/", "agent/", "runtime/", "scripts/", "src/", "test/"):
            self.assertTrue(any(k.startswith(prefix) for k in srcs), prefix)
        self.assertIn("package.json", srcs)
        self.assertFalse(any("node_modules" in k for k in srcs))

    def test_a_viewer_test_that_reads_a_doc_is_a_doc_test(self):
        sources = {"viewer/test/loaders.test.ts": 'readFileSync("docs/viewer/guide.md")'}
        p = cp.plan("pull_request", ["docs/viewer/guide.md"], [], "", "", sources)
        self.assertEqual((p.mode, p.doc_tests), ("docs", ["viewer/test/loaders.test.ts"]))

    def test_the_planner_naming_a_doc_does_not_force_full(self):
        # Round 1 nit: the planner's own docstring made README.md "named by a script".
        sources = {cp.SELF: "README.md CONTRIBUTING.md docs/x/guide.md"}
        self.assertEqual(with_guard(["docs/x/guide.md"], sources).mode, "docs")
        sources["scripts/other.py"] = "docs/x/guide.md"
        self.assertEqual(with_guard(["docs/x/guide.md"], sources).mode, "full")


# A small evaluator for the GitHub expression subset ci.yml uses in `if:` (contexts,
# string literals, == != ! && || and parentheses, cancelled()). Anything else raises, so
# a condition the tests cannot evaluate fails loudly instead of passing unchecked.
EXPR_TOKEN = re.compile(r"\s*(\$\{\{|\}\}|==|!=|&&|\|\||!|\(|\)|'[^']*'|[A-Za-z_][\w.\-]*(?:\(\))?)")


def gh_eval(expr, ctx):
    toks, pos = [], 0
    expr = expr.strip()
    while pos < len(expr):
        m = EXPR_TOKEN.match(expr, pos)
        if not m:
            raise ValueError(f"cannot tokenize {expr[pos:]!r}")
        toks.append(m.group(1))
        pos = m.end()
        while pos < len(expr) and expr[pos].isspace():
            pos += 1
    toks = [t for t in toks if t not in ("${{", "}}")]
    i = 0

    def peek():
        return toks[i] if i < len(toks) else None

    def take():
        nonlocal i
        i += 1
        return toks[i - 1]

    def truthy(v):
        return v not in ("", None, False)

    def primary():
        t = take()
        if t == "(":
            v = orexpr()
            if take() != ")":
                raise ValueError("expected )")
            return v
        if t == "!":
            return not truthy(primary())
        if t.startswith("'"):
            return t[1:-1]
        if t == "cancelled()":
            return ctx.get("cancelled", False)
        if t.endswith("()"):
            raise ValueError(f"unsupported function {t}")
        if t in ctx:
            return ctx[t]
        if t.startswith(("env.", "needs.", "github.", "matrix.")):
            return ""
        raise ValueError(f"unknown token {t}")

    def cmp():
        left = primary()
        while peek() in ("==", "!="):
            op, right = take(), primary()
            eq = str(left).lower() == str(right).lower()
            left = eq if op == "==" else not eq
        return left

    def andexpr():
        left = cmp()
        while peek() == "&&":
            take()
            right = cmp()
            left = right if truthy(left) else left
        return left

    def orexpr():
        left = andexpr()
        while peek() == "||":
            take()
            right = andexpr()
            left = left if truthy(left) else right
        return left

    v = orexpr()
    if i != len(toks):
        raise ValueError(f"trailing tokens in {expr!r}")
    return truthy(v)


def run_step(step, env, cwd=None):
    """Run a step's shell (bash -e, GitHub's default) with stub env; return GITHUB_ENV."""
    with tempfile.TemporaryDirectory() as d:
        gh_env = os.path.join(d, "github_env")
        open(gh_env, "w").close()
        full_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "GITHUB_ENV": gh_env, **env}
        subprocess.run(["bash", "-e", "-c", step["run"]], env=full_env, cwd=cwd or d, check=True, capture_output=True)
        with open(gh_env, encoding="utf-8") as fh:
            return dict(line.split("=", 1) for line in fh.read().splitlines() if line)


PLAN_RESULTS = ("success", "failure", "skipped", "cancelled", "")
PLAN_MODES = ("full", "targeted", "docs", "", "garbage", "Full", "targeted ", "docs\ntargeted")


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


LAUNCHER_STEP = "Test (s0 launcher, forked)"
SMOKE_STEP = "Test (core smoke, directory-scanning tests and doc tests)"


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

    def plan_step(self, key):
        return next(s for s in self.jobs[key]["steps"] if s.get("name") == "CI plan")

    def check_env(self, result, mode, launcher="true", scanners="test/guard.test.ts"):
        step = self.plan_step("check")
        env = {"PLAN_RESULT": result, "PLAN_MODE": mode, "PLAN_LAUNCHER": launcher, "PLAN_SCANNERS": scanners}
        return run_step(step, env)

    def steps_that_run(self, key, env):
        ran = []
        for step in self.jobs[key]["steps"]:
            cond = step.get("if")
            ctx = {f"env.{k}": v for k, v in env.items()}
            if cond is None or gh_eval(cond, ctx):
                ran.append(step.get("name") or step.get("uses", "").split("@")[0])
        return ran

    def test_check_falls_back_to_full_unless_the_plan_succeeded_with_a_known_mode(self):
        # Verifier round 1 M10 (fallback mode=docs) and D3: execute the step, do not grep it.
        for result in PLAN_RESULTS:
            for mode in PLAN_MODES:
                env = self.check_env(result, mode)
                ok = result == "success" and mode in ("full", "targeted", "docs")
                self.assertEqual(env["MODE"], mode if ok else "full", (result, mode))

    def test_check_runs_full_when_a_narrow_plan_lists_no_scanning_tests(self):
        # D7 fail safe: a narrow mode that cannot run the directory-scanning guards does
        # not narrow.
        self.assertEqual(self.plan_step("check")["env"]["PLAN_SCANNERS"], "${{ needs.plan.outputs.scanners }}")
        for mode in ("targeted", "docs"):
            self.assertEqual(self.check_env("success", mode, scanners="")["MODE"], "full", mode)
            self.assertEqual(self.check_env("success", mode)["MODE"], mode, mode)
        self.assertEqual(self.check_env("success", "full", scanners="")["MODE"], "full")

    def test_check_launcher_is_on_unless_the_plan_says_false(self):
        for value, want in (("false", "false"), ("true", "true"), ("", "true"), ("garbage", "true")):
            self.assertEqual(self.check_env("success", "targeted", value)["LAUNCHER"], want, value)

    def test_agent_and_runtime_run_unless_the_plan_succeeded_with_a_narrow_mode(self):
        # Verifier round 1 M1 (a failed plan skipped the agent tests) and D4 (an empty or
        # garbage mode skipped them).
        for key in ("agent", "runtime-agent-linux"):
            step = self.plan_step(key)
            for result in PLAN_RESULTS:
                for mode in PLAN_MODES:
                    env = run_step(step, {"PLAN_RESULT": result, "PLAN_MODE": mode})
                    skip = result == "success" and mode in ("targeted", "docs")
                    self.assertEqual(env["RUN"], "false" if skip else "true", (key, result, mode))
            # Every later step is gated on RUN, so RUN=true runs them all.
            later = self.jobs[key]["steps"][self.jobs[key]["steps"].index(step) + 1 :]
            for s in later:
                self.assertEqual(s.get("if"), "env.RUN == 'true'", (key, s.get("name")))
            if key == "runtime-agent-linux":
                self.assertEqual(self.jobs[key]["steps"][0], step, "the plan step must precede checkout")

    def test_check_runs_the_right_steps_in_each_mode(self):
        # Verifier round 1 M2 and M9: a targeted or smoke step whose `if:` is never true.
        common = {"CI plan", "actions/checkout", "actions/setup-node", "Install pnpm", "Install dependencies"}
        want = {
            "full": common | {"Typecheck", "Lint", "Test", "Build"},
            "targeted": common
            | {
                "Typecheck",
                "Lint",
                "Test (targeted, files related to the change)",
                LAUNCHER_STEP,
                SMOKE_STEP,
                "Schema validate",
                "Build",
            },
            "docs": common | {LAUNCHER_STEP, SMOKE_STEP},
        }
        for mode, names in want.items():
            env = self.check_env("success", mode)
            self.assertEqual(set(self.steps_that_run("check", env)), names, mode)
        for mode in ("targeted", "docs"):
            env = self.check_env("success", mode, "false")
            self.assertNotIn(LAUNCHER_STEP, self.steps_that_run("check", env), mode)
            self.assertIn(SMOKE_STEP, self.steps_that_run("check", env), mode)
        # A failed plan runs exactly what full mode runs.
        self.assertEqual(
            self.steps_that_run("check", self.check_env("failure", "docs")),
            self.steps_that_run("check", self.check_env("success", "full")),
        )

    def test_targeted_steps_run_the_planned_commands(self):
        steps = {s.get("name"): s for s in self.jobs["check"]["steps"]}
        t = steps["Test (targeted, files related to the change)"]
        self.assertIn('--changed "$BASE_SHA"', t["run"])
        self.assertEqual(t["env"]["BASE_SHA"], "${{ github.event.pull_request.base.sha }}")
        smoke = steps[SMOKE_STEP]
        self.assertIn("pnpm exec vitest run $SMOKE $SCANNERS $DOC_TESTS", smoke["run"])
        self.assertEqual(smoke["env"]["SMOKE"], "${{ needs.plan.outputs.smoke }}")
        self.assertEqual(smoke["env"]["SCANNERS"], "${{ needs.plan.outputs.scanners }}")
        self.assertEqual(smoke["env"]["DOC_TESTS"], "${{ needs.plan.outputs.doc_tests }}")
        # The launcher rerun is the same command `pnpm test` uses for that file.
        with open(os.path.join(REPO_ROOT, "package.json"), encoding="utf-8") as fh:
            import json

            test_script = json.load(fh)["scripts"]["test"]
        launcher = steps[LAUNCHER_STEP]["run"]
        self.assertIn(launcher.removeprefix("pnpm exec "), test_script)
        self.assertIn(cp.LAUNCHER_TEST, launcher)
        self.assertIn(f"--exclude {cp.LAUNCHER_TEST}", t["run"])

    def test_plan_job_exports_every_planner_output(self):
        outputs = self.jobs["plan"]["outputs"]
        for key in cp.Plan().outputs():
            if key == "reason":
                continue
            self.assertEqual(outputs.get(key), f"${{{{ steps.plan.outputs.{key} }}}}", key)

    def test_side_jobs_run_unless_the_plan_succeeded_and_says_no(self):
        for key, flag in (("m2-scorecard", "m2"), ("linux-path", "linux_path")):
            cond = self.jobs[key]["if"]
            for result in PLAN_RESULTS:
                for mode in PLAN_MODES:
                    for value in ("true", "false", ""):
                        ctx = {
                            "needs.plan.result": result,
                            "needs.plan.outputs.mode": mode,
                            f"needs.plan.outputs.{flag}": value,
                        }
                        skip = result == "success" and mode in ("targeted", "docs") and value == "false"
                        self.assertEqual(gh_eval(cond, ctx), not skip, (key, result, mode, value))
            self.assertFalse(gh_eval(cond, {"cancelled": True}))

    def test_required_jobs_start_whatever_the_plan_did(self):
        for key in self.required_jobs():
            cond = self.jobs[key].get("if")
            for result in PLAN_RESULTS:
                ctx = {"needs.plan.result": result}
                self.assertTrue(cond is None or gh_eval(cond, ctx), (key, result))

    def test_evaluator_rejects_what_it_cannot_evaluate(self):
        with self.assertRaises(ValueError):
            gh_eval("contains(github.event.pull_request.labels.*.name, 'x')", {})
        self.assertTrue(gh_eval("env.MODE == 'full'", {"env.MODE": "full"}))
        self.assertFalse(gh_eval("env.MODE != 'docs' && env.X == 'y'", {"env.MODE": "full"}))

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
