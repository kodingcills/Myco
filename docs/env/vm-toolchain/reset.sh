#!/usr/bin/env bash
# reset.sh [live|cold|disposable]
#   live (default): force-stop, restore snapshot "clean-base-live" (RAM + disk; desktop already logged in), resume. ~6-10 s.
#   cold:           force-stop, restore "clean-base" (disk only), cold boot to the auto-logged-on desktop. ~20-30 s.
#   disposable:     force-stop, restore "clean-base", start with saving=false: nothing written during the run persists.
# After a live resume the guest clock is stale (it is the snapshot's clock); we resync it from the host over SSH.
set -euo pipefail
D=$(dirname "$0"); MODE=${1:-live}; T=$(date +%s)
"$D/vm.sh" kill >/dev/null 2>&1 || true
for i in $(seq 1 20); do [ "$("$D/vm.sh" status)" = stopped ] && break; sleep 1; done
case $MODE in
  live) "$D/vm.sh" restore clean-base-live; "$D/vm.sh" start ;;
  cold) "$D/vm.sh" restore clean-base; "$D/vm.sh" start ;;
  disposable) "$D/vm.sh" restore clean-base; "$D/vm.sh" start-disposable ;;
  *) echo "usage: $0 [live|cold|disposable]"; exit 2 ;;
esac
"$D/wait-ssh.sh" 600 >/dev/null
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
"$D/vssh" "Set-Date -Date ([datetime]::Parse('$NOW').ToUniversalTime().ToLocalTime()) | Out-Null" >/dev/null 2>&1 || true
echo "reset ($MODE) ready in $(( $(date +%s)-T ))s"
