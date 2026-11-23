#!/usr/bin/env bash
# Thin wrapper over UTM's AppleScript API (works where `utmctl` hits the macOS Automation/TCC block).
# usage: vm.sh start|start-disposable|stop|kill|status|snapshot <name>|restore <name>|snapshots|delete-snapshot <name>|screenshot <png>
set -euo pipefail
NAME=${VM_NAME:-myco-win11}
as() { osascript -e "tell application \"UTM\"" -e "set vm to virtual machine named \"$NAME\"" -e "$1" -e "end tell"; }
case "${1:-}" in
  start) as 'start vm' ;;
  start-disposable) as 'start vm saving false' ;;
  stop) as 'stop vm by request' ;;
  kill) as 'stop vm by force' ;;
  status) as 'get status of vm' ;;
  snapshots) as 'get name of every snapshot of vm' ;;
  snapshot) as "create snapshot vm named \"$2\"" ;;
  restore) as "restore (first snapshot of vm whose name is \"$2\")" ;;
  delete-snapshot) as "delete snapshot (first snapshot of vm whose name is \"$2\")" ;;
  screenshot) as "capture screen vm to (POSIX file \"$2\")" ;;
  *) sed -n 2,3p "$0"; exit 2 ;;
esac
