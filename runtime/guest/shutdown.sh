#!/usr/bin/env bash
# RT-003: shut the guest down cleanly (SSH poweroff), fall back to SIGTERM.
# Idempotent: no-op when not running. Never touches myco-win11 or UTM.
set -euo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$GUEST_DIR/state"
PID_FILE="$STATE/qemu.pid"
KEY="$GUEST_DIR/keys/id_ed25519"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Guest not running (no pidfile)."
  exit 0
fi
PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "Guest not running (stale pidfile)."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Requesting clean shutdown over SSH ..."
if ssh -i "$KEY" -p 10022 -o ConnectTimeout=5 -o StrictHostKeyChecking=no \
     -o UserKnownHostsFile=/dev/null -o BatchMode=yes \
     myco@localhost 'sudo systemctl poweroff' 2>/dev/null; then
  for _ in $(seq 1 60); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "Clean shutdown did not complete; sending SIGTERM to QEMU ($PID)."
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "OK: guest is down. Overlay kept (runtime/guest/state/myco-runtime-v0.qcow2)."
