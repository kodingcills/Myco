# DF-S01 cannot start from a clean host: preflight demands the guest the runner would boot

**Found 2026-11-23** while attempting DF-S01 as the next queue item. Recorded rather
than worked around, because both obvious workarounds fail and one of them means
bypassing a safety gate.

## The conflict, in three lines

```
scripts/df005-runner.py:1347   rc = preflight()                 # requires guest-ssh reachable
scripts/df005-runner.py:1354   lock_fd = acquire_vm_lock(...)   # only reached if preflight passed
runtime/crates/.../lib.rs:616  self.run_script("boot.sh", &[])  # create() boots the guest
```

**Preflight hard-fails when no guest is running**, and it runs *before* the runner
acquires the lock or calls `create()`. **The guest only ever comes up via
`create()` — which is downstream of the gate that requires it.**

So the runner cannot be started from a clean host:
`preflight failed; not taking the guest slot. Fix the checks above`.

## Both workarounds fail, and one is unsafe

**(a) Boot the guest first, then run.** `guest-ssh` passes, but `boot.sh` holds
the host flock for the guest's lifetime (`boot.sh:115`, and `:37` shows it exits 0
without re-locking when the guest is already up), so the runner then fails:

```
FAIL vm-lock: held by 19182 boot.sh /Users/.../runtime/guest
```

**(b) Pass `--skip-preflight`.** The runner offers it, but taking it means
**bypassing the readiness gate in order to reach the thing the gate guards** — and
TIF-158's whole finding was that a gate not wired to its action is not a gate.

## What was already fixed on the way here

Two real blockers cleared off-VM, worth recording because both would have wasted
the slot:

1. **The MCP binary was stale** — built Nov 22 07:24 against source from Nov 23
   01:05. Preflight caught it exactly as designed: *"create does not declare
   introspection_file"*. `cargo build -p myco-rt-mcp`; `create-schema` now `ok`.
2. **The Linux runtime guest was unprovisioned in this worktree** — all six assets
   `MISS` (key, image, overlay, seed, agent). `provision.sh` (downloads the pinned
   592 MB image, builds keypair/overlay/seed) then `--build-agent` (boots, waits
   cloud-init, builds in-guest, shuts down). `Provisioned.` rc 0; both locks
   released. This is a *fresh-worktree* cost every checkout pays, and it is
   ~4 minutes of guest time dominated by the in-guest cargo build.

## Candidate fixes

- **Make `guest-ssh` advisory in the context of a run that will boot.** Preflight's
  own docstring says it checks things that *"if wrong, waste the slot"* — an
  absent guest is exactly what `create()` is for, so it is not one of those things.
  This matches the reading already applied to `app-deployed`, which is `skip`ped
  rather than failed when the guest is unreachable.
- **Or boot before preflight**, and have preflight re-check `vm-lock` afterwards
  knowing `boot.sh` legitimately holds it during the run.

The first is smaller. Either way the fix must keep `--skip-preflight` from being
the *only* way to run, because a gate whose sole escape hatch is itself is not a
gate.
