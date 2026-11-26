"""Tests for scripts/history-safety-scan.py (M2-14, plan label, Linear pending).

Run: python3 -m unittest discover -s test/ci-hygiene -v

The scan must count host paths across every ref and never print what it matched: no
account name, no secret value. A fake gitleaks that writes an UNREDACTED report proves
the script keeps only rule, path, line and commit even if gitleaks leaked a value.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(REPO_ROOT, "scripts", "history-safety-scan.py")

spec = importlib.util.spec_from_file_location("history_safety_scan", SCRIPT)
assert spec and spec.loader
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)

# Built from parts so this file never holds a literal home path (test/no-home-paths.test.ts).
ACCOUNT = "seedaccountq7"
HOME = "/" + "Users" + "/" + ACCOUNT + "/"
CLAUDE_TMP = "/private/tmp/" + "claude-501/x"
VAR_FOLDERS = "/var/" + "folders/zz/T/x"
SEEDED_SECRET = "SEEDVALUE-never-print-me"


def git(repo: str, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True,
                          text=True, env=env).stdout


def commit(repo: str, path: str, text: str, msg: str) -> None:
    full = os.path.join(repo, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(text)
    git(repo, "add", path)
    git(repo, "commit", "-q", "-m", msg)


class HistoryScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = os.path.join(self.tmp.name, "r")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q", "-b", "main")
        commit(self.repo, "a.md", f"cd {HOME}Projects\nrun {CLAUDE_TMP}\n", "add paths")
        self.first_blob = git(self.repo, "rev-parse", "HEAD:a.md").strip()
        commit(self.repo, "a.md", "cd ~/Projects\n", "scrub")
        commit(self.repo, "b.md", f"tmp {VAR_FOLDERS}\n", "tmp comment")
        # A side branch that never reached main still counts in history.
        git(self.repo, "checkout", "-q", "-b", "side")
        commit(self.repo, "c.log", f"{HOME}x\n{HOME}y\n", "side log")
        git(self.repo, "checkout", "-q", "main")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, SCRIPT, "--repo", self.repo, *extra],
                              capture_output=True, text=True)

    def test_counts_every_ref_and_the_tree(self):
        out_json = os.path.join(self.tmp.name, "r.json")
        p = self.run_cli("--json", out_json)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(out_json, encoding="utf-8") as fh:
            report = json.load(fh)
        home = report["host_paths_history"]["macos-home"]
        self.assertEqual(home["commits"], 2)
        self.assertEqual(home["commits_on_main"], 1)
        self.assertEqual(home["added_lines"], 3)
        self.assertEqual(home["distinct_account_names"], 1)
        self.assertEqual(home["account_classes"], {"other": {"distinct": 1, "matches": 3}})
        self.assertEqual(home["files"], {"a.md": 1, "c.log": 2})
        self.assertEqual(report["host_paths_history"]["private-tmp-claude"]["added_lines"], 1)
        self.assertEqual(report["host_paths_history"]["var-folders"]["files"], {"b.md": 1})
        tree = report["host_paths_tree"]
        self.assertEqual(tree["macos-home"]["lines"], 0)  # scrubbed on main
        self.assertEqual(tree["var-folders"]["files"], {"b.md": 1})
        self.assertEqual(report["refs"], {"heads": 2})
        self.assertIn("host path macos-home, history: 2 commits (1 on main), 3 added lines", p.stdout)

    def test_never_prints_the_account_name_or_the_matched_text(self):
        out_json = os.path.join(self.tmp.name, "r.json")
        p = self.run_cli("--json", out_json)
        with open(out_json, encoding="utf-8") as fh:
            dumped = fh.read()
        for blob in (p.stdout, p.stderr, dumped):
            self.assertNotIn(ACCOUNT, blob)
            self.assertNotIn("claude-501", blob)
            self.assertNotIn("zz/T", blob)

    def write_fake_gitleaks(self) -> str:
        """A gitleaks stand-in that writes one UNREDACTED finding, as if --redact failed."""
        fake = os.path.join(self.tmp.name, "gitleaks")
        head = git(self.repo, "rev-parse", "HEAD").strip()
        finding = {"RuleID": "generic-api-key", "File": "a.md", "StartLine": 1, "Commit": head,
                   "Secret": SEEDED_SECRET, "Match": f"key={SEEDED_SECRET}",
                   "Line": f"key={SEEDED_SECRET}", "Entropy": 4.2}
        with open(fake, "w", encoding="utf-8") as fh:
            fh.write(textwrap.dedent(f"""\
                #!{sys.executable}
                import json, sys
                args = sys.argv[1:]
                assert "--redact" in args and "--ignore-gitleaks-allow" in args, args
                path = args[args.index("--report-path") + 1]
                finding = {json.dumps(finding)}
                if args[0] == "dir":  # point at the blob of a.md's first version
                    import os
                    finding["File"] = os.path.join(args[-1], {json.dumps(self.first_blob)})
                json.dump([finding], open(path, "w"))
                print("7 commits scanned.")
                sys.exit(1)
                """))
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)
        return fake

    def test_keeps_only_safe_gitleaks_fields_even_if_unredacted(self):
        fake = self.write_fake_gitleaks()
        head = git(self.repo, "rev-parse", "HEAD").strip()
        out_json = os.path.join(self.tmp.name, "r.json")
        p = self.run_cli("--gitleaks", fake, "--json", out_json)
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(out_json, encoding="utf-8") as fh:
            dumped = fh.read()
        for blob in (p.stdout, p.stderr, dumped):
            self.assertNotIn(SEEDED_SECRET, blob)
        self.assertIn("gitleaks, all refs, non-merge commits: 1 findings in 7 commits scanned", p.stdout)
        self.assertIn(f"commit {head} a.md:1 on-main=yes", p.stdout)
        # Blob pass: every reachable blob is written out and scanned once.
        self.assertIn("gitleaks dir, every blob reachable from any ref: 1 findings in 4 blobs", p.stdout)
        self.assertIn(f"blob {self.first_blob} a.md:1", p.stdout)
        # Tree pass over `git archive main` (a.md and b.md), and the refs holding the commit.
        self.assertIn("gitleaks dir, tree at main: 1 findings in 2 files", p.stdout)
        self.assertRegex(p.stdout, rf"refs containing {head} \(committed \d{{4}}-\d\d-\d\d\): heads 2 \(refs/heads/main refs/heads/side\)")

    def test_run_gitleaks_drops_value_fields_in_memory(self):
        fake = self.write_fake_gitleaks()
        res = scan.run_gitleaks(fake, self.repo, "--all")
        self.assertEqual([set(f) for f in res["findings"]], [set(scan.GITLEAKS_FIELDS)])
        self.assertNotIn(SEEDED_SECRET, json.dumps(res))
        blobs = scan.run_gitleaks_blobs(fake, self.repo)
        self.assertNotIn(SEEDED_SECRET, json.dumps(blobs))

    def test_gitleaks_tool_error_exits_2(self):
        fake = os.path.join(self.tmp.name, "gitleaks")
        with open(fake, "w", encoding="utf-8") as fh:
            fh.write(f"#!{sys.executable}\nimport sys\nsys.exit(3)\n")
        os.chmod(fake, os.stat(fake).st_mode | stat.S_IXUSR)
        self.assertEqual(self.run_cli("--gitleaks", fake).returncode, 2)


if __name__ == "__main__":
    unittest.main()
