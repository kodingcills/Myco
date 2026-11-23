# TIF-164 follow-up: wait-guest-ready.sh declares a booting guest dead

**Found in production 2026-11-23**, on the first window where the guest actually
booted. #314 is merged (15:36:18Z); this is a defect in it, reported rather than
quietly patched.

## CORRECTION (same day): the timeout was wrong; the cause is the CR in the compare

An earlier revision of this file, and the merged PR #319, named
`ConnectTimeout=10` as the cause. **That is wrong.** At the time of this section
the live failure was unexplained and a string comparison was the leading
candidate; it has since been **measured** — the guest's `ssh ... 'echo ok'`
returns `ok\r`, so the strict compare can never match. The sections below carry
both the measurement and the reasoning that led to it.

## Evidence status: MEASURED — the earlier "hypothesis" framing is superseded

**This section originally said the cause was a hypothesis with the CR untested.
That is no longer true, and the correction below carries the measurement.** The
live guest's `ssh ... 'echo ok'` was captured with `od` and returns `o k \r` — the
three bytes, matching the prediction — so the CR is no longer an inference. The
bullets are kept because the reasoning was sound at the time and the distinction
matters; only the status has changed.

What was true when written, and remains true of the reasoning:

- **Solid:** `grep -q ok` (in `wait-ssh.sh`, which works) is CR*and*-newline
  tolerant by construction, while `[ "$(ssh ...)" = "ok" ]` requires an exact
  match. The two gates really do differ in strictness against the same command.
- **Solid:** bash command substitution strips trailing newlines, so the earlier
  "trailing newline" hypothesis is **wrong** — `ok\n` becomes `ok` and matches.
- **Solid:** `tr -d '\r'` before the compare makes the strict form tolerant.
- **NOW MEASURED: this guest emits `\r`.** This bullet originally said the
  opposite, and it was right to: the `6f6b 0d` first quoted came from
  **simulating** PowerShell with `printf "ok\r\n"`, not from the guest, and no
  committed artefact recorded the real bytes. That gap has since been closed — a
  live capture shows the probe returns `o k \r` (three bytes), `[ "$v" = "ok" ]`
  is NO MATCH, and `tr -d '\r'` then compare is MATCH. **The prediction was
  right and the evidence now exists.**

**The requested live capture has since been taken, and it settled it:** the guest
returns `ok\r`, so the comparison could never match. The four eliminations stand,
and the fifth candidate turned out to be the cause.

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

## Candidate fix — SHIPPED (the live capture confirmed the mechanism)

`tr -d '\r'` before the compare makes the strict form tolerant, matching `wait-ssh.sh`. The timeout question (raise
`ConnectTimeout`? separate probe from sample cadence?) is a separate, secondary
decision.

The timeout message should also stop asserting "has not booted" when what was
observed is "SSH did not answer, or did not answer in the expected form".

## Not the same as TIF-164's original cause

The abandoned window was **host starvation** (1 s CPU across 4:22 elapsed). This
window's guest **booted** (CPU advanced 4→5→6→13→435 s, state `Rl`, SSH
answering). Different failure, same file.
