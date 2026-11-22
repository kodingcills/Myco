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

## Content-identity merge rule (coordinator ruling, 2026-11-22)

**Problem it solves:** branch protection requires "up to date with main", and main moves faster than a ~2 minute CI cycle. Every `update-branch` creates a new head, which invalidates a verifier PASS; the run then needs re-verification while main moves again. One verified 6-line change was rebased seven times without landing.

**Rule — all four must hold, and all four are stated in the PR body:**

1. `git diff <verified-head> <merge-head> -- <every path in origin/main...merge-head>` is **empty for all non-docs paths**.
2. Any remaining difference is docs only (`docs/coordination/`, `docs/backlog/`) — never a doc a reader could mistake for specification.
3. CI is green on the merge head.
4. The PR records the verified SHA, the merge SHA, and the command output proving zero non-docs change.

If any non-docs path differs, it needs a fresh PASS. No exceptions. Docs drift alone does not reopen verification, because a state-log line cannot change what code does.

### Test-only extension (2026-11-22, after #112)

A delta that is **provably test-only** may merge without a fresh PASS when ALL of:

1. **Zero deletions** in the delta.
2. **Every hunk lies inside a test module** (`mod tests` / `#[cfg(test)]`) — verify by comparing the hunk header line number against the module's start line.
3. **CI green on the merge head** (CI executes the tests, so CI *is* the verification for a test-only delta).
4. The PR records the verified SHA, the merge SHA, and the proof: deletion count, hunk header, and the test-module start line.

**Production code differing from the verified head still requires a fresh PASS. No exceptions.** A test cannot change what production code does; a production change can alter behaviour in ways CI does not cover.

Worked example (#112 at `246cd302`): one runtime path differed from the verified heads, so content-identity did **not** hold. The delta was 0 deletions / a single hunk `@@ -97,0 +98,21 @@ mod tests {` with `mod tests` at line 67 — two new tests, no production line touched. Mergeable under this extension.

The **addition count depends on the comparison base**: `74074d7 -> 246cd302` is `21/0`, while earlier verified heads give a smaller count because they predate a comment reflow. State the base alongside the number, or the figure is not reproducible. Prefer the stronger check over the hunk label — compare the region above `#[cfg(test)]` directly:

```bash
F=path/to/file.rs
diff <(git show <verified>:$F | sed -n "1,$((line-1))p") \
     <(git show <head>:$F     | sed -n "1,$((line-1))p")
```

Empty output means no production line changed, independent of how the diff was framed.

**Why not a merge queue:** enabling one is a repository-settings decision for the outer loop, not the coordinator. Auto-merge is already on and helps throughput but does not fix verifier invalidation, since `update-branch` still produces a new head.

**Verifier reading rule (from a false REJECT):** a verifier claimed a PR contained no `runtime/` changes because the author had reset a shared worktree while it was reading. Verifiers must be given the SHA and must read objects (`git show <sha>:<path>`), never the working tree, and authors must not mutate a worktree while a review is reading it.

## VM queue gate (standing rule, Tiffany via outer loop, 2026-11-22 14:27 ET)

**Never gate VM work on AC power.** The charger state is not a scheduling condition. A VM slot may be granted on battery.

The only gates that remain:

1. **`memory_pressure` / `vm_stat` not critical** — no warn/critical pressure, free pages present.
2. **The VM lock is held by exactly one owner at a time** — acquire `LOCK_EX` before any VM action; back off immediately if unavailable; never retry in a loop.

**Load average alone is not a reason to hold the queue.** It may be reported for context, and a run may be *paused* mid-flight if the host becomes unusable, but it must not block a grant.

Removed by this rule: the AC-power gate, the swap-free gate (swap grows on demand on macOS, so it is not a pressure signal), and the "load under 8 sustained" watcher. The watcher script was deleted rather than left dormant, so it cannot be restarted by habit.

**Consequence for owner code:** any harness that refuses to run because of charger state must drop that check. `src/baseline/c1-trial.ts` had `if (!prepared.acPower) throw new Error("AC power required")`; that gate is to be removed, and the same edit must move the precondition inside the cleanup scope so an abort at entry cannot leave guest processes behind.

## Worktree isolation (standing rule, 2026-11-22)

**One worktree per agent. A verifier never reads the working tree of the agent it is reviewing.**

Two incidents on 2026-11-22, same class:

1. A verifier returned REJECT claiming a PR contained no `runtime/` changes. It was false: the author had reset a shared worktree while the verifier was reading it, so the verifier saw `main`'s files.
2. A verifier's mutation edits landed in another agent's working tree because that worktree was switched out from under it mid-review (to `origin/main`, then to a feature branch).

Rules:

- **Authors:** never reset, checkout, rebase, or stash a worktree while a review is reading it. If you must switch branches, do it in your own worktree and tell the reviewer.
- **Verifiers:** read objects, not files — `git show <sha>:<path>`, `git diff <sha>..<sha>`, `git cat-file`. Never trust the working tree of a checkout you did not create.
- **Verifiers:** run mutation tests and any write-touching check in an **isolated worktree at the pinned SHA**, then remove it. Never mutate a shared checkout.
- **Coordinators:** when briefing a verifier, give it the exact SHA and say "read objects, not the working tree". A verdict is only meaningful for the SHA it names.

Why it matters: a verifier reading a mutated worktree produces a confident, wrong verdict — either a false REJECT that wastes a fix cycle, or a false PASS that lets unverified code land. Both are worse than no review.
