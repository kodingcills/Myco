# C1 arm 001 — first live attempt (2026-11-22)

Preserved evidence, byte-exact. The run's working output lived in `/tmp`, which
can be reaped, so the artefacts are copied here rather than referenced.

## Outcome — read this before the numbers

**Zero scored rows. $0.00 spent.**

| | |
|---|---|
| Trials producing a usable row | **0** |
| Trials excluded | **30** |
| Exclusion reason | `driver-unreachable` (all 30) |
| Spend | **$0.00** |

There is no C1 pass rate from this run and none should be computed from it. A
30-trial arm that scores nothing is not a low pass rate; it is a run that did not
happen.

## What worked

The stack came up cleanly, in order: cold reset → agent up in Session 1 → ping
verified → fixture converted → Calc launched → **Cua found the window**
(pid 2096, window 262762) → **UNO ready, cell B39 readable**.

Then the driver preflight failed with `session-command-failed`, and the sweep
ended.

## Why

`queryGuest` allowed **15s** per guest command. Measured on this guest a round
trip runs **6–11s**: `cua-driver.exe --version` up to **9.35s** under load, and
the CIM enumeration query **7.8–10.9s**. Against a 15s budget that is roughly
1.4× headroom at the worst measured call — thin, and thinner under the load this
arm ran at.

**What is measured, and what is not.** The budget is per call: `execFileSync`
times each call independently, so sequential calls cannot sum into one timeout.
The exact call that exceeded 15s was never measured — there is no per-call
duration log — so this is a fix for a budget too tight for the observed
distribution, not a proven reproduction. An earlier revision of this file
claimed the two calls crossed 15s together; that reasoning was wrong on both the
arithmetic and the mechanism, and is retracted here.

What *is* confirmed against the live guest is the fix's effect:

| Timeout | Result |
|---|---|
| 15s | `session-command-failed` |
| 45s | `match`, `sessionIdentityMatches: true` (13.76s end-to-end) |

Fixed in PR #156, along with the six **unbounded** `vssh` calls in `c1-sweep.ts`
that had no timeout at all. The check was right; charging a liveness
precondition a performance budget was not.

## Files

| File | What it is |
|---|---|
| `spike-trial-0.json` | The one **real** scored row from the spike earlier the same day: `refuted`/`modified`, 26 model calls, \$0.076808. This is the run that proves the stack works end to end, and the basis for the arm's cost projection. |
| `accounting.json` | Per-index status: trial 0 `scored` (uncertain/driver-unreachable), 1–29 `omitted`, with reasons. The honest denominator. |
| `report.json` | The sweep's own final report. |
| `arm-abort-progress.log` | The run's progress log, ending at the preflight failure. |

`docs/research/experiments/**` is excluded from the formatter so preserved
evidence stays byte-exact — these files are artefacts, not source.
