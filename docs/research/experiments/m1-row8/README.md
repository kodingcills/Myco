# Row 8 — fresh-agent reproducibility test: RESULT

**Run 2026-11-24 05:04–05:40Z by the M1 coordinator.** Protocol from
`docs/m1-scorecard.md:167+`: one agent that had never seen the project, given **only** the repo
URL, the runbook, and the four snapshot names, attempts the runbook end to end and records every
point where the repo was insufficient.

**The operator's own report is preserved verbatim at
[`OPERATOR-REPORT.md`](OPERATOR-REPORT.md)** — 11.6 KB, written incrementally per step so
progress could not be lost. Everything below summarises it; the report is the evidence.

## Verdict: FAIL at §6 — and the failure is NOT cleanly attributable to the repo

| step | result | wall time | findings |
|---|---|---|---|
| §1.2 install/typecheck/lint/test/build | **PASS** | ~50 s | F1 |
| §2.0 `vm-state.sh` | **PASS** | <1 s | — |
| §2 `vm.sh status` | **PASS** | <1 s | — |
| §2 flock check | **CONFLICT** | <1 s | F3 |
| §2 `wait-ssh` + `whoami` | **PASS** | 18 s | — |
| §2 `smoke.ps1` | INCONCLUSIVE | 71 s | F4 |
| §3.1 `reset-trial-vm.sh` | **FAIL** `REFUSED_VM_LOCKED` | <1 s | F3 |
| §3.2 `reset.sh cold` | **PASS** | 279 s | F5 |
| §4 deploy | **PASS** | 418 s | F6, F7 |
| §5 `session_info` | **PASS** (exact match) | 9 s | — |
| §6 generator proof | **FAIL — 1/14 verified** | 900 s, killed at cap | F8, F9 |
| §7 trials/sweeps | **NOT RUN** — blocked by §6 | — | F10 |
| §8.2 `validate-live` | **PASS** | 1 s | F11 |

**The operator reached §5 with every expected output matching exactly** — host gate green,
VM sanity, cold reset, deploy (`DEPLOY OK`), and the desktop proof's JSON matching the runbook
field for field. **That is a genuine positive result for the repo:** a naive operator got from
nothing to a verified desktop session unaided.

**§6 is where it stopped**, and per the runbook's own rule (§6 is the "prerequisite for
reliability numbers") that correctly blocks §7.

## Why §6's failure cannot be read as a repo defect

**The operator measured 13/14 refuted with `observe-after-action` guard failures and 15 s
observation timeouts, and said so plainly:** *"Cannot be attributed to repo-vs-env without an
uncontended run (which the runbook itself demands and the environment did not provide)."*

**Measured at the time: load average 7.42 / 7.83 / 8.91, with no single CPU hog** (top process
4.5 %) — i.e. broad contention, not one runaway process.

**So the honest classification is INCONCLUSIVE, not FAIL-by-repo:** the runbook explicitly
requires a quiet host for reliability numbers, the environment did not provide one, and the
run did not fail in a way that distinguishes the two. **A re-run on an idle host is required
before any repo-side conclusion about §6.**

## The findings that DO stand, independent of load

| | finding |
|---|---|
| **F1** | runbook names `schemas/validate-artifacts.ts`; the pnpm alias is `schema-validate` |
| **F2** | §1.1 says `scripts/` is absent from main — **it is present** |
| **F3** | the flock read as "someone else owns the host"; see the coordinator note below |
| **F4** | no ordering guidance between the optional smoke check and the reset — the reset kills the smoke test mid-run |
| **F5** | §3.2 quotes ~20 s for a cold reset; measured **234 s to SSH, 279 s end to end** |
| **F6** | §4 quotes 100–180 s; measured **418 s** under load |
| **F7** | §4 expects `"session_id": 1` in ping; it is a hex GUID. `session_info` still reports integer `1` |
| **F8** | expected-result shape drift: `elapsedMs` null where the runbook shows numbers |
| **F9** | §6's recorded "20/20 verified (2026-11-20)" did not reproduce under contention — see above |
| **F10** | no guidance on what to do when the lock state contradicts the premise |
| **F11** | `validate-live` passed but the step's expected output is under-specified |

**The pattern across F1, F2, F5, F6, F7, F8 is one class: the runbook's quoted outputs and
timings are stale.** Every one is a one-line fix, and together they are the most valuable output
of this test — a contributor would never have noticed them, because they already know the answers.

## F3 was caused by the coordinator, not the runbook

**I held the VM flock with a watchdog to "reserve" the VM for this test.** The operator applied
the runbook's rule correctly — *a held flock is the only evidence of ownership* — found the
watchdog, and `reset-trial-vm.sh` refused. **I released it within minutes.**

**This is a real gap in the runbook, exposed by my own mistake:** there is **no way to express
"the VM is reserved for you"**. A reservation is indistinguishable from a competing owner, and a
naive operator has no move available. F10 is the same gap from the other side.

## What row 8 needs to be judged

1. **A quiet host** (load under the runbook's own threshold) for §6 and §7.
2. **F3/F10 resolved** — either the reservation is expressed in a way the runbook describes, or
   the coordinator simply does not hold the lock during the test.
3. **F1, F2, F5–F8 corrected** in the runbook, so the next operator's stop condition is a genuine
   repo gap and not a stale figure.

**Row 8 is therefore NOT passable as of this run, and the run should not be counted as a fail
against the repo.** It produced 11 findings and one clean positive (§1–§5).
