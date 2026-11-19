#!/usr/bin/env bash
# RT-003: create (or reuse) the qcow2 overlay over the pristine base image.
# The base image is never written to; all guest state lives in the overlay.
# Idempotent: reuses an existing overlay (prints a note) unless --recreate.
set -euo pipefail

GUEST_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE="$GUEST_DIR/state/noble-server-cloudimg-arm64.img"
OVERLAY="$GUEST_DIR/state/myco-runtime-v0.qcow2"
RECREATE=0
[[ "${1:-}" == "--recreate" ]] && RECREATE=1

"$GUEST_DIR/fetch-image.sh"

if [[ -f "$OVERLAY" && $RECREATE -eq 1 ]]; then
  echo "Removing existing overlay (--recreate)."
  rm -f "$OVERLAY"
fi

if [[ -f "$OVERLAY" ]]; then
  echo "OK: overlay already exists at $OVERLAY (pass --recreate to discard it)."
else
  qemu-img create -f qcow2 -F qcow2 -b "$BASE" "$OVERLAY" 20G
  echo "OK: created overlay $OVERLAY (20G virtual) over $BASE."
fi
