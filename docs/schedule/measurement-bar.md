# Track S: proposed pre-registered measurement bar (for the capability spec)

Status: **proposal, written before any run**, 2026-11-26. If `docs/product/capability-spec.md`
has landed, the spec adopts or amends this. If not, the PR body carries this text for the
spec to adopt. Nothing here has been run on a VM or a model, and no money has been spent.
Measurement runs are **not** part of the track S PR. They need the integrity fixes (#518,
the xlsx replacement for #503, the #494 follow-up) and the lead's GO, and run on Claude Ultra
only.

## The claim under test

> With Myco, an unattended (scheduled or triggered) desktop-agent run that is reported done
> is done. Without Myco, the agent's own report is all there is.

Unattended runs are where a false "done" costs the most, because nobody is watching. The
baseline arms can be started by the same triggers. The difference is that their completion
report is the agent's own claim, while Myco reports only a gate verdict.

## Arms

All three arms use the same model settings, the same tasks and fixtures, and the same trigger
schedule. They are paired by (task, fixture seed, fault class, trigger slot).

| Arm | Started by | "Reported done" means |
|---|---|---|
| **C1** (screenshot-only baseline) | the track S scheduler (same triggers) | the agent claims done |
| **hcu+shell** baseline | the track S scheduler (same triggers) | the agent claims done |
| **Myco-S** (same agent + gate) | the track S scheduler | the row is `accepted` (gate `verified`) |

Using the same scheduler for all arms isolates the gate's contribution from trigger
plumbing. Trigger fidelity is measured separately (bar T below).

## Tasks and sample size

The fc-v1 task set (`benchmark/false-completion/fc-v1`), calc-record-edit family, CSV
persistence (the gate stays CSV-only until the xlsx replacement lands). This follows
Foundry's sample-size policy (docs/product/mvd-preregistration.md §1).

- **60 scheduled runs per arm**: 30 refutable fault-class trials (kill-app, delayed-save,
  focus-change and invalid-target, as balanced as the bundle allows) and 30 normal
  (`none`) trials. The schedule assigns them to cron, inbox and webhook triggers in equal
  thirds.
- Every trial of every arm counts, including harness-faulted and topped-up attempts (#511
  semantics), and R1 runs over all fc-v1 trials.

## Grading

The **independent grader** (`src/benchmark/grade`, which shares no code with the gate or the
scheduler) grades the persisted document of every trial in every arm. Grader `pass` is the
ground truth. Simulated rows never count: a row is evidence only if `simulated: false`, its
planner is a Claude model id with evidence provenance, and it passes `checkBenchmark(...,
{ evidence: true })`.

## Metrics and tests

Primary, **false completion among runs reported done** (FC): reported done, but the grader
says not `pass`.

- **Bar P1 (absolute)**: Myco-S has 0 false completions over the 30 refutable trials.
  At n=30, the Wilson 95% upper bound is 0.114.
- **Bar P2 (versus each baseline)**: paired exact two-sided sign test (exact McNemar) on
  discordant pairs. A discordant pair is one where one arm falsely completed and the other did
  not. α = 0.05 with Holm correction across the two baselines. With fewer than 6 discordant
  pairs the report says **underpowered** and makes no superiority claim.

Secondary, reported with Wilson 95% intervals and not gating:

- **Verified completion rate**: reported done AND grader `pass`, over all 60 runs.
- **Failure-notification recall (Myco-S)**: the share of grader-failed runs that notified.
  Target 1.0. The baselines have no notifier; their analogue, the agent saying "not done",
  is reported alongside.
- **R7, cost per verified task**: total estimated cost of ALL trials divided by the number
  verified. A null cost is never counted as 0. Cost is a token-derived ESTIMATE, never billed
  USD.

Scheduler-specific, **bar T (trigger fidelity)**, from the ledger and claims of the same
runs, and also checkable at $0 with the scripted executor:

- every trigger produced exactly one run or one recorded skip;
- 0 double runs (no duplicate trigger key ran);
- 0 runs started while paused;
- no per-schedule budget (runs/day, concurrency, wall time) exceeded;
- the ledger chain verifies end to end.

Any violation fails track S, whatever P1 and P2 say.

## Decision rule

Track S **passes** when T holds, P1 holds, and P2 is significant against both baselines. If
P2 is underpowered, the result is reported as a demonstration, not a rate. No public
leaderboard.
