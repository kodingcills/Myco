#!/usr/bin/env bash
# Wait until the VM answers SSH (default timeout 3600s).
# VM_ROOT overrides where ssh_config lives, matching build-all.sh / build-seed-iso.sh.
T=${1:-3600}; S=$(date +%s); C=${VM_ROOT:-$HOME/VMs/myco-win11}/ssh_config
until ssh -F "$C" -o BatchMode=yes myco-win11 'echo ok' 2>/dev/null | grep -q ok; do
  [ $(( $(date +%s) - S )) -gt $T ] && { echo "timeout waiting for ssh"; exit 1; }; sleep 10; done
echo "ssh up after $(( $(date +%s) - S ))s"
