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

# ── 10. boot.sh's RAM guard rejects bad values before ANY side effect ──────────
# TIF-110: `${VAR:-2048}` let a set-but-empty value through, and `0` (QEMU's
# "default") was accepted. A revert of either turns this red.
guard_bad=0
for v in "" 0 00 08 -1 abc 1e3 " 2048"; do
  G="$(sandbox "$TMP/g10")"   # fresh per value: one leak must not mask the others
  out="$(MYCO_RT_GUEST_MB="$v" bash "$G/boot.sh" 2>&1)"; rc=$?
  if [[ $rc -ne 1 || "$out" != *"positive integer MB"* || -f "$G/state/noble-server-cloudimg-arm64.img" ]]; then
    bad "boot.sh guard let MYCO_RT_GUEST_MB='$v' through (rc=$rc): $out"; guard_bad=1
  fi
done
[[ $guard_bad -eq 0 ]] && ok "boot.sh rejects empty/0/08/-1/non-numeric RAM caps before any side effect"

# ── 11. provision.sh: unknown args refused, --check gates on completeness ──────
P="$TMP/p11"; rm -rf "$P"; mkdir -p "$P/state" "$P/keys"
cp "$HERE/provision.sh" "$P/"
out="$(bash "$P/provision.sh" --chek 2>&1)"; rc=$?
if [[ $rc -eq 2 && ! -f "$P/keys/id_ed25519" ]]; then ok "provision.sh refuses an unknown argument without provisioning"
else bad "provision.sh --chek was not refused cleanly (rc=$rc): $out"; fi
out="$(bash "$P/provision.sh" --check 2>&1)"; rc=$?
if [[ $rc -eq 1 && "$out" == *MISS* && ! -f "$P/keys/id_ed25519" ]]; then ok "provision.sh --check exits 1 and changes nothing when unprovisioned"
else bad "provision.sh --check on an empty tree: rc=$rc (want 1): $out"; fi
echo "ssh-ed25519 AAAA test" > "$P/keys/id_ed25519.pub"   # non-empty: --check rejects an empty .pub
touch "$P/keys/id_ed25519" "$P/state/noble-server-cloudimg-arm64.img" "$P/state/myco-runtime-v0.qcow2" "$P/state/seed.iso"
out="$(bash "$P/provision.sh" --check 2>&1)"; rc=$?
if [[ $rc -eq 0 ]]; then ok "provision.sh --check exits 0 when every asset is present"
else bad "provision.sh --check on a complete tree: rc=$rc (want 0): $out"; fi

# ── 12. a new SSH key forces a fresh overlay; refused under a live guest ───────
# cloud-init will not re-apply ssh_authorized_keys to an overlay it already ran in,
# so re-keying over an old overlay would print "Provisioned" and then refuse SSH.
R="$TMP/r12"; rm -rf "$R"; mkdir -p "$R/state" "$R/keys"
cp "$HERE/provision.sh" "$R/"
for s in fetch-image make-seed; do printf '#!/usr/bin/env bash\nexit 0\n' > "$R/$s.sh"; done
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; [[ -f "$d/state/myco-runtime-v0.qcow2" ]] && e=old || e=none; echo "$e $*" >> "$d/overlay-args.log"; touch "$d/state/myco-runtime-v0.qcow2"\n' > "$R/create-overlay.sh"
chmod +x "$R"/*.sh
touch "$R/state/myco-runtime-v0.qcow2"
out="$(bash "$R/provision.sh" 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$(cat "$R/overlay-args.log" 2>/dev/null)" == "none "* ]]; then
  ok "provision.sh discards the old overlay when it generates a new key"
else bad "re-key kept the old overlay (rc=$rc): $(cat "$R/overlay-args.log" 2>/dev/null) / $out"; fi
rm -f "$R/keys/id_ed25519" "$R/overlay-args.log"; touch "$R/state/myco-runtime-v0.qcow2"
sleep 300 & live=$!; echo "$live" > "$R/state/qemu.pid"
out="$(bash "$R/provision.sh" 2>&1)"; rc=$?
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
if [[ $rc -eq 1 && ! -f "$R/overlay-args.log" && ! -f "$R/keys/id_ed25519" && -f "$R/state/myco-runtime-v0.qcow2" && "$out" == *Refusing* ]]; then
  ok "provision.sh refuses to re-key over a running guest's overlay"
else bad "re-key under a live guest was not refused (rc=$rc): $out"; fi

# ── 13. a missing .pub alone never re-keys, even with a live guest ─────────────
# A `git pull` deletes the formerly tracked .pub while the private key and overlay
# stay. Rebuild the .pub from the private key; never touch the guest's identity.
K="$TMP/k13"; rm -rf "$K"; mkdir -p "$K/state" "$K/keys"
cp "$HERE/provision.sh" "$K/"
for s in fetch-image make-seed; do printf '#!/usr/bin/env bash\nexit 0\n' > "$K/$s.sh"; done
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; [[ -f "$d/state/myco-runtime-v0.qcow2" ]] && e=old || e=none; echo "$e $*" >> "$d/overlay-args.log"; touch "$d/state/myco-runtime-v0.qcow2"\n' > "$K/create-overlay.sh"
chmod +x "$K"/*.sh
ssh-keygen -t ed25519 -N '' -q -f "$K/keys/id_ed25519"; rm -f "$K/keys/id_ed25519.pub"
touch "$K/state/myco-runtime-v0.qcow2"
before="$(shasum "$K/keys/id_ed25519" | cut -d' ' -f1)"
sleep 300 & live=$!; echo "$live" > "$K/state/qemu.pid"
out="$(bash "$K/provision.sh" 2>&1)"; rc=$?
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
after="$(shasum "$K/keys/id_ed25519" | cut -d' ' -f1)"
derived="$(ssh-keygen -y -f "$K/keys/id_ed25519" | cut -d' ' -f2)"
if [[ $rc -eq 0 && "$before" == "$after" && "$(cut -d' ' -f2 "$K/keys/id_ed25519.pub" 2>/dev/null)" == "$derived" \
      && "$(cat "$K/overlay-args.log" 2>/dev/null)" == "old "* ]]; then
  ok "provision.sh rebuilds a missing .pub from the private key without re-keying"
else bad "missing .pub with live guest: rc=$rc key-changed=$([[ $before == "$after" ]] && echo no || echo YES) / $out"; fi

# ── 14. make-seed.sh (boot.sh's path) never silently re-keys ───────────────────
M="$TMP/m14"; rm -rf "$M"; mkdir -p "$M/state" "$M/keys" "$M/seed" "$M/bin"
cp "$HERE/make-seed.sh" "$M/"; printf 'k: __MYCO_PUBKEY__\n' > "$M/seed/user-data"; : > "$M/seed/meta-data"
printf '#!/usr/bin/env bash\n: > "$1"\n' > "$M/bin/cloud-localds"; chmod +x "$M/bin/cloud-localds"
touch "$M/state/myco-runtime-v0.qcow2"
out="$(PATH="$M/bin:$PATH" bash "$M/make-seed.sh" 2>&1)"; rc=$?
if [[ $rc -eq 1 && ! -f "$M/keys/id_ed25519" && "$out" == *Refusing* ]]; then
  ok "make-seed.sh refuses to mint a new key over an existing overlay"
else bad "make-seed.sh re-keyed over an existing overlay (rc=$rc): $out"; fi
rm -f "$M/keys/id_ed25519" "$M/keys/id_ed25519.pub"   # never prompt "Overwrite?" (hangs a tty)
ssh-keygen -t ed25519 -N '' -q -f "$M/keys/id_ed25519" </dev/null; rm -f "$M/keys/id_ed25519.pub"
before="$(shasum "$M/keys/id_ed25519" | cut -d' ' -f1)"
out="$(PATH="$M/bin:$PATH" bash "$M/make-seed.sh" 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$before" == "$(shasum "$M/keys/id_ed25519" | cut -d' ' -f1)" && -f "$M/keys/id_ed25519.pub" ]]; then
  ok "make-seed.sh rebuilds a missing .pub from the existing private key"
else bad "make-seed.sh with private key but no .pub (rc=$rc): $out"; fi

# ── 15. a bad private key never leaves an empty .pub behind ────────────────────
# A failed `ssh-keygen -y` used to leave a 0-byte .pub that the next run accepted,
# seeding a guest that authorizes no key.
E="$TMP/e15"; rm -rf "$E"; mkdir -p "$E/state" "$E/keys" "$E/seed" "$E/bin"
cp "$HERE/make-seed.sh" "$HERE/provision.sh" "$E/"; printf 'k: __MYCO_PUBKEY__\n' > "$E/seed/user-data"; : > "$E/seed/meta-data"
printf '#!/usr/bin/env bash\n: > "$1"\n' > "$E/bin/cloud-localds"; chmod +x "$E/bin/cloud-localds"
echo "not a key" > "$E/keys/id_ed25519"; chmod 600 "$E/keys/id_ed25519"
out1="$(PATH="$E/bin:$PATH" bash "$E/make-seed.sh" 2>&1)"; rc1=$?
out2="$(PATH="$E/bin:$PATH" bash "$E/make-seed.sh" 2>&1)"; rc2=$?
if [[ $rc1 -eq 1 && $rc2 -eq 1 && ! -e "$E/keys/id_ed25519.pub" && "$(cat "$E/keys/id_ed25519")" == "not a key" && "$out1" == *"Cannot derive"* ]]; then
  ok "a corrupt private key fails clearly, every time, and leaves no empty .pub"
else bad "corrupt key: rc1=$rc1 rc2=$rc2 pub=$( [[ -e $E/keys/id_ed25519.pub ]] && wc -c <"$E/keys/id_ed25519.pub" || echo none) / $out1 / $out2"; fi
: > "$E/keys/id_ed25519.pub"; touch "$E/state/noble-server-cloudimg-arm64.img" "$E/state/myco-runtime-v0.qcow2" "$E/state/seed.iso"
ssh-keygen -t ed25519 -N '' -q -f "$E/keys/k2" </dev/null; mv "$E/keys/k2" "$E/keys/id_ed25519"; rm -f "$E/keys/k2.pub"
: > "$E/keys/id_ed25519.pub"
out="$(bash "$E/provision.sh" --check 2>&1)"; rc=$?
if [[ $rc -eq 1 ]]; then ok "provision.sh --check treats an empty .pub as not provisioned"
else bad "--check accepted an empty .pub (rc=$rc): $out"; fi

# ── 16. a .pub that does not match the private key is rebuilt, not trusted ─────
ssh-keygen -t ed25519 -N '' -q -f "$E/keys/other" </dev/null
cp "$E/keys/other.pub" "$E/keys/id_ed25519.pub"
out="$(PATH="$E/bin:$PATH" bash "$E/make-seed.sh" 2>&1)"; rc=$?
want="$(ssh-keygen -y -f "$E/keys/id_ed25519" | cut -d' ' -f2)"
if [[ $rc -eq 0 && "$(cut -d' ' -f2 "$E/keys/id_ed25519.pub")" == "$want" && "$out" == *"does not match"* ]]; then
  ok "a mismatched .pub is rebuilt from the private key"
else bad "mismatched .pub was trusted (rc=$rc): $out"; fi

# ── 17. an interrupted re-key cannot leave "new key + old overlay" ─────────────
# fetch-image fails (Ctrl-C, SHA mismatch, no network) after the key is minted;
# the re-run must still end on a fresh overlay.
I="$TMP/i17"; rm -rf "$I"; mkdir -p "$I/state" "$I/keys"
cp "$HERE/provision.sh" "$I/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$I/make-seed.sh"
printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/fail-fetch" ]] && exit 1; exit 0\n' > "$I/fetch-image.sh"
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; [[ -f "$d/state/myco-runtime-v0.qcow2" ]] && e=old || e=none; echo "$e $*" >> "$d/overlay-args.log"; touch "$d/state/myco-runtime-v0.qcow2"\n' > "$I/create-overlay.sh"
chmod +x "$I"/*.sh
echo stale > "$I/state/myco-runtime-v0.qcow2"; touch "$I/fail-fetch"
bash "$I/provision.sh" >/dev/null 2>&1; rc1=$?
rm -f "$I/fail-fetch"
bash "$I/provision.sh" >/dev/null 2>&1; rc2=$?
if [[ $rc1 -ne 0 && $rc2 -eq 0 && "$(cat "$I/overlay-args.log" 2>/dev/null)" == "none "* ]]; then
  ok "an interrupted re-key still ends on a fresh overlay"
else bad "interrupted re-key: rc1=$rc1 rc2=$rc2 overlay-log=$(cat "$I/overlay-args.log" 2>/dev/null)"; fi

# ── 18. boot.sh on a fresh checkout seeds before creating the overlay ──────────
F="$TMP/f18"; rm -rf "$F"; mkdir -p "$F/state" "$F/keys"
cp "$HERE/boot.sh" "$F/"
printf '#!/usr/bin/env bash\necho seed >> "$(dirname "$0")/order.log"\n' > "$F/make-seed.sh"
printf '#!/usr/bin/env bash\necho overlay >> "$(dirname "$0")/order.log"; exit 7\n' > "$F/create-overlay.sh"
chmod +x "$F"/*.sh
bash "$F/boot.sh" >/dev/null 2>&1
if [[ "$(tr '\n' ' ' < "$F/order.log" 2>/dev/null)" == "seed overlay " ]]; then
  ok "boot.sh runs make-seed.sh before create-overlay.sh"
else bad "boot.sh order: $(tr '\n' ' ' < "$F/order.log" 2>/dev/null)"; fi

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "guest selftest OK: all 18 scenarios passed, no guest started, no download"
  exit 0
fi
echo "guest selftest FAILED: $FAILURES scenario(s)" >&2
exit 1
