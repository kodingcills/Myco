# `viewer verdict budget (macos-latest)` fails on main from runner contention, not a regression

**Measured 2026-11-24.** Three instances in one hour, all on `push` to main. This job
does not run on PRs (`if: github.event_name == 'push' || contains(labels, 'perf')`),
so a PR cannot see it before merging — which is why both failures below landed on
`main` first.

## The signature: the same commit measures 3x apart

Run `45295568672` (main at `7317fd75`) — **failed**:

```
1000 steps:  median 152.2 ms   (limit 150)   samples 97.6 .. 279.6
10000 steps: median 503.6 ms   (limit 425.8) samples 439.6 .. 883.2
```

The same job **re-run with no code change** — **passed**:

```
1000 steps:  median  53.3 ms
```

**152.2 -> 53.3 ms is a 2.9x swing on identical bytes.** The limit is 150. Other
main runs in the same hour: 123.9, 101.7, 67.3 — the distribution straddles the
threshold, so this job is **red roughly whenever it lands on a contended runner**,
which on this repo is common (see `ci-runner-cancellations/`).

Run for `b8031ec2` (`#348`, TIF-172) shows the same shape on the other step count:
`median 429.35` against a 425.8 limit — **a 0.8% overshoot**, and `#348` touches
only docs, a python link-checker, and its selftest.

## Why this is not the PR's fault

- **Both failing runs measure viewer render time, and neither changed viewer code.**
  `#342` is `test/*.py` plus a vitest wrapper; `#348` is a scorecard link checker.
- **The job passed on the 7 preceding main runs**, so it is not chronically broken.
- The samples are **median-of-20 within a single run**, so they are internally
  consistent and the spread is between runs, not within one.

## What the numbers do and do not say

This is a **wall-clock benchmark on a shared, unpatched CI runner**, comparing against
a `darwin` baseline captured elsewhere (`baseline 315.4 ms`, limit = +35%). Two
problems compound: the baseline is not measured on the same machine class, and the
runner's own contention is not controlled. **The job therefore cannot distinguish
"the viewer regressed" from "the runner was busy".**

**It is right to have a budget.** But a budget enforced this way will keep failing
on code that did not change, and each false failure trains readers to re-run —
the same erosion `ci-runner-cancellations/` describes for a different cause.

## Workaround recorded

- **Re-run the job** rather than investigating the diff; the same commit can pass.
- **Before believing a viewer regression, check the 1000-step median.** Under ~80 ms
  is the healthy cluster; the failures have all been >150 ms with a long tail.
- A real regression would show **both step counts elevated together on a re-run**,
  not a single run's spread.
