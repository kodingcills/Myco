# Contributing — agents

## Main is protected (2026-11-21)

`main` is protected via GitHub branch protection (classic). Direct pushes, force pushes, and branch deletion are blocked for everyone, including admins. Every change — code or docs — reaches `main` only through a merged pull request.

Settings on `main`:

- Pull request required before merging; **0 approving reviews** required (agents self-merge after an independent verifier PASS).
- Required status checks (exact names): `check (macos-latest)`, `check (ubuntu-latest)`, `myco-agent tests (macos-latest)`, `myco-agent tests (ubuntu-latest)`.
- Branch must be up to date with `main` before merging (rebase/merge-base push before merge).
- Force pushes and deletions blocked; enforced for admins (no bypass).

The historical exception ("coordinator may push docs/coordination state-log commits directly to main") is **revoked**. It was the mechanism behind merge-rule breaches #24/#25/#27/#28 (a `git push origin HEAD:main` from a worktree sitting on a feature branch carried code to main). The protection makes it impossible anyway; do not try.

## Lightest flow for docs/coordination updates

Docs-only changes (e.g. `docs/coordination/*-state.md` log entries) still go through a PR, but with the lightest possible path:

```bash
git switch -c docs/coord-$(date -u +%Y%m%d-%H%M) origin/main
# edit docs/coordination/*.md
git commit -am "docs(coordination): <what>"
git push -u origin HEAD
gh pr create --fill --base main
gh pr merge --squash --auto   # merges itself once CI is green and branch is current
```

- No verifier needed for docs-only diffs, but the PR diff must contain **only** `docs/**` — if it touches anything else, the full code rules (verifier PASS + CI at the exact head) apply.
- `--auto` lets GitHub merge when the 4 required checks pass; if the branch falls behind, `git fetch origin && git rebase origin/main && git push --force-with-lease` (allowed on your own feature branch; force is only blocked on `main`).
- Never check out a feature branch in a worktree and then push `HEAD:main` — that path is now closed and was the source of past breaches.

## Code changes (unchanged)

1. PR from a feature branch.
2. Merge ONLY when BOTH hold at the same head SHA: independent verifier PASS **and** all 4 CI checks green.
3. Reviewers/verifiers state the head SHA they verified.

## Model policy (standing, outer loop 2026-11-21)

- **Verifiers, reviewers, and any judgment subagent: `cheaperinference/deepseek-v4.1-flash`.**
- **Builders: `cheaperinference/glm-5.3`.**
- **No new `cheaperinference/kimi-k3` threads** — too expensive. A kimi-k3 verifier already running may finish; nothing new starts on it.
- The coordinator itself runs on kimi-k3 as the parent session; that is a platform fact, not a policy exception.

Rationale: verification is the highest-frequency role (every PR needs one, most need a re-check after fixes), so it carries the largest cost exposure. deepseek-v4.1-flash has proven adequate for the mechanical checks that matter (diff scope, command-by-command verification against the repo, stub tests, running the gates) when the brief is specific about what to attack.

## Sub-thread delegation (standing, outer loop 2026-11-21)

A task too complex to hold in the main thread may be split into sub-threads or subagents. Two conditions:

1. **Every sub-thread gets its own independent verifier.** A child that both builds and declares its own work good is not verification.
2. **The coordinator reports each one** — what it owns, its branch/PR, and its verdict — in the end-of-turn report.

## Verifier brief requirements (learned the hard way)

Every verifier brief must state, explicitly:
- the exact head SHA to verify, and that a verdict covers only that SHA;
- whether VM access is allowed (during a sweep: **never**, stubbed or not);
- `MYCO_VM_SCRIPTS=... bash script.sh` must be one command, never a preceding export — a separated export silently fell through to the real VM and killed a live sweep (PR #32 incident);
- what evidence to paste, and the exact final-line format.
