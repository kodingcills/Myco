#!/bin/bash
# Sourced by the Windows trial drivers. FD 9 holds a kernel-managed flock.
# Leave the lock file in place so contenders always lock the same inode.
VM_LOCK_PATH=${MYCO_VM_LOCK_PATH:-/tmp/myco-win11.vm.lock}

vm_lock_refused() {
  local message="REFUSED_VM_LOCKED: holder $1"
  echo "$message" >&2
  if [ -n "${2:-}" ]; then
    echo "$message" >> "$2"
  fi
  return 10
}

vm_lock_release() {
  exec 9>&-
}

vm_lock_acquire() {
  local driver=$1 progress=${2:-} holder status=0 pid matches
  exec 9>>"$VM_LOCK_PATH" || return 1

  # macOS and Linux both expose flock through Python. The lock belongs to the
  # inherited open file description, so it survives this Python process.
  # The kernel releases it when the driver and its last inheriting child exit.
  holder=$(python3 - "$VM_LOCK_PATH" "$$" "$driver" <<'PY'
import fcntl
import os
import sys
from pathlib import Path

path, pid, driver = sys.argv[1:]
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    holder = Path(path).read_text().strip()
    if holder:
        try:
            os.kill(int(holder.split()[0]), 0)
        except ProcessLookupError:
            holder += " (driver exited; a child still holds the lock)"
        except (ValueError, PermissionError):
            pass
    print(holder or "initializing lock owner")
    sys.exit(10)
# Overwrite stale metadata only after the kernel has granted exclusive access.
os.ftruncate(9, 0)
os.write(9, f"{pid} {driver}\n".encode())
PY
  ) || status=$?
  if [ "$status" -ne 0 ]; then
    vm_lock_release
    if [ "$status" -eq 10 ]; then
      vm_lock_refused "$holder" "$progress"
      return 10
    fi
    return "$status"
  fi

  # An older driver can already be running without holding this lock. Match
  # its script argument, excluding a caffeinate wrapper around this driver.
  local shell='([^[:space:]]*/)?(bash|sh|zsh)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*'
  local script='([^[:space:]]*/)?(m1-sweep|m1-corrupt-suite)\.sh([[:space:]]|$)'
  status=0
  matches=$(pgrep -f "^($shell)?$script") || status=$?
  if [ "$status" -gt 1 ]; then
    vm_lock_release
    echo "VM lock: could not check for legacy drivers (pgrep exit $status)" >&2
    return 1
  fi
  for pid in $matches; do
    if [ "$pid" != "$$" ]; then
      holder=$(ps -p "$pid" -o command= 2>/dev/null) || holder="legacy trial driver"
      vm_lock_release
      vm_lock_refused "$pid $holder" "$progress"
      return 10
    fi
  done
  export MYCO_VM_LOCK_OWNER=$$
}

# The fd-proven parent check (TIF-210), for the operator-session wrapper.
# True only when ALL hold, checked in this order:
#   1. $1 (the recorded, live owner) is an ancestor of this process. A child
#      that inherited the wrapper's FD 9 always is, so this costs a genuine
#      child nothing; it refuses a non-descendant before step 3 can run, which
#      is what closes the stale-record / reused-pid forgery (verifier D1).
#   2. FD 9 is the same file as $VM_LOCK_PATH (samestat), so step 3 never
#      touches any other file.
#   3. LOCK_EX|LOCK_NB on FD 9 succeeds. On the holder's own open file
#      description this is a no-op (the exclusive lock is already on it). On a
#      description this process opened itself it fails while the holder lives.
#      It is NOT side-effect-free when the lock is free: then it takes the lock
#      on this process's descriptor. Steps 1-2 limit that case to a descendant
#      of the recorded owner whose family has already let the lock go, and the
#      wrapper clears its record on exit (scripts/vm-session.sh), so a session
#      that was not SIGKILLed leaves no record for the check to match at all.
vm_lock_fd_is_holders() {
  python3 - "$VM_LOCK_PATH" "$1" <<'PY'
import fcntl
import os
import subprocess
import sys

path, owner = sys.argv[1], int(sys.argv[2])

curr = os.getppid()
for _ in range(64):
    if curr == owner:
        break
    if curr <= 1:
        sys.exit(1)
    try:
        out = subprocess.run(["ps", "-o", "ppid=", "-p", str(curr)],
                             capture_output=True, text=True, timeout=5).stdout
        nxt = int(out.strip())
    except Exception:
        sys.exit(1)
    if nxt == curr:
        sys.exit(1)
    curr = nxt
else:
    sys.exit(1)

try:
    if not os.path.samestat(os.fstat(9), os.stat(path)):
        sys.exit(1)
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(1)
PY
}

vm_lock_owned_by_parent() {
  local pid driver owner="${MYCO_VM_LOCK_OWNER:-}"
  [ -n "$owner" ] &&
    read -r pid driver < "$VM_LOCK_PATH" &&
    [ "$pid" = "$owner" ] &&
    case "$driver" in
      # The operator-session wrapper (TIF-210). Descent is necessary but never
      # sufficient: the child must also carry the wrapper's FD 9. There is no
      # "fd OR ppid" fallback as for the drivers below.
      vm-session.sh)
        kill -0 "$pid" 2>/dev/null && vm_lock_fd_is_holders "$pid"
        ;;
      m1-sweep.sh|m1-corrupt-suite.sh|c1-baseline.sh|c1-sweep.sh|c1-spike.sh)
        kill -0 "$pid" 2>/dev/null &&
          python3 - "$VM_LOCK_PATH" "$owner" <<'PY'
import os
import subprocess
import sys

path, owner_str = sys.argv[1:3]
owner = int(owner_str)

try:
    if os.path.samestat(os.fstat(9), os.stat(path)):
        sys.exit(0)
except OSError:
    pass

curr = os.getppid()
while curr > 1:
    if curr == owner:
        sys.exit(0)
    try:
        out = subprocess.check_output(["ps", "-o", "ppid=", "-p", str(curr)], text=True)
        curr = int(out.strip())
    except Exception:
        break

sys.exit(1)
PY
        ;;
      *) return 1 ;;
    esac
}
