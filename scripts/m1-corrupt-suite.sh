#!/bin/bash
# M1-014: cold reset -> deploy -> one corrupted trial -> append JSONL.
# Re-run with the same OUT_DIR to skip indices already recorded.
set -u
WS=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/tmp/m1-014/corrupted}
PARAM_ARGS=(scripts/m1-corrupt-suite-params.ts)
FINAL=--final
if [ "$#" -gt 1 ]; then
  if [ "$#" -ne 3 ] || [ "$2" != --groups ] || [ -z "$3" ]; then
    echo "Usage: $0 [OUT_DIR [--groups GROUP:COUNT[,GROUP:COUNT]]]" >&2
    exit 1
  fi
  FINAL=--final-supplement
fi
mkdir -p "$OUT/runs" || exit 1
OUT=$(cd "$OUT" && pwd) || exit 1
if [ "$FINAL" = --final-supplement ]; then
  PARAM_ARGS+=(--groups "$3" "${OUT##*/}")
fi
PARAMS="$OUT/params.json"
LOG="$OUT/trials.jsonl"
PROGRESS="$OUT/progress.log"
RECORDER=scripts/m1-corrupt-suite-record.py
cd "$WS" || exit 1
source "$WS/scripts/vm-lock.sh"
vm_lock_acquire m1-corrupt-suite.sh "$PROGRESS" || exit "$?"
trap vm_lock_release EXIT

# Refuse a mismatched run before doing any VM work, including on resume.
if [ -f "$LOG" ] && grep -q '"status": "seed-mismatch"' "$LOG"; then
  echo "REFUSED_SEED_MISMATCH_PRESENT $(date -u +%FT%TZ): start with a fresh OUT" | tee -a "$PROGRESS" >&2
  exit 9
fi
NEW_PARAMS=$(mktemp "$OUT/params.XXXXXX") || exit 1
PENDING=$(mktemp "$OUT/pending.XXXXXX") || { rm -f "$NEW_PARAMS"; exit 1; }
trap 'rm -f "$NEW_PARAMS" "$PENDING"; vm_lock_release' EXIT
pnpm exec tsx "${PARAM_ARGS[@]}" > "$NEW_PARAMS" || exit 1
if [ -s "$PARAMS" ]; then
  cmp -s "$PARAMS" "$NEW_PARAMS" || {
    echo "FATAL: suite parameters changed; start with a fresh OUT" | tee -a "$PROGRESS" >&2
    exit 1
  }
else
  mv "$NEW_PARAMS" "$PARAMS" || exit 1
fi
python3 "$RECORDER" --pending "$PARAMS" "$LOG" > "$PENDING" || exit "$?"

append_record() {
  local row
  row=$(python3 "$RECORDER" --record "$PARAMS" "$@") || exit 1
  printf '%s\n' "$row" >> "$LOG" || exit 1
  if [[ "$row" == *'"status": "seed-mismatch"'* ]]; then
    echo "ABORT_SEED_MISMATCH at trial $i $(date -u +%FT%TZ): $row" | tee -a "$PROGRESS" >&2
    exit 7
  fi
}

while IFS=$'\t' read -r i MODE FS RK CL NV RECOVERY <&3; do
  echo "=== trial $i ($MODE) $(date -u +%FT%TZ)" >> "$PROGRESS"

  # AC power is RECORDED, never enforced (Tiffany via outer loop, 2026-11-22):
  # charger state must not block a run, and a row that ran on battery is still
  # valid evidence. The value goes into the row so the JSONL shows it.
  AC_POWER=no; pmset -g batt | head -1 | grep -q "AC Power" && AC_POWER=yes
  echo "ac_power=$AC_POWER trial=$i" >> "$PROGRESS"
  LOAD1=$(sysctl -n vm.loadavg | awk '{print $2}')
  SWAP_FREE=$(sysctl -n vm.swapusage | sed -E 's/.*free = ([0-9.]+)M.*/\1/')
  if awk -v l="$LOAD1" 'BEGIN{exit !(l>14.0)}'; then
    echo "PAUSED_LOAD $LOAD1 at trial $i $(date -u +%FT%TZ)" >> "$PROGRESS"; exit 4
  fi
  if awk -v f="${SWAP_FREE:-9999}" 'BEGIN{exit !(f<300)}'; then
    echo "PAUSED_SWAP free=${SWAP_FREE}M at trial $i $(date -u +%FT%TZ)" >> "$PROGRESS"; exit 6
  fi

  bash scripts/reset-trial-vm.sh >> "$PROGRESS" 2>&1 || {
    append_record "$i" reset-failed; sleep 20; continue; }
  perl -e 'alarm 400; exec @ARGV' agent/bootstrap/deploy-to-vm.sh >> "$PROGRESS" 2>&1 || {
    append_record "$i" deploy-failed; continue; }
  TOK=$(~/VMs/myco-win11/scripts/vssh 'Get-Content C:\ProgramData\Myco\agent.token' 2>/dev/null | tr -d '\r\n')
  if [ ${#TOK} -lt 20 ]; then
    append_record "$i" token-failed
    continue
  fi

  # The Python recorder consumes the report even when the entrypoint exits
  # nonzero. The Node process receives the watchdog signal directly.
  ARGS=(--mode "$MODE" --audit-corruption)
  if [ "$RECOVERY" = True ]; then ARGS+=(--recovery); fi
  MYCO_AGENT_TOKEN="$TOK" perl -e 'alarm 1500; exec @ARGV' node --import tsx src/integration/run-live.ts \
    "${ARGS[@]}" --seed "$FS" --row-key "$RK" --column "$CL" --new-value "$NV" \
    --runs-dir "$OUT/runs/$i" > "$OUT/trial-$i.out" 2> "$OUT/trial-$i.err" 3<&-
  unset TOK
  append_record "$i" report "$OUT/trial-$i.out"
  sleep 20
done 3< "$PENDING"

if ! python3 "$RECORDER" "$FINAL" "$PARAMS" "$LOG" > "$OUT/summary.txt"; then
  cat "$OUT/summary.txt"
  echo "SUITE_FAILED $(date -u +%FT%TZ)" >> "$PROGRESS"
  exit 8
fi
cat "$OUT/summary.txt"
echo "SUITE_DONE $(date -u +%FT%TZ)" >> "$PROGRESS"
