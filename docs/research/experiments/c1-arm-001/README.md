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

`queryGuest` allowed **15s** per guest command. Measured on this guest:
`cua-driver.exe --version` takes **5.7–6.8s** through `vssh`, and the CIM
enumeration query takes **11.8s** idle. Two version calls plus the enumeration
cross 15s under sweep load, `execFileSync` throws, and the preflight reports
`session-command-failed`.

Confirmed against the live guest, same query, same machine:

| Timeout | Result |
|---|---|
| 15s | `session-command-failed` |
| 45s | `match`, `sessionIdentityMatches: true` (13.76s) |

Fixed in PR #156. The check was right; charging a liveness precondition a
performance budget was not.

## Files

| File | What it is |
|---|---|
| `spike-trial-0.json` | The one **real** scored row from the spike earlier the same day: `refuted`/`modified`, 26 model calls, \$0.076808. This is the run that proves the stack works end to end, and the basis for the arm's cost projection. |
| `accounting.json` | Per-index status: trial 0 `scored` (uncertain/driver-unreachable), 1–29 `omitted`, with reasons. The honest denominator. |
| `report.json` | The sweep's own final report. |
| `arm-abort-progress.log` | The run's progress log, ending at the preflight failure. |

`docs/research/experiments/**` is excluded from the formatter so preserved
evidence stays byte-exact — these files are artefacts, not source.
