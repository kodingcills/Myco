# TIF-164: the guest stalls in early UEFI because the host is CPU-saturated

**Diagnosed 2026-11-23 ~09:40 ET.** Cause is **external to the VM**; no snapshot is
damaged. Do not rebuild anything.

## Evidence

**The guest never left firmware.** UTM's own capture of the failed boot:

> `Guest has not initialized the display (yet).`

**The guest was starved, not stalled on a fault.** `qemu` pid 69100 burned
**1:48 of CPU in ~4.5 minutes of wall time** — roughly **40% of one core** on a
**14-core** host, with `-S` present and `load average 26.56`.

**The load was not the VM's.** The top consumer at diagnosis time:

```
%CPU     PID  COMM
1294.3   4381 /opt/homebrew/bin/omp          <- 13 cores saturated
  25.5  69100 QEMULauncher (the guest)
  19.1    430 WindowServer
```

`omp` pid **4381** is an agent process whose **cwd is
`~/.t3/worktrees/Myco/myco-mvp-discovery-4b5ff1cd3a7126c4`** — the **MVP Discovery
worktree**, not this one and not the VM. It had been running **44 minutes** at
**>1000% CPU**, and was still at **950%** after the guest stopped.

## What is NOT the cause (checked and cleared)

- **Snapshots are intact.** `qemu-img info` reports **`corrupt: false`** on both the
  system disk and the EFI varstore. All four snapshots parse with a correct parent
  chain.
- **The EFI varstore is not corrupt.** It is a valid qcow2, `virtual size: 64 MiB`,
  and its file being ~9 GiB is UTM's normal over-allocation, not damage. I initially
  read the size as corruption; `qemu-img` disproved that.
- **`-S` is normal.** UTM launches with `-S` and resumes via QMP. Its presence is
  not evidence of a stuck pause.
- No stale spice socket, no leftover pidfile, no held lock.

## Why this looks new

`cua-c1-base` (the snapshot the probe restored) has **`HasState: False`** and
`Size: 0` — a **disk-only** snapshot with no saved RAM. So a restore is a **cold
Windows boot**, which needs 20–30 s of real CPU to reach `sshd`. Under a host at
load 26 with 13 cores gone, that boot does not complete. **arm-003c booted fine
before the 04:38 reboot because the host was idle then**, not because anything
about the snapshot changed.

```
clean-base        HasState=False  Size=0           parent=None      (root)
clean-base-live   HasState=True   Size=2215968090  parent=clean-base
m1-agent-live     HasState=True   Size=2919031845
cua-c1-base       HasState=False  Size=0           parent=clean-base
```

## Consequence for the queue

**A VM slot cannot succeed while pid 4381 is spinning.** Every queued item — Shot
probe, arm-003d, DF-S01, row 8 — depends on a boot that this host will not complete.
The fix is to stop the runaway Discovery process (or wait for it), not to touch the
VM.

**I have not touched it.** It belongs to another workstream and killing another
owner's agent process is not mine to do. Flagged to the outer loop for a decision.

## The guard that should exist (to build next)

`vm.sh start` returns rc 0 as soon as UTM accepts the start, which is why this
looked like a successful launch for 4.5 minutes. It should **fail unless the guest
reaches an SSH banner within a measured timeout**, so an external stall is reported
as a failed start rather than an empty window. That is the Tier-1 change for TIF-164.

**Built.** `vm.sh start`/`start-disposable` now poll `wait-ssh.sh` for
`MYCO_BOOT_TIMEOUT` seconds (default 180) after UTM accepts the launch, and exit 1
with the causes above if the guest never answers. `MYCO_BOOT_SKIP_READINESS=1`
bypasses it. The lock behaviour is unchanged.

## Re-measure before any slot

```bash
uptime                                   # expect load under ~8
pgrep -f 'QEMULauncher|qemu-system'      # expect 0 before you start
ps -Ao pcpu,pid,comm -r | head -5        # expect no >200% agent process
```
