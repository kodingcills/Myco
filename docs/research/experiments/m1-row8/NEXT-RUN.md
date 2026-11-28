# Row-8 §6 launch — ready when r6 releases the flock

Owner: M1 coordinator. Prepared 2026-11-24 06:56Z, **not run**. r6 (c1-baseline, pid 36343)
holds the VM until it finishes, by lead's order. Nothing below touches the guest until then.

## Gate

```bash
# 1. Nobody may own the VM. Read-only: lsof, never a flock probe (F5, F19).
lsof /tmp/myco-win11.vm.lock || echo "free"      # a table = someone owns it
ps -eo pid,command | grep -E "[c]1-baseline|[m]1-sweep|[r]eset-trial-vm" || echo "no driver"
```

Both must show free / none. **Do not use a `fcntl.flock` probe here.** An earlier revision of
this block did, and step 1 of the launch sequence below forbids it: a probe holds `LOCK_EX` for
an instant, and a driver starting in that instant refuses with exit 10 (F5). Then verify the
guest is clean (§6.1), which is where attempt A's leftover `myco-80877-…` dir came from.

**This page skips §3 reset and §4 deploy, and that is only acceptable outside row 8 (F20).** The
§6 run below was a generator re-measure on the guest r6 left. A **row-8 reproduction does not
skip them**; see the runbook §6, "When you may skip §3 and §4". The M1 lock procedure is in
the runbook §6 as well: each step takes and releases the lock through its own script, and you run
the `lsof` gate check before every step. Deploy and the §6.1 check and cleanup do not take the
lock, so the gate check is all that guards them.

## Launch — §6, survivor-detached

```bash
/tmp/s6-launch.sh runs/s6-final 20
```

**`setsid` DOES NOT EXIST ON macOS.** Checked 2026-11-24: `which setsid` is empty. A launcher built
on it fails **instantly and silently** — the background job dies before writing a byte, so the log
is empty, the pid file names a dead process, and no exit file appears. Two launches were lost to
this before `which setsid` was the first thing checked. **Use `nohup`**, optionally wrapped in
`caffeinate` to keep the host awake.

The launcher writes:

| file | meaning |
|---|---|
| `/tmp/s6-run.pid` | the run's own pid (the launcher execs, so it is not a wrapper) |
| `/tmp/s6-run.log` | `launch …` line, then the JSON array at the end. **Silence is normal** |
| `/tmp/s6-run.exit` | `exit=0` means 20/20 verified; `1` a non-verified row; `2` no sets; `10` lock held |

**Liveness is the guest run dirs, not the log**: one new dir under `runs/s6-final/values` every
~40–90 s (mean 51 s, 17 min 7 s for all 20 on 2026-11-24 at load 5–9; F21), and `result.json`
appears when each trial finishes:

```bash
ls runs/s6-final/values | wc -l
for d in runs/s6-final/values/*/; do jq -r '.verdict.status + " " + .verdict.reasons[0]' "$d/result.json" 2>/dev/null; done
```

If `/tmp/s6-run.exit` does not appear and the dir count stops growing, the run is dead — check the
pid with `kill -0` before concluding anything.

## After §6

- **20/20** → §7.3 sweep into its own fresh dir, then the row-8 rerun: a **fresh worker in its own
  fresh clone**, no lock reservation (that reservation was F3, and it made the first operator
  stop at §3.1).
- **exit 10** → the flock was taken between the gate and the launch; wait and re-run. Nothing was
  created on the guest.
- **any refutation** → stop per §6. The runbook says fix the generator first.

## Fencing (added after attempt B)

`run-live` now takes the VM flock (TIF-191, merged as `865389fc`), so a §6 run **cannot** be reset
out from under it any more: a driver that tries gets `REFUSED_VM_LOCKED` instead. On a build
before that, the gate above is the only protection, and it is a race — attempt B passed the gate
and was reset 55 s later.

## The guest is not clean after a C1 run

r6 finished at 08:2xZ and released the flock, and the guest it left was **not** clean:

- **two stray `soffice` processes** (`soffice 6644`, `soffice 3868`), and
- **a run dir literally named `20`** — the C1 sweep's output directory, holding the C1 trial
  `myco-36375-…` dir and a `profiles/`. §6.1's `myco-*` filter does **not** match a dir named
  `20`, so the standard cleanup leaves it and every §6 row then fails
  `guest contaminated — leftover run dirs: 20`.

The §6 command also needs a **fresh token**: the one in `~/.myco-token` is what the *last* run
fetched, and r6 installed its own. A stale one gives `AUTH_FAILED` after the guest has already
been touched. Fetch it first:

```bash
(umask 077; ~/VMs/myco-win11/scripts/vssh 'powershell -NoProfile -Command "Get-Content C:\ProgramData\Myco\agent.token"' > /tmp/s6-token)
```

Both were hit on 2026-11-24 immediately after r6 released the guest.

**Today, fetch into `~/.myco-token` instead (runbook §4).** `run-live` and the §5 CLI read that
file (with `MYCO_AGENT_TOKEN` unset); nothing reads `/tmp/s6-token`. The path is shared by every
operator on this Mac, and any deploy rotates the token, so re-fetch straight after your own deploy.

## Handoff: r6 resume (Shot) — the flock is FREE as of 2026-11-24 08:5xZ

r6 ended **PARTIAL at trial 19** on a `max_tokens=1024` truncation (harness fault, TIF-200), and
Shot resumes it from trial 20. **The flock is free and no driver is running.** My §6 run finished
at 08:49:46Z and released it; nothing of mine holds the guest now.

**Match the reset target to r6's snapshot.** r6 resumed from `cua-c1-base` (`/tmp/c1-r6-resume.log`:
`Resetting VM to cua-c1-base...`). My §6 ran on the post-r6 guest and required no reset, so
whichever snapshot Shot resumes against, it should be the one r6 was built on — not `clean-base`,
which predates the Cua install.

### What I removed, and what I did not touch

**Guest (Windows) — removed, r6's own residue, recreated automatically:**
- two stray `soffice` processes (`6644`, `3868`) left by r6's teardown;
- `C:\myco\runs\20` — the C1 sweep's output dir, holding r6's trial dir
  `myco-36375-1795508434142-964161670` and a `profiles/`. It is the guest half of the run, and
  `vm-lock`/§6.1 treat it as contamination; `myco-admin` is recreated on demand by `runGuestScript`.
  **It was deleted without a copy, and that is no longer the rule (F17).** A stray C1 guest dir is
  not row-8 evidence, but it may be the only guest-side copy of that C1 trial. Copy it to the
  host first (`scp -r … /tmp/row8-guest-residue/`, runbook §6.1), record the path, then clean.
  The 11:4xZ row-8 operator did this for `runs\29` (`/private/tmp/row8-guest-residue/29`, 53 files).
- `C:\myco\profiles\myco-*` throwaway UNO profiles.

**Mac — untouched.** `~/Projects/myco-runs/c1-r6/` is intact (644K:
`accounting.json`, `report.json`, `progress.log`, `run.pid`, `trials*`, `watch.*`). **Nothing on the
host side was read, moved, or deleted by me** — my cleanup used `vssh` + PowerShell against the
guest only, and my file operations were confined to this worktree and `/tmp`.

**If Shot's `--resume` needs anything from the guest's `runs\20`, it is gone**; it was r6's output
directory, not its input, and `--resume` reads the host ledger.

## The §6 window, as of 2026-11-24 10:00Z

**r6 holds the VM** (`c1-baseline` pid 21994, node 22027) for its resume, expected ~2h. The
row-8 §6 goes **after** it releases, on the corrected runbook (#405 merged `2833a941`).

### The launch sequence

1. **Confirm r6 is finished and the flock is free, read-only.** Use `lsof`, never a flock probe:
   a probe takes `LOCK_EX|LOCK_NB` for an instant, and drivers acquire with `LOCK_NB` and no
   retry, so a probe and a real driver starting together can make the DRIVER exit 10 (F5).
   ```bash
   lsof /tmp/myco-win11.vm.lock          # empty = free
   ps -eo pid,command | grep -E "[c]1-baseline|[m]1-sweep"   # nothing = no driver
   ```
   The lock FILE text is not evidence — it is the last writer and is routinely a dead pid. In
   fact TIF-202 means launcher **tests** write it, so it can name a `c1-baseline` that never ran.

2. **Clean the guest *past* §6.1's filter.** A C1 run leaves `C:\myco\runs\20`; `myco-*` does
   not match it, so the old check printed nothing (a false clean) and every row then failed
   `leftover run dirs: 20`. r6 also left two stray `soffice`. §6.1 now excludes only
   `myco-admin` and `profiles` (#405). Run the check. If it lists a C1 dir (a bare number),
   copy it aside before the cleanup (runbook §6.1, F17): it is not row-8 evidence, but it is
   not yours to destroy unseen. Re-run the check and confirm it prints nothing.

3. **Fetch a fresh token.** The cached `~/.myco-token` belongs to the last deploy and gives
   `AUTH_FAILED` *after* the guest has been touched:
   ```bash
   (umask 077; ~/VMs/myco-win11/scripts/vssh 'powershell -NoProfile -Command "Get-Content C:\ProgramData\Myco\agent.token"' > /tmp/s6-token)
   ```

4. **Launch, detached, with an explicit runs dir.** `nohup` + `caffeinate`; **macOS has no
   `setsid`** and a launcher built on it dies instantly and silently (empty log, dead pid file,
   no exit file). Use `--runs-dir runs/s6-final` so the evidence is not mixed with the §1.2 test
   fixtures:
   ```bash
   pnpm exec tsx src/integration/run-live.ts --mode values --limit 20 --runs-dir runs/s6-final
   ```

5. **Watch liveness, not the log.** A `values` run prints its JSON array **once at the end**, so
   **a silent log is the healthy shape** — attempt A died because that was read as a hang.
   Liveness is a new dir under `runs/s6-final/values/` every ~40–90 s; plan 12–20 min in all (F21). `/tmp/row8-watch.sh` does
   exactly this, and checks ownership with `lsof` so it can never fail the run it watches.

6. **§6 takes the flock itself.** `run-live` acquires it and refuses with **exit 10** if another
   driver holds it. Exit 10 is *not* a generator failure — someone else holds the VM; wait and
   re-run.

### Recorded §6 result, 2026-11-24 08:34-08:49Z: 20/20 verified, exit 0

Already PASSED once on this hardware (see [`S6-PASS.md`](S6-PASS.md)). The rerun exists to show a
*first-time operator* can reproduce it, not to re-measure the generator.

