#!/usr/bin/env bash
# sync-toolchain.sh — copy the committed toolchain into the host scripts dir.
#
# Why this exists (TIF-166 B1): the scripts that trial drivers actually execute
# live in $VM_ROOT/scripts, which is not the repo. Nothing synced them, so the
# committed toolchain could gain a fix while the host copy kept running the old
# one. On 2026-11-23 the host copy of vm.sh was 19 lines from Nov 18 with no
# lock block at all, so the whole TIF-137 lock feature was inert on the path
# reset-trial-vm.sh uses — while the repo looked correct.
#
# usage:
#   scripts/sync-toolchain.sh --dry-run     # show what would change
#   scripts/sync-toolchain.sh --go          # copy, backing up what it replaces
#
# Never deletes host-only files. A host copy may legitimately carry files the
# repo does not (wait-guest-ready.sh did), and removing them is not this
# script's call. It only adds and updates repo-owned files.
#
# BEFORE RUNNING --go AGAINST A REAL HOST: the synced vm.sh must already take
# the host VM lock and honour a parent-held one (TIF-164/TIF-166 B2, PR #304).
# Syncing an older vm.sh onto a driver path that expects the newer one can make
# things worse, not better. Check what you are about to push:
#
#     scripts/sync-toolchain.sh --dry-run
#     git -C <repo> log --oneline -1 -- docs/env/vm-toolchain/vm.sh
#
# This script cannot verify that for you: it copies what the working tree has.
set -euo pipefail

D=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$D/../docs/env/vm-toolchain" && pwd)
VM=${VM_ROOT:-$HOME/VMs/myco-win11}
DST=$VM/scripts

DRY=1
case "${1:-}" in
  --go) DRY=0 ;;
  --dry-run|"") DRY=1 ;;
  *) echo "usage: $0 [--dry-run|--go]" >&2; exit 2 ;;
esac
# Reject extra args rather than silently ignoring them: `--go --dry-run` would
# otherwise run in dry-run and not sync, the opposite of what was asked.
if [ $# -gt 1 ]; then
  echo "sync-toolchain: takes at most one argument, got $#: $*" >&2
  echo "usage: $0 [--dry-run|--go]" >&2
  exit 2
fi

[ -d "$SRC" ] || { echo "sync-toolchain: source not found: $SRC" >&2; exit 1; }
[ -d "$DST" ] || { echo "sync-toolchain: host scripts dir not found: $DST" >&2; echo "  (set VM_ROOT if the VM lives elsewhere)" >&2; exit 1; }

changed=0 same=0 added=0
STAMP=$(date +%Y%m%d-%H%M%S)

# Walk the committed toolchain, mirroring its directory shape into the host.
# `find` over regular files keeps this correct as the toolchain grows.
while IFS= read -r rel; do
  s=$SRC/$rel
  d=$DST/$rel
  if [ ! -e "$d" ]; then
    echo "ADD    $rel"
    added=$((added + 1))
    if [ "$DRY" = "0" ]; then mkdir -p "$(dirname "$d")"; cp -p "$s" "$d"; fi
  elif cmp -s "$s" "$d"; then
    same=$((same + 1))
  else
    echo "UPDATE $rel"
    changed=$((changed + 1))
    if [ "$DRY" = "0" ]; then
      # Keep the previous version rather than overwriting it unread: if a sync
      # breaks a live driver, the previous file is how you get back.
      cp -p "$d" "$d.bak-$STAMP"
      cp -p "$s" "$d"
    fi
  fi
done < <(cd "$SRC" && find . -type f ! -name 'README.md' | sed 's|^\./||' | sort)

echo
if [ "$DRY" = "1" ]; then
  echo "dry run: $added to add, $changed to update, $same already in sync"
  echo "re-run with --go to apply (each replaced file is backed up as <name>.bak-$STAMP)"
else
  echo "synced: $added added, $changed updated, $same unchanged"
  echo "backups (if any) carry the suffix .bak-$STAMP"
  echo
  echo "NOTE: a running driver holds the old files in memory; this affects the"
  echo "      NEXT launch. If a guest is up, its launcher is already loaded."
fi
