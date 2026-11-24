
## Fencing (added after attempt B)

`run-live` now takes the VM flock (TIF-191, PR #390), so a §6 run **cannot** be reset out from
under it any more: a driver that tries gets `REFUSED_VM_LOCKED` instead. On a build before #390,
the gate above is the only protection, and it is a race — attempt B passed the gate and was
reset 55 s later.
