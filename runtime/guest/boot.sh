#!/usr/bin/env bash
# RT-003: boot the Myco runtime v0 Linux ARM64 guest under QEMU+HVF (headless).
# Idempotent: refuses to double-boot; safe to re-run after shutdown.
# NOTE: never touches anything named myco-win11 or UTM.
set -euo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$GUEST_DIR/state"
OVERLAY="$STATE/myco-runtime-v0.qcow2"
SEED="$STATE/seed.iso"
SERIAL_LOG="$STATE/serial.log"
SSH_PORT=10022
EDK2="/opt/homebrew/share/qemu/edk2-aarch64-code.fd"
PID_FILE="$STATE/qemu.pid"

# RT-013 (TIF-47): the guest RAM cap is configurable, not a literal buried in the
# QEMU invocation. Default 2048 MB is the measured working value (docs/env/
# linux-runtime.md); raise it with MYCO_RT_GUEST_MB when a scenario needs more, and
# record why in that scenario's evidence. The cap is a ceiling, not a reservation:
# QEMU commits lazily, so a 2048 MB cap does not charge the host 2048 MB up front
# (measured 2026-11-22: host RSS ~ 0 while idle, see scripts/memory-budget.sh).
GUEST_MB="${MYCO_RT_GUEST_MB:-2048}"
[[ "$GUEST_MB" =~ ^[0-9]+$ ]] || { echo "MYCO_RT_GUEST_MB must be an integer MB, got '$GUEST_MB'" >&2; exit 1; }

[[ -f "$EDK2" ]] || { echo "Missing UEFI firmware: $EDK2 (brew install qemu)" >&2; exit 1; }

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Guest already running (pid $(cat "$PID_FILE")). SSH: ssh -p $SSH_PORT myco@localhost"
  exit 0
fi
rm -f "$PID_FILE"

"$GUEST_DIR/create-overlay.sh"
"$GUEST_DIR/make-seed.sh"

: > "$SERIAL_LOG"
echo "Booting guest (-m ${GUEST_MB} MB, serial log: $SERIAL_LOG) ..."
qemu-system-aarch64 \
  -machine virt \
  -cpu host \
  -accel hvf \
  -smp 2 \
  -m "$GUEST_MB" \
  -display none \
  -serial file:"$SERIAL_LOG" \
  -monitor none \
  -bios "$EDK2" \
  -drive if=none,file="$OVERLAY",format=qcow2,id=hd0 \
  -device virtio-blk-pci,drive=hd0 \
  -drive if=none,file="$SEED",format=raw,id=cidata,readonly=on \
  -device virtio-blk-pci,drive=cidata \
  -netdev user,id=net0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22 \
  -device virtio-net-pci,netdev=net0 \
  -daemonize \
  -pidfile "$PID_FILE"

echo "OK: guest booted (pid $(cat "$PID_FILE")). Wait for SSH: ssh -p $SSH_PORT myco@localhost"
echo "Serial console log: $SERIAL_LOG"
