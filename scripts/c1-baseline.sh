#!/bin/bash
# M1 C1 Screenshot Baseline Sweep Runner
# Wraps c1-sweep.ts under kernel VM lock and caffeinate, with a watchdog.
#
# Usage: c1-baseline.sh <outDir> --coordinator-go [--resume]
#
# `--resume` continues the ledger already in <outDir>: finished trials are
# skipped, an interrupted or in-progress trial is re-attempted, and the run
# refuses to continue if the manifest, model or snapshot differs from the one
# recorded in that ledger. Spend is still measured against the project ceiling,
# so a resume cannot buy back the allowance the first attempt already used.
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
shift || true
PROGRESS="$OUT/progress.log"
if ! printf '%s\n' "$@" | grep -qx -- '--coordinator-go'; then
  echo "Coordinator GO required" >&2
  exit 1
fi

# `--resume` is forwarded, never inferred: a relaunch into an existing directory
# without it is a FRESH run that happens to reuse the ledger's files, and the two
# must be distinguishable afterwards.
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --resume) EXTRA+=("--resume") ;;
    --adopt-identity) EXTRA+=("--adopt-identity") ;;
    --coordinator-go) ;;
  esac
done

cd "$WS"
mkdir -p "$OUT"
# Adoption only means anything alongside a resume.
case " ${EXTRA[*]:-} " in
  *" --adopt-identity "*)
    case " ${EXTRA[*]:-} " in
      *" --resume "*) ;;
      *) echo "c1-baseline: --adopt-identity requires --resume" >&2; exit 4 ;;
    esac ;;
esac
if [ ${#EXTRA[@]} -gt 0 ] && [ ! -f "$OUT/accounting.json" ]; then
  echo "c1-baseline: --resume given but $OUT/accounting.json does not exist; nothing to resume" >&2
  exit 3
fi

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

if [ ${#EXTRA[@]} -gt 0 ]; then VERB=Resuming; else VERB=Starting; fi
echo "VM lock acquired. $VERB C1 sweep at $(date -u +%FT%TZ)..." | tee -a "$PROGRESS"

# The watchdog, written to the run directory so a later reader can tell whether
# ANYTHING was watching.
#
# r6 ran for 1h45m with no watchdog and no pid file. When its guest died mid-trial
# the sweep hung on SSH and nothing said so: the operator found out by reading the
# log by hand, an hour later. A watchdog turns "is it stuck?" from an investigation
# into a file.
#
# Its pid and log live beside the ledger, not in /tmp, for the same reason the
# ledger does. The limit and silence window come from the environment so a resumed
# arm can set them without editing this script.
WATCH="$OUT/watch.log"
WATCH_LIMIT="${MYCO_WATCH_LIMIT_USD:-9.00}"
WATCH_SILENT="${MYCO_WATCH_SILENT_MIN:-20}"
# `9>&-` is load-bearing: the watchdog must NOT inherit FD 9, the VM lock.
#
# A background child inherits every open descriptor, so a watcher started from
# inside the locked shell held the flock too - and killing its wrapper left the
# watcher's `sleep` orphaned with FD 9 still open, which kept the lock held after
# the sweep had exited. Measured: a leaked `sleep 300` owned
# /tmp/myco-win11.vm.lock after a probe run finished, blocking the next arm.
# The watchdog does not need the VM, so it is given no descriptor to hold.
bash "$WS/scripts/watch-c1-arm.sh" "$OUT" "$WATCH_LIMIT" "$WATCH_SILENT" >>"$WATCH" 2>&1 9>&- &
WATCH_PID=$!
echo "$WATCH_PID" > "$OUT/watch.pid"
echo "watchdog pid $WATCH_PID -> $WATCH (limit \$$WATCH_LIMIT, silent ${WATCH_SILENT}m)" | tee -a "$PROGRESS"

# The sweep writes its own pid so a later reader does not have to guess which
# process belonged to this directory.
caffeinate -dimsu node --import tsx scripts/c1-sweep.ts "$OUT" --coordinator-go ${EXTRA[@]+"${EXTRA[@]}"} 2>&1 | tee -a "$PROGRESS" &
SWEEP_PIPE=$!
# The pipeline's pid is `tee`-adjacent; record the c1-sweep child by name, which is
# the process that actually holds the ledger and the VM.
sleep 2
SWEEP_PID=$(pgrep -f "c1-sweep.ts $OUT" | head -1 || true)
[ -n "${SWEEP_PID:-}" ] && echo "$SWEEP_PID" > "$OUT/run.pid" && \
  echo "sweep pid $SWEEP_PID -> $OUT/run.pid" | tee -a "$PROGRESS"

wait "$SWEEP_PIPE" || true

# The sweep is done, so the watchdog has nothing left to watch. Killing it here
# rather than leaving it is deliberate: a stale watcher on a finished run would
# keep reporting SILENT and look like a problem.
kill "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true
rm -f "$OUT/watch.pid" "$OUT/run.pid"

echo "C1 sweep finished at $(date -u +%FT%TZ)." | tee -a "$PROGRESS"
