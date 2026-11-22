#!/bin/bash
# M1-013 30-trial sweep: reset -> deploy -> one trial -> append JSONL.
#
#   scripts/m1-sweep.sh [OUT_DIR]          (default /tmp/m1-013/sweep)
#   nohup caffeinate -dimsu scripts/m1-sweep.sh OUT_DIR &   # unattended
#
# Re-running resumes: indices already in trials.jsonl are skipped, never re-run.
#
# Reset path: scripts/reset-trial-vm.sh, the guarded disk-only cold reset.
#
# Fixture seed (fixed 2026-11-21): each trial passes its set's fixtureSeed to
# run-live.ts as --seed. The pilot sweep did not, so all of its trials ran on
# the default sheet. To stop that recurring silently, every trial's report
# carries the SHA-256 of the fixture CSV it uploaded, and this script checks it:
#   - per trial: reported seed == requested seed AND hash == expected hash for
#     that seed (from m1-sweep-params.ts fingerprints). A mismatch is recorded
#     as status "seed-mismatch" and the sweep ABORTS (exit 7).
#   - at the end: no seed-mismatch row, and every sweep seed seen with exactly
#     one hash. Otherwise SEED_CHECK_FAILED and exit 8.
#   - on start: a trials.jsonl that already holds a seed-mismatch is refused
#     (exit 9); resume is only for gate pauses / operator stops.
#
# Host gates, checked before each trial (exit and resume later; never run
# through them): 1-min load > 14 (exit 4), swap free < 300 MB (exit 6). Power is
# NOT a gate - it is recorded in $PROGRESS as NOTE_ON_BATTERY and the trial runs
# (standing rule: no harness refuses to run on charger state). A healthy run
# sits at load 8-10 because QEMU is the load.
set -u
WS=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/tmp/m1-013/sweep}
PARAMS="$OUT/params.json"
FPRINTS="$OUT/fingerprints.json"
LOG="$OUT/trials.jsonl"
PROGRESS="$OUT/progress.log"
cd "$WS" || exit 1
mkdir -p "$OUT/runs" || exit 1
source "$WS/scripts/vm-lock.sh"
vm_lock_acquire m1-sweep.sh "$PROGRESS" || exit "$?"
trap vm_lock_release EXIT

# A recorded seed-mismatch means a trial ran on the wrong fixture. Resume-skip would
# keep that row and continue, so refuse: the directory is unusable for acceptance.
if [ -f "$LOG" ] && grep -q '"status": "seed-mismatch"' "$LOG"; then
  echo "REFUSED_SEED_MISMATCH_PRESENT $(date -u +%FT%TZ): $LOG contains a seed-mismatch; start a fresh OUT" >> "$PROGRESS"
  exit 9
fi

if [ ! -s "$PARAMS" ]; then
  pnpm exec tsx scripts/m1-sweep-params.ts params > "$PARAMS" || { echo "FATAL: params generation failed" >> "$PROGRESS"; exit 1; }
fi
if [ ! -s "$FPRINTS" ]; then
  pnpm exec tsx scripts/m1-sweep-params.ts fingerprints > "$FPRINTS" || { echo "FATAL: fingerprint generation failed" >> "$PROGRESS"; exit 1; }
fi
COUNT=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$PARAMS" 2>/dev/null)
[ "${COUNT:-0}" -eq 30 ] || { echo "FATAL: expected 30 parameter sets, got ${COUNT:-0}" >> "$PROGRESS"; exit 1; }

field() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[int(sys.argv[2])][sys.argv[3]])" "$PARAMS" "$1" "$2" 2>/dev/null; }

for i in $(seq 0 29); do
  if [ -f "$LOG" ] && grep -q "\"index\": *$i," "$LOG" 2>/dev/null; then
    continue
  fi
  echo "=== trial $i $(date -u +%FT%TZ)" >> "$PROGRESS"

  # Power is RECORDED, never enforced: a harness must not refuse to run because
  # of charger state (standing rule, CONTRIBUTING-agents.md). The trial proceeds
  # on battery; the line below leaves a trace in the progress log instead.
  pmset -g batt | head -1 | grep -q "AC Power" || \
    echo "NOTE_ON_BATTERY at trial $i $(date -u +%FT%TZ)" >> "$PROGRESS"
  LOAD1=$(sysctl -n vm.loadavg | awk '{print $2}')
  SWAP_FREE=$(sysctl -n vm.swapusage | sed -E 's/.*free = ([0-9.]+)M.*/\1/')
  if awk -v l="$LOAD1" 'BEGIN{exit !(l>14.0)}'; then
    echo "PAUSED_LOAD $LOAD1 at trial $i $(date -u +%FT%TZ)" >> "$PROGRESS"; exit 4
  fi
  if awk -v f="${SWAP_FREE:-9999}" 'BEGIN{exit !(f<300)}'; then
    echo "PAUSED_SWAP free=${SWAP_FREE}M at trial $i $(date -u +%FT%TZ)" >> "$PROGRESS"; exit 6
  fi

  FS=$(field "$i" fixtureSeed); RK=$(field "$i" rowKey); CL=$(field "$i" column); NV=$(field "$i" newValue)
  if [ -z "$FS" ] || [ -z "$RK" ] || [ -z "$CL" ] || [ -z "$NV" ]; then
    echo "{\"index\": $i, \"status\": \"param-error\"}" >> "$LOG"; continue
  fi

  bash scripts/reset-trial-vm.sh >> "$PROGRESS" 2>&1 || {
    echo "{\"index\": $i, \"status\": \"reset-failed\"}" >> "$LOG"; sleep 20; continue; }
  perl -e "alarm 400; exec @ARGV" agent/bootstrap/deploy-to-vm.sh >> "$PROGRESS" 2>&1 || {
    echo "{\"index\": $i, \"status\": \"deploy-failed\"}" >> "$LOG"; continue; }
  TOK=$(~/VMs/myco-win11/scripts/vssh 'Get-Content C:\ProgramData\Myco\agent.token' 2>/dev/null | tr -d '\r\n')
  [ ${#TOK} -lt 20 ] && { echo "{\"index\": $i, \"status\": \"token-failed\"}" >> "$LOG"; continue; }

  # Allow the sequential cold-start polls and agent RPCs to finish (see the
  # M1-014 cold-start note in docs/research/experiments).
  MYCO_AGENT_TOKEN="$TOK" perl -e "alarm 1500; exec @ARGV" node --import tsx src/integration/run-live.ts \
    --mode normal --seed "$FS" --row-key "$RK" --column "$CL" --new-value "$NV" \
    --runs-dir "$OUT/runs/$i" > "$OUT/trial.out" 2> "$OUT/trial.err"

  python3 scripts/m1-sweep-record.py "$i" "$FS" "$RK" "$CL" "$NV" "$OUT/trial.out" "$FPRINTS" >> "$LOG"
  if tail -1 "$LOG" | grep -q '"status": "seed-mismatch"'; then
    echo "ABORT_SEED_MISMATCH at trial $i $(date -u +%FT%TZ): $(tail -1 "$LOG")" >> "$PROGRESS"; exit 7
  fi
  sleep 20
done

if ! python3 scripts/m1-sweep-record.py --final "$LOG" "$FPRINTS" >> "$PROGRESS"; then
  echo "SEED_CHECK_FAILED $(date -u +%FT%TZ)" >> "$PROGRESS"; exit 8
fi
echo "SWEEP_DONE $(date -u +%FT%TZ)" >> "$PROGRESS"
