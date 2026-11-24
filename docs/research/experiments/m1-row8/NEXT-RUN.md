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
/tmp/s6-run.sh runs/s6-final 20
```

`/tmp/s6-run.sh` uses **`setsid`** so the job owns its own session and no omp teardown can reap it
(attempt A died that way at 06:33:04Z, leaving one empty run dir). It writes:

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