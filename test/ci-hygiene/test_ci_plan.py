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

SOURCES = {
    "test/baseline/task-text.test.ts": 'readFileSync(join(process.cwd(), "docs/architecture/m1.md"))',
    "scripts/check-scorecard-links.py": "open('docs/eval-runbook.md')",
}


def pr(files, labels=(), title="", body=""):
    return cp.plan("pull_request", list(files), list(labels), title, body, SOURCES)


def classify_reason(p):
    """The class named in a full-suite path-class reason, e.g. 'tier2'."""
    m = re.search(r"\((tier2|tooling|unknown)\)", " ".join(p.reasons))
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
        # A new src/ subtree, or TypeScript outside any known root, is never narrowed.
        for f in ("src/newarea/x.ts", "examples/x.ts", "x.ts", "viewer/e2e/viewer.pw.ts", "src/x.ts"):
            self.assertEqual(pr([f]).mode, "full", f)
        self.assertEqual(pr(["src/tasks/intent.ts"]).mode, "targeted")

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
        self.assertEqual(pr(["src/tasks/intent.ts"], labels=["tier-2"]).mode, "full")
        self.assertEqual(pr(["src/tasks/intent.ts"], labels=["full-ci"]).mode, "full")
        for body in ("Tier: 2", "**Tier 2**", "## Tier\nTier 2 (locks)", "- tier 2"):
            self.assertEqual(pr(["src/tasks/intent.ts"], body=body).mode, "full", body)
        self.assertEqual(pr(["src/tasks/intent.ts"], title="Tier 2: x").mode, "full")

    def test_tier1_body_stays_targeted(self):
        body = "Tier 1. A rewrite touching a guard's test would be Tier 2."
        self.assertEqual(pr(["src/tasks/intent.ts"], body=body).mode, "targeted")

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
        many = [f"src/tasks/f{i}.ts" for i in range(cp.MAX_FILES + 1)]
        self.assertEqual(pr(many).mode, "full")

    def test_side_jobs_follow_their_paths(self):
        self.assertTrue(pr(["src/linux/calc.ts"]).linux_path)
        self.assertTrue(pr(["test/init/init.test.ts"]).linux_path)
        self.assertFalse(pr(["src/tasks/intent.ts"]).linux_path)
        self.assertFalse(pr(["src/tasks/intent.ts"]).m2)
        # Full mode keeps every side job on (the job-level ifs read the mode too).
        self.assertTrue(pr(["scripts/m2-r1-dryrun.ts"]).m2)
        self.assertTrue(pr(["scripts/m2-r1-dryrun.ts"]).linux_path)
        # D6: the forked launcher test reruns in targeted mode when discovery changes.
        self.assertTrue(pr(["test/discovery/s0-live-launcher.test.ts"]).launcher)
        self.assertTrue(pr(["test/discovery/replay.test.ts"]).launcher)
        self.assertFalse(pr(["src/tasks/intent.ts"]).launcher)
        self.assertEqual(pr(["test/discovery/replay.test.ts"]).outputs()["launcher"], "true")
        self.assertEqual(pr(["src/tasks/intent.ts"]).outputs()["launcher"], "false")
        sources = {"test/discovery/x.test.ts": 'import { d } from "../../src/discovery/decision.ts";'}
        p = cp.plan("pull_request", ["src/discovery/decision.ts"], [], "", "", sources)
        self.assertEqual((p.mode, p.launcher), ("targeted", True))

    def test_bad_base_sha_means_unknown_diff(self):
        self.assertIsNone(cp.changed_files("", REPO_ROOT))
        self.assertIsNone(cp.changed_files("origin/main; rm -rf /", REPO_ROOT))

    def test_smoke_files_exist(self):
        for f in cp.SMOKE:
            self.assertTrue(os.path.isfile(os.path.join(REPO_ROOT, f)), f)


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
        for name in ("TIER2", "TOOLING", "NARROWABLE_TS", "LINUX_PATH", "M2", "LAUNCHER_PATHS", "SMOKE"):
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

    SOURCES = {
        "scripts/run-thing.ts": 'import { go } from "../src/tasks/runner.ts";\ngo();\n',
        "src/tasks/runner.ts": 'import { helper } from "./helper.ts";\nexport const go = helper;\n',
        "src/tasks/helper.ts": "export const helper = () => 1;\n",
        "src/tasks/spawned.ts": "console.log(1);\n",
        "src/tasks/plain.ts": "export const plain = 1;\n",
        "test/tasks/spawn.test.ts": 'spawnSync("tsx", [join(ROOT, "src", "tasks", "spawned.ts")]);\n',
        "test/tasks/plain.test.ts": 'import { plain } from "../../src/tasks/plain.ts";\n',
    }

    def plan(self, files):
        return cp.plan("pull_request", files, [], "", "", self.SOURCES)

    def test_a_module_a_script_imports_transitively_forces_full(self):
        for f in ("src/tasks/runner.ts", "src/tasks/helper.ts"):
            p = self.plan([f])
            self.assertEqual(p.mode, "full", f)
            self.assertIn("spawned script", p.reasons[0])
            self.assertIn("scripts/run-thing.ts", p.reasons[0])

    def test_a_file_a_test_names_outside_an_import_forces_full(self):
        p = self.plan(["src/tasks/spawned.ts"])
        self.assertEqual(p.mode, "full")
        self.assertIn("test/tasks/spawn.test.ts", p.reasons[0])

    def test_a_deleted_file_a_test_still_names_forces_full(self):
        sources = {k: v for k, v in self.SOURCES.items() if k != "src/tasks/spawned.ts"}
        self.assertEqual(cp.plan("pull_request", ["src/tasks/spawned.ts"], [], "", "", sources).mode, "full")

    def test_a_module_only_imported_stays_targeted(self):
        self.assertEqual(self.plan(["src/tasks/plain.ts"]).mode, "targeted")
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
        self.assertEqual(cp.plan("pull_request", ["docs/x/guide.md"], [], "", "", sources).mode, "docs")
        sources["scripts/other.py"] = "docs/x/guide.md"
        self.assertEqual(cp.plan("pull_request", ["docs/x/guide.md"], [], "", "", sources).mode, "full")


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

    def check_env(self, result, mode, launcher="true"):
        step = self.plan_step("check")
        return run_step(step, {"PLAN_RESULT": result, "PLAN_MODE": mode, "PLAN_LAUNCHER": launcher})

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
                "Test (s0 launcher, forked, when discovery changed)",
                "Test (core smoke and doc tests)",
                "Schema validate",
                "Build",
            },
            "docs": common | {"Test (core smoke and doc tests)"},
        }
        for mode, names in want.items():
            env = self.check_env("success", mode)
            self.assertEqual(set(self.steps_that_run("check", env)), names, mode)
        env = self.check_env("success", "targeted", "false")
        self.assertNotIn("Test (s0 launcher, forked, when discovery changed)", self.steps_that_run("check", env))
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
        smoke = steps["Test (core smoke and doc tests)"]
        self.assertIn("pnpm exec vitest run $SMOKE $DOC_TESTS", smoke["run"])
        self.assertEqual(smoke["env"]["SMOKE"], "${{ needs.plan.outputs.smoke }}")
        self.assertEqual(smoke["env"]["DOC_TESTS"], "${{ needs.plan.outputs.doc_tests }}")
        # The launcher rerun is the same command `pnpm test` uses for that file.
        with open(os.path.join(REPO_ROOT, "package.json"), encoding="utf-8") as fh:
            import json

            test_script = json.load(fh)["scripts"]["test"]
        launcher = steps["Test (s0 launcher, forked, when discovery changed)"]["run"]
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
