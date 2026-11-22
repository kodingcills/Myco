#!/usr/bin/env bash
# VM-free self-test of the guest lifecycle scripts (RT-003).
#
# Runs no guest, downloads nothing, and touches no shared state: the scripts under
# test derive GUEST_DIR from $0, so they are copied into a temp directory alongside
# stubs. That exercises their real logic -- overlay reuse, --recreate, the
# pre-boot refusal -- with no VM and no network.
#
#   runtime/guest/selftest.sh
#
# Why this exists (operating rule B, 2026-11-22): the overlay and boot guards were
# only ever exercised by booting a guest, so a regression in them cost a window.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILURES=0

ok()   { printf 'ok   %s\n' "$*"; }
bad()  { printf 'FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }

# A sandbox that mirrors runtime/guest/ with the scripts under test plus a stub
# fetch-image.sh, so create-overlay.sh does not try to download a 600 MB image.
sandbox() {
  local d="$1"
  rm -rf "$d"; mkdir -p "$d/state"
  cp "$HERE/create-overlay.sh" "$HERE/boot.sh" "$HERE/shutdown.sh" "$d/"
  # Stub: declare success and create a tiny base so qemu-img has a backing file.
  cat > "$d/fetch-image.sh" <<'STUB'
#!/usr/bin/env bash
base="$(cd "$(dirname "$0")" && pwd)/state/noble-server-cloudimg-arm64.img"
[[ -f "$base" ]] || qemu-img create -f qcow2 "$base" 8M >/dev/null
exit 0
STUB
  chmod +x "$d/fetch-image.sh"
  printf '%s' "$d"
}

# ── 1. create-overlay creates an overlay backed by the base ────────────────────
A="$(sandbox "$TMP/a")"
out="$("$A/create-overlay.sh" 2>&1)"
if [[ -f "$A/state/myco-runtime-v0.qcow2" ]]; then
  ok "create-overlay.sh creates the overlay"
else
  bad "create-overlay.sh did not create the overlay: $out"
fi
# It must be a qcow2 over the base, not a copy of it.
backing="$(qemu-img info --output=json "$A/state/myco-runtime-v0.qcow2" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("backing-filename",""))' 2>/dev/null)"
if [[ -n "$backing" ]]; then
  ok "the overlay is backed by the base image (not a copy)"
else
  bad "the overlay has no backing file -- guest state would not be discarded on destroy"
fi

# ── 2. re-running without --recreate is idempotent ─────────────────────────────
before="$(stat -f '%m' "$A/state/myco-runtime-v0.qcow2" 2>/dev/null || stat -c '%Y' "$A/state/myco-runtime-v0.qcow2")"
sleep 1
out="$("$A/create-overlay.sh" 2>&1)"
after="$(stat -f '%m' "$A/state/myco-runtime-v0.qcow2" 2>/dev/null || stat -c '%Y' "$A/state/myco-runtime-v0.qcow2")"
if [[ "$before" == "$after" ]] && grep -q "already exists" <<<"$out"; then
  ok "re-running without --recreate reuses the overlay and says so"
else
  bad "an existing overlay was replaced without --recreate"
fi

# ── 3. --recreate discards it ──────────────────────────────────────────────────
sleep 1
out="$("$A/create-overlay.sh" --recreate 2>&1)"
after2="$(stat -f '%m' "$A/state/myco-runtime-v0.qcow2" 2>/dev/null || stat -c '%Y' "$A/state/myco-runtime-v0.qcow2")"
if grep -q "Removing existing overlay" <<<"$out" && [[ "$after2" != "$after" ]]; then
  ok "--recreate removes and rebuilds the overlay"
else
  bad "--recreate did not rebuild the overlay: $out"
fi

# ── 4. boot.sh refuses to double-boot a live guest ─────────────────────────────
B="$(sandbox "$TMP/b")"
"$B/fetch-image.sh" >/dev/null 2>&1
# A pidfile naming this shell: the process is alive, so boot must refuse.
echo "$$" > "$B/state/qemu.pid"
out="$("$B/boot.sh" 2>&1)"
rc=$?
if [[ $rc -eq 0 ]] && grep -qi "already running" <<<"$out"; then
  ok "boot.sh refuses to double-boot when the pid in the pidfile is alive"
else
  bad "boot.sh did not refuse a live guest (rc=$rc): $out"
fi
# And it must not have started qemu.
if pgrep -f "qemu-system-aarch64.*$B" >/dev/null 2>&1; then
  bad "boot.sh started a guest despite a live pidfile"
else
  ok "no guest was started"
fi

# ── 5. boot.sh clears a stale pidfile and would proceed ────────────────────────
C="$(sandbox "$TMP/c")"
"$C/fetch-image.sh" >/dev/null 2>&1
# A pid that cannot be alive.
echo "999999" > "$C/state/qemu.pid"
out="$("$C/boot.sh" 2>&1 || true)"
if grep -qi "already running" <<<"$out"; then
  bad "boot.sh treated a dead pid as a live guest"
else
  ok "boot.sh does not treat a dead pid as a live guest"
fi

# ── 6. create-overlay never writes to the base image ───────────────────────────
D="$(sandbox "$TMP/d")"
"$D/fetch-image.sh" >/dev/null 2>&1
base_before="$(shasum -a 256 "$D/state/noble-server-cloudimg-arm64.img" | cut -d' ' -f1)"
"$D/create-overlay.sh" >/dev/null 2>&1
base_after="$(shasum -a 256 "$D/state/noble-server-cloudimg-arm64.img" | cut -d' ' -f1)"
if [[ "$base_before" == "$base_after" ]]; then
  ok "the base image is byte-identical after creating the overlay"
else
  bad "creating an overlay modified the base image"
fi

# ── 7. shutdown.sh verifies liveness AFTER its kill attempts ───────────────────
#
# An unkillable qemu cannot be simulated from a test: SIGKILL is uncatchable, and
# any fixture process this user can start is one this user can also kill. Rather
# than fake it, this asserts the two things that are actually observable:
#
#   (a) the liveness check exists and sits AFTER the SIGKILL attempt -- the bug was
#       that the script removed the pidfile and printed success without re-checking;
#   (b) a pidfile naming a process this user cannot signal (PID 1) is NOT treated as
#       a live guest, i.e. `kill -0` is what decides, not the file's presence.
#
# (b) is the reachable half and shows the check is real rather than decorative.
E="$(sandbox "$TMP/e")"
echo "1" > "$E/state/qemu.pid"
out="$("$E/shutdown.sh" 2>&1)"
rc=$?
if [[ $rc -eq 0 ]] && grep -qi "stale pidfile" <<<"$out"; then
  ok "an unsignalable pid is treated as stale, not as a live guest"
else
  bad "PID 1 in the pidfile produced rc=$rc: $out"
fi

# (a) the structural check the bug would fail.
kill_line="$(grep -n 'kill -9' "$HERE/shutdown.sh" | head -1 | cut -d: -f1)"
check_line="$(grep -n 'survived SIGKILL' "$HERE/shutdown.sh" | head -1 | cut -d: -f1)"
if [[ -n "$kill_line" && -n "$check_line" && "$check_line" -gt "$kill_line" ]]; then
  ok "the liveness check follows the SIGKILL attempt"
else
  bad "shutdown.sh has no liveness check after kill -9 (kill=$kill_line check=$check_line)"
fi

# The success message must be guarded by that check, not printed unconditionally.
if awk "/survived SIGKILL/{found=1} /OK: guest is down/{if(!found) bad=1} END{exit bad+0}" "$HERE/shutdown.sh"; then
  ok "the success message is unreachable when the guest survived"
else
  bad "the success message can print without the liveness check having passed"
fi

# ── 8. shutdown.sh no-ops cleanly with no pidfile ──────────────────────────────
F="$(sandbox "$TMP/f")"
out="$("$F/shutdown.sh" 2>&1)"
rc=$?
if [[ $rc -eq 0 ]] && grep -q "not running" <<<"$out"; then
  ok "shutdown.sh no-ops cleanly with no pidfile"
else
  bad "shutdown.sh with no pidfile returned rc=$rc: $out"
fi

# ── 9. a stale pidfile is cleared and reported as such ─────────────────────────
G="$(sandbox "$TMP/g")"
echo "999999" > "$G/state/qemu.pid"
out="$("$G/shutdown.sh" 2>&1)"
rc=$?
if [[ $rc -eq 0 ]] && grep -qi "stale" <<<"$out" && [[ ! -f "$G/state/qemu.pid" ]]; then
  ok "shutdown.sh clears a stale pidfile and says why"
else
  bad "a stale pidfile was not handled cleanly (rc=$rc): $out"
fi

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "guest selftest OK: all 9 scenarios passed, no guest started, no download"
  exit 0
fi
echo "guest selftest FAILED: $FAILURES scenario(s)" >&2
exit 1
