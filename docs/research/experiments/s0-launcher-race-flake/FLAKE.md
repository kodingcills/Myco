# s0-live-launcher's race test is flaky, and it makes CI red on main

**Found 2026-11-23** while trying to merge a docs-only PR. Recorded because it is
blocking every PR behind it, not because the docs change is at fault.

## What fails

```
test/discovery/s0-live-launcher.test.ts:174
  expect(winners).toBe(1);
AssertionError: expected 2 to be 1
```

The test spawns **8 concurrent `--run` racers** and asserts that **exactly one**
wins the launcher's claim. On a loaded CI runner, **two** admit themselves.

## It is not the docs PR

- The failing PR touches only `docs/backlog/dogfood.md` and a research note.
- **It passes locally every time** — 4 consecutive runs, `Tests 7 passed (7)`.
- **`main` itself fails it.** Recent main runs: `8fc960b` failure, `2f419c1`
  failure, `57f5c3e` success. So the flake predates this PR and is intermittent
  on main.

## Why it flakes

The assertion is about **mutual exclusion under contention**: 8 processes race to
claim one run, and the test requires the count of admitted winners to be exactly 1.
Two admitted means either the claim is not fully atomic under load, or the test's
counting method (grepping a shared log for `^1$`) is racing the writers.

**The counting method is the likelier culprit.** The test reads a *shared* log
after the racers exit, and the comment at `:176` notes `--run` routes stdout to
that shared log rather than each racer's own file. A shared append target plus 8
writers plus a grep after exit is a read-after-write assumption, which is exactly
what a loaded runner breaks.

## Why it matters beyond this PR

`check (ubuntu-latest)` is a **required** status check. A flaky required check
means:

- every PR can be blocked at random, with no code change at fault;
- re-running "until green" is the only remedy, which trains everyone to treat a
  red required check as noise;
- the launcher's *actual* atomicity property is asserted by a test that cannot
  distinguish "the claim admitted two" from "the log was read mid-write" — so a
  genuine regression here would be dismissed as the known flake.

## Not fixed here

The test belongs to TIF-138 / #315. Fixing it means either making the count
race-free (per-racer output, or count under the launcher's own lock) or widening
the assertion with a documented tolerance — and **widening it without first
determining which reading is true would hide a real defect**. That is the
distinction worth preserving: the flake is a test-methodology problem *or* a
launcher-atomicity problem, and nobody has measured which.
