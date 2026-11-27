#!/usr/bin/env bash
# build-trial-base.sh: build a versioned trial base (MYCO_TRIAL_BASE_NAME, default
# `trial-base-v2`; `trial-base-v3` was built with MYCO_TRIAL_BASE_NAME=trial-base-v3) from
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
#   6. shut down cleanly; take the snapshot ($NEW) with the VM stopped.
#
# HCU (TIF-734, optional): with MYCO_TRIAL_BASE_HCU_DIR=<dir> holding computer-use.exe,
# computer-use-windows-provider.exe, LICENSE, THIRD_PARTY_NOTICES.md and SHA256SUMS (a pinned
# build of microsoft/Hybrid-Computer-Use, docs/benchmark/hcu-shell-runbook.md section 1):
#   3b. copy them in and install (scripts/trial-base/guest-hcu.ps1 install): every sha256 must
#       match SHA256SUMS; the MycoHCU logon task runs `computer-use.exe serve` in the
#       interactive session.
#   5b. on the cold boot in place, egress denied: computer-use.exe runs in a session other
#       than 0 and its daemon answers (guest-hcu.ps1 verify), and over SSH
#       `computer-use.exe mcp --attach <socket>` initialises, lists the GUI tool and returns
#       one screenshot image. Any failure stops the build before the snapshot.
#
# Fails closed: any step that fails stops the build before the snapshot. The
# VM is then left with egress DENIED (an EXIT trap re-denies it) and clean-base
# untouched; the next reset-trial-vm.sh restores its snapshot as usual.
set -uo pipefail

OUT=${1:?usage: build-trial-base.sh <evidence-dir>}
NEW=${MYCO_TRIAL_BASE_NAME:-trial-base-v2}
FROM=clean-base
REPO=$(cd "$(dirname "$0")/.." && pwd)
VM=${MYCO_VM_SCRIPTS:-$HOME/VMs/myco-win11/scripts}
VSSH="$VM/vssh"
CFG=${VM_SSH_CONFIG:-$HOME/VMs/myco-win11/ssh_config}
GUEST_PS='C:\Users\myco\trial-base-maintenance.ps1'
HCU_DIR=${MYCO_TRIAL_BASE_HCU_DIR:-}
GUEST_HCU_PS='C:\myco\bin\myco-hcu.ps1'
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
if [ -n "$HCU_DIR" ]; then
  for f in computer-use.exe computer-use-windows-provider.exe LICENSE THIRD_PARTY_NOTICES.md SHA256SUMS; do
    [ -f "$HCU_DIR/$f" ] || die "MYCO_TRIAL_BASE_HCU_DIR is missing $f"
  done
  (cd "$HCU_DIR" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) || die "MYCO_TRIAL_BASE_HCU_DIR does not match its SHA256SUMS"
fi
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
# TIF-98: every boot in the build must be a full cold boot. The reset classifies its own
# boot (and cycles a fast one, the first start after `guest-egress.sh allow`); record it.
BOOT_LINE=$(grep -E '^reset-trial-vm: boot class=' "$OUT/02-reset-open.log" | tail -n 1)
echo "step 1 reset: ${BOOT_LINE:-no boot line}" >> "$OUT/boot-classes.log"
case "$BOOT_LINE" in
  "reset-trial-vm: boot class=cold "*) ;;
  *) die "step 1 reset did not report a cold boot (see boot-classes.log)" ;;
esac
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

# 3b. HCU (TIF-734), only when MYCO_TRIAL_BASE_HCU_DIR is set.
hcu_guest() { # hcu_guest <stage> <logfile>
  "$VSSH" "powershell -NoProfile -ExecutionPolicy Bypass -File $GUEST_HCU_PS -Stage $1" 2>&1 \
    | tr -d '\r' | grep -v -e 'post-quantum' -e 'openssh.com/pq.html' > "$2"
  return "${PIPESTATUS[0]}"
}
if [ -n "$HCU_DIR" ]; then
  log "step 3b: install HCU from $(basename "$HCU_DIR") (sha256-checked in the guest)"
  cp "$HCU_DIR/SHA256SUMS" "$OUT/10b-hcu-sha256sums.txt"
  "$VSSH" "New-Item -ItemType Directory -Force -Path 'C:\myco\hcu-staging','C:\myco\bin' | Out-Null" >/dev/null 2>&1 \
    || die "could not create the HCU staging directory"
  scp -q -F "$CFG" -o ConnectTimeout=10 "$HCU_DIR/computer-use.exe" "$HCU_DIR/computer-use-windows-provider.exe" \
    "$HCU_DIR/LICENSE" "$HCU_DIR/THIRD_PARTY_NOTICES.md" "$HCU_DIR/SHA256SUMS" "myco-win11:C:/myco/hcu-staging/" \
    || die "could not copy the HCU files"
  scp -q -F "$CFG" -o ConnectTimeout=10 "$REPO/scripts/trial-base/guest-hcu.ps1" "myco-win11:C:/myco/bin/myco-hcu.ps1" \
    || die "could not copy guest-hcu.ps1"
  hcu_guest install "$OUT/10c-hcu-install.log" || die "HCU install failed (see 10c-hcu-install.log)"
fi

# 4. Tidy and shut down cleanly.
log "step 4: remove the maintenance script; clean shutdown"
"$VSSH" "Remove-Item -LiteralPath '$GUEST_PS' -Force" >/dev/null 2>&1 || die "could not remove the maintenance script from the guest"
clean_shutdown || die "guest did not shut down cleanly within 6 min; not snapshotting an unclean disk"

# 5. Deny egress, boot in place (NO restore: that would discard the work), prove it.
log "step 5: deny egress; boot in place; verify + probe"
bash "$EGRESS" deny > "$OUT/11-egress-deny.log" 2>&1 || die "guest-egress deny failed"
EGRESS_OPENED=0
[ "$(status)" = stopped ] || die "VM not stopped after deny"
# TIF-98: `deny` just rewrote UTM's config, so this boot in place (no reset, so no reset
# guard) would be fast. Classify it the way reset-trial-vm.sh does, by the gate's guest CPU at
# the first ssh answer: a fast boot gets a clean shutdown and one more start; a second fast
# boot, or an unreadable line, stops the build before the snapshot.
COLD_MIN_GUEST_CPU=${MYCO_COLD_MIN_GUEST_CPU:-100}
boot_in_place() { # boot_in_place <attempt> <log>; sets BIP_CPU (empty if unreadable)
  "$VM/vm.sh" start >/dev/null || die "vm.sh start failed"
  bash "$GATE" 900 > "$2" 2>&1 || die "guest did not come up after deny (see $(basename "$2"))"
  BIP_CPU=$(sed -nE 's/^wait-guest-ready: first ssh answer after [0-9]+s \(guest CPU ([0-9]+)s\).*/\1/p' "$2" | tail -n 1)
  echo "step 5 boot in place, attempt $1: guest_cpu_first_ssh_s=${BIP_CPU:-unreadable}" >> "$OUT/boot-classes.log"
  [ -n "$BIP_CPU" ] || die "cannot read the boot-in-place guest CPU at the first ssh answer (see $(basename "$2"))"
}
boot_in_place 1 "$OUT/12-boot-in-place.log"
if [ "$BIP_CPU" -lt "$COLD_MIN_GUEST_CPU" ]; then
  log "step 5: boot in place was fast (guest CPU ${BIP_CPU}s < ${COLD_MIN_GUEST_CPU}s); clean shutdown and one more start"
  clean_shutdown || die "guest did not shut down cleanly after a fast boot in place"
  boot_in_place 2 "$OUT/12b-boot-in-place-2.log"
  [ "$BIP_CPU" -ge "$COLD_MIN_GUEST_CPU" ] || die "boot in place was fast again (guest CPU ${BIP_CPU}s); not snapshotting a guest that skipped its boot work"
fi
echo "step 5 boot in place: class=cold guest_cpu_first_ssh_s=$BIP_CPU" >> "$OUT/boot-classes.log"
bash "$EGRESS" verify > "$OUT/13-egress-verify.log" 2>&1 || die "egress verify failed after deny"
bash "$EGRESS" probe > "$OUT/14-probe-denied.json" 2>/dev/null || die "probe failed to run"
python3 - "$OUT/14-probe-denied.json" <<'PY' || die "a probe target was reachable with egress denied (see 14-probe-denied.json)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d and all(v != "ok" for v in d.values()), d
PY

# 5b. HCU reachable on this cold boot, egress denied (TIF-734).
if [ -n "$HCU_DIR" ]; then
  log "step 5b: HCU in the interactive session; MCP over --attach: initialise, GUI tool, one screenshot"
  hcu_guest verify "$OUT/14b-hcu-verify.log" || die "HCU verify failed (see 14b-hcu-verify.log)"
  HCU_SOCKET=$(sed -n 's/^socket=//p' "$OUT/14b-hcu-verify.log" | tail -n 1)
  [ -n "$HCU_SOCKET" ] || die "HCU verify printed no socket (see 14b-hcu-verify.log)"
  { printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"build-trial-base","version":"1"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"GUI","arguments":{"actions":[{"type":"screenshot"}]}}}'
    sleep "${MYCO_HCU_PROBE_WAIT_S:-25}"; } \
    | ssh -F "$CFG" -o LogLevel=ERROR -o ConnectTimeout=10 myco-win11 "C:\myco\bin\computer-use.exe mcp --attach $HCU_SOCKET" 2>/dev/null | tr -d '\r' > "$OUT/14c-hcu-mcp.raw"
  python3 - "$OUT/14c-hcu-mcp.raw" "$OUT/14c-hcu-mcp-probe.json" <<'PY' || die "HCU MCP probe failed (see 14c-hcu-mcp-probe.json)"
import json, sys
raw, out = sys.argv[1], sys.argv[2]
by_id = {}
for line in open(raw):
    line = line.strip()
    if not line:
        continue
    try:
        j = json.loads(line)
    except ValueError:
        continue
    if "id" in j:
        by_id[j["id"]] = j
init = (by_id.get(1) or {}).get("result") or {}
tools = [t.get("name") for t in ((by_id.get(2) or {}).get("result") or {}).get("tools", [])]
shot = (by_id.get(3) or {}).get("result") or {}
images = [c for c in shot.get("content", []) if c.get("type") == "image" and c.get("data")]
summary = {
    "server": init.get("serverInfo"),
    "tools": tools,
    "screenshot_is_error": shot.get("isError"),
    "screenshot_images": [{"mimeType": c.get("mimeType"), "base64Length": len(c["data"])} for c in images],
    "screenshot_text": [c.get("text", "")[:300] for c in shot.get("content", []) if c.get("type") == "text"],
}
json.dump(summary, open(out, "w"), indent=2)
ok = bool(init.get("serverInfo")) and "GUI" in tools and shot.get("isError") is not True and len(images) == 1
sys.exit(0 if ok else 1)
PY
  rm -f "$OUT/14c-hcu-mcp.raw"
fi

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
