#!/usr/bin/env bash
# RT-003: build the cloud-init NoCloud seed ISO from seed/ + keys/.
# Idempotent: re-runs just regenerate the ISO with the current public key.
set -euo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
SEED_DIR="$GUEST_DIR/seed"
KEYS_DIR="$GUEST_DIR/keys"
SEED_ISO="$GUEST_DIR/state/seed.iso"
PUBKEY_FILE="$KEYS_DIR/id_ed25519.pub"

command -v cloud-localds >/dev/null && MAKER="cloud-localds" || MAKER=""
if [[ -z "$MAKER" ]]; then
  command -v mkisofs >/dev/null || {
    echo "Need cloud-localds (brew install cloud-utils) or mkisofs (brew install cdrtools)." >&2
    exit 1
  }
  MAKER="mkisofs"
fi

# Never silently change the guest's identity (TIF-111 re-verifier):
# - private key present, .pub missing: rebuild the .pub from it (same identity).
# - private key missing with an existing overlay: refuse. cloud-init already ran in
#   that overlay with the old key and will not re-apply a new one, so a fresh key
#   would boot "OK" and then refuse SSH. provision.sh re-keys and recreates safely.
# - private key missing, no overlay: a fresh guest; generate a new keypair.
if [[ -f "$KEYS_DIR/id_ed25519" && ! -f "$PUBKEY_FILE" ]]; then
  echo "Public key missing; rebuilding it from the existing private key." >&2
  ssh-keygen -y -f "$KEYS_DIR/id_ed25519" > "$PUBKEY_FILE"
elif [[ ! -f "$KEYS_DIR/id_ed25519" ]]; then
  if [[ -f "$GUEST_DIR/state/myco-runtime-v0.qcow2" ]]; then
    echo "Refusing: SSH private key missing but an overlay exists; a new key would not be" >&2
    echo "authorized in it. Run runtime/guest/provision.sh (re-keys and recreates the overlay)." >&2
    exit 1
  fi
  echo "Keypair missing in $KEYS_DIR; generating keypair." >&2
  rm -f "$PUBKEY_FILE"
  ssh-keygen -t ed25519 -N '' -C myco-rt-guest -f "$KEYS_DIR/id_ed25519" -q
fi

mkdir -p "$GUEST_DIR/state"
# Render user-data with the actual public key in place.
TMP_SEED="$(mktemp -d)"
trap 'rm -rf "$TMP_SEED"' EXIT
sed "s|__MYCO_PUBKEY__|$(cat "$PUBKEY_FILE")|" "$SEED_DIR/user-data" > "$TMP_SEED/user-data"
cp "$SEED_DIR/meta-data" "$TMP_SEED/meta-data"

rm -f "$SEED_ISO"
if [[ "$MAKER" == "cloud-localds" ]]; then
  cloud-localds "$SEED_ISO" "$TMP_SEED/user-data" "$TMP_SEED/meta-data"
else
  # NoCloud: cloud-init finds the seed by volume label "cidata".
  mkisofs -output "$SEED_ISO" -volid cidata -joliet -rational-rock \
    "$TMP_SEED/user-data" "$TMP_SEED/meta-data" >/dev/null
fi
echo "OK: wrote $SEED_ISO from $SEED_DIR (user-data, meta-data) via $MAKER."
