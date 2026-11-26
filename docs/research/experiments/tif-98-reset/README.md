# TIF-98 (M2-01): where the trial reset's time goes

Measured 2026-11-25 on the shared M4 Pro Mac (14 cores, 24 GB) against `myco-win11`
(UTM 5.0.9, 6 vCPU, 6 GB, Windows 11 ARM64, snapshot `clean-base`). All runs used the
lock-gated `scripts/reset-trial-vm.sh` and the `lsof` check plus host load gate in
`scripts/reset-bench.sh`. No model API was called.

## Result in one paragraph

The reset is **not materially faster**. The repo-side waste was small: 10 s readiness
polling, and a 5 s sleep stacked on each slow stability probe. Those are removed, which saves
a few seconds and is lost in run-to-run noise here. The cost is the guest's own boot, about
150 s to the first SSH answer. Windows spends 50+ s in session-manager init (1.1 s on its
first boot), and the guest burns 264-314 CPU-seconds (median 281) before sshd answers, then
keeps about two host cores busy with Defender, .NET `ngen`, scheduled tasks and Windows Update. Every reset
reverts the disk, so that maintenance repeats on every trial. The restore itself costs
~2 s, and a plain in-guest reboot with no restore is just as slow. Host swap pressure is a
secondary factor: freeing swap from 9.9 GB to 4.5 GB did not bring resets down. The lever
that would matter is a new base image with the post-boot maintenance done or disabled
(follow-up 1).

## Before / after

`summary.md` is generated from the JSONL here and every row is counted:

```bash
E=docs/research/experiments/tif-98-reset
python3 scripts/reset-bench-summary.py before=$E/before.jsonl after=$E/after.jsonl \
  after-recovered=$E/after-recovered.jsonl after-cycle=$E/after-cycle.jsonl > $E/summary.md
```

The all-rows figures in `docs/eval-runbook.md` §3.1 (13 rows: total 213 (185-254), load1
3.83-9.72) come from the same script with one pooled label, and the memory ranges quoted
below from the rows that carry those fields:

```bash
python3 scripts/reset-bench-summary.py \
  all=$E/before.jsonl,$E/after.jsonl,$E/after-recovered.jsonl,$E/after-cycle.jsonl
cat $E/*.jsonl | python3 -c 'import json,sys
r=[json.loads(l) for l in sys.stdin if l.strip()]
for k in ("host_mem_free_pct_at_start","qemu_rss_mb_after_reset"):
    v=[x[k] for x in r if x.get(k) is not None]; print(k,len(v),min(v),max(v))'
```

| series | code | n | total s, median (min-max) | first ssh answer s | stability s | host swap MB | load1 |
|---|---|---|---|---|---|---|---|
| before | main + timing lines (`a2aa72d8`) | 5 | 205 (195-219) | 145 (143-159) | 38 (35-54) | ~9,890 (not in rows, see below) | 5.28 (3.83-8.27) |
| after | TIF-98 (`42cd2376`) | 2 | 194 (185-203) | 142 (139-145) | 33.5 (29-38) | 9,876 (9,864-9,888) | 6.65 (4.36-8.94) |
| after-recovered | TIF-98 (`bcd57dba`) | 1 | 227 | 163 | 48 | 4,532 | 8.08 |
| after-cycle | TIF-98 (`bcd57dba`) | 5 | 214 (213-254) | 159 (152-183) | 43 (33-48) | 4,460 (4,420-4,468) | 8.92 (6.71-9.72) |

Same-swap comparison (about 9.9 GB): before median 205 s (n=5), after 194 s (n=2). The 11 s
gap is about the size of the polling waste removed, but n=2 at different loads cannot
separate it from noise. Later series ran at higher load (medians 8.08 and 8.92), which is the more likely
reason they were slower. They used the same code, and swap was lower.

Every reset in every series ended `ready on 'clean-base'` with a passing readiness re-check
(one ssh round trip). All 5 `after-cycle` rows ran reset, then `agent/bootstrap/deploy-to-vm.sh`
(rc 0, 146-229 s, each printing `verified 13 files on the guest against the source (sha256)`,
`ping verified` and `DEPLOY OK`), then `session_info` (rc 0, 3-5 s,
`{"session_id":1,"window_station":"WinSta0","desktop":"Default"}`), back to back.

### Disclosures

- **Two resets have no JSONL row.** Their reset lines are in `reset-lines.txt`. "before
  run 4" (226 s) finished, but the harness's 60-min background cap killed the bench while it
  waited at the load gate before the readiness re-check. "after run 3" (200 s) finished, but
  I stopped the bench at the load gate to add the memory fields. Neither stop interrupted a
  VM step, and both resets succeeded. Including them changes no conclusion.
- **The `before` rows predate the swap fields.** Host swap during that series was read
  from a diagnostic shell (`sysctl vm.swapusage`: 9,888-9,896 MB used of 11,264) and is
  not in the rows.
- **One more reset, for the boot profile** (240 s, TIF-98 code, swap 4,321 of 5,120 MB), was
  run without the bench and is not in the table. `boot-profile.json` was taken 578 s after
  that boot.
- **`before.jsonl` holds two bench invocations under one label.** Its `run` values are
  1, 2, 3, 1, 2: the first invocation's runs 1-3, then the second invocation's runs 1-2,
  which `reset-lines.txt` calls `before-2`. The summary counts all five rows; the data file
  is left as recorded, so read a `before` run number together with its `started_utc`.

## Phase breakdown (`after-cycle` medians)

| phase | s | what it is |
|---|---|---|
| stop | 1 | `vm.sh kill`, poll `stopped` |
| restore | 2 | UTM applies the qcow2 internal snapshot (disk and EFI vars) |
| start | 3 | UTM launches QEMU |
| boot to first SSH answer | 159 | Windows booting (`first ssh answer` line) |
| stability probes | 43 | 3 consecutive answers, starts at least 5 s apart (TIF-220) |
| clock resync | 11 | `Set-Date` over ssh |

## Why the boot is slow (evidence)

- `boot-profile.json` (`scripts/guest-boot-profile.sh`, read-only) holds Windows' own
  Diagnostics-Performance event 100 for this boot and for the first boot on record:
  `BootSmssInitTime` 54,466 ms vs 1,147 ms, `BootDriverInitTime` 23,794 ms vs 174 ms,
  `MainPathBootTime` 168,993 ms vs 89,760 ms. Top CPU since boot: Defender (`MsMpEng`,
  251 s), System (203 s), then svchost and explorer; OneDrive is not in the recorded top 10.
  In the 10 s window at 578 s uptime: Defender, System and `ngen`.
- `reset-lines.txt`: guest CPU at the first SSH answer is 264-314 s (median 281) across all
  15 resets, about two host cores for the whole boot.
- **Diagnostic-shell observations, not scripted:**
  - An in-guest `shutdown /r` with no snapshot restore took 166 s to the first SSH answer,
    the same as a reset.
  - At 1,558 s uptime, Defender (487 CPU-s), `taskhostw` (221), `mscorsvw`/`ngen` and
    `MoUsoCoreWorker` were still active, with QEMU at 187 % host CPU.
  - `sshd` StartType is Automatic, not delayed.
  - Windows power settings: sleep and hibernate after 0, i.e. never.
  - At 9.9 GB swap, QEMU held about 1.8 GB resident for a 6 GB guest. The `before` and
    `after` rows predate the QEMU resident field, so this figure is in no row.
- **Memory is a secondary factor.** After the coordinator's session freed memory, the 6 rows
  that record it (`after-recovered`, `after-cycle`) show swap 4,420-4,532 MB, 61-72 % host
  memory free and QEMU resident 4,305-4,559 MB, and those resets took 213-254 s.

## What changed

1. `wait-guest-ready.sh` samples guest CPU and probes SSH every **2 s** instead of 10 s.
   The stall verdict is now a **30 s wall-clock window** (`MYCO_READY_STALL_SECONDS`), and the
   number of flat samples is derived from it, never fewer than 3. So faster sampling cannot
   call a slow boot a stall sooner than before.
2. Stability probes are spaced **start to start**. The property is unchanged: 3 consecutive
   answers whose starts are at least 5 s apart, so the window still spans at least 10 s. The
   difference is that no sleep is added on top of a probe that already took longer than the
   spacing. The integer clock is handled by an extra second when the gap is exactly the
   spacing.
3. `reset-trial-vm.sh` prints a per-phase `timing` line and a `host swap` line. The gate
   prints the `first ssh answer` time. These are informational only.
4. `reset-bench.sh`, `reset-bench-summary.py` and `guest-boot-profile.sh` are the
   measurement tools that produced this pack.

## RAM snapshot (`loadvm`): considered, not used

`clean-base-live` (RAM and disk) would skip the boot, at ~7-8 s when healthy. It was not
used, for two reasons:

- **The wedge.** The live path wedged UTM in `resuming` after 2-3 rapid cycles (m1-state
  log 35, reproduced by a verifier). Recovery is GUI-only, and this session runs unattended
  on a shared VM.
- **No equivalence proof.** The snapshot was taken 63 s into a boot, so it captures a guest
  mid-boot rather than a cold boot from the base. The equivalence the brief requires for
  oracle reads would need its own study.

See follow-up 2.

## Follow-ups (to file)

1. **New base image with post-boot maintenance done (the real speedup).** Starting from
   `clean-base`:
   - drain the .NET queue (`ngen executeQueuedItems`);
   - let Windows Update finish, or disable it;
   - add Defender exclusions for `C:\myco` and the agent, or turn real-time scanning off in
     the test VM;
   - consider disabling OneDrive and search indexing (an unrecorded observation: neither is in
     `boot-profile.json`'s top 10, which has `SearchHost` at 14.6 s, so measure first);
   - shut down cleanly and snapshot `clean-base-v2`.

   Measure it with `reset-bench.sh` and `guest-boot-profile.sh`. This changes the trial base,
   so it needs the lead's and Tiffany's approval, a re-run of the clean-base proof, and a
   decision on M1 comparability. TIF-275's egress block should also remove the network part
   of Defender and Windows Update churn.
2. **RAM-snapshot study.** Retry the live path on UTM 5.0.9 with a written host-side
   recovery (QEMU process kill), and define "identical for what the oracle reads". Do this
   only with an operator at the GUI.
3. **Guest stops answering SSH when idle.** About 20 min after a good reset, with no
   activity, SSH timed out during banner exchange and guest CPU was flat (0.08 s over 5 s).
   This was seen once. Windows sleep is set to never, so the cause is unknown. The next
   reset recovers it. It matters for long gaps between reset and trial.
4. **Clock resync costs 6-18 s.** It is one more ssh round trip. It could be folded into
   the deploy's first guest call when a deploy always follows.
