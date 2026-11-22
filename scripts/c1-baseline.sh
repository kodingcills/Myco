#!/bin/bash
# M1 C1 Screenshot Baseline Sweep Runner
# Wraps c1-sweep.ts under kernel VM lock and caffeinate.
set -euo pipefail

WS=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/tmp/baseline/c1}
PROGRESS="$OUT/progress.log"

cd "$WS"
mkdir -p "$OUT"

# Load Anthropic API key strictly from ~/.myco/secrets/anthropic.env without printing
SECRETS="$HOME/.myco/secrets/anthropic.env"
if [ -f "$SECRETS" ]; then
  set -a
  source "$SECRETS"
  set +a
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY required in $SECRETS for paid Sonnet planner" >&2
  exit 1
fi

source "$WS/scripts/vm-lock.sh"
echo "Acquiring VM lock for c1-baseline.sh..."
vm_lock_acquire c1-baseline.sh "$PROGRESS" || exit "$?"
trap vm_lock_release EXIT

echo "VM lock acquired. Starting C1 sweep at $(date -u +%FT%TZ)..." | tee -a "$PROGRESS"

# Run unattended under caffeinate
caffeinate -dimsu node --import tsx scripts/c1-sweep.ts "$OUT" 2>&1 | tee -a "$PROGRESS"

echo "C1 sweep finished at $(date -u +%FT%TZ)." | tee -a "$PROGRESS"
