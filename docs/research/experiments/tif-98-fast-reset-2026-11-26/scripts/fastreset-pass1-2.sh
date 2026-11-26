#!/bin/bash
# Fast-reset investigation (TIF-98 follow-up). Run under scripts/vm-session.sh from the repo root.
# usage: fastreset-exp.sh <evidence-dir>
# Egress stays denied throughout (normal resets enforce the TIF-275 check). No agent, no model, no data:
# the only guest write is a marker text file with a timestamp, used to test whether a reset reverts the disk.
set -u
E=$1
mkdir -p "$E"
VM=$HOME/VMs/myco-win11/scripts
VSSH=$VM/vssh
PROBE_PS1=${PROBE_PS1:?set PROBE_PS1}
log() { echo "fastreset: $(date -u +%H:%M:%SZ) $*" | tee -a "$E/driver.log"; }

probe() { # probe <label>: guest uptime, boot type, marker, hiberboot setting -> one JSON line
  local label=$1 out
  scp -q -F "$HOME/VMs/myco-win11/ssh_config" -o ConnectTimeout=10 "$PROBE_PS1" "myco-win11:C:/Users/myco/fastreset-probe.ps1" 2>/dev/null
  out=$("$VSSH" "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\myco\fastreset-probe.ps1" 2>/dev/null | tr -d '\r' | grep '^{')
  echo "{\"label\":\"$label\",\"probeUtc\":\"$(date -u +%FT%TZ)\",\"guest\":${out:-null}}" >> "$E/probes.jsonl"
  log "probe $label: ${out:-unreadable}"
}

mark() { # mark <text>: write the marker file in the guest
  "$VSSH" "Set-Content -LiteralPath 'C:\Users\myco\fastreset-marker.txt' -Value '$1'" >/dev/null 2>&1
  log "marker written: $1"
}

wait_stopped() {
  for _ in $(seq 1 80); do [ "$("$VM/vm.sh" status | tr -d '\r')" = stopped ] && return 0; sleep 3; done
  return 1
}

reset_to() { # reset_to <label>
  local label=$1
  log "reset $label: start (VM status $("$VM/vm.sh" status | tr -d '\r'))"
  bash scripts/reset-trial-vm.sh trial-base-v2 > "$E/reset-$label.log" 2>&1
  log "reset $label: rc=$? $(grep -oE 'first ssh answer after [0-9]+s \(guest CPU [0-9]+s\)' "$E/reset-$label.log") $(grep -oE 'total=[0-9]+' "$E/reset-$label.log")"
}

# T0: from the current (stopped for a long time) state.
reset_to t0-after-long-stop
probe t0
mark "written-after-t0"

# E1: stop by request, then reset at once (the 488r4 pattern).
"$VM/vm.sh" stop >/dev/null; wait_stopped; log "E1: stopped by request"
reset_to e1-after-request-stop
probe e1
mark "written-after-e1"

# E2: stop by request, then rewrite the UTM network config while stopped (guest-egress deny), then reset
# (the build-run pattern: egress allow/deny right before the reset).
"$VM/vm.sh" stop >/dev/null; wait_stopped; log "E2: stopped by request"
bash scripts/guest-egress.sh deny > "$E/e2-egress-deny.log" 2>&1; log "E2: guest-egress deny rc=$?"
reset_to e2-after-request-stop-and-config-write
probe e2
mark "written-after-e2"

# E3: force stop of the running guest via guest-egress deny (the exit-trap pattern), then reset.
bash scripts/guest-egress.sh deny > "$E/e3-egress-deny.log" 2>&1; log "E3: guest-egress deny (force stop) rc=$?"
reset_to e3-after-force-stop-and-config-write
probe e3

bash scripts/guest-egress.sh verify > "$E/final-egress-verify.log" 2>&1; log "final egress verify rc=$?"
"$VM/vm.sh" stop >/dev/null; wait_stopped && log "done: VM stopped"
