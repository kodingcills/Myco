#!/usr/bin/env bash
# M1-016 slot 2 handoff: wait for the C1 arm to exit cleanly, then post the
# scorecard bundle for slot 4 and announce slot 2 is free.
#
#   m1-016-handoff.sh [ARM_DIR] [PID] [OUT_DIR]
#
# Runs detached (CONTRIBUTING-agents.md §C). It never touches the guest: it waits
# on a pid and then does host-side work only, so it cannot contaminate a trial.
#
# Why it waits on the pid rather than polling the ledger: the ledger keeps
# entries for a crashed run, so "the ledger looks done" and "the arm finished"
# are different facts. The pid is the only honest signal.
set -euo pipefail

ARM_DIR=${1:-/tmp/baseline/c1-arm2}
PID=${2:?usage: m1-016-handoff.sh ARM_DIR PID OUT_DIR}
OUT=${3:-/tmp/m1-016}
REPO=$(cd "$(dirname "$0")/.." && pwd)

mkdir -p "$OUT"
echo "$$" > "$OUT/handoff.pid"
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

log "watching pid $PID (arm dir $ARM_DIR)"
# Two independent signals, because a bare pid is not reliable: macOS reuses pids,
# and a pid that has been recycled reads as "still running" forever. The arm
# writes `C1 sweep finished` into progress.log as its last act, so completion is
# (marker present) OR (pid gone AND the ledger has stopped growing).
finished() {
  grep -q "sweep finished" "$ARM_DIR/progress.log" 2>/dev/null && return 0
  kill -0 "$PID" 2>/dev/null || return 0
  return 1
}
STALL_LIMIT=${STALL_LIMIT:-900}   # 15 min of no ledger growth = wedged
last_size=0
stalled=0
while ! finished; do
  sleep 20
  size=$(wc -c < "$ARM_DIR/accounting.json" 2>/dev/null || echo 0)
  if [ "$size" = "$last_size" ]; then
    stalled=$((stalled + 20))
    if [ "$stalled" -ge "$STALL_LIMIT" ]; then
      log "STALLED: ledger unchanged for ${stalled}s and no completion marker; not handing off"
      exit 2
    fi
  else
    stalled=0
    last_size=$size
  fi
done
log "arm finished (completion marker, or pid $PID gone); ledger stable"

if [ ! -f "$ARM_DIR/accounting.json" ]; then
  log "FAIL: no accounting.json in $ARM_DIR - the arm produced nothing"
  exit 1
fi

cd "$REPO"
python3 scripts/c1-scorecard-adapter.py "$ARM_DIR/accounting.json" \
  --manifest src/baseline/sweep-v3.json --out "$OUT/c1-trials.jsonl" \
  2>&1 | tee "$OUT/adapter.log"

python3 scripts/m1-scorecard.py "$OUT/c1-trials.jsonl"        > "$OUT/c1-scorecard.md"   2>&1
python3 scripts/m1-scorecard.py "$OUT/c1-trials.jsonl" --json > "$OUT/c1-scorecard.json" 2>&1
log "scorecard staged at $OUT/c1-scorecard.md"

# The denominator, stated before anyone reads the number.
python3 - "$OUT/c1-trials.jsonl" <<'PY' | tee "$OUT/denominator.txt"
import json, sys
from collections import Counter
recs = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(f"rows recorded: {len(recs)} of 30")
print("statuses:", dict(Counter(r["status"] for r in recs)))
print("false successes:", sum(1 for r in recs if r["falseSuccess"] is True))
print("rows with a driver diagnostic:", sum(1 for r in recs if r.get("driverDiagnostic")))
print("reasons:", dict(Counter(r["reason"] for r in recs)))
PY

log "slot 2 free: M1-016 may start (docs/coordination/m1-016-brief.md)"
log "slot 4 staged: $OUT/c1-scorecard.md"
