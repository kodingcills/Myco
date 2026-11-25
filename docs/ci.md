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
| `ci.yml` | `check (ubuntu-latest)`, `check (macos-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `myco-agent tests (macos-latest)` | yes | no |
| `ci.yml` | `runtime guest agent tests (ubuntu-latest)` | yes | yes |
| `ci.yml` | `viewer verdict budget (…)` | only with the `perf` label | no |
| `tif-170-race-diagnostics.yml` | `race x1` | only when the PR touches its paths | no |

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

## What needs a maintainer

- **First-time contributors.** Depending on the repository's Actions setting, a fork
  PR from a first-time contributor waits for a maintainer to click "Approve and run".
- **`perf` label.** Add it to run the viewer verdict budget on a PR.
- **TIF-170 race diagnostics.** Manual runs (`workflow_dispatch`, with `runs`,
  `rounds`, `launcher` inputs) need write access.

## Rerunning

- Contributors: push a new commit to the PR branch.
- Maintainers (write access): "Re-run jobs" or "Re-run failed jobs" on the run page.
- Locally, the `check` job is: `pnpm install --frozen-lockfile && pnpm typecheck &&
  pnpm lint && pnpm test && pnpm build`. The agent job: `cd agent && pip install -e .
  pytest && pytest -v`. The runtime job: `cd runtime && cargo test -p myco-rt-agent`
  (its confinement tests run only on Linux).
- Lint workflows with [actionlint](https://github.com/rhysd/actionlint) before
  pushing a workflow change.
