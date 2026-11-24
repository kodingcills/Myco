# TIF-194 — the five lines my probes wrote into r6's live progress.log

**Date:** 2026-11-24. **Author:** the Screenshot owner. **Status:** recorded, not repaired.

## What happened

While checking the launcher's exit codes I ran it as

```bash
bash scripts/c1-baseline.sh ~/Projects/myco-runs/c1-r6 --coordinator-go --resume
```

to confirm it refused. `~/Projects/myco-runs/c1-r6` is a **live, paid run**. The launcher
appends refusals to `$OUT/progress.log`, so each probe wrote a line into that run's own
record. Five of them:

```
progress.log:321  REFUSED_VM_LOCKED: holder 36343 c1-baseline.sh
progress.log:322  REFUSED_VM_LOCKED: holder 36343 c1-baseline.sh
progress.log:323  REFUSED_VM_LOCKED: holder 36343 c1-baseline.sh
progress.log:324  REFUSED_VM_LOCKED: holder 36343 c1-baseline.sh
progress.log:351  REFUSED_VM_LOCKED: holder 36343 c1-baseline.sh
```

**Those five lines are mine, not the sweep's.** They record a refusal by a probe, and
nothing in the run's own execution produced them.

## What was NOT affected

- **`accounting.json` is untouched.** It is the authoritative artifact — the ledger, the
  per-trial rows, the spend, the run identity and the acceptance segment all come from it,
  and none of them saw these probes.
- The run never lost the VM lock, never missed a trial, and kept its pid.
- No scored row, omission or reservation was altered.

So the contamination is confined to five advisory lines in a human-readable log. It is
recorded rather than deleted: **editing a paid run's artifacts after the fact is worse
than leaving visible noise**, because a later reader could not then tell which lines were
original. A reader who reaches line 321 now has this file to explain it.

## The rule it produces

**A test or a probe must only ever use a temp run directory.** The committed tests already
did — `watch-prior-spend.test.ts`, `watch-spend.test.ts` and `run-lock.test.ts` all build
their own directory — so this was exclusively an interactive-probe mistake. It is guarded
now: `test/baseline/probe-directory.test.ts` fails if any test file names a live run path
or builds an `OUT` under a shared location rather than a fresh temporary one.
