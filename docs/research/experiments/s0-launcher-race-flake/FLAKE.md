
---

## Update 2026-11-24 (later) — the guard window is not it either

**Goal.** Test whether the pid-file guard window is where the second claim slips through.

**Hypothesis.** `--run`'s guard reads `$PID_FILE`, and `$PID_FILE` is written *after* the
claim, so on a round's first claim the guard sees nothing and `mkdir` alone decides. If a
racer passes the guard and, before its `mkdir`, a concurrent teardown removes
`$LOCK_DIR`, that `mkdir` succeeds alongside the real winner.

**FALSIFIED.** Three arms, one dispatch each, identical parameters (6 invocations × 40
rounds):

| Arm | Launcher | Window | Failing rounds |
|---|---|---|---|
| A | `s0-live.sh` (baseline) | as shipped | 1 |
| B | `s0-live-guardclosed.sh` | **closed** — guard asks the lock | 0, 12 |
| C | `s0-live-guardwide.sh` | **held open 50 ms** | 14 |

Closing the window did not remove the double-admit (B failed twice, more than the
baseline), and widening it 50 ms did not raise the rate (C once, the same as A). Every
failure has the same signature: two `pid N` lines, two racers at `rc=0`, six refusals —
so it is the same mechanism in all three arms.

- A: <https://github.com/kodingcills/Myco/actions/runs/45312593627>
- B: <https://github.com/kodingcills/Myco/actions/runs/45312596920>
- C: <https://github.com/kodingcills/Myco/actions/runs/45312600265>
- branch `tif-170-guard-window`, PR #360

### Hypotheses tested and ruled out

| Hypothesis | Experiment | Result |
|---|---|---|
| The loser's process tree survives (killed by pid, not group) | descendant census, 100 loaded rounds | no surviving grandchild; never two claims |
| The winner's watchdog removes the lock during its own teardown | 40 rounds sampling the lock every 20 ms | zero flaps |
| `--stop`'s unconditional rmdir clears a live lock | two-arm dispatch vs an owner-checked `--stop` | both arms reproduced |
| The pid-file guard window | three-arm dispatch: closed vs widened vs baseline | all three reproduced |

### What the experiments have established

- It is a **real double-admit**: two `mkdir` calls both return 0 (proved by two `pid N`
  lines, which is the only place `say "pid $CHILD"` runs).
- It needs **many cores' worth of contention to show**: ~1 round in 5 on 4-vCPU ubuntu,
  zero in ~13,000 racer invocations on a 14-core dev host.
- It is **not** any of the four candidates above, and it is **not** sensitive to the
  guard→claim window at all, which rules out the whole class of "a teardown between the
  two steps" explanations.

### What is left, honestly

Nobody has named the remover. Every candidate that removes `$LOCK_DIR` has been tested
with a discriminator on the runner that reproduces the bug, and none moves the rate.

The next thing worth doing is not another hypothesis but **direct observation**: the
diagnostics need to record *which* process removes the lock, with a timestamp, in the
failing round. That means `--run`, `--stop` and the watchdog stamping their own
`mkdir`/`rmdir` with `$$` into the round's log — a launcher change that belongs with a
fix, not with a diagnostics branch, and one this harness can then exercise.

---

## Update 2026-11-24 — the lock trace, and what it rules out

Instrumentation was added (`lock_trace` in `scripts/s0-live.sh`, PR #362) so every
`mkdir`/`rmdir` on the lock is stamped with its pid and a sub-second time. Two dispatches
reproduced the race; the second carries usable ordering.

### The capture (round 27, run 45314693888)

Ordered by the trace's own sub-second stamps:

| time | pid | op |
|---|---|---|
| `.084626460` | — | `s0.lock` born (one inode, 8543836) |
| `.099621877` | 64235 | `mkdir-won` |
| `.103022761` | 64232 | **`mkdir-won`** |
| `.108161519` | 64234 | `mkdir-lost` |
| `.109607515` | 64230 | `mkdir-lost` |

`rmdir-before` + `rmdir-done` lines in the whole capture: **0**. `s0.lock` entries in the
times dump: **1**. Winners: `rc.2 = 0`, `rc.4 = 0`.

### What that means

Two `mkdir` calls returned 0 **3.4 ms apart, with the lock already present and never
removed**. So **the lock is not being removed at all** — which is why all four earlier
hypotheses failed: every one of them was a theory about *what removes the lock*, and the
answer is that nothing does.

That relocates the question. It is no longer "who removes the lock" but "how can a second
`mkdir` on an existing path return 0". Candidates a future attempt should look at, none
yet tested:

- whether both winners are actually creating the **same** path (the trace records pid and
  op, not the path or the resulting inode, so this is unproven);
- whether `$RUN_DIR` differs between racers in a way that makes `$LOCK_DIR` differ;
- whether an `rmdir` happens in a process this trace does not cover (a *previous* round's
  watchdog tearing down against the same `RUN_DIR` after the next round started).

### The instrumentation's own gap

The trace records pid and op but **not the path and not the resulting inode**, so it
cannot distinguish "same path twice" from "two different paths". Adding both — plus the
inode of what each `mkdir` created — is the obvious next increment, and it is a small
change to `lock_trace`'s printf rather than a new experiment.

Recorded here because it is the first result about the mechanism rather than about a
candidate for it.
