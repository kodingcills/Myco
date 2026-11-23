#!/bin/bash
# biome-ignore-all
# Watch a C1 arm: report committed spend, and flag a stalled or silent run.
#
# Committed spend counts ALL ledger entries - scored, omitted AND reserved - not
# just scored rows. An omitted trial still made real API calls before it died
# (arm-002 trial 9 holds $0.3768 that way), and a reserved row holds a live
# reservation, so a scored-only figure under-reports by the amount most likely
# to matter when a cap is being approached. This mirrors charged() in
# src/baseline/sweep.ts, which is what the fail-closed cap check actually uses.
#
# Exits 0 when the sweep ends, 9 on spend over the limit, 10 when the run has
# been silent longer than SILENT_MIN (a stalled guest looks exactly like a slow
# trial from the outside, so the Coordinator gets told rather than guessed at).
OUT=${1:-/tmp/baseline/c1-arm2}
LIMIT_USD=${2:-4.00}
SILENT_MIN=${3:-20}
last_size=0
last_change=$(date +%s)
while true; do
  if ! pgrep -f "c1-sweep.ts $OUT" > /dev/null 2>&1; then
    echo "[$(date -u +%H:%MZ)] SWEEP ENDED"
    exit 0
  fi
  if [ -f "$OUT/progress.log" ]; then
    size=$(wc -c < "$OUT/progress.log" | tr -d ' ')
    if [ "$size" != "$last_size" ]; then last_size=$size; last_change=$(date +%s); fi
  fi
  now=$(date +%s)
  silent_min=$(( (now - last_change) / 60 ))
  python3 - "$OUT" "$LIMIT_USD" "$silent_min" <<'PY'
import glob, json, sys
out, limit, silent = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
ledger = json.load(open(f"{out}/accounting.json"))["c1"]
committed = sum(e.get("micros", 0) for e in ledger.values()) / 1_000_000
scored = [e for e in ledger.values() if e.get("status") == "scored"]
from collections import Counter
reasons = Counter(r.get("verdictReason") for r in (e.get("row", {}) for e in scored) if r)
print(f"[watch] rows={len(scored)} committed=${committed:.4f}/${limit:.2f} silent={silent}m reasons={dict(reasons)}")
if committed > limit:
    print("[watch] TRIGGER committed spend over limit"); sys.exit(9)
if silent >= SILENT_MIN:
    print(f"[watch] TRIGGER silent {silent}m - tell the Coordinator"); sys.exit(10)
PY
  code=$?
  [ $code -ne 0 ] && exit $code
  sleep 300
done
