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
| §8.2 `validate-live` | **PASS — but on fixture dirs, not run evidence** (F11) | 1 s | F11 |

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
| **F11** | **`runs/` is contaminated by test fixtures before §8.2 validates it** — see below |

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

### F11 is more serious than "minor": §8.2's PASS is not evidence

**The operator's finding, verified:**

- `runs/` is **gitignored** (`.gitignore:3`), so a fresh clone has none.
- **§1.2 runs `pnpm test`**, which creates fixture dirs there. Measured after a test run:
  `direction-a-todo-save`, `direction-a-todo-save.mycotrace`, `run-df-s01-1`,
  `test-dir-b-clean`, `test-dir-b-interrupted`, `test-dir-c-comparison` — **6 dirs**.
- **§8.2 then runs `validate-live` over `runs/`, and it reports `ALL OK`** — because the
  fixtures are schema-valid.

**So the runbook's own order (§1 tests, then §8 evidence validation) makes the evidence check
pass on artifacts the *repo's tests* produced rather than on any run the operator performed.**
A naive operator reads `ALL OK` as "my evidence validates". **It is a false PASS, and it is the
one step in the table that cannot be trusted at face value.**

**Fix:** §8 should validate an explicit run directory (or `runs/` should be emptied between
§1 and §8), and the runbook should say that `pnpm test` populates `runs/` with fixtures.

## §6 diagnosed: the guest was contaminated, not the generator

**Follow-up check 2026-11-24, after the row-8 run.** Running the runbook's own §6 command on the
guest the operator had left:

```
pnpm exec tsx src/integration/run-live.ts --mode values --limit 20

20 rows, all "uncertain", exit 1. Every row reason:
  could not look: guest contaminated — leftover run dirs:
  myco-54774-1795498578019-67975384; leftover profiles: ...;
  refusing to read a foreign document
```

**The guard is working correctly.** The leftover run dir is from the **operator's own earlier §6
attempt** (§1–§5 ran before it), and `run-live` **refused to read a foreign document rather than
report a verdict about someone else's run.** The runbook warns about precisely this: *"running it
on a contaminated guest measures the contamination, not the generator."*

**So the row-8 §6 failure (1/14, then 13/14 refuted) was contamination plus contention — NOT a
generator defect**, which is consistent with the operator's own caution that it could not be
attributed.

**Consequence for the re-run protocol:** the guest must be **reset and verified clean** before the
operator starts, not merely idle. **The first run's operator inherited a guest left dirty by its
own precondition steps** — a harness flaw, not an operator error, and it is why a fresh-agent test
needs the environment prepared *before* the agent begins.

**Not yet established:** whether §6 passes on a genuinely quiet host (load < 4). The follow-up
check ran at load 5.8–10.0, so it cleared the contamination question but **not** the contention
one. A clean-host §6 remains outstanding.

## §6 on a cleaned, owned guest — 2026-11-24, 16/16 verified, 0 refuted

Two attempts after resetting the guest and removing the residue above. **No row was refuted and
no row failed a generator check.** Neither run finished, for two unrelated reasons, and both are
now runbook steps.

### Attempt A — 06:19–06:33Z, 15 verified, then the host process vanished

```
runs/values/<runId>/result.json     15 rows   all "verified"
runs/values/f1b42488-…/             empty     trial 16 started, never wrote a result
```

The 15 rows span 06:19:43–06:33:04 at ~48 s each, one cell per row, e.g.
`cell B39 (record EMP-0038, column name) persisted as "REVISED-908578"`. At 06:33:04 the dir for
trial 16 was created and the process was gone. **No crash report, no stack, no output**: the log
held only the `agent ping ok` line, because `run-live` writes its JSON array once at the end of
the loop (`src/integration/run-live.ts:156`) — **a silent log is the expected shape of a healthy
`values` run, not a symptom.** Cause unproven; the process was not survivor-detached, so a
harness/session teardown is the leading hypothesis and is untested.

Leftovers after it: one guest run dir `myco-80877-1795501985546-716442753`, no `soffice`.

### Attempt B — 06:37–06:40Z, 1 verified then 19 harness aborts

Relaunched detached via the broker, after deleting the guest residue (`--runs-dir runs/s6-clean2`).

| row | elapsed | verdict |
|---|---|---|
| 1 `name` | 44 656 ms | **verified** — `cell B39 … persisted as "REVISED-908578"` |
| 2 `qty` | 99 135 ms | uncertain — `UNO readback of C24 failed — ssh tunnel is not running` |
| 3–20 | 0–1 ms | uncertain — `agent unreachable — ssh tunnel is not running (call start() first)` |

**A concurrent driver cold-reset the guest underneath the run.** Measured from the host, not
inferred:

```
01:38:14 local (06:38:14Z)  bash scripts/reset-trial-vm.sh cua-c1-base   # baseline worktree, pid 36434
01:38:21 local              bash .../wait-guest-ready.sh 600             # pid 36523
01:38:40 local              QEMU pid 44955 -> 36509                      # the guest restarted
```

`run-live` **takes no VM flock** — `scripts/m1-sweep.sh` sources `scripts/vm-lock.sh`, this
entrypoint does not — so the §6 attempt held no ownership evidence and the driver's
`vm_lock_acquire` succeeded rather than refusing. The tunnel then died with the guest, and
`SshTunnel.call` rejects immediately when its child is gone (`src/win/agent-client.ts:296-299`),
which is why the remaining rows cost 0–1 ms each.

### What this changes

| | finding |
|---|---|
| **F12** | **`run-live` holds no VM lock, so §6 can be reset out from under while it runs.** A driver that legitimately acquires the lock cannot detect it. Every later row degrades to a 0 ms `uncertain` and the run exits 1 looking like a generator failure. Runbook §6.2 now requires a proven-free flock and no running driver. |
| **F13** | An aborted §6 leaves a guest run dir that fails **every** row of the next attempt with one `guest-contaminated` reason. Runbook §6.1 now verifies cleanliness and gives the cleanup. |
| **F14** | A `values` run prints nothing until the loop ends, so "no output after 15 minutes" is **not** evidence of a hang. Liveness is the guest run dirs, one every ~48 s. |
| — | F8 is corrected, not reproduced: `elapsedMs` is a number in every row tonight (44 656, 99 135, …), not `null`. |

### Status of the §6 gate

**§6 is not refuted.** On a guest that was clean and belonged to the run, 16 of 16 rows verified
and none was refuted. **It is also not yet passed:** `20/20` has not been observed on a quiet
host, because both attempts were cut short by infrastructure. The gate stays open, and §7 stays
blocked behind it, until one uninterrupted 20-row run exists.
