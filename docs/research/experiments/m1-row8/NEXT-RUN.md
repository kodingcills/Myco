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

