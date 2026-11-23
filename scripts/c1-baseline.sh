#!/bin/bash
# M1 C1 Screenshot Baseline Sweep Runner
# Wraps c1-sweep.ts under kernel VM lock and caffeinate.
set -euo pipefail

WS=$(cd "$(dirname "$0")/.." && pwd)
# NEVER default a run under /tmp. arm-003c's ledgers and rows lived there, and the
# 2026-11-23 reboot wiped them mid-investigation - the spend is still only known
# because someone had quoted it before the loss, and the two rows it produced are
# gone entirely. A sweep's whole point is the evidence it leaves behind.
#
# The default now lands beside the other run artefacts, outside the OS's temp
# reaper. Callers may still pass an explicit directory; if they pass one under
# /tmp this refuses rather than silently accepting it, because a run that expects
# its ledger to outlive the session must not be able to point it at /tmp by
# accident either.
OUT=${1:-$HOME/Projects/myco-runs/c1}
case "$OUT" in
  /tmp/*|/var/tmp/*)
    echo "c1-baseline: refusing to run under '$OUT' - /tmp is wiped by reboot and took arm-003c's ledger with it (TIF-164). Use a durable path, e.g. \$HOME/Projects/myco-runs/c1" >&2
    exit 2
    ;;
esac
PROGRESS="$OUT/progress.log"
if [ "${2:-}" != "--coordinator-go" ]; then
  echo "Coordinator GO required" >&2
  exit 1
fi

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
caffeinate -dimsu node --import tsx scripts/c1-sweep.ts "$OUT" --coordinator-go 2>&1 | tee -a "$PROGRESS"

echo "C1 sweep finished at $(date -u +%FT%TZ)." | tee -a "$PROGRESS"
