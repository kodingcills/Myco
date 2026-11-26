#!/usr/bin/env bash
# build-trial-base.sh: build the versioned trial base `trial-base-v2` from
# `clean-base` (TIF-98 follow-up). clean-base is never modified or deleted: it is
# restored, worked on in the live disk, and the result is saved as a NEW
# snapshot. clean-base stays the rollback (runbook §3.5).
#
# usage (straight after `lsof /tmp/myco-win11.vm.lock || echo free` prints free):
#   scripts/vm-session.sh -- scripts/build-trial-base.sh <evidence-dir>
#
# Steps, each logged to <evidence-dir>:
#   1. open egress for the maintenance window only (guest-egress.sh allow), and
#      restore + boot clean-base with MYCO_GUEST_EGRESS=open. Nothing but the
#      maintenance script enters the guest: no agent, no token, no data.
#   2. record state; Defender signature update; ngen executeQueuedItems;
#      Automatic Maintenance + idle tasks until quiet; Defender full scan.
#   3. disable the maintenance trigger and Windows Update; record state; check
#      Defender real-time is on with no exclusions (else stop).
#   4. remove the script, shut the guest down cleanly.
#   5. deny egress, boot the same disk in place (no restore), prove the
#      restriction is live (verify + the TIF-275 probes, every target must fail).
#   6. shut down cleanly; take snapshot trial-base-v2 with the VM stopped.
#
# Fails closed: any step that fails stops the build before the snapshot. The
# VM is then left with egress DENIED (an EXIT trap re-denies it) and clean-base
# untouched; the next reset-trial-vm.sh restores clean-base as usual.
set -uo pipefail

OUT=${1:?usage: build-trial-base.sh <evidence-dir>}
NEW=${MYCO_TRIAL_BASE_NAME:-trial-base-v2}
FROM=clean-base
REPO=$(cd "$(dirname "$0")/.." && pwd)
VM=${MYCO_VM_SCRIPTS:-$HOME/VMs/myco-win11/scripts}
VSSH="$VM/vssh"
CFG=${VM_SSH_CONFIG:-$HOME/VMs/myco-win11/ssh_config}
GUEST_PS='C:\Users\myco\trial-base-maintenance.ps1'
# Overridable so the host test can stub them; the defaults are the in-repo scripts.
EGRESS=${MYCO_EGRESS_SCRIPT:-$REPO/scripts/guest-egress.sh}
RESET=${MYCO_RESET_SCRIPT:-$REPO/scripts/reset-trial-vm.sh}
GATE=${MYCO_GATE_SCRIPT:-$REPO/scripts/wait-guest-ready.sh}
mkdir -p "$OUT"

die() { echo "build-trial-base: $*" >&2; exit 1; }
log() { echo "build-trial-base: $(date -u +%H:%M:%SZ) $*"; }

# Only under the session wrapper: the whole build must hold the VM.
source "$REPO/scripts/vm-lock.sh"
vm_lock_owned_by_parent || die "run me under scripts/vm-session.sh (the VM lock must be held for the whole build)"

snapshots() { "$VM/vm.sh" snapshots 2>/dev/null | tr -d '\r'; }
has_snapshot() { snapshots | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -qx "$1"; }
status() { "$VM/vm.sh" status 2>/dev/null | tr -d '\r'; }

has_snapshot "$FROM" || die "source snapshot '$FROM' not found"
has_snapshot "$NEW" && die "snapshot '$NEW' already exists; never overwrite a trial base (pick a new version name)"

# Whatever happens, leave egress denied.
EGRESS_OPENED=0
cleanup() {
  if [ "$EGRESS_OPENED" = 1 ]; then
    echo "build-trial-base: exit trap: re-denying guest egress" >&2
    bash "$EGRESS" deny >&2 || echo "build-trial-base: WARNING could not re-deny egress; run scripts/guest-egress.sh deny before any trial" >&2
  fi
}
trap cleanup EXIT

guest() { # guest <stage> <logfile>
  "$VSSH" "powershell -NoProfile -ExecutionPolicy Bypass -File $GUEST_PS -Stage $1" 2>&1 \
    | tr -d '\r' | grep -v -e 'post-quantum' -e 'openssh.com/pq.html' > "$2"
  return "${PIPESTATUS[0]}"
}

clean_shutdown() { # never force: a forced stop would snapshot an unclean disk
  "$VSSH" 'shutdown.exe /s /t 0' >/dev/null 2>&1 || true
  local n=0 s
  for _ in $(seq 1 120); do
    s=$(status)
    if [ "$s" = stopped ]; then n=$((n + 1)); [ "$n" -ge 2 ] && return 0; else n=0; fi
    sleep 3
  done
  return 1
}

# 1. Maintenance window: egress open, clean-base booted.
log "step 1: open egress for the maintenance window; restore and boot $FROM"
EGRESS_OPENED=1
bash "$EGRESS" allow > "$OUT/01-egress-allow.log" 2>&1 || die "guest-egress allow failed (see 01-egress-allow.log)"
MYCO_GUEST_EGRESS=open bash "$RESET" "$FROM" > "$OUT/02-reset-open.log" 2>&1 || die "reset of $FROM failed (see 02-reset-open.log)"
scp -q -F "$CFG" -o ConnectTimeout=10 "$REPO/scripts/trial-base/guest-maintenance.ps1" "myco-win11:C:/Users/myco/trial-base-maintenance.ps1" \
  || die "could not copy the maintenance script"

# 2. Record, then do the maintenance.
log "step 2: state before; signatures; ngen; idle tasks; full scan"
guest state "$OUT/03-state-before.json" || die "state (before) failed"
guest signatures "$OUT/04-signatures.log" || die "Defender signature update failed (see 04-signatures.log)"
guest ngen "$OUT/05-ngen.log" || die "ngen executeQueuedItems failed (see 05-ngen.log)"
guest idle "$OUT/06-idle.log" || die "idle/maintenance tasks did not finish (see 06-idle.log)"
guest scan "$OUT/07-defender-full-scan.log" || die "Defender full scan failed (see 07-defender-full-scan.log)"

# 3. Disable the triggers only; Defender stays on.
log "step 3: disable maintenance trigger and Windows Update; check Defender"
guest disable "$OUT/08-disable.log" || die "disable failed (see 08-disable.log)"
guest state "$OUT/09-state-after.json" || die "state (after) failed"
guest check "$OUT/10-defender-check.log" || die "Defender check failed: real-time off or exclusions present (see 10-defender-check.log)"

# 4. Tidy and shut down cleanly.
log "step 4: remove the maintenance script; clean shutdown"
"$VSSH" "Remove-Item -LiteralPath '$GUEST_PS' -Force" >/dev/null 2>&1 || die "could not remove the maintenance script from the guest"
clean_shutdown || die "guest did not shut down cleanly within 6 min; not snapshotting an unclean disk"

# 5. Deny egress, boot in place (NO restore: that would discard the work), prove it.
log "step 5: deny egress; boot in place; verify + probe"
bash "$EGRESS" deny > "$OUT/11-egress-deny.log" 2>&1 || die "guest-egress deny failed"
EGRESS_OPENED=0
[ "$(status)" = stopped ] || die "VM not stopped after deny"
"$VM/vm.sh" start >/dev/null || die "vm.sh start failed"
bash "$GATE" 900 > "$OUT/12-boot-in-place.log" 2>&1 || die "guest did not come up after deny (see 12-boot-in-place.log)"
bash "$EGRESS" verify > "$OUT/13-egress-verify.log" 2>&1 || die "egress verify failed after deny"
bash "$EGRESS" probe > "$OUT/14-probe-denied.json" 2>/dev/null || die "probe failed to run"
python3 - "$OUT/14-probe-denied.json" <<'PY' || die "a probe target was reachable with egress denied (see 14-probe-denied.json)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d and all(v != "ok" for v in d.values()), d
PY

# 6. Snapshot, stopped, egress denied.
log "step 6: clean shutdown; snapshot $NEW"
clean_shutdown || die "guest did not shut down cleanly after the probe"
bash "$EGRESS" status > "$OUT/15-egress-status-at-snapshot.log" 2>&1
grep -q '^utm isolate-from-host: true$' "$OUT/15-egress-status-at-snapshot.log" || die "egress flag not true at snapshot time"
"$VM/vm.sh" snapshot "$NEW" >/dev/null || die "UTM refused to create snapshot $NEW"
has_snapshot "$NEW" || die "snapshot $NEW not listed after creation"
has_snapshot "$FROM" || die "source snapshot $FROM is missing after the build"
snapshots > "$OUT/16-snapshots.txt"
log "done: $NEW created from $FROM; egress denied; $FROM untouched"
