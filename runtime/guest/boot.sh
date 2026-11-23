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
# `-2048` (not `:-2048`): a SET-but-empty value must reach the guard and fail, not
# be silently replaced by the default. `${VAR:-def}` substitutes on empty, so the
# guard validated the substitute rather than the caller's input and
# `MYCO_RT_GUEST_MB=` fell through to a real boot (post-merge verifier, TIF-110).
GUEST_MB="${MYCO_RT_GUEST_MB-2048}"
# Positive integer only, no leading zero (`08` would also trip bash's octal
# arithmetic): `0` is not a cap. QEMU treats `-m 0` as "use the default",
# so accepting it would silently defeat the memory cap this guard exists to enforce
# (post-merge verifier, TIF-110).
[[ "$GUEST_MB" =~ ^[1-9][0-9]*$ ]] \
  || { echo "MYCO_RT_GUEST_MB must be a positive integer MB, got '$GUEST_MB'" >&2; exit 1; }

[[ -f "$EDK2" ]] || { echo "Missing UEFI firmware: $EDK2 (brew install qemu)" >&2; exit 1; }

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Guest already running (pid $(cat "$PID_FILE")). SSH: ssh -p $SSH_PORT myco@localhost"
  exit 0
fi
rm -f "$PID_FILE"

# TIF-137: every guest launch takes the host VM lock (CONTRIBUTING-agents.md, VM
# queue gate: "acquire LOCK_EX before any VM action"). boot.sh is the only place in
# runtime/ that starts qemu, so taking it here covers provision.sh, smoke.sh,
# channel-test.sh, live-proof.sh and the Rust backend's create/reset alike.
#
# The lock is an flock on fd 9, which qemu inherits when it daemonizes: it stays
# held for the guest's whole life and is released when the guest exits. A caller
# that already holds the lock (provision.sh --build-agent, a trial driver, or
# df005-runner.py, which locks from Python) is an ANCESTOR of this process and is
# recorded as the holder in the lock file ("<pid> <driver>", written by every
# owner under the protocol). That pid, not an environment variable, decides it:
# only the flock holder can write the file, so it cannot be spoofed, and callers
# that never export MYCO_VM_LOCK_OWNER still work. No re-acquire in that case:
# flock is per open file, so a second acquire would refuse our own caller.
VM_LOCK_SCRIPT="${MYCO_VM_LOCK_SCRIPT:-$GUEST_DIR/../../scripts/vm-lock.sh}"
LOCK_HOLDER=""
lock_held_by_ancestor() {
  local holder p
  local path="${MYCO_VM_LOCK_PATH:-/tmp/myco-win11.vm.lock}"
  read -r holder _ < "$path" 2>/dev/null || return 1
  [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null || return 1
  # The file keeps the last owner's pid after a release, so also prove the lock is
  # HELD right now: a non-blocking flock that succeeds means it is free.
  python3 - "$path" <<'PY' || return 1
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(0)          # held by someone: the holder line is current
fcntl.flock(fd, fcntl.LOCK_UN)
sys.exit(1)              # free: nobody holds it, so take it ourselves
PY
  p=$PPID
  while [[ -n "$p" && "$p" -gt 1 ]]; do
    if [[ "$p" == "$holder" ]]; then LOCK_HOLDER="$holder"; return 0; fi
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  done
  return 1
}
if lock_held_by_ancestor; then
  echo "VM lock: held by the caller (pid $LOCK_HOLDER); booting under it."
else
  [[ -r "$VM_LOCK_SCRIPT" ]] || { echo "Refusing to boot: cannot take the VM lock ($VM_LOCK_SCRIPT not found)" >&2; exit 1; }
  # shellcheck source=/dev/null
  source "$VM_LOCK_SCRIPT"
  lock_rc=0
  vm_lock_acquire "boot.sh $GUEST_DIR" || lock_rc=$?
  if [[ $lock_rc -eq 10 ]]; then
    echo "Refusing to boot: the host VM lock is held by another owner (see above)." >&2
    exit 10
  elif [[ $lock_rc -ne 0 ]]; then
    echo "Refusing to boot: could not take the VM lock (vm_lock_acquire exit $lock_rc)." >&2
    exit 1
  fi
fi

# Seed first: make-seed.sh mints a key only when no overlay exists yet, so on a
# fresh checkout it must run before create-overlay.sh makes one (TIF-111).
"$GUEST_DIR/make-seed.sh"
"$GUEST_DIR/create-overlay.sh"

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
