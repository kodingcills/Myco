# TIF-98: trial-base-v3, built from cold boots, 2026-11-26

Lead ruling 18:15Z: rebuild the trial base as a new versioned snapshot, `trial-base-v3`, with
every build boot classified cold under the TIF-98 guard and logged. The reason is that two of
`trial-base-v2`'s build boots were fast boots (`docs/research/experiments/tif-98-fast-reset-2026-11-26/`).

Every attempt ran under `scripts/vm-session.sh` with the VM lock held. Egress was open only for
the maintenance window, and nothing but the maintenance script entered the guest: no agent, no
token, no data, $0. `trial-base-v2`, `clean-base` and every other snapshot were left untouched.

## Result: built on attempt 3, 22:54:28Z

`trial-base-v3` was created at 22:54:26Z, disk-only (`HasState` false), from `clean-base`
(`snapshot-metadata.txt`, `attempt-3/16-snapshots.txt`).

| attempt | code | outcome |
|---|---|---|
| 1 (18:13Z) | 44eea863 = #546's head + the boot-class patch | failed in step 2's idle stage: `WDI\ResolutionHost` still counted at the 60-minute deadline |
| 2 (19:45Z) | the same | the same failure; the wrapper stopped on two identical failures |
| 3 (21:10Z) | 85d65837 = #557's 44f5a98a + the same boot-class patch | **built** |

**Boot classes (`attempt-3/boot-classes.log`).** Every boot that the maintenance ran on, or that
the snapshot was taken from, was cold:

| boot | first ssh s | guest CPU at first ssh s | class |
|---|---|---|---|
| step 1 reset, first start (just after `guest-egress.sh allow`) | 14 | 4 | fast: the reset guard stopped by request and booted again |
| step 1 reset, second start | 154 | 275 | **cold**; maintenance ran on this boot |
| step 5 boot in place, first start (just after `guest-egress.sh deny`) | 13 | 4 | fast: the build shut down cleanly and started again |
| step 5 boot in place, second start | 149 | 270 | **cold**; verify and probes ran on this boot, and the snapshot was taken after its clean shutdown |

Both fast first starts came straight after a UTM configuration write, as the fast-reset evidence
predicts.

**Maintenance (attempt 3):**
- Signatures: 1.403.7.0 to 1.463.485.0, after two `0x80070652` retries (`04-signatures.log`).
- ngen: all three passes exit 0 (`05-ngen.log`). The per-assembly "Failed to load the runtime"
  warnings also appear in `trial-base-v2`'s run 3.
- Idle stage: quiet for 3 samples, with 0 counted tasks and CPU 2-4% (`06-idle.log`). The only
  tasks running at the end were the three full-path exclusions disclosed in #557 and the runbook
  §3.5: `Multimedia\SystemSoundsService`, `Wininet\CacheTask` and `WDI\ResolutionHost`.
- Defender full scan: 1,982 s, 0 threat detections on record (`07-defender-full-scan.log`).
- Disabled: `MaintenanceDisabled=1`, AU `NoAutoUpdate=1`, `wuauserv` Disabled (`08-disable.log`).
- Defender real-time on, no exclusions (`10-defender-check.log`).
- State before and after: `03-state-before.json`, `09-state-after.json`.

**Egress closed before the snapshot:** `13-egress-verify.log` (verify exit 0: one restricted user
netdev, hostfwd exactly `tcp:127.0.0.1:2222-:22`, UTM config matches), and all five TIF-275 probes
failed with `SocketException` (`14-probe-denied.json`). `15-egress-status-at-snapshot.log`
shows `isolate-from-host: true` with the VM stopped.

## Attempts 1 and 2: the ResolutionHost timeouts

Both ran on a cold step-1 boot (290 s and 289 s of guest CPU). In both, `\Microsoft\Windows\WDI\ResolutionHost`
started about 10-13 minutes into the idle stage and was still running at the deadline line, with
the guest otherwise idle. It never appeared in `trial-base-v2`'s fast-booted build runs. The
explanation, that the Diagnostic Policy Service is resolving the slow-boot event a cold boot
logs, is **unconfirmed**. The lead ruled at 20:3xZ to exclude it by full path (#557, merged as
e8c9b5b6), and attempt 3 was run on that rule. Both failures left egress re-denied, the VM
stopped and no snapshot.

`chain.log` records the checks made before attempt 3 started: attempt 2's failure and its
ResolutionHost deadline line, lock free, VM stopped, `isolate-from-host: true`, and the snapshot
set unchanged. (Its `running guest network: FAIL ... found 0` only means the VM was stopped.)

## Files

- `progress-attempts-1-2.log`, `session-attempts-1-2.log`, `attempt-1.log`, `attempt-2.log`,
  `attempt-1/`, `attempt-2/`: the two failed attempts, copied unchanged from the attempt-1/2
  worktree.
- `chain.log`: the pre-launch checks for attempt 3.
- `progress.log`, `session.log`, `attempt-3.log`, `attempt-3/`: attempt 3.
- `snapshot-metadata.txt`: UTM's snapshot list after the build (title, created, `HasState`, size).
