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

source "$(dirname "$0")/vm-lock.sh"
if ! vm_lock_owned_by_parent; then
  vm_lock_acquire reset-trial-vm.sh || exit "$?"
  trap vm_lock_release EXIT
fi

SNAPSHOT=${1:-clean-base}
# Where vm.sh lives. Override with MYCO_VM_SCRIPTS to point at a stub.
#
# Footgun this guards: a test that means to stub but forgets to export the
# variable silently drove the REAL VM and wedged it mid-sweep. So the real
# default is only used when the caller is not asking for a stub — and a stub
# that is requested but missing fails loudly instead of falling back.
VM_SCRIPTS=${MYCO_VM_SCRIPTS:-$HOME/VMs/myco-win11/scripts}
if [ -n "${MYCO_VM_SCRIPTS:-}" ] && [ ! -x "$VM_SCRIPTS/vm.sh" ]; then
  echo "reset-trial-vm: MYCO_VM_SCRIPTS is set but $VM_SCRIPTS/vm.sh is not executable; refusing to fall back to the real VM" >&2
  exit 2
fi
# The readiness gate is the one VM-adjacent script that lives in THIS repo, so
# the version that runs is the version the tests exercise. The other lifecycle
# scripts (vm.sh, vssh) stay in the VM dir per docs/eval-runbook.md.
#
# It is still resolved through VM_SCRIPTS so a test stub can shadow it, as
# test/wait-guest-ready.test.ts and the reset-allowlist test both do.
REPO_GATE=$(cd "$(dirname "$0")" && pwd)/wait-guest-ready.sh

STOP_TIMEOUT=${MYCO_STOP_TIMEOUT:-30}
SSH_WAIT_TIMEOUT=${MYCO_SSH_WAIT_TIMEOUT:-600}

die() { echo "reset-trial-vm: $*" >&2; exit 1; }

# Per-phase wall-clock timing (TIF-98). One `timing` line on stderr at the end,
# so an operator and the evidence scripts can see where a reset's time went
# without changing what the reset does. Seconds, integer, host clock.
T0=$(date +%s)
T_PREV=$T0
TIMING=""
phase() {
  local now
  now=$(date +%s)
  TIMING="$TIMING $1=$(( now - T_PREV ))"
  T_PREV=$now
}

status() { "$VM_SCRIPTS/vm.sh" status 2>/dev/null | tr -d '\r' || true; }

# Prefer the in-repo gate when no stub directory was requested, so the tested
# copy is the deployed one; fall back to the VM dir only if it is missing.
gate_script() {
  if [ -n "${MYCO_VM_SCRIPTS:-}" ]; then
    echo "$VM_SCRIPTS/wait-guest-ready.sh"
  elif [ -x "$REPO_GATE" ]; then
    echo "$REPO_GATE"
  else
    echo "$VM_SCRIPTS/wait-guest-ready.sh"
  fi
}

# Refuse to touch a snapshot we do not own the name of; these are protected.
# cua-c1-base (M1 Coordinator-approved): a derivative taken from a cold clean-base
# restore with Cua installed, for the screenshot-baseline C1/C2 arms only.
case "$SNAPSHOT" in
  clean-base|clean-base-live|m1-agent-live|cua-c1-base) ;;
  *) die "refusing to restore unexpected snapshot '$SNAPSHOT'" ;;
esac

# 1. Get to a hard stopped state. `resuming` is the wedge: UTM will not accept
#    stop or start from it, so waiting forever is wrong — fail loudly instead.
"$VM_SCRIPTS/vm.sh" kill >/dev/null 2>&1 || true
for _ in $(seq 1 "$STOP_TIMEOUT"); do
  s=$(status)
  [ "$s" = stopped ] && break
  # Diagnose the wedge the moment it is observed: waiting out the timeout only
  # delays the message the operator needs.
  [ "$s" = resuming ] && break
  sleep 1
done
s=$(status)
if [ "$s" != stopped ]; then
  if [ "$s" = resuming ]; then
    die "UTM is stuck in 'resuming' (the known -2700 wedge). It cannot be stopped or started by script; quit and reopen UTM in the GUI session, then re-run. See docs/coordination/m1-state.md log 35."
  fi
  die "VM did not reach 'stopped' within ${STOP_TIMEOUT}s (state: '$s')"
fi
phase stop

# 2. Restore + boot. Never call restore on a non-stopped VM: that is what
#    triggers UTM's live-resume path and the wedge above.
"$VM_SCRIPTS/vm.sh" restore "$SNAPSHOT" >/dev/null
phase restore
"$VM_SCRIPTS/vm.sh" start >/dev/null
phase start

# 3. Wait for a real boot, then prove the state we are in is not a half-resumed
#    one. SSH alone is not enough: a stalled guest accepts TCP on 2222 (QEMU's
#    user-mode netdev listens with the guest stopped) and never answers, so an
#    SSH-only wait spends its whole budget and then fails - which is exactly what
#    consumed the 2026-11-23 09:2x slot (TIF-164). wait-guest-ready.sh also
#    requires guest CPU time to ADVANCE, which a non-booting guest never does.
GATE=$(gate_script)
[ -x "$GATE" ] || die "readiness gate not found: '$GATE' (expected the in-repo scripts/wait-guest-ready.sh, or one via MYCO_VM_SCRIPTS). Refusing to skip the boot check."
"$GATE" "$SSH_WAIT_TIMEOUT" >/dev/null || die "guest did not reach a real boot within ${SSH_WAIT_TIMEOUT}s (see TIF-164)"
phase ready
# 4. The guest clock is the snapshot's clock; resync so trial timestamps are sane.
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
if ! "$VM_SCRIPTS/vssh" "Set-Date -Date ([datetime]::Parse('$NOW').ToUniversalTime().ToLocalTime()) | Out-Null" >/dev/null 2>&1; then
  echo "reset-trial-vm: WARNING guest clock resync failed; trial timestamps may be stale" >&2
fi

phase clock
echo "reset-trial-vm: timing${TIMING} total=$(( $(date +%s) - T0 ))" >&2

# Host memory, on every reset (TIF-98). The measured driver of slow resets is
# host swap pressure, not this script: at ~9.9 GB of 11.2 GB swap used, QEMU
# held 1.8 GB resident for a 6 GB guest and a cold boot took ~145 s to its
# first ssh answer; M1 log 44 saw the same reset take 25.8 s once the host
# recovered. So the line that explains a slow reset is printed beside it.
# Informational only: memory never changes what the reset does or decides.
SWAP=$(sysctl -n vm.swapusage 2>/dev/null || true)
SWAP_USED=$(printf '%s' "$SWAP" | sed -nE 's/.*used = ([0-9]+)[.0-9]*M.*/\1/p')
SWAP_TOTAL=$(printf '%s' "$SWAP" | sed -nE 's/.*total = ([0-9]+)[.0-9]*M.*/\1/p')
if [ -n "$SWAP_USED" ] && [ -n "$SWAP_TOTAL" ] && [ "$SWAP_TOTAL" -gt 0 ]; then
  echo "reset-trial-vm: host swap used ${SWAP_USED} of ${SWAP_TOTAL} MB" >&2
  if [ $(( SWAP_USED * 100 / SWAP_TOTAL )) -ge 75 ]; then
    echo "reset-trial-vm: WARNING host swap is ${SWAP_USED}/${SWAP_TOTAL} MB (>= 75%); expect slow boots and slow ssh (runbook §3.1). This measures the host, not the repo." >&2
  fi
fi
echo "reset-trial-vm: ready on '$SNAPSHOT'"
