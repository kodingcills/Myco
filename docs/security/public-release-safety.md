# Public-release safety pass

M2-14 (plan label, Linear pending), 2026-11-25. The repo `kodingcills/Myco` is already
public. This pass checks the whole git history for secrets and host paths, and makes the
public-CI hygiene rules a failing check. Findings are counts, paths and commit SHAs only:
no secret value, matched text or account name appears here or in the scan output.

Nothing in history was rewritten. A rewrite is Tiffany's decision alone; the
recommendation is [below](#recommendation-on-a-history-rewrite).

## How to recompute

Every number in the two findings sections comes from one run of
`scripts/history-safety-scan.py` on a fresh mirror clone. A mirror fetches every ref:
branches, tags and GitHub's read-only `refs/pull/*`.

```sh
git clone --mirror https://github.com/kodingcills/Myco myco.git
# gitleaks 8.30.1, checksum-pinned as in .github/workflows/ci.yml
python3 scripts/history-safety-scan.py --repo myco.git --gitleaks ./gitleaks --json scan.json
```

The run below was on `main` at `81cd59d1fa45592fce37db63660ac161ca20adce`. Later pushes
add refs and commits, so a re-run shows larger totals. The secret findings should stay
the same unless a new commit adds one. The scan is a report and always exits 0. The
per-PR gate is CI's `secret scan (gitleaks)` job.

**Scope of the run:** 510 refs (8 branches, 28 tags, 474 `refs/pull/*`) and 1,914
commits (1,552 non-merge, 362 merge).

## Secrets: whole-history gitleaks

gitleaks 8.30.1, default rules, `--redact` and `--ignore-gitleaks-allow` (so an inline
`gitleaks:allow` hides nothing), over all refs. There are three passes, because each one
covers a gap in another:

| Pass | Scanned | Findings | Rule | Path |
| --- | --- | --- | --- | --- |
| `git`, all refs, non-merge commits | 1,546 commits | 4 | `generic-api-key` | `test/orgo/orgo.test.ts` |
| `git`, all refs, with `-m` (each merge diffed against each parent) | 1,908 commits | 18 | `generic-api-key` | `test/orgo/orgo.test.ts` |
| `dir`, every blob reachable from any ref, one file per blob | 3,446 blobs | 6 | `generic-api-key` | `test/orgo/orgo.test.ts` |

The `git` mode counts 1,546 of the 1,552 non-merge commits; it does not say why it skips
the other six (empty and binary-only commits are among them). The blob pass does not
depend on which commits get diffed, and it finds the same single file. The 14 extra `-m` findings
are merges carrying the same lines in from a parent. The 6 blobs are six versions of
that file.

All the findings are one test fixture: a key-shaped Orgo API key value in the Orgo
tests. The four non-merge commits that carry it:

| Commit | Date | Where | On `main` |
| --- | --- | --- | --- |
| `ecc7e19e86abbd8bf4196ffc5f84c25f3aa51576` | 2026-11-21 | `refs/pull/81/head` only (pre-squash) | no |
| `aad8b59332b585f85278fcbfc07b32d0fdc51107` | 2026-11-22 | #81 squash; in 387 of 474 PR refs and 24 of 28 tags | yes |
| `7511f3d2cdf4b3d4c0abdad16136260e5e99f3eb` | 2026-11-24 | `refs/pull/416/head` only (pre-squash) | no |
| `5185de00df9b7287503ca94bab3c90d76a1ae069` | 2026-11-24 | #416, which added a `gitleaks:allow` to the line; in 6 of 8 branches and 50 PR refs | yes |

Dates are commit dates. The "where" counts are from the script's `refs containing` lines.

#456 (TIF-244, `884a7ac`, 2026-11-25) replaced the fixture with an obvious fake and
dropped the `gitleaks:allow`. TIF-244 treated the old value as a key-shaped fake, not a
live credential. This scan cannot settle that, because it never reads the value.

**Current tree:** `gitleaks dir` over `git archive main` (992 files), with the same
flags, finds **0**. The earlier OSS-01 result (one `generic-api-key` hit at
`test/orgo/orgo.test.ts:41`) is fixed in the tree but stays in history, as listed above.

## Host paths in history

Lines **added** by any non-merge commit on any ref, for three patterns. The script
counts distinct account names in the home-directory pattern but never prints one.

| Pattern | Commits (on `main`) | Added lines | Files | Tree at `main` |
| --- | --- | --- | --- | --- |
| macOS home dir (a `Users` directory, an account name, a slash) | 26 (13) | 139 | 15 | 2 lines in 2 files |
| `/private/tmp/claude-*` | 0 | 0 | 0 | 0 |
| `/var/folders/` | 1 (1) | 1 | 1 | 1 line in 1 file |

**Home-dir account names:** 3 distinct.

- One is a real host account name: 135 of the 139 matches.
- One is the Windows trial VM's own `myco` user, in a `C:` drive path: 3 matches.
- One was already elided to `...` in quoted output: 2 matches.

The tree at `main` holds only the last two. They are the allow-listed files in
`test/no-home-paths.test.ts`: `agent/bootstrap/deploy-to-vm.sh` and
`docs/research/experiments/df-s01-preflight-deadlock/BLOCKER.md`. #465 removed the rest.

**Files with home-dir matches in history** (added lines per file): `HANDOFF.md` 2,
`agent/bootstrap/deploy-to-vm.sh` 3, `docs/architecture/evidence-schema.md` 6,
`docs/coordination/m1-state.md` 1, `docs/env/dogfood-runtime-runbook.md` 2,
`docs/env/vm-toolchain/README.md` 2,
`docs/research/experiments/c1-arm-002/progress-snapshot.log` 6,
`docs/research/experiments/c1-arm-003/r2-void/PRIOR_SPEND.md` 2,
`docs/research/experiments/df-s01-preflight-deadlock/BLOCKER.md` 2,
`docs/research/experiments/m1-row8-corrupt/deploy-check.log` 2,
`docs/research/experiments/m1-row8-corrupt/progress.log` 36,
`docs/research/experiments/m1-row8-sweep2/progress.log` 58,
`docs/research/experiments/m1-row8/NEXT-RUN.md` 2, `docs/research/index.jsonl` 13,
`scripts/verify-direction-a-viewer.ts` 2.

**`/var/folders/`:** one line, in `test/baseline/watch-prior-spend.test.ts`. It is a code
comment that names the macOS temp root generically (`/var/folders/...`). It identifies
no one, and it stays in the tree.

## Recommendation on a history rewrite

**Recommendation: do not rewrite. Confirm the old Orgo fixture was never a live key, and
rotate that key if there is any doubt.** This is Tiffany's call.

- **A rewrite cannot remove what is already out.** The repo is public, so forks, clones
  and caches already hold the history. GitHub's `refs/pull/*` are read-only to the repo
  owner. 387 of the 474 PR refs hold the fixture commit, and so do 24 of the 28 tags. A
  push cannot remove those. It takes a GitHub Support request to purge cached views and
  PR refs. If a value was ever live, the fix is to rotate it, and rotation works whatever
  happens to history.
- **The only secret-rule finding is one test fixture.** TIF-244 judged it a fake, and the
  tree no longer has it. If it was ever a real Orgo key, rotate it at Orgo. That fully
  fixes the exposure; a rewrite would not.
- **The host-path finding is one account name in 135 lines across 15 files.** It is an
  identifier, not a credential. It shows a local username in logs and docs. The tree is
  clean and `test/no-home-paths.test.ts` stops new ones.
- **A rewrite costs a lot.** It changes every SHA from the first affected commit onward.
  That breaks 24 tags, every open PR, and every verifier record and doc that cites a SHA
  (the content-identity merge rule depends on those). Every clone would need a reset.

If Tiffany decides to rewrite anyway: use `git filter-repo` with `--replace-text` on a
mirror for the fixture line and the account name. Force-push all branches and tags
(that needs her admin override, since agents never force push). Then ask GitHub Support
to purge cached views and `refs/pull/*`. Plan a freeze, because every open PR must be
recreated.

## CI hygiene rules and how they are enforced

`scripts/ci-hygiene-check.py` enforces these rules. CI runs it in the
`ci hygiene (workflows)` job (`.github/workflows/ci.yml`) on every push to `main` and
every PR, together with its tests (`test/ci-hygiene/`). It reads every workflow under
`.github/workflows/` and every local action under `.github/actions/`. Any violation
fails the job, with a `VIOLATION <rule> <file> [job] [step]: ...` line.

| Rule id | Rule | Why |
| --- | --- | --- |
| `pull-request-target` | No workflow is triggered by `pull_request_target`. | It runs with the base repo's secrets and a write token. With fork code checked out, that is a repo takeover. Myco uses `pull_request`. |
| `runner` | Every `runs-on` resolves to GitHub-hosted labels only: `ubuntu-*`, `macos-*`, `windows-*`. `self-hosted`, any other label, a runner `group:` and an expression the checker cannot resolve all fail. `${{ matrix.<key> }}` is resolved from the job's literal matrix, including `include`. | Fork code must never run on Tiffany's Mac or the trial VM. |
| `workflow-run-write` | A `workflow_run` workflow holds no write permission, and it must set top-level permissions. | `workflow_run` runs in the base repo's context after an untrusted run. A write token there is the same takeover path. |
| `top-level-permissions` | Every workflow sets top-level `permissions` to `{}` or a mapping of `read` / `none` values. `read-all`, `write-all` and any `write` fail. | Without it the token gets the repository default, which may be write. |
| `job-permissions` | No job widens its token to `write`, `write-all` or `read-all`. | Keeps "no job widens it" (docs/ci.md) true. |
| `unpinned-action` | Every `uses:` is local (`./...`), `docker://...@sha256:<digest>`, or `owner/repo[/path]@<40-hex SHA>`. This covers steps, reusable-workflow jobs and composite actions. | Someone can move a tag or branch to new code after review. |
| `pin-comment` | A SHA-pinned `uses:` line ends with a `# <version>` comment. | Lets a reviewer see what the SHA is (docs/ci.md). |

The checker exits 2, never 0, when there is nothing to check or a workflow does not
parse. An empty or broken input cannot pass.

Proof (`test/ci-hygiene/test_ci_hygiene_check.py`):

- Each rule has a test that seeds one violation into a clean workflow and expects that
  rule to fire. The tests cover each trigger syntax, a self-hosted runner as a string, a
  list, a group and a matrix entry, a tag, branch or short-SHA pin, a docker tag, and an
  unpinned composite action.
- The clean fixture and this repo's real workflows must pass.
- Disabling any single rule in the script turns at least one test red.

PyYAML is the checker's only dependency. The job installs it with `--require-hashes`
from `scripts/ci-hygiene-requirements.txt`.

## Admin action for Tiffany: first-time-contributor approval

Agents cannot change this repository setting; an admin must set it.

**Settings → Actions → General → "Approval for running fork pull request workflows from
contributors"**: choose **"Require approval for first-time contributors"** or the
stricter **"Require approval for all external contributors"**. Do not leave it at
"Require approval for first-time contributors who are new to GitHub": that asks only
recently created GitHub accounts for approval, so any older account's first PR runs
straight away. "All external
contributors" is the safest choice before the announcement.

On the same page, worth checking while there:

- **Workflow permissions:** "Read repository contents and packages permissions". Every
  workflow already sets its own read-only `permissions`, so this is defence in depth.
- **"Allow GitHub Actions to create and approve pull requests":** off.
- **Actions permissions:** consider "Allow OWNER, and select non-OWNER, actions and
  reusable workflows", with "Require actions to be pinned to a full-length commit SHA"
  turned on if GitHub offers it. That enforces pinning at the platform level too.

Once the setting is chosen, record it in `docs/ci.md` ("What needs a maintainer").
Optionally, add `ci hygiene (workflows)` to the required status checks on `main`.
