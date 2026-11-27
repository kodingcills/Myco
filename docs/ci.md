# CI

Myco's CI is GitHub Actions, in `.github/workflows/`. It is built so a pull request
from a fork runs the same checks as a maintainer's branch, with no secrets and a
read-only token (TIF-241).

## What runs on a pull request (including forks)

Every workflow is triggered by `pull_request`, never by `pull_request_target` or
`workflow_run`. On a fork PR GitHub runs the fork's code with a read-only
`GITHUB_TOKEN` and passes no repository secrets. No job here reads a secret, so
nothing is skipped or fails for lack of one.

| Workflow | Job (check name) | Runs on fork PRs | Required on `main` |
| --- | --- | --- | --- |
| `ci.yml` | `ci plan (path classes)` | yes | no |
| `ci.yml` | `secret scan (gitleaks)` | yes | yes |
| `ci.yml` | `ci hygiene (workflows)` | yes | no |
| `ci.yml` | `check (ubuntu-latest)`, `check (macos-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (macos-latest)` | yes | no |
| `ci.yml` | `runtime guest agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `linux path (ubuntu-latest)` | yes, when the plan says so | no |
| `ci.yml` | `safe parallelism (ubuntu-latest)` | yes (every PR; not gated by the plan) | no |
| `ci.yml` | `m2 evidence and scorecard` | yes, when the plan says so | no |
| `ci.yml` | `strict isolation (ubuntu-latest)` | yes | no |
| `ci.yml` | `viewer verdict budget (…)` | only with the `perf` label | no |
| `tif-170-race-diagnostics.yml` | `race x1` | only when the PR touches its paths | no |

- **Secret scan.** gitleaks 8.30.1, downloaded and checked against a pinned SHA-256
  (it matches upstream's `gitleaks_8.30.1_checksums.txt`). It scans only the commits
  the PR adds, with findings redacted in the log. Enable the same check locally with
  `git config core.hooksPath .githooks`.
- **Linux path.** Installs LibreOffice Calc and Python-UNO from Ubuntu's archive, runs
  `test/linux` with `MYCO_LINUX_PATH_REQUIRED=1` (a missing prerequisite fails the suite
  instead of skipping it), then `pnpm myco-linux --demo`, which exits non-zero unless
  every scenario gets its expected verdict. See `docs/product/linux-path.md` (TIF-269).
- **Safe parallelism.** Track L. Installs LibreOffice Calc, Python-UNO and Xvfb, runs
  `test/parallel` with `MYCO_PARALLEL_REQUIRED=1` (the Xvfb and real-Calc suites fail
  instead of skipping), then a $0 throughput run at N = 1, 2, 4 with scripted agents on
  the unprivileged `linux-plain` backend (`--allow-weak-isolation`; nothing is counted as
  verified there). Then the L-infra zero-contamination run (`pnpm myco-l-infra`: fc-v1's
  90 satisfiable tasks at N = 1, 2, 4, 8, real Calc, a canary per desktop, a positive
  control), which prints its rows and their SHA-256 to the log and must recompute
  (`pnpm myco-l-infra-analyze --check`). Strict namespace isolation is not in this job. See
  `docs/product/safe-parallelism.md` and `docs/product/l-infra/README.md`.
- **M2 evidence and scorecard.** `scripts/m2-evidence-check.ts --all` checks every
  committed `docs/research/experiments/m2-*` pack (schemas, the shared benchmark ledger,
  a cause on every non-verified row, the guest load gate record), then
  `scripts/m2-scorecard-check.py` recomputes every number in `docs/m2-scorecard.md`
  (TIF-273). The same tests also run in `check` through `pnpm test`.
- **Strict isolation.** Lifts Ubuntu 24.04's AppArmor restriction on unprivileged user
  namespaces, then runs `test/isolation` as the runner user with
  `MYCO_STRICT_NS_REQUIRED=1`, so a host that cannot start the strict backend fails the
  suite instead of skipping it. See `docs/product/strict-isolation.md` (track L2).
- **Viewer verdict budget.** A timing gate that is noisy on shared runners, so it runs
  on pushes to `main` and on PRs a maintainer labels `perf`. Only people with triage
  access or above can add labels, and a labelled fork PR still runs under
  `pull_request`: same read-only token, no secrets.

## Targeted CI (test audit, TIF-265 follow-up)

The `ci plan (path classes)` job runs `scripts/ci-plan.py` on the PR's changed files,
labels, title and body, and every other job reads its decision. It picks one of three
modes.

| Mode | When | `check` runs | agent, runtime jobs |
| --- | --- | --- | --- |
| `full` | Pushes to `main`; any Tier 2 signal (below); any changed path in a Tier 2 or tooling class; **any change under `src/` or `viewer/src/`**; TypeScript outside `test/` and `viewer/test/`; a test file a script can reach or a source names outside an import (below); any other file kind (yaml, json, py, sh, html, css, fixtures); a doc that a non-test source names; a diff it cannot compute, or over 300 files; no readable test sources | typecheck, lint, `pnpm test`, build: exactly what it ran before the planner existed | run |
| `targeted` | Only `.md` docs and TypeScript under `test/` or `viewer/test/` | typecheck, lint, `vitest run --changed <PR base>` (the changed test files and every test importing them), the forked s0 launcher test, the core smoke set, **every directory-scanning test**, the doc tests, `pnpm schema-validate`, build | steps skipped, job green |
| `docs` | Only `.md` docs, none of them named by a non-test source | the forked s0 launcher test, the core smoke set, **every directory-scanning test**, and the test files that name a changed doc | steps skipped, job green |

**Only test-only and docs-only changes are narrowed.** Every change under `src/` or
`viewer/src/` runs the full suite. The reason (verifier round 2, D7): guard tests such as
`test/baseline/hcu-shell/import-boundary.test.ts` (the hcu+shell arm never reaches grader
code) and `test/foundry/split.test.ts` (nothing outside the hidden roots imports the
oracles) read a source directory with `readdirSync` or `globSync`; they never import the
module they guard, so `vitest run --changed` cannot find them, and a grader-independence
violation in `src/baseline/hcu-shell/ledger.ts` passed targeted CI. Narrowable TypeScript is
therefore just `test/` and `viewer/test/`, minus every Tier 2 path. Even there,
`vitest run --changed` only sees imports, so the planner forces `full` for a changed file
that any `scripts/**/*.ts` reaches through imports, that a file named outside an import
reaches, or whose file name any source mentions outside an import (a spawned helper such
as `test/gate/fifo-child.ts`).

**Directory-scanning tests always run.** A guard can scan `test/` or `docs/` too
(`test/no-home-paths.test.ts`, `test/baseline/probe-directory.test.ts`), so targeted and
docs mode run every test file that lists or walks a directory, found mechanically by
`scanning_tests()` in `scripts/ci-plan.py`: the test itself, a helper it imports (any
depth), or a `scripts/` or `schemas/` file it spawns calls `readdir`, `readdirSync`,
`opendir`, `glob`, `globSync`, `readDirectory`, Python's `os.walk`/`listdir`/`scandir`/
`glob`/`rglob`/`iterdir`, `git ls-files`/`ls-tree`, or runs `find`, `rg` or `grep`. A new
scanning test joins with no list edit. Today that is about 65 files, about 2 minutes
locally. The plan job exports them as `scanners`; if a narrow plan lists none, `check`
runs the full suite. The test file pins every known repo guard (grader independence, the
hidden split, required instructions, the probe directory, home paths, claim isolation,
secret hygiene) into that set, and checks it against an independent detector.

**The secret scan always runs.** It does not depend on the plan.

**Required checks never hang.** The five required checks keep their names, and their
jobs are never skipped at the job level. A skipped matrix job reports as
`check (${{ matrix.os }})`, which would leave `check (macos-latest)` pending forever. Each
required job starts, reads the plan in its first step, and skips only its own later
steps. If the plan job fails, is skipped or cancelled, or its mode is empty or anything
but `full`, `targeted` or `docs`, every required job runs in full; the agent and runtime
jobs skip their steps only on a successful plan whose mode is exactly `targeted` or
`docs`. `test/ci-hygiene/test_ci_plan.py` (run by `ci hygiene (workflows)`) executes each
job's `CI plan` step with every combination of plan result and mode (including empty,
garbage and multi-line modes), evaluates every step's `if:` and the side jobs' job-level
`if:`, and fails if a required name changes, a required job gains a job-level condition,
a fallback does not reach full, or a mode runs the wrong steps.

**Tier 2 always gets the full suite.** Any one of these forces `full`:

- the `tier-2` label (or `full-ci`);
- a PR title or a body line that states the tier as 2 (`Tier: 2`, `**Tier 2.**`, `Tier 2 (locks)`),
  as `.github/PULL_REQUEST_TEMPLATE.md` asks every PR to;
- a changed path in a Tier 2 class: `schemas/`, `src/{core,verify,gate,integrity,win,integration,faults,m2,benchmark,oracle-selftest}/`,
  `src/foundry/{grader,oracles,hidden-split}/`, `src/foundry/guard.ts`,
  `src/baseline/secret-file.ts`, `src/baseline/sweep.ts` (the run lock and the
  spend-ceiling enforcement), all of `scripts/`, `agent/`, `runtime/`, `foundry/`,
  `benchmark/`, `docs/research/`, the scorecards, and the guard tests
  (`test/{gate,integrity,oracle-selftest,fault-classes,m2,benchmark}/`,
  `test/baseline/{run-lock,spend-ceiling,secret-file}.test.ts`, the directory-scanning
  guards `test/baseline/{hcu-shell/import-boundary,import-graph,instruction-required,probe-directory}.test.ts`,
  `test/foundry/{split,hidden-split}.test.ts`, no-home-paths, claim isolation, evidence,
  faults, VM-lock, scorecard). The test file checks that every tracked file under `src/{gate,integrity,benchmark,m2,core}/`,
  `schemas/`, `scripts/`, `.github/`, `agent/` and `runtime/` forces `full`, and that every
  listed prefix matches a tracked file;
- a changed tooling path: `.github/`, `.githooks/`, `package.json`, the lockfile,
  `tsconfig*`, `vitest.config.ts`, `biome.json`, `test/setup/`, `test/ci-hygiene/`.

The workflow also runs on `labeled` and `unlabeled`. Adding `tier-2` after a targeted run
starts a new run, which cancels the old one, so the required checks go back to pending
until the full suite passes. A body edit alone does not start a run; the stated tier takes
effect at the next push, or add the label. **When unsure, add `tier-2`.** A reviewer who
raises a PR's tier adds the label.

**Core smoke set** (about 5 s, `SMOKE` in `scripts/ci-plan.py`; the test file pins this list and the code to each other): `test/claim-isolation.test.ts`, `test/eval.test.ts`, `test/evidence.test.ts`, `test/faults.test.ts`, `test/no-home-paths.test.ts`, `test/recovery.test.ts`, `test/runner.test.ts`, `test/verify.test.ts`, `test/baseline/import-graph.test.ts`, `test/gate/gate.test.ts`, `test/integrity/isolation.test.ts`, `test/oracle-selftest/selftest.test.ts`.

The `linux path` and `m2 evidence and scorecard` jobs are not required. They run unless
a successful plan names a narrow mode and says their paths are untouched (`test/{linux,init}/`;
`test/m2/`). Their other paths (`src/`, `scripts/`) always run everything. `viewer-perf` is unchanged.

See what the planner would do for your branch:

```sh
python3 scripts/ci-plan.py --event pull_request --files $(git diff --name-only origin/main...HEAD)
```

## Security posture

The `ci hygiene (workflows)` job enforces these rules with `scripts/ci-hygiene-check.py`;
a workflow change that breaks one fails CI. Rule list and rationale:
[docs/security/public-release-safety.md](security/public-release-safety.md) (M2-14).

- **Least privilege.** Each workflow sets `permissions: contents: read` at the top
  level and no job widens it. Caching and artifact upload use the runner's Actions
  runtime token, not `GITHUB_TOKEN` scopes.
- **No persisted credentials.** `actions/checkout` runs with
  `persist-credentials: false`, so later steps (dependency installs, tests) cannot
  read the token from `.git/config`.
- **Pinned actions.** Every third-party action is pinned to a full commit SHA with
  its version in a comment. To update one, resolve the new tag's commit
  (`git ls-remote https://github.com/OWNER/REPO 'refs/tags/vX.Y.Z^{}' 'refs/tags/vX.Y.Z'`;
  use the `^{}` line when present) and update the SHA and the comment together.
  `dtolnay/rust-toolchain` has no release tags; pin a commit on its `master` branch
  and keep `toolchain: stable`.
- **No untrusted interpolation.** Event data (`github.base_ref`,
  `github.event.before`, dispatch inputs) reaches scripts through `env:`, not
  `${{ }}` inside `run:`.
- **GitHub-hosted runners only.** No self-hosted runner is used, so fork code never
  runs on maintainer hardware.

## Concurrency

A newer push to a PR cancels that PR's superseded run (`cancel-in-progress` is true
only for `pull_request`). Each push to `main`, and each manual dispatch, gets its own
group keyed on `github.run_id`, so a `main` run is never cancelled or displaced by a
later one. A cancelled PR run shows as "cancelled", not failed; the newest run is
the one that counts.

## Job timeouts

`check` has `timeout-minutes: 15` and `myco-agent tests` has 10. From 2026-11-23 to
11-25, once a runner had the job, macOS `check` took at most 3.5 min (p50 1.8) and
macOS `myco-agent tests` at most 0.9 min. A hang now ends as "timed out" in the
step that hung, not as an unexplained cancel. `viewer-perf` keeps 20. A timeout
counts from when a runner starts the job, so it never covers queue time.

## macOS runner cancellations (TIF-256)

**Symptom.** A `macos-latest` job shows "cancelled" after 15-30 min, with an empty
step list and no log. The check run's annotations say *"The job was not acquired
by Runner of type hosted even after multiple attempts"*, plus GitHub's notice
*"Due to capacity constraints, jobs targeting macOS arm64 runners may experience
longer queue times"*. The API shows `runner_id: 0` and zero steps.

**Cause.** GitHub had no macOS arm64 runner free and gave up on the queued job.
No step of ours ran, so it is not a test hang (pty, launcher, or otherwise), not
`timeout-minutes`, and not the PR concurrency group. Concurrency cancels the
whole superseded run, whose conclusion is then `cancelled`. Here the run's
conclusion is `failure`. From 2026-11-23 to 11-25 this happened to 63 of 1,723
macOS jobs (about 1 in 25, from 1,000 CI runs), each after 15.0 to 29.6 min in
the queue. In the same window, macOS jobs that did get a runner waited up to 10
min at p95 and about 23 min at the worst.

**Recognise one.** On the run page the job has no steps and no log. From the
command line:

```sh
gh api repos/kodingcills/Myco/actions/jobs/<job-id> --jq '{conclusion, runner_id, steps: (.steps | length)}'
# cancelled, runner_id 0, steps 0
gh api repos/kodingcills/Myco/check-runs/<job-id>/annotations --jq '.[].message'
# includes "The job was not acquired by Runner of type hosted even after multiple attempts"
```

The run itself ends as `failure`. A run that ends as `cancelled` was superseded
by a newer push to the PR (see [Concurrency](#concurrency)), and you do not need
to re-run it.

**Re-run it by hand.** The job ran nothing, so a re-run repeats no side effect.
Maintainers (write access) can re-run it:

```sh
gh run rerun <run-id> --failed
```

Or use "Re-run failed jobs" on the run page. Contributors can push a new commit
instead. Before re-running a PR run, check that it is still the PR's newest run.
A re-run rejoins the PR's concurrency group, so re-running an older run cancels
the newer one.

An automatic retry is deferred to TIF-264. Until then, a no-runner cancellation
costs one manual re-run.

## vitest "Timeout calling onTaskUpdate"

**Symptom.** `check (macos-latest)` fails with every test passed and
`Errors 1 error`: `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`.

**Cause.** A vitest worker's progress RPC to the main process has a fixed 60 s
reply timeout, and the worker only reads the reply when its event loop gets a
turn. vitest moves between tests without one, so a file of synchronous tests
(`spawnSync` and friends) starves the loop for the whole file. On macOS runners
`test/guest-egress.test.ts` took 61-80 s in every failing run.

**Fix in place.** `vitest.config.ts` loads `test/setup/yield-to-event-loop.ts`,
which yields one event-loop iteration before and after every test, so only a
single synchronous test over 60 s can trigger it. If it comes back, find that
test and make its child processes async (`spawn`), as
`test/df005-contract-gates.test.ts` does. Do not re-run it away and do not set
`dangerouslyIgnoreUnhandledErrors`.

## What needs a maintainer

- **First-time contributors.** Depending on the repository's Actions setting, a fork
  PR from a first-time contributor waits for a maintainer to click "Approve and run".
  Which setting to choose: [public-release-safety.md](security/public-release-safety.md#admin-action-for-tiffany-first-time-contributor-approval).
- **`perf` label.** Add it to run the viewer verdict budget on a PR.
- **TIF-170 race diagnostics.** Manual runs (`workflow_dispatch`, with `runs`,
  `rounds`, `launcher` inputs) need write access.

## Rerunning

- Contributors: push a new commit to the PR branch.
- Maintainers (write access): "Re-run jobs" or "Re-run failed jobs" on the run page.
  A macOS job cancelled with no steps is a no-runner cancellation; see
  [macOS runner cancellations](#macos-runner-cancellations-tif-256).
- Locally, the targeted `check` job is `pnpm exec vitest run --changed origin/main` plus
  the smoke set `scripts/ci-plan.py` prints; per-area commands are in
  [CONTRIBUTING.md](../CONTRIBUTING.md#targeted-tests-per-area).
- Locally, the full `check` job is: `pnpm install --frozen-lockfile && pnpm typecheck &&
  pnpm lint && pnpm test && pnpm build`. The agent job: `cd agent && pip install -e .
  pytest && pytest -v`. The runtime job: `cd runtime && cargo test -p myco-rt-agent`
  (its confinement tests run only on Linux). The Linux path job, after installing
  `libreoffice-calc python3-uno`: `MYCO_LINUX_PATH_REQUIRED=1 pnpm exec vitest run test/linux
  && pnpm myco-linux --demo`. The safe-parallelism job, after also installing `xvfb`:
  `MYCO_PARALLEL_REQUIRED=1 pnpm exec vitest run test/parallel`.
- Lint workflows with [actionlint](https://github.com/rhysd/actionlint) before
  pushing a workflow change, e.g. `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`
  and then `actionlint` from the repo root. With shellcheck on `PATH` it also checks `run:`
  scripts. Its SC2016 info on `viewer-perf`'s "Report samples" step is expected:
  that step is a single-quoted `node -e` program.
