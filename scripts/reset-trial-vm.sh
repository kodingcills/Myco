#!/usr/bin/env bash
# M1-013 trial reset: disk-only cold restore of myco-win11, with a loud failure
# instead of a hang when UTM is stuck.
#
# Why cold and not live: the live (RAM+disk) snapshot path wedges UTM in
# `resuming`, after which UTM refuses both `stop by force` and `start` with
# -2700 'operation not available' and needs a host-side QEMU process kill.
# Observed by the coordinator and independently by a verifier (m1-state log 35,
# and PR #28's rejection). The disk-only path uses a plain qemu-img restore and
# has not exhibited it.
#
# Known tradeoff: cold boot costs ~21s warm / ~165s from a fresh UTM start,
# versus the live path's ~7s. We pay it for a reset that cannot wedge.
#
# usage: reset-trial-vm.sh [snapshot]   (default clean-base)
set -euo pipefail

SNAPSHOT=${1:-clean-base}
VM_SCRIPTS=${MYCO_VM_SCRIPTS:-$HOME/VMs/myco-win11/scripts}
STOP_TIMEOUT=${MYCO_STOP_TIMEOUT:-30}
SSH_WAIT_TIMEOUT=${MYCO_SSH_WAIT_TIMEOUT:-600}

die() { echo "reset-trial-vm: $*" >&2; exit 1; }

status() { "$VM_SCRIPTS/vm.sh" status 2>/dev/null | tr -d '\r' || true; }

# Refuse to touch a snapshot we do not own the name of; these are protected.
case "$SNAPSHOT" in
  clean-base|clean-base-live|m1-agent-live) ;;
  *) die "refusing to restore unexpected snapshot '$SNAPSHOT'" ;;
esac

# 1. Get to a hard stopped state. `resuming` is the wedge: UTM will not accept
#    stop or start from it, so waiting forever is wrong — fail loudly instead.
"$VM_SCRIPTS/vm.sh" kill >/dev/null 2>&1 || true
for _ in $(seq 1 "$STOP_TIMEOUT"); do
  s=$(status)
  [ "$s" = stopped ] && break
  sleep 1
done
s=$(status)
if [ "$s" != stopped ]; then
  if [ "$s" = resuming ]; then
    die "UTM is stuck in 'resuming' (the known -2700 wedge). It cannot be stopped or started by script; quit and reopen UTM in the GUI session, then re-run. See docs/coordination/m1-state.md log 35."
  fi
  die "VM did not reach 'stopped' within ${STOP_TIMEOUT}s (state: '$s')"
fi

# 2. Restore + boot. Never call restore on a non-stopped VM: that is what
#    triggers UTM's live-resume path and the wedge above.
"$VM_SCRIPTS/vm.sh" restore "$SNAPSHOT" >/dev/null
"$VM_SCRIPTS/vm.sh" start >/dev/null

# 3. Wait for SSH, then prove the state we are in is not a half-resumed one.
"$VM_SCRIPTS/wait-ssh.sh" "$SSH_WAIT_TIMEOUT" >/dev/null || die "guest did not answer SSH within ${SSH_WAIT_TIMEOUT}s"

# 4. The guest clock is the snapshot's clock; resync so trial timestamps are sane.
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
"$VM_SCRIPTS/vssh" "Set-Date -Date ([datetime]::Parse('$NOW').ToUniversalTime().ToLocalTime()) | Out-Null" >/dev/null 2>&1 || true

echo "reset-trial-vm: ready on '$SNAPSHOT'"
