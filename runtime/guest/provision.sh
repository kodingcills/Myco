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
# happen IN the checkout that will run the guest, not in some shared cache. This
# script is idempotent and safe to run in any checkout:
#
#   runtime/guest/provision.sh                 # provision everything, incl. the agent
#   runtime/guest/provision.sh --check         # report state, change nothing; exit 0 only if complete
#   runtime/guest/provision.sh --no-agent      # assets only; never boots (no VM window)
#   runtime/guest/provision.sh --rebuild-agent # rebuild the agent even if a copy exists
#
# The guest agent (myco-rt-agent) must be built INSIDE the guest: it links
# libxkbcommon, so the musl cross-build from macOS fails. So when no host copy of
# the agent exists, this script boots the guest, waits for cloud-init, runs
# build-agent-in-guest.sh, and shuts the guest down again (TIF-120 / DF-008: the
# missing binary made every create fail with "no agent binary on the host").
# If a guest is already running it is reused and left running. That boot is the
# only VM action here; `--no-agent` skips it. See docs/env/linux-runtime.md.
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
USAGE="usage: $(basename "$0") [--check | --no-agent | --rebuild-agent]   (no argument = provision all)"
CHECK=0
AGENT_MODE=build      # build | skip | rebuild
case "${1:-}" in
  "")              ;;
  --check)         CHECK=1 ;;
  --no-agent)      AGENT_MODE=skip ;;
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
#    scripts never expressed: boot -> cloud-init done -> build -> shut down.
guest_live() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
if [[ $AGENT_MODE == skip ]]; then
  echo "Skipping the agent build (--no-agent). create needs it: run this script"
  echo "without --no-agent (it boots the guest), or runtime/guest/build-agent-in-guest.sh"
  echo "with a guest running."
elif [[ -s "$AGENT" && $AGENT_MODE != rebuild ]]; then
  echo "OK: guest agent binary present ($AGENT); --rebuild-agent to rebuild."
else
  BOOTED_HERE=0
  if guest_live; then
    echo "Reusing the running guest (pid $(cat "$PID_FILE")) to build the agent; it stays running."
  else
    echo "Booting the guest to build the agent (it is shut down again afterwards) ..."
    "$GUEST_DIR/boot.sh"
    BOOTED_HERE=1
    # Shut down even if a later step fails: never leave a guest this script started.
    trap '"$GUEST_DIR/shutdown.sh" || true' EXIT
  fi
  # SSH answering is not readiness: cloud-init is still installing the toolchain,
  # and a build that starts now races it (live-proof.sh learned this).
  SSH_OPTS=(-i "$KEY" -p 10022 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
            -o BatchMode=yes -o ConnectTimeout=3)
  WAIT_SECS="${MYCO_RT_CLOUDINIT_WAIT_SECS:-300}"
  INTERVAL="${MYCO_RT_WAIT_INTERVAL:-2}"
  deadline=$(( $(date +%s) + WAIT_SECS ))
  until ssh "${SSH_OPTS[@]}" myco@localhost 'cloud-init status 2>/dev/null | grep -q "status: done"' 2>/dev/null; do
    if (( $(date +%s) >= deadline )); then
      echo "FAIL: guest not ready (cloud-init not done) after ${WAIT_SECS}s; serial log: $STATE/serial.log" >&2
      exit 1
    fi
    sleep "$INTERVAL"
  done
  # Retry once: a first build on a fresh overlay has hit transient toolchain hiccups.
  rm -f "$AGENT"
  if ! "$GUEST_DIR/build-agent-in-guest.sh"; then
    echo "agent build failed; retrying once" >&2
    "$GUEST_DIR/build-agent-in-guest.sh" || { echo "FAIL: agent build (after retry)" >&2; exit 1; }
  fi
  [[ -s "$AGENT" ]] || { echo "FAIL: build reported success but $AGENT is missing" >&2; exit 1; }
  if [[ $BOOTED_HERE -eq 1 ]]; then
    trap - EXIT
    "$GUEST_DIR/shutdown.sh"
  fi
fi

echo
report
echo
if complete; then
  echo "Provisioned. Boot with: $GUEST_DIR/boot.sh"
else
  echo "Provisioned except the guest agent (see above); create will fail until it is built."
fi
echo "SSH once up:            ssh -i $KEY -p 10022 myco@localhost"
