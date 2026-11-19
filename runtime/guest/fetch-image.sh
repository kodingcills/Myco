#!/usr/bin/env bash
# RT-003: download + verify the pinned Ubuntu 24.04 LTS ARM64 cloud image.
# Idempotent: skips download when the image exists and matches the pinned SHA-256.
set -euo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-arm64.img"
IMAGE_NAME="noble-server-cloudimg-arm64.img"
# Pinned 2026-11-19 from https://cloud-images.ubuntu.com/noble/current/SHA256SUMS
IMAGE_SHA256="50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e"
IMAGE_DIR="$GUEST_DIR/state"
IMAGE="$IMAGE_DIR/$IMAGE_NAME"
SHA_FILE="$IMAGE_DIR/base-image.sha256"

mkdir -p "$IMAGE_DIR"

verify() {
  local actual
  actual="$(shasum -a 256 "$IMAGE" | cut -d' ' -f1)"
  if [[ "$actual" != "$IMAGE_SHA256" ]]; then
    echo "SHA-256 mismatch for $IMAGE" >&2
    echo "  expected $IMAGE_SHA256" >&2
    echo "  actual   $actual" >&2
    return 1
  fi
}

if [[ -f "$IMAGE" ]]; then
  if verify; then
    echo "OK: $IMAGE already present and SHA-256 verified (skipping download)."
    echo "$IMAGE_SHA256" > "$SHA_FILE"
    exit 0
  fi
  echo "Existing image failed verification; re-downloading." >&2
  rm -f "$IMAGE"
fi

echo "Downloading $IMAGE_URL ..."
curl -fL --retry 3 -o "$IMAGE" "$IMAGE_URL"
verify
echo "$IMAGE_SHA256" > "$SHA_FILE"
echo "OK: downloaded and verified $IMAGE ($IMAGE_SHA256)."
