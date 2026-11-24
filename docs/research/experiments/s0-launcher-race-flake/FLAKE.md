
---

## Update 2026-11-24 — the hypothesis that was killed, and what is now measured

### It is a real double-admit, not a bad reading

The open question above ("nobody has measured which") is answered. On unmodified
`scripts/s0-live.sh`, a failing round's capture contains **two `pid N` lines** in
`s0.log` and **two live `bash .../s0-live.sh --watchdog` processes** in the `ps` taken
after `wait` and before `--stop`. `say "pid $CHILD"` is emitted only after
`mkdir "$LOCK_DIR"` returns 0, so **two `mkdir` calls both succeeded** on a path that was
absent at both moments. Two racers really did exit 0.

That rules out the "log read mid-write" reading. The `--stop`-ordering artefact is not
involved either: the snapshot precedes `--stop`.

### Frequency, and why the dev host never saw it

| Host | Rounds | Double-admits |
|---|---|---|
| ubuntu-latest (`nproc=4`), 5 invocations | 9, 18, 18, 19, 23 | **~1 round in 5** |
| 14-core macOS dev host | ~13,000 racer invocations | **0** |

The gap is core count. This is why every local sweep came back clean.

### Hypothesis tested: `--stop`'s unconditional `rmdir "$LOCK_DIR"` — FALSIFIED

**Statement.** The test calls `--stop` every round; `--stop` removes the lock without
asking who owns it. If that removal lands after a later racer claimed, a second `mkdir`
succeeds. Prediction: an owner-checked `--stop` (remove only when no live process owns
the lock) would stop the double-admit.

**Method.** One workflow dispatch per arm, same parameters (6 invocations × 40 rounds),
against `scripts/s0-live.sh` and against a variant differing only in that `--stop` block.

| Arm | Launcher | Failing rounds |
|---|---|---|
| A | shipped | 15 |
| B | owner-checked `--stop` | 6, 11 |

Both arms reproduced, and B's capture shows the identical signature — two `pid N` lines
(5195, 5197), `rc.5=0` and `rc.8=0`, six refusals. **The owner check does not prevent
the second claim.**

- A: <https://github.com/kodingcills/Myco/actions/runs/45302113079>
- B: <https://github.com/kodingcills/Myco/actions/runs/45302130418>
- branch `tif-170-stop-variant`, commit `bf524683`

### What this leaves

The remover has still not been named. What is settled:

- two `mkdir` calls succeed, so something removes the lock between them;
- it is not the loser's process tree (no surviving grandchild; the tsx grandchild dies
  with its watchdog);
- it is not the winner's own watchdog teardown (40 pristine rounds sampling the lock
  every 20 ms: zero flaps);
- it is not `--stop`'s unconditional rmdir, by this experiment.

The remaining candidate is the **pid-file guard window**: between the guard reading
`s0.pid` and the `mkdir` that claims, a concurrent round's teardown can clear both. That
is testable the same way — dispatch with the guard's window widened by a sleep — and the
harness to do it now exists on main.
