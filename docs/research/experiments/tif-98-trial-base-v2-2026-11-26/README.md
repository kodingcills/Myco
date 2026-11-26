# TIF-98 follow-up: trial-base-v2 build, 2026-11-26 (FAILED closed at step 2)

Run: `nohup caffeinate -i scripts/vm-session.sh -- scripts/build-trial-base.sh <this dir>`
started 04:11:31Z from branch `tif-98-trial-base-v2` (origin/main merged in). No model API
was called. No agent, token, credential or data entered the guest.

## Before the build

- The lock record named `11159 reset-trial-vm.sh` (dead). `lsof` printed nothing (free), so
  the record was stale (runbook §3). It was not cleared by hand.
- The guest left by that dead reset was still running. `guest-egress.sh status` and `verify`
  both passed (egress closed). It was stopped cleanly (`vm.sh stop`, by request) under
  `vm-session.sh` before the build.
- Snapshots: `cua-c1-base, m1-agent-live, clean-base-live, clean-base` (no `trial-base-v2`).

## What happened

| step | result | file |
|---|---|---|
| 1 open egress, reset `clean-base` | ok, total 27 s (first ssh 14 s) | `01-egress-allow.log`, `02-reset-open.log` |
| 2 state before | ok | `03-state-before.json` |
| 2 Defender signature update | **failed**: `Update-MpSignature` HRESULT 0x80070652 | `04-signatures.log` |
| exit trap | egress re-denied, VM left stopped | `build.log` |

0x80070652 is ERROR_INSTALL_ALREADY_RUNNING: another install was already in progress.
`03-state-before.json` shows why that is likely. The guest had been up for 22 s, its
signatures dated from 2023-12-05, and `wuauserv` was already Running. So Windows had
probably started its own signature update before the script asked for one. The build did
what it should and stopped before any snapshot.

Proposed fix (not applied): in the `signatures` stage of
`scripts/trial-base/guest-maintenance.ps1`, retry `Update-MpSignature` after a wait when it
fails with 0x80070652. Retry until the version moves or a deadline passes, and still fail
if the deadline passes.

## After the failure

Ran under `vm-session.sh`: a normal `reset-trial-vm.sh clean-base` (its egress check is
enforced), then `guest-egress.sh verify` and `probe`, then a clean stop.

- `20-post-failure-reset.log`: ready on `clean-base`, total 33 s.
- `21-post-failure-egress-verify.log`: egress closed, UTM config matches.
- `22-post-failure-probe.json`: every target failed (DNS and pypi timed out; 1.1.1.1, 8.8.8.8
  and the host 10.0.2.2:2222 refused).
- Snapshots unchanged: `clean-base` intact; `trial-base-v2` not created. VM left stopped.
