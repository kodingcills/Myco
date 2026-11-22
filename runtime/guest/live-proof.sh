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
WORKSPACE="$(cd "$GUEST_DIR/.." && pwd)"
cd "$WORKSPACE" || exit 1

say() { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; "$GUEST_DIR/shutdown.sh" >/dev/null 2>&1; exit 1; }

cleanup() {
  say "shutting the guest down"
  "$GUEST_DIR/shutdown.sh" 2>&1 | tail -1
  if pgrep -f qemu-system-aarch64 >/dev/null; then
    echo "WARNING: qemu still running after shutdown" >&2
  else
    echo "OK: no qemu process remains"
  fi
}
trap cleanup EXIT

say "1/6 building the workspace"
cargo build --workspace --manifest-path runtime/Cargo.toml 2>&1 | tail -2 || fail "cargo build"

say "2/6 booting the guest and building the agent in-guest"
"$GUEST_DIR/boot.sh" 2>&1 | tail -1
for _ in $(seq 1 60); do
  ssh -i "$GUEST_DIR/keys/id_ed25519" -p 10022 -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o ConnectTimeout=3 \
      myco@localhost true 2>/dev/null && break
  sleep 2
done
"$GUEST_DIR/build-agent-in-guest.sh" 2>&1 | grep -E "OK:|error" | tail -2 || fail "agent build"

say "3/6 RT-011 end-to-end (create -> observe -> act -> evidence -> reset -> destroy)"
MYCO_RT_LIVE=1 cargo test --manifest-path runtime/Cargo.toml \
  -p myco-rt-backend-qemu --test first_path -- --ignored --nocapture 2>&1 \
  | grep -vE "Warning: Permanently" | tail -30 || fail "first_path"

say "4/6 RT-015 read_file (round-trip, escapes, ungranted refusal)"
MYCO_RT_LIVE=1 cargo test --manifest-path runtime/Cargo.toml \
  -p myco-rt-backend-qemu --test read_file_live -- --ignored --nocapture \
  live_read_file_round_trips_and_refuses_escapes 2>&1 \
  | grep -vE "Warning: Permanently" | tail -25 || fail "read_file_live"

say "5/6 progress heartbeat during create"
MYCO_RT_LIVE=1 cargo test --manifest-path runtime/Cargo.toml \
  -p myco-rt-backend-qemu --test read_file_live -- --ignored --nocapture \
  live_create_emits_progress_heartbeat 2>&1 \
  | grep -vE "Warning: Permanently" | tail -10 || fail "progress heartbeat"

say "6/6 done"
echo "All live proofs passed. Timings are printed above by each test."
