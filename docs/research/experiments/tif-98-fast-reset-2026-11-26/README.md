# TIF-98 follow-up: the fast resets, 2026-11-26

Lead GO at 17:10Z. Everything ran under `scripts/vm-session.sh` with the VM lock held and guest
egress denied. Every reset went through `reset-trial-vm.sh` and its TIF-275 egress check, and
every pass ended with `guest-egress.sh verify` exit 0. No agent, no trial, no model call, $0.
The only guest write was a one-line marker text file, used to test whether a reset reverts the
disk. No snapshot was created or changed.

## Result

**Trigger, reproduced 6 of 6 times: a UTM configuration write right before a reset makes the
next boot fast.** `scripts/guest-egress.sh allow` and `deny` rewrite the VM's UTM
configuration, even when nothing changes. The next `reset-trial-vm.sh` reaches its first ssh
answer after 13 s with 4 s of guest CPU, against 142-151 s and 282-312 s otherwise.

| before the reset | resets | first ssh s | guest CPU at first ssh s | total s |
|---|---|---|---|---|
| **no config write**: VM stopped by request (pass 1 `t0` after ~45 min; pass 1/2 `e1`, pass 2 `t0`, pass 3 `cold` within a minute) | 5 | 142-151 | 282-312 | 162-171 |
| **config write**: stop by request, then `deny` (pass 1/2 `e2`, pass 3 `fast`, pass 4 first boot) | 4 | 13 | 4 | 26-27 (pass 4: its first boot) |
| **config write**: `deny` force-stopping the running guest (pass 1/2 `e3`) | 2 | 13 | 4 | 25 |

A stop by request alone does not do it (the first row). The first reset after a fast one is
cold again when no config write comes in between: pass 2 `t0` followed pass 1 `e3` (fast) and a
stop by request.

**What a fast boot is: the same restored disk, cold-booted, with most of Windows' boot work
skipped.** It is not a resume:
- Windows' boot type is `0x0` (a cold boot) on fast and cold boots alike (Kernel-Boot event
  27), with a fresh boot event each time (`pass2/probes.jsonl`).
- The marker file written before each stop is gone after every reset, fast or cold, so the
  restore reverted the disk.
- The QEMU argv is byte-identical for a cold and a fast start (`pass3/argv-sha256.txt`; the
  captures name host paths, so only their hashes are committed). UTM's System and QEMU config
  are identical before and after the write (`pass3/config-*.json`).

Windows' own boot profile (Diagnostics-Performance event 100, `pass3/boot-profile-*.json`):

| | cold | fast |
|---|---|---|
| BootTime | 134,431 ms | 17,839 ms |
| BootSmssInitTime (session-manager init) | 52,277 ms | 1,254 ms |
| BootDriverInitTime | 14,265 ms | 91 ms |
| BootExplorerInitTime | 31,376 ms | 1,709 ms |
| CPU of the `System` process since boot | 100.1 s | 8.2 s |

The fast boot's phases look like the guest's first boot on 2026-11-19 (Smss 1,147 ms, drivers
174 ms), which TIF-98 recorded earlier as "50+ s in session-manager init, 1.1 s on its first
boot".

The skipped work is not just deferred past "ready". QEMU CPU four minutes after ready was 471 s
cold and 70 s fast (`pass3/cpu-after-ready.jsonl`). So a trial started on a fast boot runs
against a guest in a different state from one started on a cold boot.

**Mechanism: not identified.** The evidence fixes the trigger (the UTM configuration write)
and the effect (Windows skips most of its boot-time driver and session-manager work on the
same disk and hardware). It does not show which host-side state the write resets, for example
the TPM or firmware variables UTM keeps beside the disk.

## Threshold, measured

`summary.md` comes from `python3 scripts/reset-boot-summary.py $(cat summary-inputs.txt)`.
It covers every boot in this directory, and every committed reset log from 2026-11-26 (the
#494 build runs, the run-3 bench, the parity run, TIF-218 and the #529 default-switch proofs):

| class | boots | first ssh s | guest CPU at first ssh s |
|---|---|---|---|
| cold | 25 | 122-169 | 272-312 |
| fast | 12 | 13-19 | 4-23 |

The guard calls a boot cold when its guest CPU at the first ssh answer is at least **100 s**.
That is 77 s above the highest fast boot and 172 s below the lowest cold one. The override
(`MYCO_COLD_MIN_GUEST_CPU`) is bounded to 100-271 s, so it can never relabel a fast boot as cold,
and the R1 evidence check and `row7-compare.py` recompute the class from the recorded guest CPU
against the same 100 s.

Observation, no claim beyond it: two build steps were fast boots. Build run 3's step 1 (right
after `guest-egress.sh allow`) and its boot-in-place after `deny` both followed config writes.
So `trial-base-v2`'s maintenance ran on a guest that had fast-booted.

## The guard (`scripts/reset-trial-vm.sh`)

Every reset now classifies its boot from the gate's first-ssh guest CPU:
- At or above `MYCO_COLD_MIN_GUEST_CPU` (default 100) it is **cold**, and the reset continues.
- Below it, the boot is **fast**. The reset stops the VM by request and boots once more. A
  start with no config write before it is cold, as measured above.
- A second fast boot, or a first-ssh line that cannot be read, is **refused**: exit 1, no
  `ready on` line.

Each reset prints
`reset-trial-vm: boot class=… first_ssh_s=… guest_cpu_first_ssh_s=… attempts=…`.

**Proof on the VM (`pass4-guard/`):** `guest-egress.sh deny`, then the guarded reset. The first
boot was fast (13 s, 4 s), the reset printed `fast boot … booting once more`, and the second
boot was cold (143 s, 291 s): `class=cold … attempts=2`, `ready on 'trial-base-v2'`, egress
verified.

This is the "reorder" choice: a config write right before a reset is answered with a cold cycle
inside the reset itself, so no trial flow can start on a fast boot.

## Files

- `pass1/`: the first run. Its probe used `vssh -T` with stdin, which the guest's PowerShell
  does not execute, so its `probes.jsonl` is null. The timings stand.
- `pass2/`: the same scenarios with the probe copied in and run with `-File`
  (`scripts/fastreset-probe.ps1`). `tickUptimeS` reads 0 because Windows PowerShell 5.1's .NET
  has no `TickCount64`; the boot-event time is the uptime marker.
- `pass3/`: one cold and one fast boot, with the config before and after, argv hashes, CPU
  after ready, and Windows boot profiles.
- `pass4-guard/`: the guard on the real VM.
- `scripts/`: the experiment scripts as run. `fastreset-pass1-2.sh` is pass 2's version; pass 1
  differed only in the probe line.
- `summary.md`, `summary-inputs.txt`: the cold/fast table and the logs it reads.
