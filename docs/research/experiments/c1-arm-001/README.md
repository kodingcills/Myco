# C1 arm 001 — first live attempt (2026-11-22)

Preserved evidence, byte-exact. The run's working output lived in `/tmp`, which
can be reaped, so the artefacts are copied here rather than referenced.

## Outcome — read this before the numbers

**Zero scored rows. $0.00 spent.**

| | |
|---|---|
| Trials producing a usable row | **0** |
| Trials excluded | **29 omitted + 1 scored-but-unusable** (trial 0: `driver-unreachable`) |
| Exclusion reason | `driver-unreachable` — the single cause for all 30 |
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

These two figures were **measured by hand against the live guest** and have no
automated artefact; they are the basis for #156's budget, not output of the
harness.

**State at the time this evidence was produced (branch predates the fix).** On
the `main` this run came from, `c1-driver-preflight.ts` carried
`timeout: 15_000`, and **every `vssh` call site in `c1-sweep.ts` was unbounded**:
measured on this tree, 5 sites call `VMs/myco-win11/scripts/vssh` and none passes
a `timeout:`. (The `timeoutMs: 90_000` at line 132 is a
`WindowsFixtureConverter` option — `new SshTunnel()` at line 102 takes no
arguments — and is the convert deadline, not an `execFileSync` budget.)

**PR #156 has since merged** (`a3272a8`, 2026-11-22T21:09:55Z): it sets
`GUEST_QUERY_TIMEOUT_MS = 45_000` and adds `timeout: GUEST_TIMEOUT_MS` to all
five of those `vssh` sites, so none is unbounded on current `main`. The line
numbers quoted in this file are therefore branch-relative and do not apply to
`main`.

Recorded this way deliberately: an unmerged fix described as landed is the exact
defect the repo's merge-discipline rule exists to prevent, and a count asserted
without measuring is the same defect with more confidence.

The preflight check itself was right; charging a liveness precondition a
performance budget was not.

### Note on `Cua Driver daemon is not running`

`arm-abort-progress.log` carries this line immediately above
`[0] Cua driver pipe reachable: true`, and the string appears nowhere in the
repo. It is raw `cua-driver.exe status` stdout passed through `execFileSync`'s
inherited output at `c1-sweep.ts:58-68` — that call sets `{encoding: "utf8"}`
with no `stdio`, so a failing `status` invocation prints directly to the log.
It describes the *daemon* service, not the pipe: reachability is decided by the
next line, `[0] Cua driver pipe reachable: true`, which the sweep acts on. The
two are not in contradiction.

### Note on two lines a reader will trip over (in `report.json` / `accounting.json`)

- `report.json` `rows[0].planner == "planner:none"` while the log says
  `Paid Claude Sonnet`: `src/baseline/sweep.ts` derives `planner` from
  `row.deviations.find(n => n.startsWith("planner:"))`, and the aborted trial's
  deviations are `["reset:cua-c1-base", "step-budget-asymmetry", "planner:none"]`
  — it scored with `modelCalls: 0` because the preflight failed before the
  planner was reached. **This note applies to `accounting.json`'s trial 0, not
  to `spike-trial-0.json`,** whose deviations end in
  `planner:claude-sonnet-5-5` (26 model calls, a real run).
- `report.json` `rows[3].mycoVerdict == "refuted"` on a row that never ran: that
  is the *manifest ground truth* for index 3, carried through because rows 1-29
  were omitted. `src/baseline/sweep.ts:178` copies `mycoVerdict` from the manifest for every
  row, scored or omitted. A statement about the fixture, not about a run.

## Files

| File | What it is |
|---|---|
| `spike-trial-0.json` | The one **real** scored row from the spike earlier the same day: `refuted`/`modified`, 26 model calls, \$0.076808. This is the run that proves the stack works end to end, and the basis for the arm's cost projection. |
| `accounting.json` | Per-index status: trial 0 `scored` (uncertain/driver-unreachable), 1–29 `omitted`, with reasons. The honest denominator. |
| `report.json` | The sweep's own final report. |
| `arm-abort-progress.log` | The run's progress log, ending at the preflight failure. |

`docs/research/experiments/**` is excluded from the formatter so preserved
evidence stays byte-exact — these files are artefacts, not source.
