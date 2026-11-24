#!/bin/bash
# biome-ignore-all
# Watch a C1 arm: report committed spend, and flag a stalled or silent run.
#
# Committed spend counts ALL ledger entries - scored, omitted AND reserved - not
# just scored rows. An omitted trial still made real API calls before it died
# (arm-002 trial 9 holds $0.3768 that way), and a reserved row holds a live
# reservation, so a scored-only figure under-reports by the amount most likely
# to matter when a cap is being approached.
#
# IT IS NOT THE WHOLE CEILING, AND REPORTING IT THAT WAY WAS A DEFECT (TIF-192).
# The fail-closed check in src/baseline/sweep.ts is
#
#     priorSpendMicros + charged(ledger.c1) + charged(ledger.c2) + reservation
#         > COMBINED_LIMIT
#
# so the ledger alone is only the run-local HALF of it. This script previously
# printed `committed=$2.2268/$9.00` with no prior spend, which reads as "the
# project has spent $2.23 of $9" when the project had actually committed $6.70.
# That understatement is the dangerous direction: the watcher's whole job is to
# warn before a cap is reached, and it was comparing a partial figure against a
# whole-Arm limit. Prior spend now arrives as a fourth argument, so the printed
# number and the trigger both mean what the guard means.
#
# Exits 0 when the sweep ends, 9 on spend over the limit, 10 when the run has
# been silent longer than SILENT_MIN (a stalled guest looks exactly like a slow
# trial from the outside, so the Coordinator gets told rather than guessed at).
OUT=${1:-/tmp/baseline/c1-arm2}
LIMIT_USD=${2:-4.00}
SILENT_MIN=${3:-20}
# Spend committed by EARLIER runs, in dollars.
#
# REQUIRED, not defaulted. It previously fell back to 0, which silently reverted the
# whole comparison to run-local - the exact understatement this file exists to remove
# - whenever the argument was missing. `${4?}` makes its absence a hard error instead,
# so a caller that forgets it gets a refusal rather than a reassuring number.
PRIOR_USD=${4?prior spend is a required argument: pass dollars committed by earlier runs, e.g. 4.480732}
# Seed both from the log's OWN mtime, not from "now" and not from an empty size.
#
# Starting last_change at script start made every existing log look freshly
# written on the first iteration (last_size=0 never equals a real size), so the
# clock reset. Measured effect: staleness that existed BEFORE the watcher
# started was ignored. A log already 25 minutes stale reported silent=0m on the
# first pass and did not alert within 75s even at SILENT_MIN=1, because the
# clock only began when the log next changed. Seeding from the file's mtime makes
# pre-existing staleness count immediately, which is the case a watchdog is for:
# you start it precisely because you think the run may already be stuck.
if [ -f "$OUT/progress.log" ]; then
  last_size=$(wc -c < "$OUT/progress.log" | tr -d ' ')
  # Portable mtime. BSD `stat -f %m`, GNU `stat -c %Y`.
  #
  # The subtlety that cost a CI cycle: on GNU stat, `-f %m` is not a clean
  # failure. It treats `%m` as a FILENAME, writes "cannot read file system
  # information for '%m'" plus a filesystem dump to STDOUT, and exits 1 - so
  # capturing the attempt and testing the value afterwards means the capture
  # holds multi-line garbage with the real epoch buried inside it. Probe the
  # FLAG first on a throwaway invocation and only capture from the form that
  # works on this platform.
  last_change=""
  if [ "$(uname -s)" = "Darwin" ]; then
    last_change=$(stat -f %m "$OUT/progress.log" 2>/dev/null)
  else
    last_change=$(stat -c %Y "$OUT/progress.log" 2>/dev/null)
  fi
  case "${last_change:-}" in
    "" | *[!0-9]*) last_change=$(date +%s) ;;
  esac
else
  last_size=0
  last_change=$(date +%s)
fi
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
  python3 - "$OUT" "$LIMIT_USD" "$silent_min" "$SILENT_MIN" "$PRIOR_USD" <<'PY'
import glob, json, sys
out, limit, silent = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
prior = float(sys.argv[5])
# The threshold arrives as argv[4], not as a shell name: this block is a quoted
# heredoc, so bash variables are NOT interpolated into it. Referencing SILENT_MIN
# directly here raised NameError on every iteration, which made the watcher exit
# non-zero immediately - it never reported a stall or a spend breach, i.e. it was
# broken in exactly the way it exists to prevent.
silent_limit = int(sys.argv[4])
ledger = json.load(open(f"{out}/accounting.json"))["c1"]
local = sum(e.get("micros", 0) for e in ledger.values()) / 1_000_000
# The number the CAP is measured against, which is prior + this run.
committed = prior + local
scored = [e for e in ledger.values() if e.get("status") == "scored"]
from collections import Counter
reasons = Counter(r.get("verdictReason") for r in (e.get("row", {}) for e in scored) if r)
# Both figures, because they answer different questions: `local` is what this run
# spent, `committed` is what the cap sees. Printing only one is what made the old
# line misleading.
print(
    f"[watch] rows={len(scored)} local=${local:.4f} prior=${prior:.4f} "
    f"committed=${committed:.4f}/${limit:.2f} silent={silent}m reasons={dict(reasons)}"
)
if committed > limit:
    print("[watch] TRIGGER committed spend over limit"); sys.exit(9)
if silent >= silent_limit:
    print(f"[watch] TRIGGER silent {silent}m - tell the Coordinator"); sys.exit(10)
PY
  code=$?
  [ $code -ne 0 ] && exit $code
  sleep 300
done
