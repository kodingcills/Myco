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
# TIF-137: boot.sh now takes the host VM lock. No scenario may touch the real lock
# (/tmp/myco-win11.vm.lock): default every run to a private lock file and to this
# checkout's vm-lock.sh (sandboxed copies of boot.sh cannot find it relatively).
export MYCO_VM_LOCK_PATH="$TMP/vm.lock"
export MYCO_VM_LOCK_SCRIPT="$HERE/../../scripts/vm-lock.sh"
unset MYCO_VM_LOCK_OWNER

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
echo agent > "$P/state/myco-rt-agent-aarch64"
out="$(bash "$P/provision.sh" --check 2>&1)"; rc=$?
if [[ $rc -eq 0 ]]; then ok "provision.sh --check exits 0 when every asset is present"
else bad "provision.sh --check on a complete tree: rc=$rc (want 0): $out"; fi

# ── 12. a new SSH key forces a fresh overlay; refused under a live guest ───────
# cloud-init will not re-apply ssh_authorized_keys to an overlay it already ran in,
# so re-keying over an old overlay would print "Provisioned" and then refuse SSH.
R="$TMP/r12"; rm -rf "$R"; mkdir -p "$R/state" "$R/keys"
cp "$HERE/provision.sh" "$R/"
printf '#!/usr/bin/env bash\nexit 0\n' > "$R/fetch-image.sh"
printf '#!/usr/bin/env bash\ntouch "$(dirname "$0")/state/seed.iso"\n' > "$R/make-seed.sh"
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; [[ -f "$d/state/myco-runtime-v0.qcow2" ]] && e=old || e=none; echo "$e $*" >> "$d/overlay-args.log"; touch "$d/state/myco-runtime-v0.qcow2"\n' > "$R/create-overlay.sh"
chmod +x "$R"/*.sh
touch "$R/state/myco-runtime-v0.qcow2"; echo bin > "$R/state/myco-rt-agent-aarch64"; touch "$R/state/noble-server-cloudimg-arm64.img"
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
printf '#!/usr/bin/env bash\nexit 0\n' > "$K/fetch-image.sh"
printf '#!/usr/bin/env bash\ntouch "$(dirname "$0")/state/seed.iso"\n' > "$K/make-seed.sh"
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; [[ -f "$d/state/myco-runtime-v0.qcow2" ]] && e=old || e=none; echo "$e $*" >> "$d/overlay-args.log"; touch "$d/state/myco-runtime-v0.qcow2"\n' > "$K/create-overlay.sh"
chmod +x "$K"/*.sh
ssh-keygen -t ed25519 -N '' -q -f "$K/keys/id_ed25519"; rm -f "$K/keys/id_ed25519.pub"
touch "$K/state/myco-runtime-v0.qcow2"; echo bin > "$K/state/myco-rt-agent-aarch64"; touch "$K/state/noble-server-cloudimg-arm64.img"
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
printf '#!/usr/bin/env bash\ntouch "$(dirname "$0")/state/seed.iso"\n' > "$I/make-seed.sh"
printf '#!/usr/bin/env bash\n[[ -f "$(dirname "$0")/fail-fetch" ]] && exit 1; exit 0\n' > "$I/fetch-image.sh"
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; [[ -f "$d/state/myco-runtime-v0.qcow2" ]] && e=old || e=none; echo "$e $*" >> "$d/overlay-args.log"; touch "$d/state/myco-runtime-v0.qcow2"\n' > "$I/create-overlay.sh"
chmod +x "$I"/*.sh
echo stale > "$I/state/myco-runtime-v0.qcow2"; touch "$I/fail-fetch"; echo bin > "$I/state/myco-rt-agent-aarch64"; touch "$I/state/noble-server-cloudimg-arm64.img"
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

# ── 18b. boot.sh takes the host VM lock (TIF-137) ─────────────────────────────
# Stubs: make-seed logs, create-overlay logs and exits 7, so reaching "overlay"
# proves boot.sh got past its lock step and nothing reaches qemu.
lsand() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d/state" "$d/keys"
  cp "$HERE/boot.sh" "$d/"
  printf '#!/usr/bin/env bash\necho seed >> "$(dirname "$0")/order.log"\n' > "$d/make-seed.sh"
  printf '#!/usr/bin/env bash\necho overlay >> "$(dirname "$0")/order.log"; exit 7\n' > "$d/create-overlay.sh"
  chmod +x "$d"/*.sh
}
lorder() { [[ -f "$1/order.log" ]] && tr '\n' ' ' < "$1/order.log"; true; }
hold_lock() {   # $1 lock path, $2 name; holds the lock ~30 s in the background
  # A separate bash process, not a ( ) subshell: inside a subshell $$ is still THIS
  # script's pid, which is an ancestor of boot.sh and would look like a real owner.
  MYCO_VM_LOCK_PATH="$1" bash -c 'source "$MYCO_VM_LOCK_SCRIPT"; vm_lock_acquire "$0" >/dev/null 2>&1 && sleep 30' "$2" &
  HOLDER=$!
  for _ in $(seq 1 50); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done
}
unhold() { pkill -P "$HOLDER" 2>/dev/null; kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; true; }

L="$TMP/l18a"; lsand "$L"
out="$(MYCO_VM_LOCK_PATH="$L/vm.lock" bash "$L/boot.sh" 2>&1)"; rc=$?
if [[ $rc -eq 7 && "$(lorder "$L")" == "seed overlay " && "$(cut -d' ' -f2 "$L/vm.lock")" == boot.sh ]]; then
  ok "boot.sh takes the free VM lock before seeding (lock file names boot.sh)"
else bad "boot.sh with a free lock: rc=$rc order=[$(lorder "$L")] lock=[$(cat "$L/vm.lock" 2>/dev/null)] / $out"; fi

L="$TMP/l18b"; lsand "$L"; hold_lock "$L/vm.lock" other-owner
out="$(MYCO_VM_LOCK_PATH="$L/vm.lock" bash "$L/boot.sh" 2>&1)"; rc=$?; unhold
if [[ $rc -eq 10 && -z "$(lorder "$L")" && "$out" == *"held by another owner"* ]]; then
  ok "boot.sh refuses (exit 10) while another owner holds the VM lock, before seeding"
else bad "boot.sh with a held lock: rc=$rc order=[$(lorder "$L")] / $out"; fi

L="$TMP/l18c"; lsand "$L"
out="$( export MYCO_VM_LOCK_PATH="$L/vm.lock"; source "$MYCO_VM_LOCK_SCRIPT"; vm_lock_acquire parent-driver >/dev/null 2>&1 && bash "$L/boot.sh" 2>&1 )"; rc=$?
if [[ $rc -eq 7 && "$(lorder "$L")" == "seed overlay " && "$out" == *"held by the caller"* ]]; then
  ok "boot.sh boots under a VM lock its ancestor holds, without re-acquiring"
else bad "boot.sh under an ancestor's lock: rc=$rc order=[$(lorder "$L")] / $out"; fi

L="$TMP/l18d"; lsand "$L"; hold_lock "$L/vm.lock" spoofed-owner
spoof="$(cut -d' ' -f1 "$L/vm.lock")"
out="$(MYCO_VM_LOCK_PATH="$L/vm.lock" MYCO_VM_LOCK_OWNER="$spoof" bash "$L/boot.sh" 2>&1)"; rc=$?; unhold
if [[ $rc -eq 10 && -z "$(lorder "$L")" ]]; then
  ok "a MYCO_VM_LOCK_OWNER that is not an ancestor does not bypass the lock"
else bad "spoofed owner: rc=$rc order=[$(lorder "$L")] / $out"; fi

L="$TMP/l18e"; lsand "$L"
# (Written to a file: bash 3.2 mis-parses a quoted heredoc inside $( ).)
cat > "$L/holder.py" <<'PY'
import fcntl, os, subprocess, sys
d = sys.argv[1]
fd = os.open(os.path.join(d, "vm.lock"), os.O_RDWR | os.O_CREAT, 0o666)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)          # df005-runner.py's protocol
os.ftruncate(fd, 0); os.write(fd, ("%d df005-runner.py\n" % os.getpid()).encode())
env = {k: v for k, v in os.environ.items() if k != "MYCO_VM_LOCK_OWNER"}
r = subprocess.run(["bash", os.path.join(d, "boot.sh")], env=env, capture_output=True, text=True)
print(r.stdout + r.stderr); sys.exit(r.returncode)
PY
out="$(MYCO_VM_LOCK_PATH="$L/vm.lock" python3 "$L/holder.py" "$L" 2>&1)"; rc=$?
if [[ $rc -eq 7 && "$(lorder "$L")" == "seed overlay " && "$out" == *"held by the caller"* ]]; then
  ok "boot.sh boots under a Python holder (df005-runner style, no MYCO_VM_LOCK_OWNER)"
else bad "Python-held lock: rc=$rc order=[$(lorder "$L")] / $out"; fi

L="$TMP/l18f"; lsand "$L"
out="$(MYCO_VM_LOCK_PATH="$L/vm.lock" bash -c 'echo "$$ released-driver" > "$MYCO_VM_LOCK_PATH"; bash "$0/boot.sh" 2>&1' "$L")"; rc=$?
if [[ $rc -eq 7 && "$(lorder "$L")" == "seed overlay " && "$(cut -d' ' -f2 "$L/vm.lock")" == boot.sh ]]; then
  ok "a stale holder line from a live ancestor that released the lock does not skip it"
else bad "stale holder line: rc=$rc order=[$(lorder "$L")] lock=[$(cat "$L/vm.lock" 2>/dev/null)] / $out"; fi

# ── 19. provision.sh and the guest agent (TIF-120 / DF-008) ───────────────────
# Default never boots; --build-agent takes the host VM lock and SESSION.lock, then
# boot -> wait for cloud-init -> build -> shut down. Stubs log the call order; the
# boot stub starts a harmless `sleep` as the "guest". Nothing here can start qemu.
# The real scripts/vm-lock.sh is used, against a private lock file per sandbox.
VMLOCK_SCRIPT="$HERE/../../scripts/vm-lock.sh"
agent_sandbox() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d/state" "$d/keys" "$d/bin"
  cp "$HERE/provision.sh" "$d/"
  for s in fetch-image make-seed create-overlay; do printf '#!/usr/bin/env bash\nexit 0\n' > "$d/$s.sh"; done
  printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; echo boot >> "$d/order.log"; sleep 300 & echo $! > "$d/state/qemu.pid"\n' > "$d/boot.sh"
  printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; echo shutdown >> "$d/order.log"; kill "$(cat "$d/state/qemu.pid")" 2>/dev/null; rm -f "$d/state/qemu.pid"\n' > "$d/shutdown.sh"
  # build stub: fail-build -> exit 1; build-no-output -> "succeed" but produce nothing
  # build stub: fail-build -> exit 1; build-no-output -> "succeed" but produce nothing;
  # build-partial -> leave a truncated (non-empty) agent, then fail
  printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; echo build >> "$d/order.log"; [[ -f "$d/build-partial" ]] && { echo trunc > "$d/state/myco-rt-agent-aarch64"; exit 1; }; [[ -f "$d/fail-build" ]] && exit 1; [[ -f "$d/build-no-output" ]] && exit 0; echo new > "$d/state/myco-rt-agent-aarch64"\n' > "$d/build-agent-in-guest.sh"
  # ssh stub answers `cloud-init status` like the real thing
  printf '#!/usr/bin/env bash\nd="%s"; if [[ -f "$d/ci-error" ]]; then echo "status: error"; elif [[ -f "$d/not-ready" ]]; then echo "status: running"; else echo "status: done"; fi\n' "$d" > "$d/bin/ssh"
  chmod +x "$d"/*.sh "$d/bin/ssh"
  ssh-keygen -t ed25519 -N '' -q -f "$d/keys/id_ed25519" </dev/null
  touch "$d/state/noble-server-cloudimg-arm64.img" "$d/state/myco-runtime-v0.qcow2" "$d/state/seed.iso"
}
order() { [[ -f "$1/order.log" ]] && tr '\n' ' ' < "$1/order.log"; true; }
reap() { [[ -f "$1/state/qemu.pid" ]] && kill "$(cat "$1/state/qemu.pid")" 2>/dev/null; true; }
prov() { local d="$1"; shift; PATH="$d/bin:$PATH" MYCO_RT_WAIT_INTERVAL=0 MYCO_VM_LOCK_SCRIPT="$VMLOCK_SCRIPT" MYCO_VM_LOCK_PATH="$d/vm.lock" bash "$d/provision.sh" "$@"; }

A="$TMP/a19"; agent_sandbox "$A"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 0 && "$(order "$A")" == "boot build shutdown " && "$(cat "$A/state/myco-rt-agent-aarch64")" == new && ! -f "$A/state/qemu.pid" && ! -e "$A/state/SESSION.lock" ]]; then
  ok "--build-agent locks, boots, builds, shuts down, and releases SESSION.lock"
else bad "agent build sequence: rc=$rc order=[$(order "$A")] / $out"; fi

A="$TMP/a19b"; agent_sandbox "$A"; sleep 300 & live=$!; echo "$live" > "$A/state/qemu.pid"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?
still=$(kill -0 "$live" 2>/dev/null && echo yes || echo no); kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
if [[ $rc -eq 0 && "$(order "$A")" == "build " && $still == yes ]]; then
  ok "--build-agent reuses a running guest and leaves it running"
else bad "reuse running guest: rc=$rc order=[$(order "$A")] still-running=$still / $out"; fi

A="$TMP/a19c"; agent_sandbox "$A"; touch "$A/fail-build"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -ne 0 && "$(order "$A")" == "boot build build shutdown " && ! -s "$A/state/myco-rt-agent-aarch64" && ! -e "$A/state/SESSION.lock" ]]; then
  ok "a failed agent build retries once, fails, shuts down, and releases the lock"
else bad "failed build: rc=$rc order=[$(order "$A")] / $out"; fi

A="$TMP/a19d"; agent_sandbox "$A"; touch "$A/not-ready"
out="$(MYCO_RT_CLOUDINIT_WAIT_SECS=1 prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -ne 0 && "$(order "$A")" == "boot shutdown " && "$out" == *"cloud-init not done"* ]]; then
  ok "a guest that never finishes cloud-init fails clearly and is shut down"
else bad "cloud-init timeout: rc=$rc order=[$(order "$A")] / $out"; fi

A="$TMP/a19e"; agent_sandbox "$A"; touch "$A/ci-error"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -ne 0 && "$(order "$A")" == "boot shutdown " && "$out" == *"finished with errors"* ]]; then
  ok "cloud-init 'status: error' fails at once, not after the full wait"
else bad "cloud-init error: rc=$rc order=[$(order "$A")] / $out"; fi

A="$TMP/a19f"; agent_sandbox "$A"; echo old > "$A/state/myco-rt-agent-aarch64"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 0 && -z "$(order "$A")" && "$(cat "$A/state/myco-rt-agent-aarch64")" == old ]]; then
  ok "--build-agent with an agent present does nothing"
else bad "existing agent: rc=$rc order=[$(order "$A")] / $out"; fi

A="$TMP/a19g"; agent_sandbox "$A"; echo old > "$A/state/myco-rt-agent-aarch64"
out="$(prov "$A" --rebuild-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 0 && "$(order "$A")" == "boot build shutdown " && "$(cat "$A/state/myco-rt-agent-aarch64")" == new && ! -e "$A/state/myco-rt-agent-aarch64.prev" ]]; then
  ok "--rebuild-agent replaces an existing agent"
else bad "--rebuild-agent: rc=$rc order=[$(order "$A")] agent=$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null) / $out"; fi

A="$TMP/a19h"; agent_sandbox "$A"; echo old > "$A/state/myco-rt-agent-aarch64"; touch "$A/build-no-output"
out="$(prov "$A" --rebuild-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -ne 0 && "$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null)" == old && "$out" == *"missing"* ]]; then
  ok "a rebuild that produces nothing fails and restores the previous agent"
else bad "silent rebuild: rc=$rc agent=$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null) / $out"; fi

A="$TMP/a19h2"; agent_sandbox "$A"; echo old > "$A/state/myco-rt-agent-aarch64"; touch "$A/build-partial"
out="$(prov "$A" --rebuild-agent 2>&1)"; rc=$?; reap "$A"
chk="$(bash "$A/provision.sh" --check 2>&1)"; crc=$?
if [[ $rc -ne 0 && "$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null)" == old && ! -e "$A/state/myco-rt-agent-aarch64.prev" && $crc -eq 0 ]]; then
  ok "a rebuild that leaves a truncated agent and fails restores the previous agent"
else bad "partial rebuild: rc=$rc agent=$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null) prev=$(cat "$A/state/myco-rt-agent-aarch64.prev" 2>/dev/null) / $out"; fi

A="$TMP/a19h3"; agent_sandbox "$A"; touch "$A/build-partial"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
chk="$(bash "$A/provision.sh" --check 2>&1)"; crc=$?
if [[ $rc -ne 0 && ! -e "$A/state/myco-rt-agent-aarch64" && $crc -eq 1 && "$chk" != *"Provisioned."* ]]; then
  ok "a first build that leaves a truncated agent and fails leaves no agent behind"
else bad "partial first build: rc=$rc check-rc=$crc agent=$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null) / $chk"; fi

A="$TMP/a19h4"; agent_sandbox "$A"; echo old > "$A/state/myco-rt-agent-aarch64"; touch "$A/not-ready"
out="$(MYCO_RT_CLOUDINIT_WAIT_SECS=1 prov "$A" --rebuild-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -ne 0 && "$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null)" == old ]]; then
  ok "a rebuild that fails before building leaves the existing agent untouched"
else bad "pre-build failure: rc=$rc agent=$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null) / $out"; fi

A="$TMP/a19i"; agent_sandbox "$A"
( source "$VMLOCK_SCRIPT"; MYCO_VM_LOCK_PATH="$A/vm.lock"; VM_LOCK_PATH="$A/vm.lock"; vm_lock_acquire selftest-holder >/dev/null 2>&1 && sleep 30 ) & holder=$!
for _ in $(seq 1 50); do grep -q selftest-holder "$A/vm.lock" 2>/dev/null && break; sleep 0.1; done
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
kill "$holder" 2>/dev/null; pkill -P "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
if [[ $rc -eq 10 && -z "$(order "$A")" && "$out" == *"VM lock is held"* ]]; then
  ok "--build-agent refuses (exit 10) while the host VM lock is held, without booting"
else bad "VM lock held: rc=$rc order=[$(order "$A")] / $out"; fi

A="$TMP/a19j"; agent_sandbox "$A"; sleep 300 & sess=$!; echo "$sess" > "$A/state/SESSION.lock"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
held="$(cat "$A/state/SESSION.lock" 2>/dev/null)"; kill "$sess" 2>/dev/null; wait "$sess" 2>/dev/null
if [[ $rc -eq 10 && -z "$(order "$A")" && "$held" == "$sess" && "$out" == *"SESSION.lock"* ]]; then
  ok "--build-agent refuses while a live session holds SESSION.lock, and leaves it alone"
else bad "SESSION.lock held: rc=$rc order=[$(order "$A")] lock=$held / $out"; fi

A="$TMP/a19k"; agent_sandbox "$A"; echo 999999 > "$A/state/SESSION.lock"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 0 && "$(order "$A")" == "boot build shutdown " && ! -e "$A/state/SESSION.lock" ]]; then
  ok "a stale SESSION.lock (dead pid) is reclaimed"
else bad "stale SESSION.lock: rc=$rc order=[$(order "$A")] / $out"; fi

A="$TMP/a19l"; agent_sandbox "$A"
out="$(prov "$A" 2>&1)"; rc=$?; reap "$A"
chk="$(bash "$A/provision.sh" --check 2>&1)"; crc=$?
if [[ $rc -eq 3 && -z "$(order "$A")" && "$out" == *"--build-agent"* && $crc -eq 1 && "$chk" == *"MISS  guest agent binary"* ]]; then
  ok "without a flag provision.sh never boots: a missing agent is exit 3 with the fix, --check exit 1"
else bad "default run: rc=$rc order=[$(order "$A")] check-rc=$crc / $out"; fi

A="$TMP/a19m"; agent_sandbox "$A"; echo bin > "$A/state/myco-rt-agent-aarch64"; rm -f "$A/state/noble-server-cloudimg-arm64.img"
out="$(prov "$A" 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 1 && "$out" == *"assets are missing"* && "$out" != *"no guest agent binary"* ]]; then
  ok "an incomplete tree with the agent present names the real gap (exit 1), not the agent"
else bad "misattributed not-ready: rc=$rc / $out"; fi

# ── 20. TIF-141: round-3 nits from the TIF-120 review ─────────────────────────
# N-B: build-agent-in-guest.sh copies the host agent to a unique temp file and
# renames it into place; a failed copy leaves the existing agent and no temp file.
bsand() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d/guest/state" "$d/guest/keys" "$d/crates/myco-rt-agent" "$d/bin"
  cp "$HERE/build-agent-in-guest.sh" "$d/guest/"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$d/bin/ssh"
  # scp stub: uploads succeed; the download writes the binary, or a partial + fails
  printf '#!/usr/bin/env bash\ndst="${@: -1}"; case "$dst" in myco@*) exit 0 ;; esac\nif [[ -f "%s/scp-partial" ]]; then printf partial > "$dst"; exit 1; fi\nprintf NEWBIN > "$dst"\n' "$d" > "$d/bin/scp"
  chmod +x "$d/bin/ssh" "$d/bin/scp" "$d/guest/build-agent-in-guest.sh"
}
leftover() { ls "$1/guest/state/" 2>/dev/null | grep -c 'myco-rt-agent-aarch64\.tmp' || true; }
Bd="$TMP/b20"; bsand "$Bd"
out="$(PATH="$Bd/bin:$PATH" bash "$Bd/guest/build-agent-in-guest.sh" 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$(cat "$Bd/guest/state/myco-rt-agent-aarch64")" == NEWBIN && "$(leftover "$Bd")" -eq 0 ]]; then
  ok "build-agent-in-guest.sh renames a complete copy into place and leaves no temp file"
else bad "build copy: rc=$rc agent=$(cat "$Bd/guest/state/myco-rt-agent-aarch64" 2>/dev/null) tmp=$(leftover "$Bd") / $out"; fi
Bd="$TMP/b20b"; bsand "$Bd"; echo old > "$Bd/guest/state/myco-rt-agent-aarch64"; touch "$Bd/scp-partial"
out="$(PATH="$Bd/bin:$PATH" bash "$Bd/guest/build-agent-in-guest.sh" 2>&1)"; rc=$?
if [[ $rc -ne 0 && "$(cat "$Bd/guest/state/myco-rt-agent-aarch64")" == old && "$(leftover "$Bd")" -eq 0 ]]; then
  ok "a failed host copy leaves the existing agent and no temp file"
else bad "failed copy: rc=$rc agent=$(cat "$Bd/guest/state/myco-rt-agent-aarch64" 2>/dev/null) tmp=$(leftover "$Bd") / $out"; fi

# provision.sh's cleanup removes temp files a failed build left behind.
A="$TMP/a20c"; agent_sandbox "$A"
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; echo build >> "$d/order.log"; echo part > "$d/state/myco-rt-agent-aarch64.tmp.Ab12Cd"; exit 1\n' > "$A/build-agent-in-guest.sh"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -ne 0 && -z "$(ls "$A/state/" | grep 'aarch64\.tmp')" ]]; then
  ok "provision.sh's cleanup removes temp files left by a failed build"
else bad "temp cleanup: rc=$rc left=$(ls "$A/state/" | grep 'aarch64\.tmp' | tr '\n' ' ') / $out"; fi

# N-C: TERM to provision.sh during a build stops the build too, so an orphan cannot
# rename an agent in after the locks are released.
A="$TMP/a20d"; agent_sandbox "$A"; echo old > "$A/state/myco-rt-agent-aarch64"
printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; echo build >> "$d/order.log"; touch "$d/building"; sleep 3; echo orphan > "$d/state/myco-rt-agent-aarch64"\n' > "$A/build-agent-in-guest.sh"
# Run provision.sh itself in the background (not via the prov function: `$!` of a
# backgrounded function is a wrapper subshell, and TERM would miss provision.sh).
PATH="$A/bin:$PATH" MYCO_RT_WAIT_INTERVAL=0 MYCO_VM_LOCK_SCRIPT="$VMLOCK_SCRIPT" MYCO_VM_LOCK_PATH="$A/vm.lock" \
  bash "$A/provision.sh" --rebuild-agent >/dev/null 2>&1 & ppid_=$!
for _ in $(seq 1 100); do [[ -f "$A/building" ]] && break; sleep 0.05; done
kill -TERM "$ppid_" 2>/dev/null; wait "$ppid_" 2>/dev/null
sleep 4; reap "$A"
if [[ "$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null)" == old && ! -e "$A/state/SESSION.lock" ]]; then
  ok "TERM during a build stops the build: no orphan lands an agent afterwards"
else bad "orphan build: agent=$(cat "$A/state/myco-rt-agent-aarch64" 2>/dev/null) lock=$(cat "$A/state/SESSION.lock" 2>/dev/null)"; fi

# ── 21. TIF-154: lock-aware recovery of a saved agent (.prev) ─────────────────
AG=state/myco-rt-agent-aarch64
A="$TMP/a21a"; agent_sandbox "$A"; echo old > "$A/$AG.prev"
out="$(prov "$A" 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 0 && "$(cat "$A/$AG" 2>/dev/null)" == old && ! -e "$A/$AG.prev" && -z "$(order "$A")" && ! -e "$A/state/SESSION.lock" ]]; then
  ok "a plain run restores an agent left in .prev (under SESSION.lock, released after)"
else bad "plain-run recovery: rc=$rc agent=$(cat "$A/$AG" 2>/dev/null) / $out"; fi

A="$TMP/a21b"; agent_sandbox "$A"; echo new > "$A/$AG"; echo older > "$A/$AG.prev"
out="$(prov "$A" 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 0 && "$(cat "$A/$AG")" == new && ! -e "$A/$AG.prev" ]]; then
  ok "a leftover .prev next to a present agent is dropped, never restored over it (F2)"
else bad "leftover .prev: rc=$rc agent=$(cat "$A/$AG" 2>/dev/null) prev=$(cat "$A/$AG.prev" 2>/dev/null) / $out"; fi

A="$TMP/a21c"; agent_sandbox "$A"; echo old > "$A/$AG.prev"; sleep 300 & sess=$!; echo "$sess" > "$A/state/SESSION.lock"
out="$(prov "$A" 2>&1)"; rc=$?
held="$(cat "$A/state/SESSION.lock" 2>/dev/null)"; kill "$sess" 2>/dev/null; wait "$sess" 2>/dev/null
if [[ $rc -eq 3 && ! -e "$A/$AG" && "$(cat "$A/$AG.prev")" == old && "$held" == "$sess" && "$out" == *"leaving its saved agent alone"* ]]; then
  ok "while a live process holds SESSION.lock, a plain run leaves .prev alone"
else bad "recovery under a held lock: rc=$rc agent=$(cat "$A/$AG" 2>/dev/null) prev=$(cat "$A/$AG.prev" 2>/dev/null) / $out"; fi

A="$TMP/a21d"; agent_sandbox "$A"; echo old > "$A/$AG.prev"
out="$(prov "$A" --build-agent 2>&1)"; rc=$?; reap "$A"
if [[ $rc -eq 0 && "$(cat "$A/$AG")" == old && -z "$(order "$A")" && ! -e "$A/state/SESSION.lock" ]]; then
  ok "--build-agent recovers a saved agent under its locks instead of booting"
else bad "--build-agent recovery: rc=$rc order=[$(order "$A")] agent=$(cat "$A/$AG" 2>/dev/null) / $out"; fi

# The Tier-1 verifier's F1 race, made deterministic: run 1 is a --rebuild-agent whose
# build fails slowly; while it holds the locks, run 2 starts. Run 1 must still end by
# restoring the good agent, whatever run 2 was.
race() {  # $1 = run-2 flag ("" or --rebuild-agent)
  local A="$TMP/a21race$2"; agent_sandbox "$A"; echo GOOD-OLD > "$A/$AG"
  printf '#!/usr/bin/env bash\nd="$(dirname "$0")"; echo build >> "$d/order.log"; touch "$d/building"; sleep 2; exit 1\n' > "$A/build-agent-in-guest.sh"
  PATH="$A/bin:$PATH" MYCO_RT_WAIT_INTERVAL=0 MYCO_VM_LOCK_SCRIPT="$VMLOCK_SCRIPT" MYCO_VM_LOCK_PATH="$A/vm.lock" \
    bash "$A/provision.sh" --rebuild-agent >/dev/null 2>&1 & local r1=$!
  for _ in $(seq 1 100); do [[ -f "$A/building" ]] && break; sleep 0.05; done
  R2OUT="$(prov "$A" $1 2>&1)"; R2RC=$?
  wait "$r1"; R1RC=$?; reap "$A"
  RACE_AGENT="$(cat "$A/$AG" 2>/dev/null || echo ABSENT)"; RACE_PREV="$(cat "$A/$AG.prev" 2>/dev/null || echo ABSENT)"
}
race "" plain
if [[ $R1RC -ne 0 && "$RACE_AGENT" == GOOD-OLD && "$RACE_PREV" == ABSENT && "$R2OUT" == *"leaving its saved agent alone"* ]]; then
  ok "F1 race: a plain run during a failing rebuild cannot lose the good agent"
else bad "F1 race (plain): r1=$R1RC r2=$R2RC agent=$RACE_AGENT prev=$RACE_PREV / $R2OUT"; fi
race --rebuild-agent rebuild
if [[ $R1RC -ne 0 && $R2RC -eq 10 && "$RACE_AGENT" == GOOD-OLD && "$RACE_PREV" == ABSENT ]]; then
  ok "F1 race: a refused --rebuild-agent during a failing rebuild changes nothing"
else bad "F1 race (rebuild): r1=$R1RC r2=$R2RC agent=$RACE_AGENT prev=$RACE_PREV / $R2OUT"; fi

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "guest selftest OK: all scenarios passed, no guest started, no download"
  exit 0
fi
echo "guest selftest FAILED: $FAILURES scenario(s)" >&2
exit 1
