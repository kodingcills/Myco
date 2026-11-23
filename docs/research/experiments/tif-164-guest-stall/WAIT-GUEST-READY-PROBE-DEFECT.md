# TIF-164 follow-up: wait-guest-ready.sh declares a booting guest dead

**Found in production 2026-11-23**, on the first window where the guest actually
booted. #314 is merged (15:36:18Z); this is a defect in it, reported rather than
quietly patched.

## CORRECTION (same day): the cause is CRLF, not the timeout

An earlier revision of this file, and the merged PR #319, named
`ConnectTimeout=10` as the cause. **That is wrong, and the probe slot disproved
it.** The real cause is a string comparison that can never match.

The guest's default shell is PowerShell, which emits **CRLF**. Command
substitution strips the trailing `\n` and leaves the `\r`:

```
captured raw: 6f6b 0d          # "ok\r"
[ "$v" = "ok" ]  ->  NO MATCH  # the CR remains
```

**This is why `wait-ssh.sh` works and this gate does not** — different
comparisons against the same remote command:

```
wait-ssh.sh:    ssh ... | grep -q ok         # CR-tolerant  -> WORKS
gate line 116:  [ "$(ssh ...)" = "ok" ]      # CR-intolerant -> NEVER MATCHES
```

Proven side by side against a CRLF-emitting command: `grep -q ok` matches,
`= "ok"` does not, and `tr -d '\r'` before the compare matches.

**Bash strips trailing newlines**, so the `\n` alone was never the problem — a
plausible intermediate diagnosis that is also wrong.

**The fix is one line: `tr -d '\r'` before the compare.** The repo already does
this in three places (`m1-sweep.sh:89`, `m1-corrupt-suite.sh:80`,
`reset-trial-vm.sh:49`), so it is idiomatic here.

**The timeout observation below is still real but is NOT the cause.** Keep it
only as a separate, secondary concern. Two timeout-based fix attempts were made
and both were doomed, because raising a timeout cannot rescue a comparison that
never succeeds.

## What happened

The gate ran with a 200 s budget and reported:

```
wait-guest-ready: timeout after 200s: guest pid 30662 consumed 435s CPU and has not booted
```

**The guest was booting and SSH came up moments later.** CPU had advanced to
435 s, which is exactly what a healthy boot looks like.

## The secondary timing observation (not the cause)

`scripts/wait-guest-ready.sh`:

```
line  40:  INTERVAL=${MYCO_READY_INTERVAL:-10}
line  82:  if [ $(( NOW - START )) -gt "$T" ]; then <timeout>; exit 1; fi   # before the sleep
line  86:  sleep "$INTERVAL"
line 116:  if SEEN_PROGRESS=1 && [ "$(ssh ... )" = "ok" ]; then <ready>; exit 0; fi
```

Two things are true of the timing, independent of the CRLF defect:

1. **SSH can be slow to answer during boot** (~35–60 s observed, ~59 s once,
   18 s warm) against `ConnectTimeout=10`. Worth raising, but on its own it
   would not have prevented the failure.
2. **The budget is checked *before* the sleep**, so an iteration costs
   `INTERVAL(10) + ssh(up to 10)`. The overshoot compounds.

## Why review could not catch it

Both verifier rounds drove the gate with a **stubbed `ssh` that answers
instantly**, so the compare passed on the first iteration — the stub emitted
`ok\n` with no `\r`, which is precisely the detail a stub erases.

**A stub that answers "correctly" can hide a defect in how the answer is read.**
For this class of bug the stub must reproduce the transport's real bytes,
including line endings.

## Fix

`tr -d '\r'` before the compare. The timeout question (raise
`ConnectTimeout`? separate probe from sample cadence?) is a separate, secondary
decision.

The timeout message should also stop asserting "has not booted" when what was
observed is "SSH did not answer, or did not answer in the expected form".

## Not the same as TIF-164's original cause

The abandoned window was **host starvation** (1 s CPU across 4:22 elapsed). This
window's guest **booted** (CPU advanced 4→5→6→13→435 s, state `Rl`, SSH
answering). Different failure, same file.
