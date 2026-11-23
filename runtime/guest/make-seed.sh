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

# Never silently change the guest's identity (TIF-111 re-verifier):
# - private key present: sync the .pub to it (rebuild if missing, empty, or wrong).
# - private key missing with an existing overlay: refuse. cloud-init already ran in
#   that overlay with the old key and will not re-apply a new one, so a fresh key
#   would boot "OK" and then refuse SSH. provision.sh re-keys and recreates safely.
# - private key missing, no overlay: a fresh guest; generate a new keypair.
#   (boot.sh runs this BEFORE create-overlay.sh so a fresh checkout lands here.)
if [[ -f "$KEYS_DIR/id_ed25519" ]]; then
  sync_pub "$KEYS_DIR/id_ed25519" "$PUBKEY_FILE"
else
  if [[ -f "$GUEST_DIR/state/myco-runtime-v0.qcow2" ]]; then
    echo "Refusing: SSH private key missing but an overlay exists; a new key would not be" >&2
    echo "authorized in it. Run runtime/guest/provision.sh (re-keys and recreates the overlay)." >&2
    exit 1
  fi
  echo "Keypair missing in $KEYS_DIR; generating keypair." >&2
  rm -f "$PUBKEY_FILE"
  ssh-keygen -t ed25519 -N '' -C myco-rt-guest -f "$KEYS_DIR/id_ed25519" -q </dev/null
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
