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
| `ci.yml` | `secret scan (gitleaks)` | yes | yes |
| `ci.yml` | `ci hygiene (workflows)` | yes | no |
| `ci.yml` | `check (ubuntu-latest)`, `check (macos-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (macos-latest)` | yes | no |
| `ci.yml` | `runtime guest agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `linux path (ubuntu-latest)` | yes | no |
| `ci.yml` | `safe parallelism (ubuntu-latest)` | yes | no |
| `ci.yml` | `m2 evidence and scorecard` | yes | no |
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
  verified there). Strict namespace isolation is not in this job. See
  `docs/product/safe-parallelism.md`.
- **M2 evidence and scorecard.** `scripts/m2-evidence-check.ts --all` checks every
  committed `docs/research/experiments/m2-*` pack (schemas, the shared benchmark ledger,
  a cause on every non-verified row, the guest load gate record), then
  `scripts/m2-scorecard-check.py` recomputes every number in `docs/m2-scorecard.md`
  (TIF-273). The same tests also run in `check` through `pnpm test`.
- **Viewer verdict budget.** A timing gate that is noisy on shared runners, so it runs
  on pushes to `main` and on PRs a maintainer labels `perf`. Only people with triage
  access or above can add labels, and a labelled fork PR still runs under
  `pull_request`: same read-only token, no secrets.

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
- Locally, the `check` job is: `pnpm install --frozen-lockfile && pnpm typecheck &&
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
