# TIF-164 follow-up: wait-guest-ready.sh declares a booting guest dead

**Found in production 2026-11-23**, on the first window where the guest actually
booted. #314 is merged (15:36:18Z); this is a defect in it, reported rather than
quietly patched.

## CORRECTION (same day): the timeout was wrong; the cause is UNEXPLAINED

An earlier revision of this file, and the merged PR #319, named
`ConnectTimeout=10` as the cause. **That is wrong, and the probe slot disproved
it.** The live failure is **UNEXPLAINED**, and the most likely mechanism is a
string comparison that cannot match.

## Evidence status: this is a HYPOTHESIS, not a measured cause

Being precise, because I asserted this more strongly than I could support:

- **Solid:** `grep -q ok` (in `wait-ssh.sh`, which works) is CR*and*-newline
  tolerant by construction, while `[ "$(ssh ...)" = "ok" ]` requires an exact
  match. The two gates really do differ in strictness against the same command.
- **Solid:** bash command substitution strips trailing newlines, so the earlier
  "trailing newline" hypothesis is **wrong** — `ok\n` becomes `ok` and matches.
- **Solid:** `tr -d '\r'` before the compare makes the strict form tolerant.
- **NOT MEASURED: that this guest actually emits `\r`.** The `6f6b 0d` I quoted
  was produced by **simulating** PowerShell with `printf "ok\r\n"`, not by
  capturing the real guest. **No committed artefact records what the guest's
  `ssh ... 'echo ok'` actually returns.** The inference is plausible (PowerShell
  writes CRLF, and the earlier `tr -d '\r'` idiom appears in three repo scripts
  for exactly this guest), but it is an inference.

**So the honest state is: four hypotheses were eliminated by measurement, a
fifth (CR) is the leading candidate and is untested, and the requested live
capture is what would settle it.** The capture needs to record the probe's
stdout, stderr and exit code *inside* the gate against a running guest.

If the capture shows `ok` with no `\r`, then CR is eliminated too and the cause
is something none of the five accounts for.

**What the strict-vs-tolerant difference does establish regardless:** these two
gates disagree about what "SSH is up" means, and only one of them can be right.
That alone is worth fixing — `wait-guest-ready.sh` should use the same
tolerance `wait-ssh.sh` uses, whether or not CR turns out to be the cause.

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

## The mechanism (as first read — see the CORRECTION immediately below)

`scripts/wait-guest-ready.sh`:

```
line  40:  INTERVAL=${MYCO_READY_INTERVAL:-10}
line  82:  if [ $(( NOW - START )) -gt "$T" ]; then <timeout>; exit 1; fi   # before the sleep
line  86:  sleep "$INTERVAL"
line 116:  if SEEN_PROGRESS=1 && [ "$(ssh ... )" = "ok" ]; then <ready>; exit 0; fi
```

## CORRECTION (2026-11-23, same day): the cause above is wrong

**`ConnectTimeout=10` is NOT why the gate fails. The compare is CR-intolerant.**

The guest's default shell is PowerShell, which terminates lines with CRLF, so the
capture is the three bytes `ok\r` — command substitution strips the trailing `\n`
and leaves the `\r`, and `[ "$v" = "ok" ]` can therefore **never** match, however
long the timeout is. Measured against a CRLF-emitting stub:

```
raw bytes:   o k \r
[ "$v" = "ok" ]                -> NO MATCH
... | tr -d '\r' ; = "ok"      -> MATCH
```

This is also why `wait-ssh.sh` has always worked beside the broken gate on the
same remote command: it compares with `ssh ... | grep -q ok`, which tolerates the
CR, while the gate compared exact strings.

So the two timeout-shaped readings below — mine, both of them — were treating a
symptom that could not have been the cause. The timeout numbers are still real
(SSH genuinely takes tens of seconds on a cold boot) and the compounding overshoot
is still worth fixing, but **neither will make a comparison succeed that cannot
succeed.** The fix is `tr -d '\r'` before the compare; the repo already does this
at `reset-trial-vm.sh:49`.

Recorded rather than deleted because the reasoning is instructive: a signal that
never fires looks identical to a signal that fires too late, and only measuring
the actual bytes tells them apart.

## The original (incorrect) reading, kept for the record

**Note added after the correction above:** both timing facts below are TRUE and
independently worth fixing — they are simply not the cause of this failure. They
are kept because a gate that overshoots its own budget is a real defect whether or
not it is the one that bit here, and because deleting a correct observation to
tidy a wrong conclusion would lose information.

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

## Candidate fix (pending the live capture)

`tr -d '\r'` before the compare makes the strict form tolerant, matching `wait-ssh.sh`. The timeout question (raise
`ConnectTimeout`? separate probe from sample cadence?) is a separate, secondary
decision.

The timeout message should also stop asserting "has not booted" when what was
observed is "SSH did not answer, or did not answer in the expected form".

## Not the same as TIF-164's original cause

The abandoned window was **host starvation** (1 s CPU across 4:22 elapsed). This
window's guest **booted** (CPU advanced 4→5→6→13→435 s, state `Rl`, SSH
answering). Different failure, same file.
