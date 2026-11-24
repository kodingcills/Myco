# CI: `check (macos-latest)` is cancelled on ~37% of runs, and it blocks every PR

**Measured 2026-11-23 evening.** Recorded because it is now the dominant cost on
the critical path, not because any single PR is at fault.

## The numbers

Across the last 20 runs, the outcome of `check (macos-latest)`:

```
10 success
 6 cancelled      <- 37% of the runs that reached a conclusion
 3 running
 1 failure
```

**The cancellations are timeouts, not failures.** Three observed jobs:

```
started 21:15:53Z  completed 21:38:34Z   (22m41s)  cancelled
started 21:15:53Z  completed 21:43:57Z   (28m04s)  cancelled
started 21:15:53Z  completed 21:40:54Z   (25m01s)  cancelled
```

**The job normally takes ~1m15s.** These ran 22-28 minutes and were killed. Two of
the three were on **docs-only PRs** - a 99-line research note and a 22-line note
that touch no code at all - so the change cannot be the cause.

## Why it matters more than the individual failures

**`check (macos-latest)` is a required status check.** A required check that is
cancelled 37% of the time means:

- every PR needs **re-runs** to land, and the re-run is itself subject to the same
  cancellation;
- the only available remedy is "retry until green", which teaches everyone that a
  red required check is noise;
- **a genuine failure becomes indistinguishable from the known cancellation.** This
  is not hypothetical: one of the 20 runs *did* fail for real (run `45260619242`, a
  biome lint failure), and finding it required separating it from six cancellations
  that looked the same in the summary line.

## What was observed about the cause

The cancellations cluster in time (`21:15:53Z` start for several at once) and are
much longer than the job's normal duration, which is the signature of a runner that
was **allocated but not scheduled**, or scheduled on a heavily contended host. No
`timeout-minutes` is set on the job, so these are infrastructure kills rather than
a job-level timeout.

**Not diagnosed further here.** The honest statement is: the jobs start, run far
longer than normal, and are cancelled together - consistent with runner-pool
contention - and the repo cannot fix that from inside a workflow.

## What a reader should do meanwhile

- **Do not treat a cancelled `check (macos-latest)` as a failure of the diff.** Check
  the conclusion, not the row colour: `cancelled` and `failure` are different.
- **Re-run the cancelled job** rather than rebasing or pushing a "fix" - the diff is
  almost certainly unrelated.
- **When it does fail for real**, read the log: a cancellation has no failing step,
  while a real failure names one (`Lint`, `Test`, `Typecheck`).
