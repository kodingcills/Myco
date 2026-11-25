# CI

Myco's CI is GitHub Actions, in `.github/workflows/`. It is built so a pull request
from a fork runs the same checks as a maintainer's branch, with no secrets and a
read-only token (TIF-241).

## What runs on a pull request (including forks)

Every workflow that runs PR code is triggered by `pull_request`, never by
`pull_request_target`. On a fork PR GitHub runs the fork's code with a read-only
`GITHUB_TOKEN` and passes no repository secrets. No job here reads a secret, so
nothing is skipped or fails for lack of one. The one `workflow_run` workflow,
`ci-runner-retry.yml`, runs no PR code (see [macOS runner cancellations](#macos-runner-cancellations-tif-256)).

| Workflow | Job (check name) | Runs on fork PRs | Required on `main` |
| --- | --- | --- | --- |
| `ci.yml` | `secret scan (gitleaks)` | yes | yes |
| `ci.yml` | `check (ubuntu-latest)`, `check (macos-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (macos-latest)` | yes | no |
| `ci.yml` | `runtime guest agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `viewer verdict budget (…)` | only with the `perf` label | no |
| `tif-170-race-diagnostics.yml` | `race x1` | only when the PR touches its paths | no |
| `ci-runner-retry.yml` | `re-run jobs no runner picked up` | after a failed CI run, from `main`'s copy | no |

- **Secret scan.** gitleaks 8.30.1, downloaded and checked against a pinned SHA-256
  (it matches upstream's `gitleaks_8.30.1_checksums.txt`). It scans only the commits
  the PR adds, with findings redacted in the log. Enable the same check locally with
  `git config core.hooksPath .githooks`.
- **Viewer verdict budget.** A timing gate that is noisy on shared runners, so it runs
  on pushes to `main` and on PRs a maintainer labels `perf`. Only people with triage
  access or above can add labels, and a labelled fork PR still runs under
  `pull_request`: same read-only token, no secrets.

## Security posture

- **Least privilege.** Each workflow sets `permissions: contents: read` at the top
  level and no job widens it. The exception is `ci-runner-retry.yml`, which also has
  `actions: write` (to re-run jobs) and `checks: read` (to read annotations). It runs
  only `main`'s own files. Caching and artifact upload use the runner's Actions
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
11-25, once a runner had the job, macOS `check` took at most 3.5 min (p50 2.0) and
macOS `myco-agent tests` at most 0.9 min. A hang now ends as "timed out" in the
step that hung, not as an unexplained cancel. `viewer-perf` keeps 20. A timeout
counts from when a runner starts the job, so it never covers queue time.

## macOS runner cancellations (TIF-256)

**Symptom.** A `macos-latest` job shows "cancelled" after 15-20 min, with an empty
step list and no log. The check run's annotations say *"The job was not acquired
by Runner of type hosted even after multiple attempts"*, plus GitHub's notice
*"Due to capacity constraints, jobs targeting macOS arm64 runners may experience
longer queue times"*. The API shows `runner_id: 0` and zero steps.

**Cause.** GitHub had no macOS arm64 runner free and gave up on the queued job.
No step of ours ran, so it is not a test hang (pty, launcher, or otherwise), not
`timeout-minutes`, and not the PR concurrency group. Concurrency cancels the
whole superseded run, whose conclusion is then `cancelled`. Here the run's
conclusion is `failure`. From 2026-11-23 to 11-25 this happened to about 1 in 20
macOS jobs. While no runner is free, macOS queue time reaches 10 min at p95 and
over 20 min at the worst.

**Fix.** `ci-runner-retry.yml` runs when a CI run completes as `failure`, at most
for attempts 1 and 2. It calls `.github/scripts/rerun-unacquired.sh`, which re-runs
the run's failed jobs (`rerun-failed-jobs`) only if:

- every failed or cancelled job is a no-runner job (cancelled, `runner_id` 0, no
  steps, with the "not acquired" annotation). A real test failure stops it.
- for a PR run, no newer CI run exists on that branch. Re-running a superseded
  run would rejoin the PR's concurrency group and cancel the newer run.

A no-runner job ran nothing, so a re-run cannot repeat a side effect or hide a
flaky test. The cap means GitHub tries at most 3 times, about 45-60 min of
queueing in the worst case. After that the check stays cancelled. Re-run it by
hand or push again.

To check the script against a past run without re-running anything:
`REPO=kodingcills/Myco RUN_ID=<id> ATTEMPT=<n> DRY_RUN=1 .github/scripts/rerun-unacquired.sh`.

GitHub runs `workflow_run` workflows only from the default branch's copy, so a PR
that edits `ci-runner-retry.yml` or the script cannot exercise that edit.

## What needs a maintainer

- **First-time contributors.** Depending on the repository's Actions setting, a fork
  PR from a first-time contributor waits for a maintainer to click "Approve and run".
- **`perf` label.** Add it to run the viewer verdict budget on a PR.
- **TIF-170 race diagnostics.** Manual runs (`workflow_dispatch`, with `runs`,
  `rounds`, `launcher` inputs) need write access.

## Rerunning

- Contributors: push a new commit to the PR branch.
- Maintainers (write access): "Re-run jobs" or "Re-run failed jobs" on the run page.
  A macOS job cancelled with no steps is re-run automatically, up to twice (see
  above).
- Locally, the `check` job is: `pnpm install --frozen-lockfile && pnpm typecheck &&
  pnpm lint && pnpm test && pnpm build`. The agent job: `cd agent && pip install -e .
  pytest && pytest -v`. The runtime job: `cd runtime && cargo test -p myco-rt-agent`
  (its confinement tests run only on Linux).
- Lint workflows with [actionlint](https://github.com/rhysd/actionlint) before
  pushing a workflow change, e.g. `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`
  and then `actionlint` from the repo root. With shellcheck on `PATH` it also checks `run:`
  scripts. Its SC2016 info on `viewer-perf`'s "Report samples" step is expected:
  that step is a single-quoted `node -e` program.
