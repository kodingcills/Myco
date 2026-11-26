# TIF-98 follow-up: trial-base-v2 build run 2, 2026-11-26 (FAILED closed at step 2, idle)

Run: `nohup caffeinate -i scripts/vm-session.sh -- scripts/build-trial-base.sh <this dir>`
started 04:17:21Z at branch head `95686139`. That head carries the signature-update retry on
HRESULT 0x80070652, which run 1 (`../tif-98-trial-base-v2-2026-11-26/`) failed on. No
model API was called. No agent, token, credential or data entered the guest.

## What happened

| step | result | file |
|---|---|---|
| 1 open egress, reset `clean-base` | ok, total 29 s (first ssh 14 s) | `01-egress-allow.log`, `02-reset-open.log` |
| 2 state before | ok | `03-state-before.json` |
| 2 Defender signatures | ok: attempt 1 hit 0x80070652; the retry then saw the version move, 1.403.7.0 -> 1.463.471.0 | `04-signatures.log` |
| 2 ngen executeQueuedItems | ok: exit 0 for Framework, Framework64, FrameworkArm64 | `05-ngen.log` |
| 2 idle / Automatic Maintenance | **failed**: `not quiet after 60 min` | `06-idle.log` |
| exit trap | egress re-denied, VM left stopped | `build.log` |

The full scan, disable, check, deny/prove and snapshot steps did not run. No snapshot was
taken.

## Why the idle stage cannot pass as written

The stage counts the guest as quiet only after 3 consecutive 30 s samples with **no**
running `\Microsoft\Windows\*` task and CPU under 15%. Two tasks were running in all 116
samples: `\Microsoft\Windows\Multimedia\SystemSoundsService` and
`\Microsoft\Windows\Wininet\CacheTask`. Both also appear as running in
`03-state-before.json`, taken 22 s after boot (in both runs). From sample 25 on (guest clock
23:33, about 04:33Z), these two were the only running tasks, for 91 samples. Guest CPU in the
last 95 samples was at most 19%, and mostly 0-5%.

So the quiet condition was unreachable on this guest. Changing that condition is a new change
to the maintenance script. It has not been approved and is not made here.

## After the failure

Ran under `vm-session.sh`: a normal `reset-trial-vm.sh clean-base` (its egress check is
enforced), then `guest-egress.sh verify` and `probe`, then a clean stop.

- `20-post-failure-reset.log`: ready on `clean-base`, total 34 s.
- `21-post-failure-egress-verify.log`: egress closed, UTM config matches.
- `22-post-failure-probe.json`: every target failed (DNS and pypi timed out; 1.1.1.1,
  8.8.8.8 and the host 10.0.2.2:2222 refused).
- Snapshots unchanged (`cua-c1-base, m1-agent-live, clean-base-live, clean-base`):
  `clean-base` intact, `trial-base-v2` not created. VM left stopped, lock free.

## clean-base reset times measured today

Every `clean-base` reset on 2026-11-26, from the `timing` line `reset-trial-vm.sh` prints:

| reset | first ssh s | ready s | total s |
|---|---|---|---|
| run 1, step 1 (egress open) | 14 | 21 | 27 |
| run 1, after the failure | 19 | 27 | 33 |
| run 2, step 1 (egress open) | 14 | 21 | 29 |
| run 2, after the failure | 14 | 21 | 34 |

Totals: 27-34 s. The 2026-11-25 measurements in `../tif-98-reset/` were 185-254 s (13 rows),
summarised in runbook §3.1 as 190-260 s. Both sets are recorded as measured. This evidence
does not establish why they differ.
