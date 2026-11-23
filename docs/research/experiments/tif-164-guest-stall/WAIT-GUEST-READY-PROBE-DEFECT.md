# TIF-164 follow-up: wait-guest-ready.sh declares a booting guest dead

**Found in production 2026-11-23**, on the first window where the guest actually
booted. #314 is merged (15:36:18Z); this is a defect in it, reported rather than
quietly patched.

## What happened

The gate ran with a 200 s budget and reported:

```
wait-guest-ready: timeout after 200s: guest pid 30662 consumed 435s CPU and has not booted
```

**The guest was booting and SSH came up moments later.** CPU had advanced to
435 s, which is exactly what a healthy boot looks like.

## The mechanism (verified in the source)

`scripts/wait-guest-ready.sh`:

```
line 116:  ssh -F "$CFG" -o BatchMode=yes -o ConnectTimeout=10 myco-win11 'echo ok'
line  40:  INTERVAL=${MYCO_READY_INTERVAL:-10}
line  79:  while :; do
line  82:    if [ $(( NOW - START )) -gt "$T" ]; then <timeout>; exit 1; fi   # checked BEFORE the sleep
line  86:    sleep "$INTERVAL"
...
line 116:    if SEEN_PROGRESS=1 && ssh ... ; then <ready>; exit 0; fi
```

Two facts compose into the defect:

1. **`ConnectTimeout=10` is too short for this guest's boot.** SSH takes
   **~35–60 s** to answer while Windows is still coming up (measured ~59 s once,
   18 s when warm). So the probe gives up at 10 s, never returns `ok`, and
   **the AND never passes.**
2. **The budget is checked *before* the sleep**, so each iteration really costs
   `INTERVAL(10) + ssh(up to 10) = up to 20 s` against a budget that is only
   decremented at the top. The overshoot compounds.

Net: a guest that is genuinely booting can never satisfy the AND, the loop burns
its whole budget, and it exits 1 with a message that says the guest "has not
booted" — which is **false**, and is the same class of error as the defect this
gate was built to fix, just inverted. The old gate said *ready* too early; this
one says *not booting* too early.

## Why review could not catch it

Both verifier rounds drove the gate with a **stubbed `ssh` that answers
instantly**, so `SEEN_PROGRESS && ssh==ok` passed on the first iteration. The
race is only reachable with a real, slow-booting guest. This is the strongest
argument yet for the rule that a gate's timing behaviour needs at least one
measurement against the real thing.

## Candidate fixes (to be chosen by measurement, not preference)

- **(a) Raise `ConnectTimeout` to ~30 s.** Simple, but it interacts with the
  loop: a 30 s probe inside a 10 s interval changes the sampling rate, so the
  CPU-progress cadence is no longer what `MIN_DELTA`/`FLAT` were tuned for.
- **(b) Separate the probe cadence from the sample cadence**, so a slow probe
  does not consume the CPU-sampling interval budget. More honest structurally,
  since the two measurements want different periods.

Whichever wins, the timeout message should stop asserting "has not booted" when
what was observed is "SSH did not answer within the probe budget".

## Not the same as TIF-164's original cause

The abandoned window was **host starvation** (1 s CPU across 4:22 elapsed). This
window's guest **booted** (CPU advanced 4→5→6→13→435 s, state `Rl`, SSH
answering). Different failure, same file.
