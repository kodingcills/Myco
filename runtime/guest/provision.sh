#!/usr/bin/env bash
# RT-013 / DF-005 unblocker: provision the Myco Linux runtime guest in place.
#
# Why this exists: `runtime/guest/state/` and `runtime/guest/keys/id_ed25519` are
# gitignored, so a FRESH CHECKOUT (any worktree, including Dogfood's) has neither
# the base image, the overlay, the cloud-init seed, nor the SSH keypair. Running
# `boot.sh` there fails or boots nothing, and DF-005's preflight then reports the
# guest as unprovisioned — which is what happened.
#
# The scripts resolve `state/` relative to their own directory, so provisioning must
# happen IN the checkout that will run the guest, not in some shared cache. Without
# a flag it is idempotent, never boots a VM, and is safe to run in any checkout:
#
#   runtime/guest/provision.sh                 # assets: keypair, image, overlay, seed (no VM)
#   runtime/guest/provision.sh --check         # report state, change nothing; exit 0 only if complete
#   runtime/guest/provision.sh --build-agent   # also build the guest agent if missing: BOOTS A VM
#   runtime/guest/provision.sh --rebuild-agent # rebuild the agent even if a copy exists: BOOTS A VM
#
# The guest agent (myco-rt-agent) must be built INSIDE the guest: it links
# libxkbcommon, so the musl cross-build from macOS fails (TIF-120 / DF-008: the
# missing binary made every create fail with "no agent binary on the host").
# Without a flag, a missing agent is reported with this fix and exit 3. With
# --build-agent / --rebuild-agent the script takes the host VM lock
# (scripts/vm-lock.sh, the rule in docs/coordination/CONTRIBUTING-agents.md) AND
# the runtime's state/SESSION.lock, refusing with exit 10 if either is held; only
# then does it boot the guest (or reuse one already running, which it leaves
# running), wait for cloud-init, build, and shut down what it booted. A failed
# rebuild restores the previous agent. See docs/env/linux-runtime.md.
# It never downloads an overlay or seed from anywhere but the pinned sources, and it
# never touches myco-win11 or UTM.
set -euo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$GUEST_DIR/state"
KEY="$GUEST_DIR/keys/id_ed25519"
PUB="$GUEST_DIR/keys/id_ed25519.pub"
BASE="$STATE/noble-server-cloudimg-arm64.img"
OVERLAY="$STATE/myco-runtime-v0.qcow2"
SEED="$STATE/seed.iso"
AGENT="$STATE/myco-rt-agent-aarch64"
PID_FILE="$STATE/qemu.pid"
SESSION_LOCK="$STATE/SESSION.lock"
VM_LOCK_SCRIPT="${MYCO_VM_LOCK_SCRIPT:-$GUEST_DIR/../../scripts/vm-lock.sh}"
USAGE="usage: $(basename "$0") [--check | --build-agent | --rebuild-agent]   (no argument = assets only, no VM)"
CHECK=0
AGENT_MODE=report     # report | build | rebuild
case "${1:-}" in
  "")              ;;
  --check)         CHECK=1 ;;
  --build-agent)   AGENT_MODE=build ;;
  --rebuild-agent) AGENT_MODE=rebuild ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "$USAGE" >&2; exit 2; }

ok()   { printf '  ok    %s\n' "$1"; }
miss() { printf '  MISS  %s\n' "$1"; }

report() {
  echo "Guest assets in $GUEST_DIR:"
  [[ -f "$KEY"    ]] && ok "ssh private key ($KEY)"    || miss "ssh private key ($KEY)"
  [[ -f "$PUB"    ]] && ok "ssh public key"            || miss "ssh public key"
  [[ -f "$BASE"   ]] && ok "base image ($(du -h "$BASE" | cut -f1))" || miss "base image ($BASE)"
  [[ -f "$OVERLAY" ]] && ok "qcow2 overlay"            || miss "qcow2 overlay"
  [[ -f "$SEED"   ]] && ok "cloud-init seed"           || miss "cloud-init seed"
  [[ -s "$AGENT"  ]] && ok "guest agent binary ($AGENT)" || miss "guest agent binary ($AGENT; built in-guest)"
}

# --check exits 0 only when every asset is present, so a preflight can gate on it.
# The agent binary counts: `create` fails without it (DF-008).
complete() { [[ -f "$KEY" && -s "$PUB" && -f "$BASE" && -f "$OVERLAY" && -f "$SEED" && -s "$AGENT" ]]; }

if [[ $CHECK -eq 1 ]]; then
  report
  echo
  if complete; then echo "Provisioned."; exit 0; fi
  echo "Not provisioned. Run without --check to provision."
  exit 1
fi

# 1. Tooling. Each is a hard requirement; name the one-line fix rather than failing
#    with a bare "command not found" (lived experience: a fresh host lacks qemu).
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. Fix: $2" >&2; exit 1; }; }
need qemu-img "brew install qemu"
need ssh-keygen "comes with macOS; check PATH"
if ! command -v cloud-localds >/dev/null 2>&1 && ! command -v mkisofs >/dev/null 2>&1; then
  echo "Missing a seed-ISO builder. Fix: brew install cloud-utils   (or: brew install cdrtools)" >&2
  exit 1
fi

# Make the .pub match the private key: rebuild it if it is missing, empty, or a
# different key. The private key is the identity SSH actually presents, so it wins.
# Written to a temp file and moved into place only on success, so a failed
# `ssh-keygen -y` (corrupt or passphrase-protected key) never leaves an empty .pub
# that a later run would accept (TIF-111 re-verifier, round 3).
sync_pub() {
  local key="$1" pub="$2" derived tmp
  if ! derived="$(ssh-keygen -y -f "$key" </dev/null 2>/dev/null)" || [[ -z "$derived" ]]; then
    echo "Cannot derive a public key from $key (corrupt, or passphrase-protected)." >&2
    echo "Fix it, or remove BOTH key files and run runtime/guest/provision.sh to re-key." >&2
    exit 1
  fi
  if [[ -s "$pub" ]] && [[ "$(cut -d' ' -f1,2 "$pub")" == "$(cut -d' ' -f1,2 <<<"$derived")" ]]; then
    return 0
  fi
  [[ -s "$pub" ]] && echo "Public key does not match the private key; rebuilding it." >&2 \
                  || echo "Public key missing or empty; rebuilding it from the private key." >&2
  tmp="$(mktemp "${pub}.XXXXXX")"
  printf '%s myco-rt-guest\n' "$derived" > "$tmp"
  mv -f "$tmp" "$pub"
}

# 2. Keypair (user-data authorizes the public key, so it must exist before seeding).
#    Both key files are gitignored, so regenerating them never dirties git.
#    Only a missing PRIVATE key means a new identity; otherwise the .pub is synced to
#    the existing private key and the guest's trusted key never changes.
if [[ -f "$KEY" ]]; then
  sync_pub "$KEY" "$PUB"
else
  # A new key cannot reach an overlay where cloud-init already ran (fixed
  # instance-id: ssh_authorized_keys is not re-applied), so the old overlay must go.
  # Check for a live guest BEFORE touching anything, then delete the overlay BEFORE
  # creating the key: if this run is interrupted later (Ctrl-C in the download, a
  # SHA mismatch), a re-run must not find "new key + old overlay" and call it done.
  if [[ -f "$OVERLAY" ]]; then
    if [[ -f "$STATE/qemu.pid" ]] && kill -0 "$(cat "$STATE/qemu.pid")" 2>/dev/null; then
      echo "Refusing: the SSH private key is missing but a guest is running on the overlay." >&2
      echo "Stop it (runtime/guest/shutdown.sh), then re-run this script." >&2
      exit 1
    fi
    echo "New key: discarding the old overlay so cloud-init authorizes the new one."
    rm -f "$OVERLAY" "$SEED"
  fi
  echo "Generating guest SSH keypair ..."
  rm -f "$PUB"
  ssh-keygen -t ed25519 -N '' -C myco-rt-guest -f "$KEY" -q </dev/null
fi

# 3. Base image (SHA-256 pinned in fetch-image.sh; ~600 MB first time).
echo "Fetching/verifying the pinned base image ..."
"$GUEST_DIR/fetch-image.sh"

# 4. Overlay over the pristine base (never writes the base).
"$GUEST_DIR/create-overlay.sh"

# 5. Cloud-init seed (regenerates so the current public key is authorized).
"$GUEST_DIR/make-seed.sh"

# 6. Guest agent binary, built natively in the guest (see header). Ordering the
#    scripts never expressed: lock -> boot -> cloud-init done -> build -> shut down.
guest_live() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

# Both locks, before looking at the guest at all: the host VM lock (every VM action,
# CONTRIBUTING-agents.md) and the runtime's per-guest SESSION.lock, same protocol as
# the backend (atomic create holding our pid; a dead holder is reclaimed). Taking
# them first is what makes "is a guest live? then boot" race-free.
SESSION_LOCK_OURS=0
release_locks() {
  if [[ $SESSION_LOCK_OURS -eq 1 && "$(cat "$SESSION_LOCK" 2>/dev/null)" == "$$" ]]; then
    rm -f "$SESSION_LOCK"
  fi
  declare -F vm_lock_release >/dev/null && vm_lock_release
  return 0
}
take_locks() {
  [[ -r "$VM_LOCK_SCRIPT" ]] || { echo "Refusing: cannot take the VM lock ($VM_LOCK_SCRIPT not found)" >&2; exit 1; }
  # shellcheck source=/dev/null
  source "$VM_LOCK_SCRIPT"
  local rc=0
  vm_lock_acquire "provision.sh" || rc=$?
  [[ $rc -eq 0 ]] || { echo "Refusing: the host VM lock is held (see above); not booting." >&2; exit 10; }
  if ! ( set -C; echo "$$" > "$SESSION_LOCK" ) 2>/dev/null; then
    local holder; holder="$(cat "$SESSION_LOCK" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -f "$SESSION_LOCK"
      ( set -C; echo "$$" > "$SESSION_LOCK" ) 2>/dev/null || { release_locks; echo "Refusing: SESSION.lock race" >&2; exit 10; }
    else
      release_locks
      echo "Refusing: a runtime session holds $SESSION_LOCK (pid ${holder:-?}); not booting." >&2
      exit 10
    fi
  fi
  SESSION_LOCK_OURS=1
}

if [[ $AGENT_MODE == report ]]; then
  if [[ -s "$AGENT" ]]; then
    echo "OK: guest agent binary present ($AGENT)."
  fi
elif [[ -s "$AGENT" && $AGENT_MODE == build ]]; then
  echo "OK: guest agent binary present ($AGENT); --rebuild-agent to rebuild."
else
  take_locks
  BOOTED_HERE=0
  cleanup() {
    local rc=$?
    if [[ $BOOTED_HERE -eq 1 ]]; then "$GUEST_DIR/shutdown.sh" || true; fi
    # A failed (re)build must not cost the agent that worked before it.
    if [[ ! -s "$AGENT" && -s "$AGENT.prev" ]]; then
      mv -f "$AGENT.prev" "$AGENT"; echo "Restored the previous agent ($AGENT)." >&2
    fi
    release_locks
    return $rc
  }
  trap cleanup EXIT
  if guest_live; then
    echo "Reusing the running guest (pid $(cat "$PID_FILE")) to build the agent; it stays running."
  else
    echo "Booting the guest to build the agent (it is shut down again afterwards) ..."
    BOOTED_HERE=1      # set first: if boot.sh dies half-way, cleanup still shuts down
    "$GUEST_DIR/boot.sh"
  fi
  # SSH answering is not readiness: cloud-init is still installing the toolchain,
  # and a build that starts now races it (live-proof.sh learned this). A cloud-init
  # that finished with errors fails at once rather than after the full wait.
  SSH_OPTS=(-i "$KEY" -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
            -o BatchMode=yes -o ConnectTimeout=3 -o ServerAliveInterval=5 -o ServerAliveCountMax=2)
  WAIT_SECS="${MYCO_RT_CLOUDINIT_WAIT_SECS:-300}"
  INTERVAL="${MYCO_RT_WAIT_INTERVAL:-2}"
  deadline=$(( $(date +%s) + WAIT_SECS ))
  while :; do
    status="$(ssh "${SSH_OPTS[@]}" myco@localhost 'cloud-init status 2>/dev/null' 2>/dev/null || true)"
    case "$status" in
      *"status: done"*)  break ;;
      *"status: error"*) echo "FAIL: cloud-init finished with errors in the guest; serial log: $STATE/serial.log" >&2; exit 1 ;;
    esac
    if (( $(date +%s) >= deadline )); then
      echo "FAIL: guest not ready (cloud-init not done) after ${WAIT_SECS}s; serial log: $STATE/serial.log" >&2
      exit 1
    fi
    sleep "$INTERVAL"
  done
  # Move the old agent aside: a stale copy must not satisfy the success check below,
  # and cleanup restores it if the build fails.
  if [[ -s "$AGENT" ]]; then mv -f "$AGENT" "$AGENT.prev"; fi
  # Retry once: a first build on a fresh overlay has hit transient toolchain hiccups.
  if ! "$GUEST_DIR/build-agent-in-guest.sh"; then
    echo "agent build failed; retrying once" >&2
    "$GUEST_DIR/build-agent-in-guest.sh" || { echo "FAIL: agent build (after retry)" >&2; exit 1; }
  fi
  [[ -s "$AGENT" ]] || { echo "FAIL: build reported success but $AGENT is missing" >&2; exit 1; }
  rm -f "$AGENT.prev"
fi

echo
report
echo
if complete; then
  echo "Provisioned. Boot with: $GUEST_DIR/boot.sh"
  echo "SSH once up:            ssh -i $KEY -p 10022 myco@localhost"
elif [[ ! -s "$AGENT" ]] && [[ -f "$KEY" && -s "$PUB" && -f "$BASE" && -f "$OVERLAY" && -f "$SEED" ]]; then
  echo "NOT READY: no guest agent binary, so create will fail (\"no agent binary on the host\")."
  echo "Build it (boots a VM; needs the host VM lock and a free SESSION.lock):"
  echo "  $GUEST_DIR/provision.sh --build-agent"
  exit 3
else
  echo "NOT READY: assets are missing (MISS lines above); re-run this script." >&2
  exit 1
fi
