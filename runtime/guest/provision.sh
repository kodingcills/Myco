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
#   runtime/guest/provision.sh              # provision (downloads ~600 MB on first run)
#   runtime/guest/provision.sh --check      # report state, change nothing; exit 0 only if complete
#
# It does NOT boot. Booting is `boot.sh`; see docs/env/linux-runtime.md.
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
CHECK=0
case "${1:-}" in
  "")      ;;
  --check) CHECK=1 ;;
  *) echo "usage: $(basename "$0") [--check]   (no argument = provision)" >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo "usage: $(basename "$0") [--check]" >&2; exit 2; }

ok()   { printf '  ok    %s\n' "$1"; }
miss() { printf '  MISS  %s\n' "$1"; }

report() {
  echo "Guest assets in $GUEST_DIR:"
  [[ -f "$KEY"    ]] && ok "ssh private key ($KEY)"    || miss "ssh private key ($KEY)"
  [[ -f "$PUB"    ]] && ok "ssh public key"            || miss "ssh public key"
  [[ -f "$BASE"   ]] && ok "base image ($(du -h "$BASE" | cut -f1))" || miss "base image ($BASE)"
  [[ -f "$OVERLAY" ]] && ok "qcow2 overlay"            || miss "qcow2 overlay"
  [[ -f "$SEED"   ]] && ok "cloud-init seed"           || miss "cloud-init seed"
}

# --check exits 0 only when every asset is present, so a preflight can gate on it.
complete() { [[ -f "$KEY" && -f "$PUB" && -f "$BASE" && -f "$OVERLAY" && -f "$SEED" ]]; }

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

# 2. Keypair (user-data authorizes the public key, so it must exist before seeding).
#    Both key files are gitignored, so regenerating them never dirties git.
REKEYED=0
if [[ ! -f "$KEY" || ! -f "$PUB" ]]; then
  echo "Generating guest SSH keypair ..."
  rm -f "$KEY" "$PUB"
  ssh-keygen -t ed25519 -N '' -C myco-rt-guest -f "$KEY" -q
  REKEYED=1
fi

# A new key cannot reach an overlay where cloud-init already ran: the instance-id is
# fixed, so ssh_authorized_keys is not re-applied and SSH would be refused. So a
# re-key discards the (disposable) overlay, but never under a running guest.
OVERLAY_ARGS=()
if [[ $REKEYED -eq 1 && -f "$OVERLAY" ]]; then
  if [[ -f "$STATE/qemu.pid" ]] && kill -0 "$(cat "$STATE/qemu.pid")" 2>/dev/null; then
    echo "Refusing: new SSH key generated but a guest is running on the old overlay." >&2
    echo "Stop it (runtime/guest/shutdown.sh), then re-run this script." >&2
    exit 1
  fi
  echo "New key: recreating the overlay so cloud-init authorizes it."
  OVERLAY_ARGS=(--recreate)
fi

# 3. Base image (SHA-256 pinned in fetch-image.sh; ~600 MB first time).
echo "Fetching/verifying the pinned base image ..."
"$GUEST_DIR/fetch-image.sh"

# 4. Overlay over the pristine base (never writes the base).
"$GUEST_DIR/create-overlay.sh" ${OVERLAY_ARGS[@]+"${OVERLAY_ARGS[@]}"}

# 5. Cloud-init seed (regenerates so the current public key is authorized).
"$GUEST_DIR/make-seed.sh"

echo
report
echo
echo "Provisioned. Boot with: $GUEST_DIR/boot.sh"
echo "SSH once up:            ssh -i $KEY -p 10022 myco@localhost"
