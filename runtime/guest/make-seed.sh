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

[[ -f "$KEYS_DIR/id_ed25519" && -f "$PUBKEY_FILE" ]] || {
  echo "Keypair missing in $KEYS_DIR; generating keypair." >&2
  rm -f "$KEYS_DIR/id_ed25519" "$PUBKEY_FILE"
  ssh-keygen -t ed25519 -N '' -C myco-rt-guest -f "$KEYS_DIR/id_ed25519" -q
}

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
