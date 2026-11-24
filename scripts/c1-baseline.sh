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
#
# EVERY forwarding pass must carry the flag AND its value. `--accept-scored-cause`
# takes an argument, and a single-token loop would drop it silently - the sweep would
# then run with no acceptance, the arm would abort at the second scored row, and the
# command that produced it would look correct in the log. That is the same defect the
# round-1 review found in the runbook, one layer down, so it is handled explicitly
# here rather than folded into the pattern match.
EXTRA=()
shift_args=("$@")
i=0
while [ "$i" -lt "${#shift_args[@]}" ]; do
  arg="${shift_args[$i]}"
  case "$arg" in
    --coordinator-go) ;;
    --resume) EXTRA+=("--resume") ;;
    --adopt-identity) EXTRA+=("--adopt-identity") ;;
    --accept-scored-cause)
      value="${shift_args[$((i + 1))]:-}"
      if [ -z "$(printf '%s' "$value" | tr -d '[:space:]')" ] || [ "${value#--}" != "$value" ]; then
        echo "c1-baseline: --accept-scored-cause needs a verdict:reason value, e.g. refuted:step-budget" >&2
        exit 5
      fi
      EXTRA+=("--accept-scored-cause" "$value")
      i=$((i + 1)) ;;
    --accept-scored-cause=*)
      value="${arg#--accept-scored-cause=}"
      # Blank is refused, not forwarded: downstream would trim it away and the arm
      # would run with no acceptance, which is the silent failure this flag exists
      # to avoid. `$CAUSE` unset in an `--accept-scored-cause="$CAUSE"` call lands here.
      if [ -z "$(printf '%s' "$value" | tr -d '[:space:]')" ]; then
        echo "c1-baseline: --accept-scored-cause= needs a verdict:reason value, e.g. refuted:step-budget" >&2
        exit 5
      fi
      EXTRA+=("--accept-scored-cause" "$value") ;;
  esac
  i=$((i + 1))
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

# REFUSE rather than default. The sweep itself fails closed when this is unset
# (`parseSpendCeiling` requires both vars), so a launch that got this far has it - but
# the variable lives in the AMBIENT shell, not in the secrets file, so a resume shell
# that forgets to export it is a real operator path. Without this check the watcher
# would quietly fall back to a run-local figure and under-report the cap, which is the
# defect this change exists to remove.
# SET IS NOT ENOUGH - IT MUST BE A NUMBER, AND A SAFE ONE. Testing only for setness let
# `""`, `"   "` and `"abc"` through; all three convert to `0.000000`, which is exactly
# the run-local default this change deletes. A round-2 verifier measured them reaching
# the watcher.
#
# The rule is deliberately the SAME as `parseSpendCeiling` in scripts/spend-ceiling.ts:
# digits only, AND within `Number.MAX_SAFE_INTEGER`. A round-3 verifier caught an earlier
# version of this comment claiming the two agreed while checking only the character
# class - so `9007199254740992` and above were accepted here and thrown there. Claiming
# agreement without checking it is the same defect class as the one being fixed, so the
# bound is enforced below rather than asserted in a comment.
case "${MYCO_PRIOR_SPEND_MICROS:-}" in
  "")
    echo "c1-baseline: MYCO_PRIOR_SPEND_MICROS is unset or empty - the watchdog would report a run-local figure. Export it (0 only for a genuinely fresh project)." >&2
    exit 6 ;;
  *[!0-9]*)
    echo "c1-baseline: MYCO_PRIOR_SPEND_MICROS must be a whole number of micro-dollars (digits only); got '$MYCO_PRIOR_SPEND_MICROS'. Anything non-numeric would silently become 0 and the watchdog would under-report the cap." >&2
    exit 6 ;;
esac
# `Number.MAX_SAFE_INTEGER`, exact. Checked in python3 because an awk/double comparison
# rounds at this magnitude and would accept 9007199254740993 - the one value the bound
# exists to reject. The sweep refuses anything above it, so the launcher must too.
if ! python3 -c 'import sys; v = sys.argv[1]; sys.exit(0 if int(v) <= 2**53 - 1 else 1)' \
     "$MYCO_PRIOR_SPEND_MICROS" 2>/dev/null; then
  echo "c1-baseline: MYCO_PRIOR_SPEND_MICROS exceeds the largest safe integer (9007199254740991); the sweep would refuse it, so the launcher must not start a watcher on it." >&2
  exit 6
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
# Prior spend is passed so the watcher measures what the GUARD measures. It comes
# from the same MYCO_PRIOR_SPEND_MICROS the sweep reads, converted here rather than
# re-derived, so the two cannot disagree about what the project had already spent:
# both read the same string, and the guard below refuses anything that is not a whole
# number, so neither can silently convert a bad value to 0.
WATCH_PRIOR=$(awk -v m="$MYCO_PRIOR_SPEND_MICROS" 'BEGIN { printf "%.6f", m / 1000000 }')
bash "$WS/scripts/watch-c1-arm.sh" "$OUT" "$WATCH_LIMIT" "$WATCH_SILENT" "$WATCH_PRIOR" >>"$WATCH" 2>&1 9>&- &
WATCH_PID=$!
echo "$WATCH_PID" > "$OUT/watch.pid"
echo "watchdog pid $WATCH_PID -> $WATCH (ceiling \$$WATCH_LIMIT, prior \$$WATCH_PRIOR, silent ${WATCH_SILENT}m)" | tee -a "$PROGRESS"

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
