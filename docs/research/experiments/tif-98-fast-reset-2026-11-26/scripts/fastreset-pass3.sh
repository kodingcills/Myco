#!/bin/bash
# Pass 3: what differs between a cold reset and a fast one (TIF-98 follow-up).
# Run under scripts/vm-session.sh from the repo root. usage: fastreset-exp3.sh <evidence-dir>
# Read-only on the guest (argv, CPU, Windows boot profile); egress stays denied.
set -u
E=$1
mkdir -p "$E"
VM=$HOME/VMs/myco-win11/scripts
BUNDLE=$HOME/Library/Containers/com.utmapp.UTM/Data/Documents/myco-win11.utm
log() { echo "fastreset3: $(date -u +%H:%M:%SZ) $*" | tee -a "$E/driver.log"; }

wait_stopped() {
  for _ in $(seq 1 80); do [ "$("$VM/vm.sh" status | tr -d '\r')" = stopped ] && return 0; sleep 3; done
  return 1
}

sysconfig() { # sysconfig <label>: UTM's System and QEMU config sections (no paths, no secrets)
  plutil -convert json -o - "$BUNDLE/config.plist" 2>/dev/null \
    | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"System": d.get("System"), "QEMU": d.get("QEMU")}, sort_keys=True))' \
    > "$E/config-$1.json"
  log "config $1 captured"
}

qemu_cpu() { # cumulative CPU seconds of the QEMU guest process
  local pid
  pid=$(pgrep -f "qemu-aarch64-softmmu|qemu-system-aarch64" 2>/dev/null | head -1)
  [ -n "$pid" ] || { echo "null"; return; }
  ps -o time= -p "$pid" 2>/dev/null | awk -F'[:.]' '{ if (NF==4) print $1*3600+$2*60+$3; else if (NF==3) print $1*60+$2; else print "null" }'
}

observe() { # observe <label>: argv, CPU over 4 min after ready, Windows boot profile
  local label=$1 t
  python3 -I scripts/guest_egress_check.py argv > "$E/argv-$label.txt" 2>&1
  log "argv $label captured ($(wc -l < "$E/argv-$label.txt" | tr -d ' ') lines)"
  for t in 0 30 60 90 120 150 180 210 240; do
    [ "$t" -gt 0 ] && sleep 30
    echo "{\"label\":\"$label\",\"secondsAfterReady\":$t,\"qemuCpuS\":$(qemu_cpu),\"load1\":$(sysctl -n vm.loadavg | awk '{print $2}')}" >> "$E/cpu-after-ready.jsonl"
  done
  log "cpu samples $label done: $(grep "\"$label\"" "$E/cpu-after-ready.jsonl" | tail -1)"
  bash scripts/guest-boot-profile.sh > "$E/boot-profile-$label.json" 2> "$E/boot-profile-$label.err"
  log "boot profile $label rc=$?"
}

reset_to() {
  bash scripts/reset-trial-vm.sh trial-base-v2 > "$E/reset-$1.log" 2>&1
  log "reset $1: rc=$? $(grep -oE 'first ssh answer after [0-9]+s \(guest CPU [0-9]+s\)' "$E/reset-$1.log") $(grep -oE 'total=[0-9]+' "$E/reset-$1.log")"
}

sysconfig before
reset_to cold
observe cold

"$VM/vm.sh" stop >/dev/null; wait_stopped; log "stopped by request"
bash scripts/guest-egress.sh deny > "$E/deny.log" 2>&1; log "guest-egress deny rc=$?"
sysconfig after-config-write
reset_to fast
observe fast

bash scripts/guest-egress.sh verify > "$E/final-egress-verify.log" 2>&1; log "final egress verify rc=$?"
"$VM/vm.sh" stop >/dev/null; wait_stopped && log "done: VM stopped"
