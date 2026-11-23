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

## Defensive engineering (standing rule, 2026-11-22)

**Every owner, builder and verifier applies this. It exists because two C1 bugs — a 15 s timeout nobody measured and a cleanup that reported a failed kill as clean — were unmeasured assumptions, not coding errors.**

### 1. Pre-mortem before touching VM/guest/host

Before building anything that touches the VM, guest or host, the owner writes the **top ~5 ways it can fail on the real target** and a test or guard for each. The categories to sweep: timeouts, partial cleanup, stale locks, missing fields across language boundaries, resource exhaustion, provider/API errors.

A build without a written pre-mortem is not ready for review.

### 2. Measure, don't guess

Every **timeout, budget or threshold** comes from a **recorded measurement on the real guest**, plus **explicit headroom**. `--version` through vssh: 5.7/6.4/6.8 s. CIM enumeration: 11.8 s. Therefore 15 s is not a budget, it is a guess; 45 s is a budget with headroom.

The **citation is the durable record of the measurement** — the PR, commit or evidence file that contains it — referenced from the constant's code comment. The measurement need not be inlined at the constant; it must be *findable from it*. A constant with no recorded measurement anywhere is rejected in review.

### 3. Fault injection for cleanup/recovery

Any **cleanup, kill, reset or recovery** path needs a test that **forces it to fail** and asserts the failure is reported as **dirty, never clean — and blocks scoring**. A cleanup whose failure renders as `killed=[]` is worse than no cleanup, because it is indistinguishable from success.

### 4. Contract tests across boundaries

When data crosses **TS / Python / Rust / PowerShell / JSON**, a test asserts **every field survives the round trip** — including error fields. PR #153's Python tests all passed while `AgentClient.kill` dropped `errors[]` on the TS side; the field never reached a caller. A layer's tests never prove the wire.

### 5. Mutation check

A fix's test **must fail when the fix is reverted**. Verifiers perform this themselves and paste both runs. A test that passes with the fix restored and with it removed is not a test.

### 6. Real-target smoke before sweeps

One end-to-end trial on the **real guest** with **timings recorded** before any multi-trial run. A green unit suite is not evidence that a sweep will start.

### 7. Abort early

A sweep **stops after 2 consecutive identical causes that reach the sweep loop** — a repeated `prepare` failure, or a repeated `planner-failed` — reporting `reason: "repeated-cause"`. This is the reachable scope in `runC1Sweep`; do not claim it covers a scored `driver-unreachable` row, which the pre-existing single-strike rule already stops on and which short-circuits before this counter increments.

Motivation: the C1 arm walked iteratively toward a spend-cap stop rather than an explicit one. The second identical cause is the signal; report it for diagnosis instead of burning the remainder of the budget.

### Verifier obligations

Verifiers check items **1–7 explicitly** in their verdict, by name, with pasted evidence. "Tests pass" is not a verdict on any of them. For item 5 (mutation check), paste both runs — mutated and restored. For item 7, state whether the code change's stated trigger is reachable.

### 8. A stale `node_modules` is a false red

`pnpm typecheck` failed on `error TS2307: Cannot find module 'fflate'` and two test files failed to load — on a clean `origin/main`. `fflate` was in `package.json` but not installed. The failures looked like real regressions and were not.

Run `pnpm install --frozen-lockfile` **before** diagnosing a failing gate, and before reporting a failure as pre-existing. A gate result from a tree whose dependencies do not match the lockfile is not evidence either way.

## Operating rules (Tiffany-approved, 2026-11-22 17:20 ET)

Three rules that replace blanket policies with risk-proportionate ones. They exist because the previous policy — one independent verifier at the exact head for every PR, one VM at a time, every long run inside an agent turn — cost more than it caught.

### A. Adaptive verification

Classify the PR **before** merging and **state the tier in the PR body**. Verifiers may bump a tier up, never down.

| Tier | What it covers | Requirement |
|---|---|---|
| **0** | Docs, prose, comments, state files. No executable code. | Green CI. **No verifier.** Prose nits never block. |
| **1** | Small, low-risk code: tests, tooling, viewer/UI-only, refactors with tests, **<~100 lines**, and touching none of the tier-2 paths. | **One** verifier round. Minor nits become follow-up issues, not re-rounds. A push after PASS that only touches docs/tests does **not** need re-verification. |
| **2** | Anything touching **scoring/verdicts, trial cleanup/recovery, VM/guest control, locks, spend caps, secrets, schemas, or M1 evidence numbers**. | Full independent verifier PASS **at the exact head** + green CI + the defensive checklist (pre-mortem, mutation check, fault injection). **Max 3 rounds**; still failing after round 3 → escalate to the outer loop with the disagreement rather than looping. |

Worked examples from 2026-11-22: #162 (sweep abort logic) is **tier 2** — it stalls trials. #157 (evidence README/JSON) is **tier 2** — its numbers are M1 evidence. #152 and #149 (docs rules) are **tier 0**. #148 (a test asserting a schema line) is **tier 1**.

**A push after PASS does not automatically void it.** What voids it is a *code* change. If the delta is docs/tests only, re-verify the delta, not the whole PR — three PRs today (#148, #162, #157) were re-verified in full for prose-only follow-ups.

### B. Do not serialize on the VM

The VM queue is **only** for work that truly needs the Windows guest. Every owner waiting on VM time works in parallel **now** on:

- code, unit and contract tests, fixtures, mocks
- **offline replays of recorded traces** (the arm's rows and trace events are on disk; most logic can be exercised against them)
- docs

Per-owner non-VM work: Runtime — RT-011 prep and a mocked e2e. Foundry — EF-005 fixtures and verifiers offline. Discovery/Dogfood — anything not needing the guest.

**Batch VM needs** so each slot is used fully, and keep **M1 (C1 arm, M1-016, scorecard) first** in the queue.

A second Windows VM is **not** approved until M1 lands; do not create one. Measure whether it would fit and report the number.

### C. Long runs are detached

Any run longer than a few minutes is launched **detached** — `nohup … & disown`, logging to a file, writing a pid file — with a **watchdog** that auto-resumes or reports. It is never tied to an agent turn: a run that dies when a turn ends produces a partial artifact nobody can distinguish from a failure.

**`setsid` does not exist on macOS.** Use `nohup` + `disown`, and redirect the child's stdout/stderr to a file: a detached process that inherits the caller's pipe keeps that pipe open, so the invoking shell (or agent cell) blocks until the run ends — which defeats the purpose. Verified the hard way; see `docs/coordination/m1-016-brief.md` for the working form.

A **pid alone is not a completion signal.** macOS reuses pids, so a recycled pid reads as "still running" forever. Wait on a marker the run writes as its last act, or on both.

The C1 arm is the model: `scripts/c1-baseline.sh` logs to `progress.log`, holds a lock, and survives the turn that started it.

## When a file enters typecheck (standing note, 2026-11-22)

Adding a file to the typecheck `include` list surfaces errors that are **sometimes type lies, not code bugs**. The cheapest fix — deleting the offending expression — silently removes real information.

Worked example (PR #150): adding `scripts/c1-sweep.ts` to the include produced `TS2339: Property 'backend' does not exist on '{agent_version, session_id}'`. The author deleted the log expression to satisfy tsc. Then the live run printed:

```
ping verified: {"agent_version":"0.1.0","session_id":"…","backend":"windows"}
```

`backend` exists at runtime; the **type** was wrong. The correct fix was to widen `ping()`'s return type to optional `backend` and restore the log.

Rules:

- **Before deleting code to satisfy a checker, ask whether the checker or the code is wrong.** A type that omits a field the runtime sends is a type bug; deleting the consumer hides it and loses information.
- **Prefer widening the type at the boundary** (the function that returns the value) over narrowing the consumer.
- **Never silence with `!` or `as`** when the real question is whether the value can be absent. A cast moves the failure to runtime, where it is more expensive.
- **A file newly added to typecheck is a discovery event, not a regression.** Expect it to surface latent type lies; triage each one rather than making the errors go away.
