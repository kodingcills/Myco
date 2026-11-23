#!/usr/bin/env bash
# Thin wrapper over UTM's AppleScript API (works where `utmctl` hits the macOS Automation/TCC block).
# usage: vm.sh start|start-disposable|stop|kill|status|snapshot <name>|restore <name>|snapshots|delete-snapshot <name>|screenshot <png>
set -euo pipefail
NAME=${VM_NAME:-myco-win11}
D=$(cd "$(dirname "$0")" && pwd)
as() { osascript -e "tell application \"UTM\"" -e "set vm to virtual machine named \"$NAME\"" -e "$1" -e "end tell"; }

# TIF-137: a launch takes the host VM lock, the same flock boot.sh and the trial
# drivers use. Without this, vm.sh was the one launcher that could start a guest
# while another owner held the lock — and build-all.sh calls it four times.
# Only the launching subcommands lock; status/snapshots/screenshot are read-only.
case "${1:-}" in
  start|start-disposable)
    # vm-lock.sh lives in the repo (scripts/), not in the host copy of this
    # directory, so search both layouts before giving up.
    LOCK=""
    for c in "$D/../../../scripts/vm-lock.sh" "$D/vm-lock.sh" "$D/../scripts/vm-lock.sh"; do
      [ -r "$c" ] && { LOCK=$c; break; }
    done
    if [ -n "$LOCK" ]; then
      # shellcheck source=/dev/null
      . "$LOCK"
      vm_lock_acquire "vm.sh $1" || exit "$?"
      trap vm_lock_release EXIT
    elif [ "${MYCO_VM_LOCK_OPTIONAL:-0}" = "1" ]; then
      echo "vm.sh: WARNING: vm-lock.sh not found; launching WITHOUT the host VM lock (MYCO_VM_LOCK_OPTIONAL=1)" >&2
    else
      # Refusing is the safe default: launching unlocked is exactly the race the
      # lock exists to close. Verified: an earlier warn-and-proceed version would
      # start a guest while another holder held the lock.
      echo "vm.sh: REFUSING to launch: vm-lock.sh not found, so the host VM lock cannot be taken." >&2
      echo "  Looked in: $D/../../../scripts/vm-lock.sh, $D/vm-lock.sh, $D/../scripts/vm-lock.sh" >&2
      echo "  Set MYCO_VM_LOCK_OPTIONAL=1 to launch anyway (unsafe outside a single-owner host)." >&2
      exit 1
    fi
    ;;
esac

case "${1:-}" in
  start) as 'start vm' ;;
  start-disposable) as 'start vm saving false' ;;
  stop) as 'stop vm by request' ;;
  kill) as 'stop vm by force' ;;
  status) as 'get status of vm' ;;
  snapshots) as 'get name of every snapshot of vm' ;;
  snapshot) as "create snapshot vm named \"$2\"" ;;
  restore) as "restore (first snapshot of vm whose name is \"$2\")" ;;
  delete-snapshot) as "delete snapshot (first snapshot of vm whose name is \"$2\")" ;;
  screenshot) as "capture screen vm to (POSIX file \"$2\")" ;;
  *) sed -n 2,3p "$0"; exit 2 ;;
esac
