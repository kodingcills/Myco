# M1-013 fixture conversion timeout

On 2026-11-21, sweep v2 ran from commit `29369ce` on the 6 GB Windows guest.
The operator stopped it after index 4 at 20:47:24 UTC when the 60-second fixture
conversion timeout recurred. Three trials verified, two were uncertain, and 25
were unrun. The five trials used five distinct expected fixture hashes. All five
result records and all 63 trace events passed schema validation.

| Index | Seed | Verdict |
|---|---|---|
| 0 | `m1-013-live` | Verified |
| 1 | `seed-b` | Uncertain, fixture conversion timeout |
| 2 | `seed-c` | Verified |
| 3 | `seed-d` | Uncertain, fixture conversion timeout |
| 4 | `seed-e` | Verified |

Host-local artifacts are under `/tmp/m1-013/sweep-v2/` (`progress.log`,
`trials.jsonl`, `fingerprints.json`, `params.json` and `runs/`). The earlier
single-fixture pilot also hit this timeout at index 3 with an 8 GB guest.
Both attempts remain available for diagnosis.

## Diagnostic

The separate probe measured the time until the converted workbook appeared.
Completed samples from `/tmp/m1-013/convert-diag/results.jsonl` include:

| Probe label | Cold | Time to workbook |
|---|---|---:|
| `cycle1 / seed-b` | Yes | 30.8 s |
| `cycle1 / seed-d` | No | 13.1 s |
| `cycle1 / seed-f` | No | 6.4 s |
| `cold2 / x` | Yes | 169.4 s |
| `cold3 / seed-c` | Yes | 39.9 s |

At 60 seconds in `cold2`, both `soffice.com` and `soffice.bin` were still
present in the interactive session. This establishes that a cold conversion
can finish after the sweep deadline. The probe used a separate launch and
output path. The two sweep timeouts may each have other causes.
The diagnostic ended with a killed-task marker after starting cycle 4. The
log has no cycle 4 result. The host process check found no sweep, diagnostic,
reset or deploy command still running.

## Proposed change and restart

1. With outer-loop approval, set an explicit **240-second** workbook-arrival
   deadline at the live trial's `WindowsFixtureConverter` call site. This leaves
   roughly 70 seconds beyond the 169.4-second sample. Keep the per-RPC
   timeout and the 600-second trial watchdog. Report the conversion duration
   and outcome, including timeouts, in machine-readable evidence. Preserve
   the precondition failure, cleanup and persisted-state verification.
2. Verify the changed harness without a VM, then confirm the host is available
   and the interrupted diagnostic left no reset or deploy process running.
   Run one cold canary on each previously timed-out seed in separate
   diagnostic output. Restore
   `clean-base` and deploy for each canary. Check conversion duration, fixture
   identity, the persisted verdict and cleanup. Hold the sweep if either
   canary hits the new timeout.
3. On a pinned, reviewed commit, start at **index 0** in a fresh output
   directory. Keep the same 30 parameter sets and fixture hashes, 6 GB guest,
   per-trial cold restore and AC, load and swap gates. Keep v2 and the canaries
   as separate evidence. Stop at a trial boundary and report if the fixture
   timeout recurs under the new deadline. Carry forward all recorded outcomes
   within the new protocol if it pauses only on a host gate.

## TIF-219: 360-second deadline and a distinct harness-fault record (2026-11-24)

In the live row-8 sweep (op3), trial 3 (`seed-d`, 71 rows) was still converting at
the 240-second deadline: `convertMs 240483`, `convertOutcome: deadline`, with a host
1-minute load of 12 to 16. The trial was recorded `uncertain` before Myco acted.

Measured `convertMs` on the same host and fixtures (all arrived unless noted):

| Sweep | Host | Values (ms) |
|---|---|---|
| op3, trials 0-3 | load 12-16 | 131498, 66247, 84149, **240483 (deadline)** |
| op2, trials 0-10 | busier evening | 100301, 5101, 194154, 137960, 113423, 66165, 59959, 46668, 45757, 168660, 221207 |
| v3 (row 3), 30 trials | quieter | min 17701, median 47703, max 140125, none over 180000 |

Fixture size does not predict time: `seed-d` alone took 137960, 168660 and then
more than 240483 ms. The working hypothesis is host CPU starvation, mostly by the
guest's own QEMU during the cold boot. The data supports load and does not support
fixture size, but it is not proven.

**Deadline arithmetic.** M1-013 set 240 s as 1.4168 times its slowest sample
(240000 / 169400). The same margin applied to the slowest convert since measured,
treating the censored 240483 ms as if it had just arrived: 240483 × 1.4168 =
340708 ms, rounded up to the next whole minute = **360 s**. Two cross-checks fall
below it: the slowest arrival × 1.4168 = 221207 × 1.4168 = 313398 ms, and the
busy/quiet median ratio (op2 100301 / v3 47703 = 2.103) × v3 max 140125 = 294629 ms.

**What it covers.** Every arrived sample (44 of them, max 221207 ms, 61% of the
deadline), at the loads those sweeps saw. It covers the censored trial only if that
trial would have finished by 360 s, which is unknown. It does not cover a heavier load.

**Budget.** The pessimistic slow-but-passing path in `m1-014-calc-cold-start.md`
grows from 1170 s to 1290 s, inside the 1500 s sweep and corrupted-suite alarms.
A hung `soffice` now costs at most 120 s more per trial and still ends `uncertain`.

**Recording.** A deadline miss now records `guardFailure.predicateName =
fixture-convert-deadline` and the reason starts `could not look: harness fault,
fixture convert deadline`. The sweep record adds `harnessFault:
"fixture-convert-deadline"`. Each `fixtureConvert` also records `hostLoadStart` and
`hostLoadEnd` (host 1-minute load average), copied to the sweep record as
`convertLoadStart` and `convertLoadEnd`. Scoring is unchanged: the row stays
`uncertain` and never counts as verified.
