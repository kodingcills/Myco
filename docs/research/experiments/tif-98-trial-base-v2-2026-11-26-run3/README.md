# TIF-98 follow-up: trial-base-v2 build run 3, 2026-11-26 (OK) + cold-vs-cold reset bench

Run: `nohup caffeinate -i scripts/vm-session.sh -- scripts/build-trial-base.sh <this dir>`
started 05:39:36Z at branch head `bb19141f`. Done at 06:01:58Z. No model API was called. No
agent, token, credential or data has entered this guest: the build copies in only the
maintenance script, and removes it before the snapshot.

## Build

| step | result | file |
|---|---|---|
| 1 open egress (maintenance window only), reset `clean-base` | ok | `01-egress-allow.log`, `02-reset-open.log` |
| 2 state before | ok (uptime 21 s) | `03-state-before.json` |
| 2 Defender signatures | ok: attempt 1 hit 0x80070652 (another install); after one wait the version moved, 1.403.7.0 -> 1.463.475.0 | `04-signatures.log` |
| 2 ngen executeQueuedItems | ok: exit 0 for Framework, Framework64, FrameworkArm64 | `05-ngen.log` |
| 2 idle / Automatic Maintenance | ok: quiet for 3 samples after about 14 min (counted=0, cpu 3-7%) | `06-idle.log` |
| 2 Defender full scan | ok: 257 s, 0 threat detections on record | `07-defender-full-scan.log` |
| 3 disable triggers | `MaintenanceDisabled=1, AU NoAutoUpdate=1, wuauserv Disabled` | `08-disable.log` |
| 3 state after | ok | `09-state-after.json` |
| 3 Defender check | `Defender real-time on, no exclusions` | `10-defender-check.log` |
| 4 remove script, clean shutdown | ok | `build.log` |
| 5 deny egress, boot in place | ok: ssh stable after 19 s | `11-egress-deny.log`, `12-boot-in-place.log` |
| 5 verify | `egress closed ... UTM config matches` | `13-egress-verify.log` |
| 5 TIF-275 probes | every target failed (DNS and pypi timed out; 1.1.1.1, 8.8.8.8 and host 10.0.2.2:2222 refused) | `14-probe-denied.json` |
| 6 clean shutdown, snapshot | `utm isolate-from-host: true` at snapshot time; `trial-base-v2` listed; `clean-base` still listed | `15-egress-status-at-snapshot.log`, `16-snapshots.txt` |

The "running guest network: FAIL ... found 0" line in `15-egress-status-at-snapshot.log` is
expected. The VM is stopped for the snapshot, and the build checks only the UTM flag line.

Before vs after (`03-state-before.json`, `09-state-after.json`):

- Defender: real-time on and no exclusions in both. Signatures 2023-12-05 -> 2026-11-26.
  Full scan end: none -> 06:00:47Z.
- Windows tasks never run: 181 -> 101. Disabled: 33 -> 40.
- Automatic Maintenance: `MaintenanceDisabled` unset -> 1.
- Windows Update: `wuauserv` Manual/Running -> Disabled/Stopped.

### Idle-stage exclusion (lead ruling 2026-11-26 05:37Z)

The idle stage does not count exactly two tasks, matched by full path with no wildcards:
`\Microsoft\Windows\Multimedia\SystemSoundsService` and `\Microsoft\Windows\Wininet\CacheTask`.

The reason is the run-2 evidence (`../tif-98-trial-base-v2-2026-11-26-run2/06-idle.log`).
Both tasks were running in all 115 samples of a 60 min idle stage (and are named in its
deadline line), and both were already running 22-23 s after boot (runs 1 and 2). So "no running task" could never be reached.

Every other `\Microsoft\Windows` task must still be idle. The 60 min bound and the exit 1 stay.
Both tasks are still logged in every sample (`running=` and `counted=`). Both are running in
`09-state-after.json` too.

## Reset bench: cold vs cold, same session

Run: `scripts/reset-bench.sh reset 5`, first with `MYCO_BENCH_SNAPSHOT=trial-base-v2`, then
with `clean-base`, back to back. Times: 06:02:24Z to 06:41Z. The script's lsof check and
host load gate (10) ran before each step, and it held twice for load. All 10 resets were rc 0
and passed the readiness re-check.

Snapshot memory state, read from UTM's `snapshots.plist` (`HasState`) for this VM. The raw
`plutil -p` and `qemu-img snapshot -l -U` output is in `snapshot-metadata.txt` (captured
read-only after the round-1 review; no snapshot changed since run 3). UTM records
`trial-base-v2` as created at 06:01:57Z, one second before the build's `done` line
(06:01:58Z):

| snapshot | HasState | UTM state size |
|---|---|---|
| `trial-base-v2` | false | 0 |
| `clean-base` | false | 0 |
| `clean-base-live` (not used here) | true | 2,215,968,090 B |

`qemu-img snapshot -l -U` on the VM's qcow2 lists all five internal snapshots with VM_SIZE 0 B.
`reset-trial-vm.sh` restores the named snapshot on a stopped VM and boots it ("disk-only cold
restore", its header). So both halves are cold boots of a disk-only snapshot.

Per reset (from each reset's `timing` and `wait-guest-ready` lines, committed as
`bench-reset-lines.txt`):

| half | run | total s | first ssh s | guest CPU at first ssh s |
|---|---|---|---|---|
| trial-base-v2 | 1 | 163 | 140 | 284 |
| trial-base-v2 | 2 | 157 | 136 | 291 |
| trial-base-v2 | 3 | 140 | 123 | 279 |
| trial-base-v2 | 4 | 140 | 122 | 280 |
| trial-base-v2 | 5 | 160 | 138 | 284 |
| clean-base | 1 | 222 | 162 | 287 |
| clean-base | 2 | 221 | 162 | 287 |
| clean-base | 3 | 204 | 145 | 272 |
| clean-base | 4 | 222 | 162 | 286 |
| clean-base | 5 | 218 | 158 | 283 |

| half | n | total s: median (min-max), mean | first ssh s: median (min-max), mean | stability s: median (min-max) |
|---|---|---|---|---|
| trial-base-v2 | 5 | 157 (140-163), 152.0 | 136 (122-140), 131.8 | 10 (8-10) |
| clean-base | 5 | 221 (204-222), 217.4 | 162 (145-162), 157.8 | 43 (42-44) |

`bench-summary.md` holds the full per-phase table, generated from the JSONL with
`python3 scripts/reset-bench-summary.py trial-base-v2=bench-trial-base-v2.jsonl clean-base=bench-clean-base.jsonl`.
The host conditions were similar across halves: load1 at start, median 8.76 vs 8.94, and host
swap 2,453 MB in every row.

In this session, the trial-base-v2 total ranges (140-163 s) and the clean-base ranges
(204-222 s) do not overlap. The median difference is 64 s.

## Today's earlier clean-base resets (not reproduced)

Earlier on 2026-11-26, four `clean-base` resets in the build runs measured 27, 33, 29 and 34 s
in total, with the first ssh answer at 14-19 s (`../tif-98-trial-base-v2-2026-11-26/` and
`../tif-98-trial-base-v2-2026-11-26-run2/`, files `02-reset-open.log` and
`20-post-failure-reset.log`). They are recorded as measured. They were **not reproduced** in
this same-session bench, where every `clean-base` reset took 204-222 s.

## Files not committed

`bench-*.jsonl.logs/` holds raw per-step logs, which `reset-bench.sh` marks as
operator-only, not evidence. The two lines each reset contributes to the table above (first
ssh with guest CPU, and the timing line) are extracted into `bench-reset-lines.txt`. Every
other figure comes from the committed JSONL or `snapshot-metadata.txt`.
