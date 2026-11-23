#!/usr/bin/env bash
# Clean guest shutdown over SSH, wait until UTM reports stopped (2 consecutive reads), force-stop after timeout.
D=$(dirname "$0"); T=${1:-120}
"$D/vssh" 'shutdown.exe /s /t 0 /f' >/dev/null 2>&1 || true
S=$(date +%s); n=0
while [ $(( $(date +%s)-S )) -lt $T ]; do
  if [ "$("$D/vm.sh" status 2>/dev/null)" = stopped ]; then n=$((n+1)); [ $n -ge 2 ] && { echo "stopped after $(( $(date +%s)-S ))s"; exit 0; }; else n=0; fi
  sleep 3
done
echo "timeout; force stopping"; "$D/vm.sh" kill; sleep 3; "$D/vm.sh" status
