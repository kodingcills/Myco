# The live run has no watchdog, and the watchdog is watching a finished run

**Measured 2026-11-24 by the M1 coordinator.** Part of it is in the owner's own report, read
as describing the live arm.

## The mismatch

```
c1-arm003d-r3   ("r3" in the owner's report)
  finished 2026-11-23T23:13:17Z
  ledger: 2 scored, 28 omitted (reason: repeated-cause)
  watch.pid 20296 -> DEAD;  watch.log last written 18:15
  omit reason is `repeated-cause` = the abort-early rule fired correctly

c1-r6           (the run actually live)
  sweep pid 6251, wrapping pid 6233, caffeinate 6240/6253
  trial 10 at the time of writing; ledger 11 rows
  contents: accounting.json, progress.log, trials/  -> NO watch.pid, NO watch.log
```

**So the watchdog is correct and guarding nothing, while the paid run is unguarded.** The
owner's watchdog fix (write the loop pid, not the subshell's) is right and worth keeping —
but it was applied to a run that had already ended.

**An unguarded paid run cannot detect the condition it is there for:** a sweep that stops
making progress while spending. That is the whole point of `watch-c1-arm.sh`.

## Which is why the budget finding matters more, not less

`c1-r6` is at **73.5% of the ceiling** (prior 4,480,732 + booked 2,134,430 = 6,615,162) with
**16 trials still to attempt**, and it has **no guard watching for exactly the failure mode
that would make the remaining spend unrecoverable.**

The owner's figure — `booked 607,200 + trial 0's 104,830 = $0.7120`, "52.7% used" — reads a
one-trial snapshot. The ledger has **8 scored rows**. See `R6-BUDGET-WALL.md`.

## The owner's watchdog correction is sound and should not be lost

- `watch.pid` held `20294` (the backgrounded **subshell**, which `exec`-replaces itself) while
  the real loop was `20296`. **The bug was in the launcher form, not the watchdog.**
- A `watch.log` with no new line for a few minutes is **normal** for a 300 s sampler, not
  death. My earlier "watch.log stopped at 18:05" reading was wrong for the same reason.
- Their fix — `pgrep -f "watch-c1-arm.sh OUT"` after a `sleep 1` — writes the real pid.
- They briefly ran two appenders on one log and killed the duplicate. **Both were theirs, and
  both are cleaned up.**

**Same class as the `setsid` error: the launcher form was assumed rather than measured.**
That is now three launcher-form assumptions in one workstream (`setsid`, `$!`, and passing
the ceiling where the remainder belongs).

## Not established

Nothing is claimed here about whether `c1-r6` should be restarted, stopped, or continued —
that is the owner's call and depends on the budget decision in `R6-BUDGET-WALL.md`. **The
one action that is clearly right regardless: give the live run a watchdog, or accept in
writing that it has none.**
