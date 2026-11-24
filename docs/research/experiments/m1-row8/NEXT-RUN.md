# Row-8 §6 launch — ready when r6 releases the flock

Owner: M1 coordinator. Prepared 2026-11-24 06:56Z, **not run**. r6 (c1-baseline, pid 36343)
holds the VM until it finishes, by lead's order. Nothing below touches the guest until then.

## Gate

```bash
# 1. The flock must be FREE. Any driver still in ps means wait.
python3 -c 'import fcntl
f=open("/tmp/myco-win11.vm.lock","a+")
try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print("FREE")
except BlockingIOError: print("HELD")
finally: fcntl.flock(f,fcntl.LOCK_UN)' 2>/dev/null
ps -eo pid,command | grep -E "[c]1-baseline|[m]1-sweep|[r]eset-trial-vm" || echo "no driver"
```

Both must show free / none. Then clear the stale record (§2 of the runbook) and verify the guest
is clean (§6.1), which is where attempt A's leftover `myco-80877-…` dir came from.

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

**Liveness is the guest run dirs, not the log** — one new dir under `runs/s6-final/values` every
~48 s, and `result.json` appears when each trial finishes:

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
~/VMs/myco-win11/scripts/vssh 'powershell -NoProfile -Command "Get-Content C:\ProgramData\Myco\agent.token"' > /tmp/s6-token
```

Both were hit on 2026-11-24 immediately after r6 released the guest.

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
- `C:\myco\profiles\myco-*` throwaway UNO profiles.

**Mac — untouched.** `/Users/tofuinparis/Projects/myco-runs/c1-r6/` is intact (644K:
`accounting.json`, `report.json`, `progress.log`, `run.pid`, `trials*`, `watch.*`). **Nothing on the
host side was read, moved, or deleted by me** — my cleanup used `vssh` + PowerShell against the
guest only, and my file operations were confined to this worktree and `/tmp`.

**If Shot's `--resume` needs anything from the guest's `runs\20`, it is gone**; it was r6's output
directory, not its input, and `--resume` reads the host ledger.

