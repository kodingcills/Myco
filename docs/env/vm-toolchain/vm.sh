#!/usr/bin/env bash
# Thin wrapper over UTM's AppleScript API (works where `utmctl` hits the macOS Automation/TCC block).
# usage: vm.sh start|start-disposable|stop|kill|status|snapshot <name>|restore <name>|snapshots|delete-snapshot <name>|screenshot <png>
set -euo pipefail
NAME=${VM_NAME:-myco-win11}
D=$(cd "$(dirname "$0")" && pwd)
as() { osascript -e "tell application \"UTM\"" -e "set vm to virtual machine named \"$NAME\"" -e "$1" -e "end tell"; }

# TIF-164: `start vm` returns as soon as UTM accepts the launch, not when the
# guest boots. On 2026-11-23 that reported success for a guest that sat in early
# UEFI for 4.5 minutes and never reached sshd. A launch now proves the guest
# answers SSH first. Default 180s: a cold boot from a disk-only snapshot takes
# 20-30s on an idle host, so 180 is margin, not a hang.
BOOT_TIMEOUT=${MYCO_BOOT_TIMEOUT:-180}
boot_ready() {
  if [ "${MYCO_BOOT_SKIP_READINESS:-0}" = "1" ]; then
    echo "vm.sh: WARNING: MYCO_BOOT_SKIP_READINESS=1; not verifying that the guest reached SSH" >&2
    return 0
  fi
  case $BOOT_TIMEOUT in
    ''|*[!0-9]*)
      echo "vm.sh: MYCO_BOOT_TIMEOUT must be a whole number of seconds, got '$BOOT_TIMEOUT'" >&2
      return 2 ;;
  esac
  # wait-ssh.sh owns the ssh invocation (VM_ROOT, ssh_config, the myco-win11
  # host alias); pass it this launch's budget rather than its 3600s default.
  local w="$D/wait-ssh.sh" waited
  [ -r "$w" ] || { echo "vm.sh: wait-ssh.sh not found next to vm.sh ($w); cannot verify the guest booted" >&2; return 1; }
  if bash "$w" "$BOOT_TIMEOUT"; then
    return 0
  fi
  waited=$BOOT_TIMEOUT
  {
    echo "vm.sh: FAILED: UTM accepted the start, but the guest did not answer SSH within ${waited}s (MYCO_BOOT_TIMEOUT)."
    echo "  The guest was accepted, not proven up: it may be stuck in early UEFI, as in TIF-164."
    echo "  Likely causes, cheapest check first:"
    echo "    - host CPU saturation:  uptime; ps -Ao pcpu,pid,comm -r | head -5"
    echo "    - host reboot mid-window (the guest is gone with it):  vm.sh status"
    echo "  Re-run once the host is idle; raise MYCO_BOOT_TIMEOUT only for a first-ever boot."
    echo "  MYCO_BOOT_SKIP_READINESS=1 skips this check without proving anything."
  } >&2
  return 1
}

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
      # flock is not reentrant across processes. reset-trial-vm.sh acquires the
      # lock and then calls `vm.sh start`, so acquiring unconditionally would make
      # the child refuse its own parent (rc 10) and the guest could never boot.
      # Mirror reset-trial-vm.sh:19-22: if an ancestor already holds it, inherit.
      if vm_lock_owned_by_parent; then
        echo "vm.sh: host VM lock already held by the caller; starting under it" >&2
      else
        vm_lock_acquire "vm.sh $1" || exit "$?"
        trap vm_lock_release EXIT
      fi
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
  # `-` on the start cases: the guest answering SSH is this launch's success
  # condition, so the readiness check runs inside the same `set -e` case arm and
  # its non-zero exit propagates (before this, only the AppleScript rc mattered).
  start) as 'start vm' && boot_ready ;;
  start-disposable) as 'start vm saving false' && boot_ready ;;
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
