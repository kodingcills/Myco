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

vm_lock_owned_by_parent() {
  local pid driver
  [ "${MYCO_VM_LOCK_OWNER:-}" = "$PPID" ] &&
    read -r pid driver < "$VM_LOCK_PATH" &&
    [ "$pid" = "$PPID" ] &&
    case "$driver" in
      m1-sweep.sh|m1-corrupt-suite.sh)
        kill -0 "$pid" 2>/dev/null &&
          python3 - "$VM_LOCK_PATH" <<'PY'
import os
import sys

# Darwin's /dev/fd entries have different stat() identities from the
# files they open. Compare the inherited descriptor itself.
try:
    sys.exit(not os.path.samestat(os.fstat(9), os.stat(sys.argv[1])))
except OSError:
    sys.exit(1)
PY
        ;;
      *) return 1 ;;
    esac
}
