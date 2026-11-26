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
# Known tradeoff: a cold reset costs 140-163 s onto trial-base-v2 and 204-222 s
# onto clean-base on this Mac (TIF-98, same-session bench 2026-11-26), versus the
# live path's ~7 s. We pay it for a reset that cannot wedge. Where the time goes:
# docs/eval-runbook.md §3.1 and §3.5.
#
# usage: reset-trial-vm.sh [snapshot]
#   The snapshot defaults to trial-base-v3, the maintenance-quiet trial base
#   built from cold boots (TIF-98, runbook §3.5). MYCO_TRIAL_SNAPSHOT changes the
#   default (trial-base-v3, trial-base-v2 or clean-base), for drivers
#   that call this with no argument (scripts/m1-sweep.sh, m1-corrupt-suite.sh):
#   MYCO_TRIAL_SNAPSHOT=clean-base rolls a whole sweep back to clean-base. An
#   explicit argument wins over both. Every name must pass the allowlist below.
set -euo pipefail

source "$(dirname "$0")/vm-lock.sh"
RESET_OWNS_LOCK=0
if ! vm_lock_owned_by_parent; then
  vm_lock_acquire reset-trial-vm.sh || exit "$?"
  RESET_OWNS_LOCK=1
  trap vm_lock_release EXIT
fi

SNAPSHOT=${1:-${MYCO_TRIAL_SNAPSHOT:-trial-base-v3}}
# An explicit empty argument is a caller bug, not a request for the default.
if [ "$#" -ge 1 ] && [ -z "$1" ]; then
  echo "reset-trial-vm: refusing an empty snapshot argument" >&2; exit 1
fi
# A live snapshot is never a default: the live path wedges UTM under rapid cycling
# (runbook §3.3). Name it as an argument if one reset onto it is really meant.
if [ "$#" -eq 0 ] && [ -n "${MYCO_TRIAL_SNAPSHOT:-}" ] && [ "$MYCO_TRIAL_SNAPSHOT" != trial-base-v3 ] && [ "$MYCO_TRIAL_SNAPSHOT" != trial-base-v2 ] && [ "$MYCO_TRIAL_SNAPSHOT" != clean-base ] && [[ "$MYCO_TRIAL_SNAPSHOT" != *-live ]]; then
  echo "reset-trial-vm: refusing MYCO_TRIAL_SNAPSHOT=$MYCO_TRIAL_SNAPSHOT: as the default it must be a trial base (trial-base-v3, trial-base-v2 or clean-base); name any other snapshot as an argument" >&2; exit 1
fi
if [ "$#" -eq 0 ] && [[ "${MYCO_TRIAL_SNAPSHOT:-}" == *-live ]]; then
  echo "reset-trial-vm: refusing MYCO_TRIAL_SNAPSHOT=$MYCO_TRIAL_SNAPSHOT: a live snapshot is never the default" >&2; exit 1
fi
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
REPO_EGRESS=$(cd "$(dirname "$0")" && pwd)/guest-egress.sh

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

# The egress check (TIF-275) resolves like the gate: a stub directory shadows it.
egress_script() {
  if [ -n "${MYCO_VM_SCRIPTS:-}" ]; then
    echo "$VM_SCRIPTS/guest-egress.sh"
  else
    echo "$REPO_EGRESS"
  fi
}

# Refuse to touch a snapshot we do not own the name of; these are protected.
# cua-c1-base (M1 Coordinator-approved): a derivative taken from a cold clean-base
# restore with Cua installed, for the screenshot-baseline C1/C2 arms only.
# trial-base-v2 (TIF-98 follow-up): clean-base with its pending maintenance run
# to completion and the maintenance/Windows Update triggers disabled; built by
# scripts/build-trial-base.sh, taken with guest egress denied. trial-base-v3
# (TIF-98, 2026-11-26): the same build rerun with every boot classified cold
# (some of v2's build steps ran on fast boots); the default since then.
# trial-base-v2 and clean-base stay as rollbacks (runbook §3.5).
case "$SNAPSHOT" in
  clean-base|clean-base-live|m1-agent-live|cua-c1-base|trial-base-v2|trial-base-v3) ;;
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

# 2-3. Restore, boot, and wait for a real boot; then prove it was a full cold boot.
#
# Restore + boot: never call restore on a non-stopped VM: that is what triggers
# UTM's live-resume path and the wedge above.
#
# Wait for a real boot, then prove the state we are in is not a half-resumed
# one. SSH alone is not enough: a stalled guest accepts TCP on 2222 (QEMU's
# user-mode netdev listens with the guest stopped) and never answers, so an
# SSH-only wait spends its whole budget and then fails - which is exactly what
# consumed the 2026-11-23 09:2x slot (TIF-164). wait-guest-ready.sh also
# requires guest CPU time to ADVANCE, which a non-booting guest never does.
#
# Cold-boot check (TIF-98, docs/research/experiments/tif-98-fast-reset-2026-11-26/):
# the first start after a UTM configuration write (scripts/guest-egress.sh
# allow/deny rewrites it, even with no change) boots the same restored disk
# with most of Windows' boot work skipped: Windows reports BootTime 17.8 s vs
# 134 s, and the guest burns 4 s of CPU by its first ssh answer instead of
# 272-312 s. Trials must start from the same state, so the guest CPU the gate
# reports at the first ssh answer classifies the boot. Under
# MYCO_COLD_MIN_GUEST_CPU (default 100 s, inside the measured gap: fast 4-23 s,
# cold 272-312 s) it is a fast boot: stop by request and boot once more (a
# start with no config write before it is cold, measured). A second fast boot,
# or a first-ssh line that cannot be read, is refused.
GATE=$(gate_script)
[ -x "$GATE" ] || die "readiness gate not found: '$GATE' (expected the in-repo scripts/wait-guest-ready.sh, or one via MYCO_VM_SCRIPTS). Refusing to skip the boot check."
COLD_MIN_GUEST_CPU=${MYCO_COLD_MIN_GUEST_CPU:-100}
[[ "$COLD_MIN_GUEST_CPU" =~ ^[0-9]+$ ]] || die "MYCO_COLD_MIN_GUEST_CPU='$COLD_MIN_GUEST_CPU' is not a whole number of seconds"
# The override stays inside the measured gap (fast 4-23 s, cold 272-312 s over 37 boots), with a
# hard floor of 100 s: a lower value could relabel a fast boot as cold (#546 round 1 D2).
if [ "$COLD_MIN_GUEST_CPU" -lt 100 ] || [ "$COLD_MIN_GUEST_CPU" -gt 271 ]; then
  die "MYCO_COLD_MIN_GUEST_CPU=$COLD_MIN_GUEST_CPU is outside 100-271 s (the measured gap between fast and cold boots, TIF-98)"
fi
# A stop by request after a fast boot waits longer than the initial force-stop: Windows took
# 18 s in pass 4, and a slower shutdown should not turn into a force-stopped retry (round 1 nit 3).
FAST_STOP_TIMEOUT=${MYCO_FAST_STOP_TIMEOUT:-120}
GATE_ERR=$(mktemp "${TMPDIR:-/tmp}/reset-gate.XXXXXX")
trap 'rm -f "$GATE_ERR"; if [ "$RESET_OWNS_LOCK" = 1 ]; then vm_lock_release; fi' EXIT
BOOT_ATTEMPT=0
while :; do
  BOOT_ATTEMPT=$((BOOT_ATTEMPT + 1))
  SUFFIX=""; [ "$BOOT_ATTEMPT" -gt 1 ] && SUFFIX=$BOOT_ATTEMPT
  "$VM_SCRIPTS/vm.sh" restore "$SNAPSHOT" >/dev/null
  phase "restore$SUFFIX"
  "$VM_SCRIPTS/vm.sh" start >/dev/null
  phase "start$SUFFIX"
  GATE_RC=0
  "$GATE" "$SSH_WAIT_TIMEOUT" >/dev/null 2>"$GATE_ERR" || GATE_RC=$?
  cat "$GATE_ERR" >&2
  [ "$GATE_RC" -eq 0 ] || die "guest did not reach a real boot within ${SSH_WAIT_TIMEOUT}s (see TIF-164)"
  phase "ready$SUFFIX"
  FIRST_SSH_S=$(sed -nE 's/^wait-guest-ready: first ssh answer after ([0-9]+)s \(guest CPU ([0-9]+)s\).*/\1/p' "$GATE_ERR" | tail -n 1)
  FIRST_SSH_CPU=$(sed -nE 's/^wait-guest-ready: first ssh answer after ([0-9]+)s \(guest CPU ([0-9]+)s\).*/\2/p' "$GATE_ERR" | tail -n 1)
  [ -n "$FIRST_SSH_CPU" ] || die "cannot read the guest CPU at the first ssh answer from the readiness gate; refusing to call a boot cold that was not measured (TIF-98)"
  if [ "$FIRST_SSH_CPU" -ge "$COLD_MIN_GUEST_CPU" ]; then
    BOOT_CLASS=cold
    break
  fi
  if [ "$BOOT_ATTEMPT" -ge 2 ]; then
    die "fast boot again on attempt $BOOT_ATTEMPT (guest CPU ${FIRST_SSH_CPU}s at the first ssh answer, under ${COLD_MIN_GUEST_CPU}s): not a full cold boot; refusing to call this guest ready (TIF-98)"
  fi
  echo "reset-trial-vm: fast boot (guest CPU ${FIRST_SSH_CPU}s at the first ssh answer, under ${COLD_MIN_GUEST_CPU}s): not a full cold boot (a UTM config write just before a reset does this, TIF-98); stopping by request and booting once more" >&2
  "$VM_SCRIPTS/vm.sh" stop >/dev/null 2>&1 || true
  for _ in $(seq 1 "$FAST_STOP_TIMEOUT"); do [ "$(status)" = stopped ] && break; sleep 1; done
  if [ "$(status)" != stopped ]; then
    "$VM_SCRIPTS/vm.sh" kill >/dev/null 2>&1 || true
    for _ in $(seq 1 "$STOP_TIMEOUT"); do [ "$(status)" = stopped ] && break; sleep 1; done
  fi
  [ "$(status)" = stopped ] || die "VM did not stop after a fast boot; refusing to continue (TIF-98)"
  phase "stop$((BOOT_ATTEMPT + 1))"
done
echo "reset-trial-vm: boot class=$BOOT_CLASS first_ssh_s=${FIRST_SSH_S:-0} guest_cpu_first_ssh_s=$FIRST_SSH_CPU attempts=$BOOT_ATTEMPT" >&2
# 3b. Guest egress must be closed (TIF-275): the running netdev must carry
#     restrict=on, so the guest can reach nothing but the host's inbound ssh
#     forward. Checked on every reset, before anything is deployed into the
#     guest, and fail-closed: a guest that booted with egress open (someone
#     cleared UTM's "isolate from host") is refused, not trusted. The one
#     escape is an explicit MYCO_GUEST_EGRESS=open, for base-image maintenance
#     that needs the internet; it is loud and never the default.
EGRESS=$(egress_script)
if [ "${MYCO_GUEST_EGRESS:-closed}" = open ]; then
  echo "reset-trial-vm: WARNING MYCO_GUEST_EGRESS=open: guest egress NOT verified closed. Maintenance only; never run trials or put credentials in this guest (TIF-275)" >&2
else
  [ -x "$EGRESS" ] || die "egress check not found: '$EGRESS'. Refusing to call the guest ready without proving its egress is closed (TIF-275)"
  "$EGRESS" verify >/dev/null || die "guest egress is not closed: refusing to call this guest ready. Run 'scripts/guest-egress.sh deny', then reset again (TIF-275, runbook §3.4)"
fi
phase egress

# 4. The guest clock is the snapshot's clock; resync so trial timestamps are sane.
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
if ! "$VM_SCRIPTS/vssh" "Set-Date -Date ([datetime]::Parse('$NOW').ToUniversalTime().ToLocalTime()) | Out-Null" >/dev/null 2>&1; then
  echo "reset-trial-vm: WARNING guest clock resync failed; trial timestamps may be stale" >&2
fi

phase clock
echo "reset-trial-vm: timing${TIMING} total=$(( $(date +%s) - T0 ))" >&2

# Host swap, on every reset (TIF-98), so a slow reset carries the host state
# it ran under. Informational only: it never changes what the reset does. No
# threshold warning: macOS resizes swap dynamically, so used/total is not a
# stable signal, and the TIF-98 measurements found swap pressure a secondary
# cost (resets took 213-254 s with swap freed to ~4.5 GB; the main cost is the
# guest's own boot work, runbook §3.1).
SWAP=$(sysctl -n vm.swapusage 2>/dev/null || true)
SWAP_USED=$(printf '%s' "$SWAP" | sed -nE 's/.*used = ([0-9]+)[.0-9]*M.*/\1/p')
SWAP_TOTAL=$(printf '%s' "$SWAP" | sed -nE 's/.*total = ([0-9]+)[.0-9]*M.*/\1/p')
if [ -n "$SWAP_USED" ] && [ -n "$SWAP_TOTAL" ] && [ "$SWAP_TOTAL" -gt 0 ]; then
  echo "reset-trial-vm: host swap used ${SWAP_USED} of ${SWAP_TOTAL} MB" >&2
fi
echo "reset-trial-vm: ready on '$SNAPSHOT'"
