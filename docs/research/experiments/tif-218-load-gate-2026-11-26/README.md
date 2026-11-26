# TIF-218: host load with and without the guest, 2026-11-26

Why: the M1 sweep load gate (pause at raw 1-min load > 14, resume under 10 for 3 min) was
blocked by the guest itself. With the VM lock free and no sweep running, host load sat at
11-14.5, and the op2 sweep paused on `PAUSED_LOAD` twice. This run measures how much of the
host load the guest's own QEMU process explains.

No model API was called, and no agent, token or data was put in the guest. Every reset was
`reset-trial-vm.sh`, which refuses a guest unless egress is closed. All five resets ended
`ready`. No snapshot was created or changed.

## How it ran

One `scripts/vm-session.sh` session, detached (`driver.log`), 08:07:44Z-08:54:23Z, on a shared
M4 Pro Mac (14 cores, 24 GB). `scripts/load-gate-sample.sh` sampled every 15 s:

- the host 1-min load (`sysctl vm.loadavg`);
- the guest's QEMU CPU share: %cpu summed over processes whose executable is `QEMULauncher`,
  from a names-only `ps` (no arguments or environment);
- swap (`vm.swapusage`), `memory_pressure -Q`, and the `vm_stat` page and swap counters.

| state | what ran | samples |
|---|---|---|
| `vm-stopped` | VM stopped, lock held, nothing else | 40 (10 min) |
| `v2-idle` | reset to `trial-base-v2`, then idle | 40 (10 min, from the moment the reset said ready) |
| `v2-resets` | three back-to-back `trial-base-v2` resets (the no-paid-run guest action) | 36 |
| `clean-base-idle` | reset to `clean-base`, then idle | 40 (10 min) |

The resets used `reset-trial-vm.sh` from the TIF-98 branch (PR #494), because `main` does not
yet accept `trial-base-v2`. Reset totals were 170-188 s for `trial-base-v2` and 229 s for
`clean-base` (`reset-*.log`).

## Result

`summary.md` comes from `python3 scripts/load-gate-summary.py samples.jsonl`. Percentiles are
nearest-rank, and every line is counted. `test/load-gate.test.ts` checks that the committed
`summary.md` is exactly what the script prints.

| state | load1 p50 / p95 / max | QEMU cores p50 / p95 / max | load - QEMU p50 / p95 / max | mem free % min | swapouts |
|---|---|---|---|---|---|
| vm-stopped | 4.32 / 6.27 / 7.22 | 0 / 0 / 0 | 4.32 / 6.27 / 7.22 | 70 | none |
| v2-idle | 5.99 / 11.87 / 16.33 | 0.02 / 1.57 / 2.71 | 5.97 / 11.59 / 16.31 | 70 | none |
| v2-resets | 9.47 / 13.04 / 13.23 | 2.51 / 2.98 / 3.11 | 7.09 / 11.11 / 11.17 | 71 | none |
| clean-base-idle | 4.43 / 9.11 / 10.23 | 1.06 / 2.60 / 2.67 | 3.18 / 7.07 / 8.40 | 62 | none |

What the samples show:

- **This host carries 4-7 load with no guest at all** (`vm-stopped`). That load comes from
  other work on the shared Mac.
- **A booting guest adds about 2.5-3 cores of QEMU** (`v2-resets`) and pushes the raw load
  to 13.2. That is the old gate's 14 minus about one core.
- **An idle `clean-base` guest keeps QEMU at 1-2.6 cores** for the whole 10 min. An idle
  `trial-base-v2` guest drops to about 0.02 cores within 3 min of boot.
- **The raw 1-min load lags QEMU's CPU.** In `v2-idle`, load decays from the boot over the
  first 2-3 min while QEMU's %cpu is already near 0 (08:20:49Z-08:23:06Z).
- **Some jumps are not the guest.** At 08:21:35Z the load went from 10.94 to 16.33 in 15 s
  with QEMU at 0.02 cores, and at 08:25:38Z from 2.77 to 7.48 with QEMU at 0.02 cores. Those
  are other host processes.
- **Memory was never under pressure**: free memory was 62-75%, swap free was 1,683-1,691 MB,
  and no swapouts happened in any state.

## The gate this supports (`scripts/load-gate.sh`)

**Net load = 1-min load minus QEMU's current cores.**

- **Pause above net 14.** That is about 2.8 above the highest net load the guest's own resets
  produced (11.17). For comparison, raw 14.54 with QEMU at 2.5 cores, one of the old pauses,
  is net 12.04 and passes.
- **Resume under net 10 for 7 consecutive 30 s samples.** That is above the net maximum of an
  idle host with a `clean-base` guest (8.40) or with no guest (7.22).
- **Swap free under 300 MB still pauses** (unchanged), and so does an unreadable load or
  swap value.

The subtraction uses QEMU's %cpu at that moment, which does not cover the lag after a boot.
That is why net load stays at 11-16 at the start of `v2-idle`. The 16.31 maximum is a host
burst, which is what the gate is for. The resume gate's 3-minute window covers the boot tail.
