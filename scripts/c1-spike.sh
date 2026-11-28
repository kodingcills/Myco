#!/bin/bash
# M1 C1 Screenshot Baseline Spike Runner (Single-Trial Phase 1a)
# Wraps c1-spike.ts under kernel VM lock and caffeinate.
set -euo pipefail

WS=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/tmp/baseline/c1-spike}
PROGRESS="$OUT/progress.log"

cd "$WS"
mkdir -p "$OUT"

# Anthropic API key: pass the secrets file PATH, never the key itself (TIF-206).
# This used to `set -a; source` the file, which exported the key into the environment of
# caffeinate, node, tee and every child, so `ps eww` on the sweep printed it (TIF-193).
# The planner now reads the file at the point of use (src/baseline/secret-file.ts).
# An ambient ANTHROPIC_API_KEY is still honoured for back-compat.
SECRETS="$HOME/.myco/secrets/anthropic.env"
if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! { [ -f "$SECRETS" ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=.+' "$SECRETS"; }; then
  echo "ERROR: ANTHROPIC_API_KEY required in $SECRETS for paid Sonnet planner" >&2
  exit 1
fi
export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"

source "$WS/scripts/vm-lock.sh"
echo "Acquiring VM lock for c1-spike.sh..."
vm_lock_acquire c1-spike.sh "$PROGRESS" || exit "$?"
trap vm_lock_release EXIT

echo "VM lock acquired. Starting C1 spike at $(date -u +%FT%TZ)..." | tee -a "$PROGRESS"

# Run under caffeinate
caffeinate -dimsu node --import tsx scripts/c1-spike.ts "$OUT" 2>&1 | tee -a "$PROGRESS"

echo "C1 spike finished at $(date -u +%FT%TZ)." | tee -a "$PROGRESS"
