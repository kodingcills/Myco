#!/bin/bash
# Watch the C1 arm and report; exits when the sweep ends or a trigger fires.
# Kept as a script (not an inline loop) so a scheduler can run it unattended.
OUT=${1:-/tmp/baseline/c1-arm2}
LIMIT_USD=${2:-4.00}
while true; do
  if ! pgrep -f "c1-sweep.ts $OUT" > /dev/null 2>&1; then
    echo "[$(date -u +%H:%MZ)] SWEEP ENDED"; exit 0
  fi
  python3 - "$OUT" "$LIMIT_USD" <<'PY'
import glob, json, sys
out, limit = sys.argv[1], float(sys.argv[2])
rows = sorted(glob.glob(f"{out}/trials/c1/*.json"))
spend = 0.0
for f in rows:
    try: spend += json.load(open(f)).get("cost", 0) or 0
    except Exception: pass
print(f"[watch] rows={len(rows)} spend=${spend:.4f} limit=${limit:.2f}")
if spend > limit:
    print(f"[watch] TRIGGER spend>limit"); sys.exit(9)
PY
  [ $? -eq 9 ] && exit 9
  sleep 300
done
