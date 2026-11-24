
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
