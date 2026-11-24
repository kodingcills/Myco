
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

---

## Update 2026-11-24 — the path and inode, and a flaw in how they were read

The trace was extended to record `path=` and `ino=` per line (PR #364), to answer whether
the two claims are the same lock twice or two different locks.

### The capture (round 13, run 45316678834, 10 invocations x 40 rounds)

```
.808890100   s0.lock born            ino=8529976
.816359845   pid=15662  mkdir-won    path=.../run/s0.lock  ino=8529976
.821474865   pid=15668  mkdir-won    path=.../run/s0.lock  ino=8529976
.829...      s0.pid born
.834054328   pid=15666  mkdir-lost   path=.../run/s0.lock  ino=8529976
```

**Same path, one inode, two `mkdir-won`** 5.1 ms apart. `rc.1 = 0`, `rc.5 = 0`.

### Why that inode field cannot be read as "the inode this call created"

The lock was **born at `.808890100`**, 7.4 ms *before* the first `mkdir-won` at
`.816359845`. A successful `mkdir` creates the directory; the inode of what it created
would be stamped at the moment of the call. This trace samples `stat` on `$LOCK_DIR`
*after* the call, so it reports whatever the path is *now*, not what the call made.

That makes `ino=` useless for attribution here: it would print `8529976` for a winner, a
loser, and a late observer alike. **The field answers "does the lock exist at this
instant" and nothing more.** The finding that survives is narrower than it first looks:

- **both calls returned 0** (that is the `mkdir` exit status, not an inference);
- on the **same path**;
- with **no rmdir** in the capture;
- and a **single** lock inode.

### What would actually attribute creation

`mkdir` cannot report the inode it made, so the honest way to tell "created" from
"found existing" is to compare the lock's **birth time** against each call's own stamp:
the racer whose stamp is at or after the birth is the creator, and any *later* `mkdir-won`
on the same inode is a second success on an existing directory. That comparison is
available from the data already captured — the times dump carries the birth, the trace
carries each call — and it is what the next round should run on the existing artifacts
before any more instrumentation is written.

### Not claimed

`mkdir` returning 0 twice on an existing directory is not normal on ext4 or on the
container's overlayfs, where a direct test shows the second call losing. So either the
runner's filesystem differs in this respect, or something removes the lock in a way this
trace does not see. Both remain open; the five hypotheses tested so far are listed above.

---

## Update 2026-11-24 — a pre-call stamp, and why the birth comparison still does not attribute

Added a `pre=` stamp (taken immediately before `mkdir`) and a `birth=` field (the lock's
filesystem creation time, `stat -c %w` converted to epoch-with-fraction), so a line could
be classified as the creator or a later observer. Predicted discriminator: a creator's
`pre` is before the birth, an observer's is at or after.

### It does not discriminate. Measured, not assumed.

**A single racer that certainly created the lock** — three consecutive runs:

| run | `pre` | `birth` | birth minus pre |
|---|---|---|---|
| 1 | `.567152055` | `.566420976` | −0.73 ms |
| 2 | `.574754102` | `.573420942` | −1.33 ms |
| 3 | `.581798443` | `.580420908` | −1.38 ms |

In every case the filesystem's recorded birth is **about a millisecond earlier** than the
`pre` stamp of the very call that created it. So `pre < birth` is false even for a creator,
and the classifier is noise: across five 8-racer rounds it reported 0, 1, 0, 0 and **2**
creators, where the truth is exactly 1.

Two independent clock sources disagree at the sub-millisecond scale: `date +%s.%N` in the
shell and the kernel's `btime` as reported by `statx`. Neither is wrong; they are not the
same measurement, and the ~1 ms offset between them is larger than the interval the
comparison needs to resolve.

### What is still sound

- **`pre=`** is a real reading taken before the call, so it orders a racer's own call
  against any other racer's line. It cannot be compared with `birth=`, but it *can* be
  compared with another `pre` — which is enough to say which racer reached `mkdir` first.
- **`ino=` and `path=`** still hold (one inode, one path, from the previous round).
- The verdict on the mechanism is unchanged: **two `mkdir` calls return 0 on the same
  existing path with no `rmdir`**, and nothing yet names what makes the second one succeed.

### The next thing that would actually attribute

Not another clock read. Either:

- have the **winner write its own pid into the lock** at creation and read that back, so the
  lock names its creator directly rather than by timestamp; or
- classify by `pre=` order alone, which needs no birth at all: the racer with the earliest
  `pre` that also recorded `mkdir-won` is the creator, and any *later* `mkdir-won` is the
  anomaly. That is available from this round's data and needs no new instrumentation.
---
 
## Update 2026-11-24 — a pre-call stamp, and the split the old traces could not see

`lock_trace` now carries `pre=` (a timestamp taken immediately **before** `mkdir`, in the
racer's own process) and `birth=` (the lock's filesystem creation time). Two dispatches;
two rounds reproduced.

### The classifier works on `pre`, and it shows a pair, not a pair-of-anomaly

Round 12, all racers sorted by `pre` — the time each reached `mkdir`:

| `pre` (before the call) | pid | `mkdir` |
|---|---|---|
| `.596847043` | 29631 | **won** |
| `.597539782` | 29639 | **won** |
| `.599989147` | 29635 | lost |
| `.607108147` | 29633 | lost |
| `.608327607` | 29640 | lost |
| `.618819452` | 29641 | lost |
| `.624579493` | 29644 | lost |
| `.629688477` | 29645 | lost |

Round 14 has the same shape: the two earliest `pre` stamps both won (`.852359219`,
`.855467521`) and everything from `.868` onward lost.

**So the double-admit is the first *two* arrivals, and only those.** It is not one winner
plus a late anomaly — the boundary is between `pre=.5975` (won) and `pre=.5999` (lost), a
2.4 ms window at the start of the round. From the third racer onward the lock behaves
exactly as designed.

That is a sharper statement than any earlier round could make, because every earlier trace
sampled *after* the call and could not order the racers at all. It relocates the question
again: not "what removes the lock" (nothing does) but **"why do the first two arrivals both
get past a claim that admits one"** — a window at the start of a round, involving exactly
two processes.

### `birth=` remains unusable for ordering — confirmed again

The lock's `birth` in round 12 is `.605670525`, later than both wins, and in the
single-racer control it is consistently ~1 ms *earlier* than the `pre` of the call that
made it. Two clock sources that disagree by more than the interval being resolved. The
field is kept but must not be used to classify; `pre` order is the usable signal.

### Also fixed

A `local` inside the `--run` case branch — a runtime error (`local: can only be used in a
function`) that `bash -n` does not catch, found by the first fixture run.
