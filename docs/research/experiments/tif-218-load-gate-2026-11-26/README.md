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

- **This host carries load 2.55-7.22 with no guest at all** (`vm-stopped`, p50 4.32). That load
  comes from other work on the shared Mac.
- **A booting guest adds about 2.5-3 cores of QEMU** (`v2-resets`) and pushes the raw load
  to 13.2. That is the old gate's 14 minus about one core.
- **An idle `clean-base` guest keeps QEMU at 0.92-2.67 cores** for the whole 10 min. An idle
  `trial-base-v2` guest dropped to 0.08 cores about 30 s after ready (08:21:20Z), and mostly
  stayed near 0 after that, with spikes to 1.57, 1.75 and 1.18 cores.
- **Right after the `trial-base-v2` reset said ready, net load was 9.15, 9.75 and 10.87**
  (08:20:49Z-08:21:20Z), while QEMU fell from 2.7 to 0.08 cores. Then came one jump to 16.31
  at 08:21:35Z, and that jump decayed over the next minute: 13.74, 11.59, 9.68. These samples
  do not separate how much of the start of `v2-idle` was the load average lagging the boot and
  how much was other host load.
- **Some jumps are not the guest's QEMU.** At 08:21:35Z the load went from 10.94 to 16.33 in
  15 s with QEMU at 0.02 cores, and at 08:25:38Z from 2.77 to 7.48 with QEMU at 0.02 cores.
  That they were other host processes is an **inference**: the sampler records only QEMU's
  share, not per-process data. Supporting it, but not proving it: no similar jump followed the
  three later readies in `v2-resets`.
- **One guest runs as 2 `QEMULauncher` processes** (`qemu_procs` is 2 in every guest state and
  0 with the VM stopped), so the gate sums all of them. There is no cap: any other UTM VM on
  the host would be subtracted too, which could hide that much real host load. In every
  measured guest state the subtraction was at most 3.11 cores (the `v2-resets` maximum).
- **Memory was never under pressure**: free memory was 62-75%, swap free was 1,683-1,691 MB,
  and no swapouts happened in any state.

## The gate this supports (`scripts/load-gate.sh`)

**Net load = 1-min load minus QEMU's current cores.**

Both thresholds are the old numbers, kept. The measurement checks them; it did not derive
them.

- **Pause above net 14.** That is about 2.8 above the highest net load the guest's own resets
  produced (11.17). For example, if QEMU was at about 2.5 cores during the old 14.54 pause
  (its share was not measured then), net load was about 12.04, and that would now pass.
- **Resume under net 10 for 7 consecutive 30 s samples.** This has **no margin over an idle
  `trial-base-v2` guest**: net load there reached 10.00 at 08:30:12Z (raw 10.01) and 9.52 at
  08:29:12Z. It is above the net maximum of an idle `clean-base` guest (8.40) and of no guest
  (7.22). A sample at or over 10 does not block a resume; it restarts the 3-minute wait.
  The resume table in `summary.md` shows when a 3-minute window first cleared:
  - VM stopped: after 182 s;
  - idle `trial-base-v2`: after 274 s (5 of its 40 samples were at or over 10);
  - idle `clean-base`: after 184 s;
  - during back-to-back resets: never (7 of 36 samples at or over 10, longest run under 10
    was 152 s). The supervisor only checks the resume gate while no driver runs, so no reset
    is in progress at that point.

  The table uses the 15 s samples, but the supervisor samples every 30 s. It can miss a
  15-second excursion over 10 and clear sooner than the table shows.
- **Swap free under 300 MB still pauses** (unchanged; no memory pressure was seen, so the data
  cannot derive it). An unreadable load or swap value pauses, and so does a threshold override
  that is not a number.

The subtraction uses QEMU's %cpu at the moment of the check, not its CPU averaged over the
same minute as the load average.
