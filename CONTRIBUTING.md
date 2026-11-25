# Contributing to Myco

Thanks for your interest in Myco. This page is the short version for human contributors. The full
rules, written for the coding agents that do most of the work here, are in
[docs/coordination/CONTRIBUTING-agents.md](docs/coordination/CONTRIBUTING-agents.md) and
[AGENTS.md](AGENTS.md). Where this page and those disagree, those win.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems
privately, as described in [SECURITY.md](SECURITY.md), never in a public issue.

License: [Apache-2.0](LICENSE). By contributing you agree that your contributions are licensed under it.

## Setup

You need:

- **Node ≥ 24** (the `engines` field in [package.json](package.json)). An older Node only warns
  `Unsupported engine` at install, so check `node -v` yourself.
- **pnpm 10.** Use pnpm, not npm: `npm install` leaves the repo broken (see the
  [README](README.md#setup)).
- **Python 3** for the `python3 scripts/…` checks (standard library only).
- Optional: Python 3.12 with `pytest` for the guest agent tests in `agent/`, and a stable Rust
  toolchain for `runtime/`. CI runs both (see [docs/ci.md](docs/ci.md)).

```sh
pnpm install --frozen-lockfile
```

Turn on the local secret scan once per clone. It runs [gitleaks](https://github.com/gitleaks/gitleaks)
on staged changes before each commit; CI runs the same scan on every pull request.

```sh
git config core.hooksPath .githooks
```

## Checks

Run these before you open a pull request. They are what CI runs in the `check` job.

```sh
pnpm typecheck
pnpm lint
pnpm test
npx biome check .
```

`pnpm lint` already includes `biome check .`; running `npx biome check .` on its own gives a quick
answer while you edit. The guest agent and runtime jobs are `cd agent && pip install -e . pytest &&
pytest -v` and `cd runtime && cargo test -p myco-rt-agent`. [docs/ci.md](docs/ci.md) lists every
CI job, which ones are required on `main`, and how to rerun them.

## How a change lands

1. **Issue first.** Every pull request links an issue. Maintainers track work in Linear (team TIF)
   and mirror it in [docs/backlog/](docs/backlog/); if you are outside the team, open a GitHub
   issue and a maintainer will link it.
2. **Small pull requests.** One concern per PR. A PR that keeps finding real problems in review is
   split, not reviewed forever.
3. **Sync by merging `main`.** `main` is protected and requires branches to be up to date. Before
   you open a PR, and before each push for review, run `git fetch origin` and
   `git merge origin/main`.
4. **No force pushes.** Push new commits instead, so reviewers can see what changed since their
   last look.
5. **Never commit a secret.** No keys, tokens or passwords in code, logs, PR text or commit
   messages. Code loads keys from a file at the point of use (`src/baseline/secret-file.ts`).

## Review tiers

Each PR states its tier in the body. A reviewer may raise the tier, never lower it.

| Tier | What it covers | What it needs to merge |
|---|---|---|
| **0** | Docs, prose, comments. No executable code. | Green CI. |
| **1** | Small, low-risk code: tests, tooling, viewer-only changes, refactors with tests. | Green CI and one review round. Nits become follow-up issues. |
| **2** | Anything that decides a result or touches the machine: scoring and verdicts, trial cleanup and recovery, VM and guest control, locks, spend caps, secrets, schemas, M1 evidence numbers. | Green CI and a reviewer PASS on the exact head that merges, in at most three rounds. |

The full table and the reasons behind it are in
[CONTRIBUTING-agents.md](docs/coordination/CONTRIBUTING-agents.md#a-adaptive-verification-hard-round-cap-tiffany-2026-11-22-2215-et).

## Evidence stays recomputable

Myco's claims are only as good as the evidence behind them. Two rules follow:

- **A verdict comes from persisted application state, never from an agent's report.** A `refuted`
  row is a result, not a harness bug, and it is never dropped to improve a number.
- **Every number in [docs/m1-scorecard.md](docs/m1-scorecard.md) is recomputed from committed
  artifacts.** If you change a scorecard figure or the evidence behind it, this must still exit 0:

  ```sh
  python3 scripts/scorecard-check.py
  python3 scripts/check-scorecard-links.py
  ```

  A number that cannot be re-derived from committed data does not go in the scorecard.

## Live VM steps are maintainer-only

The end-to-end evaluation runs against a Windows 11 ARM64 guest whose ISO, offline payloads and
`clean-base` snapshots live outside the repo. Contributors cannot run those steps, and CI never
does. Everything else (core runtime, verifier, schemas, viewer, scorecard checks) runs without a
VM. If your change needs a live run, say so in the PR and a maintainer will run it following
[docs/eval-runbook.md](docs/eval-runbook.md).

## Where to read next

- [README.md](README.md): what Myco is and what runs today.
- [docs/eval-runbook.md](docs/eval-runbook.md): the live evaluation procedure.
- [docs/ci.md](docs/ci.md): CI jobs, fork pull requests, rerunning.
- [docs/coordination/CONTRIBUTING-agents.md](docs/coordination/CONTRIBUTING-agents.md): the full
  rules.
- [docs/agents/](docs/agents/): issue tracker, triage labels, reviewer briefs.
