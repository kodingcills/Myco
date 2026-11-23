#!/usr/bin/env bash
# TIF-56 / RT-011 live proof: one command, one host window.
#
# Runs the whole end-to-end path against a real guest and reports measured
# timings. Everything here boots a VM, so it must only be run inside a window
# granted by the M1 Coordinator — never while another workstream holds the host.
#
#   runtime/guest/live-proof.sh
#
# What it does, in order:
#   1. build the workspace (host)
#   2. boot the guest, wait for SSH, build the agent in-guest
#   3. RT-011: create -> observe -> act -> evidence -> reset -> destroy (MCP)
#   4. RT-015: read_file round-trip, escape refusals, ungranted refusal
#   5. progress heartbeat: notifications/progress during create
#   6. shut the guest down and verify no qemu remains
#
# Any failure stops the run and leaves the guest down.
set -uo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$GUEST_DIR/../.." && pwd)"  # repo root
cd "$WORKSPACE" || exit 1

say() { printf '\n=== %s\n' "$*"; }

# TIF-163: is a guest running? `pgrep -f qemu-system-aarch64` is NOT the answer —
# UTM runs the guest as QEMULauncher and the qemu binary name appears only in that
# process's arguments, so the narrow pattern reads 0 while a guest is live. Prefer
# the shared check; fall back to an argv[0]-basename scan so this script works even
# where `scripts/vm-state.sh` is not on PATH.
# Fails CLOSED: if the host cannot be read, report running.
vm_state_running() {
  if [[ -x "$WORKSPACE/scripts/vm-state.sh" ]]; then
    "$WORKSPACE/scripts/vm-state.sh" --quiet
    # 0 running, 1 idle, 2 unknown -> treat unknown as running
    [[ $? -eq 1 ]] && return 1 || return 0
  fi
  local table
  table="$(ps -Ao command)" || return 0
  [[ -n "$table" ]] || return 0
  awk '{n = split($1, a, "/"); b = a[n]
        if (b == "qemu-system-aarch64" || b == "QEMULauncher" ||
            b == "qemu-aarch64-softmmu") found = 1} END {exit !found}' <<<"$table"
}

# This script boots a VM. It must never run by accident: the host is shared with
# other workstreams and a stray guest measurably degrades their runs. Require an
# explicit --go, and say why.
if [[ "${1:-}" != "--go" ]]; then
  cat >&2 <<'USAGE'
refusing to start: this script boots a VM.

Run it only inside a host window granted by the M1 Coordinator:

    runtime/guest/live-proof.sh --go

USAGE
  exit 2
fi
fail() { printf '\nFAILED: %s\n' "$*" >&2; "$GUEST_DIR/shutdown.sh" >/dev/null 2>&1; exit 1; }

cleanup() {
  say "shutting the guest down"
  "$GUEST_DIR/shutdown.sh" 2>&1 | tail -1
  if vm_state_running; then
    echo "WARNING: a guest is still running after shutdown" >&2
  else
    echo "OK: no qemu process remains"
  fi
}
trap cleanup EXIT

say "0/7 preflight (fail in seconds, not after a boot)"
[[ -f "$GUEST_DIR/state/noble-server-cloudimg-arm64.img" ]] \
  || fail "base image missing: run runtime/guest/fetch-image.sh"
[[ -f "$GUEST_DIR/keys/id_ed25519" ]] \
  || fail "guest private key missing (gitignored): see runtime/guest/keys/README.md, then re-provision"
command -v qemu-system-aarch64 >/dev/null || fail "qemu-system-aarch64 not on PATH"
command -v cargo >/dev/null || fail "cargo not on PATH"
if vm_state_running; then
  fail "a guest is already running; another workstream may hold the host"
fi
echo "OK: image, key, qemu, cargo present; no guest running"

say "1/7 building the workspace"
cargo build --workspace --manifest-path runtime/Cargo.toml 2>&1 | tail -2 || fail "cargo build"

say "2/7 booting the guest and building the agent in-guest"
"$GUEST_DIR/boot.sh" 2>&1 | tail -1
# SSH answering is NOT readiness: cloud-init is still installing packages, and a
# build that starts now races it. Observed: ssh up at ~15s, cloud-init "done" at
# ~60s, and the build failing in between because `build-essential` had not landed
# yet. Require cloud-init to report done, with a bounded wait.
for _ in $(seq 1 150); do
  ssh -i "$GUEST_DIR/keys/id_ed25519" -p 10022 -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=3 \
      myco@localhost 'cloud-init status 2>/dev/null | grep -q "status: done"' 2>/dev/null && break
  sleep 2
done
echo "cloud-init: $(ssh -i "$GUEST_DIR/keys/id_ed25519" -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=3 myco@localhost 'cloud-init status 2>/dev/null | head -1' 2>/dev/null)"
# Retry once: even after cloud-init, a first build on a fresh overlay has hit
# transient toolchain hiccups.
if ! "$GUEST_DIR/build-agent-in-guest.sh" 2>&1 | grep -q "OK:"; then
  echo "agent build failed; retrying once" >&2
  "$GUEST_DIR/build-agent-in-guest.sh" 2>&1 | grep -E "OK:|error" | tail -3 || fail "agent build (after retry)"
fi

say "3/7 RT-011 end-to-end (create -> observe -> act -> evidence -> reset -> destroy)"
MYCO_RT_LIVE=1 cargo test --manifest-path runtime/Cargo.toml \
  -p myco-rt-backend-qemu --test first_path -- --ignored --nocapture 2>&1 \
  | grep -vE "Warning: Permanently" | tail -30 || fail "first_path"

say "4/7 RT-015 read_file (round-trip, escapes, ungranted refusal)"
MYCO_RT_LIVE=1 cargo test --manifest-path runtime/Cargo.toml \
  -p myco-rt-backend-qemu --test read_file_live -- --ignored --nocapture \
  live_read_file_round_trips_and_refuses_escapes 2>&1 \
  | grep -vE "Warning: Permanently" | tail -25 || fail "read_file_live"

say "5/7 progress heartbeat during create"
MYCO_RT_LIVE=1 cargo test --manifest-path runtime/Cargo.toml \
  -p myco-rt-backend-qemu --test read_file_live -- --ignored --nocapture \
  live_create_emits_progress_heartbeat 2>&1 \
  | grep -vE "Warning: Permanently" | tail -10 || fail "progress heartbeat"

say "6/7 act primitives for AT-SPI-blind apps (typeTextGlobal, clickAt)"
MYCO_RT_LIVE=1 cargo test --manifest-path runtime/Cargo.toml \
  -p myco-rt-backend-qemu --test act_global_live -- --ignored --nocapture 2>&1 \
  | grep -vE "Warning: Permanently" | tail -15 || fail "act_global_live"

say "7/7 done"
echo "All live proofs passed. Timings are printed above by each test."
