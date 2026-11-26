#!/usr/bin/env bash
# reset-bench.sh: time trial resets, and optionally reset -> deploy -> session_info
# cycles, and record one JSON line per run (TIF-98).
#
# usage: reset-bench.sh <reset|cycle> <count> <out.jsonl> [label]
#
#   reset  N runs of scripts/reset-trial-vm.sh (MYCO_BENCH_SNAPSHOT, default
#          clean-base), each followed by a
#          readiness re-check of the guest over ssh.
#   cycle  N runs of reset -> agent/bootstrap/deploy-to-vm.sh -> session_info.
#          Needs MYCO_TOKEN_OUT (a private token path, runbook §4).
#
# This driver never takes or holds the VM lock. reset-trial-vm.sh takes and
# releases it itself; agent/bootstrap/deploy-to-vm.sh does not take it (runbook
# lock table), so the read-only check right before the deploy is what keeps it
# off a VM someone else owns. Before each step it checks, read-only, that nobody owns
# the lock (`lsof`, runbook §2.0) and that the host's NET load is under the guest
# load gate (10): the 1-minute load minus the guest's own QEMU cores
# (scripts/load-gate.sh, TIF-218). On a busy lock it stops. On net load >= 10 it
# waits until it has stayed under 10 for 3 minutes (7 samples, 30 s apart), then
# resumes. The JSON line still records the raw 1-minute load.
#
# The JSON line holds the label, run number, start time, commit, timings, exit
# codes, load, host swap / free memory / page-ins, QEMU resident size, the phase
# breakdown the reset prints (`reset-trial-vm: timing stop=.. restore=.. ...`)
# and, for cycles, session_info's JSON line. No host paths, no tokens. Raw step logs go to <out.jsonl>.logs/ for the operator; they are
# not part of the evidence pack.
set -uo pipefail

MODE=${1:?usage: reset-bench.sh <reset|cycle> <count> <out.jsonl> [label]}
COUNT=${2:?count}
OUT=${3:?out.jsonl}
LABEL=${4:-$MODE}
REPO=$(cd "$(dirname "$0")/.." && pwd)
LOCK=${MYCO_VM_LOCK_PATH:-/tmp/myco-win11.vm.lock}
LOAD_LIMIT=${MYCO_LOAD_LIMIT:-10}
VSSH=${MYCO_VSSH:-$HOME/VMs/myco-win11/scripts/vssh}
LOGS="$OUT.logs"
SNAPSHOT=${MYCO_BENCH_SNAPSHOT:-clean-base}
mkdir -p "$LOGS"

case "$MODE" in reset|cycle) ;; *) echo "reset-bench: unknown mode '$MODE'" >&2; exit 2 ;; esac
if [ "$MODE" = cycle ] && [ -z "${MYCO_TOKEN_OUT:-}" ]; then
  echo "reset-bench: cycle mode needs MYCO_TOKEN_OUT (a private token path, runbook §4)" >&2
  exit 2
fi

# Host memory pressure is the measured driver of slow guest boots (TIF-98:
# QEMU resident far below the guest's RAM while host swap is nearly full), so
# each row records swap in use at the start and the host's pageins over the
# reset. Both are host-wide counters, not per-process.
swap_used_mb() { sysctl -n vm.swapusage 2>/dev/null | sed -E 's/.*used = ([0-9.]+)M.*/\1/'; }
mem_free_pct() { memory_pressure 2>/dev/null | sed -nE 's/^System-wide memory free percentage: ([0-9]+)%.*/\1/p'; }
# QEMU's resident size in MB: far below the guest's RAM means the guest's
# memory is swapped or compressed on the host. Largest QEMULauncher process.
qemu_rss_mb() { ps -Ao rss=,comm= 2>/dev/null | awk '/QEMULauncher/ { if ($1 > m) m = $1 } END { if (m) print int(m / 1024) }'; }
pageins() { vm_stat 2>/dev/null | awk '/^Pageins:/ { gsub(/\./, "", $2); print $2 }'; }

source "$REPO/scripts/load-gate.sh"
load1() { lg_load1; }
# Net load for the gate; an unreadable load reads as 999 (over the line: fail closed).
net_load() { local l; l=$(lg_load1); lg_is_num "$l" || { echo 999; return; }; lg_net "$l" "$(lg_qemu_cores)"; }
over() { awk -v l="$1" -v m="$LOAD_LIMIT" 'BEGIN { exit !(l >= m) }'; }

lock_free() {
  if lsof "$LOCK" >/dev/null 2>&1; then
    echo "reset-bench: VM lock is held (lsof shows an owner); stopping" >&2
    return 1
  fi
}

# The guest load gate: never start a step at net load >= LOAD_LIMIT; after a high
# reading, resume only once 7 consecutive 30 s samples (3 min) are under it.
load_gate() {
  local l ok
  l=$(net_load)
  over "$l" || return 0
  echo "reset-bench: net load $l >= $LOAD_LIMIT; holding" >&2
  ok=0
  while [ "$ok" -lt 7 ]; do
    sleep 30
    l=$(net_load)
    if over "$l"; then ok=0; else ok=$(( ok + 1 )); fi
  done
  echo "reset-bench: net load under $LOAD_LIMIT for 3 min (now $l); resuming" >&2
}

gate() { lock_free && load_gate; }

# Run one step, timing it; leaves its exit code in STEP_RC and its seconds in STEP_S.
step() {
  local name=$1 log=$2 t
  shift 2
  t=$(date +%s)
  "$@" >"$log" 2>&1
  STEP_RC=$?
  STEP_S=$(( $(date +%s) - t ))
  echo "reset-bench: $name rc=$STEP_RC ${STEP_S}s" >&2
}

for i in $(seq 1 "$COUNT"); do
  gate || exit 3
  L0=$(load1)
  SW0=$(swap_used_mb)
  PI0=$(pageins)
  MF0=$(mem_free_pct)
  STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  step reset "$LOGS/$i-reset.log" bash "$REPO/scripts/reset-trial-vm.sh" "$SNAPSHOT"
  R_RC=$STEP_RC R_S=$STEP_S
  PI1=$(pageins)
  SW1=$(swap_used_mb)
  QRSS=$(qemu_rss_mb)
  TIMING=$(grep -m1 '^reset-trial-vm: timing' "$LOGS/$i-reset.log" | sed 's/^reset-trial-vm: timing //' || true)
  FIRST=$(grep -m1 'first ssh answer after' "$LOGS/$i-reset.log" | sed -E 's/.*after ([0-9]+)s.*/\1/' || true)
  D_RC=null D_S=null S_RC=null S_S=null C_RC=null
  if [ "$R_RC" = 0 ]; then
    # Readiness re-check right after the reset: one ssh round trip that must answer.
    gate || exit 3
    step check "$LOGS/$i-check.log" "$VSSH" -o BatchMode=yes 'echo ok'
    if [ "$STEP_RC" = 0 ] && tr -d '\r' <"$LOGS/$i-check.log" | grep -qx ok; then C_RC=0; else C_RC=1; fi
    if [ "$MODE" = cycle ]; then
      gate || exit 3
      step deploy "$LOGS/$i-deploy.log" bash "$REPO/agent/bootstrap/deploy-to-vm.sh"
      D_RC=$STEP_RC D_S=$STEP_S
      if [ "$D_RC" = 0 ]; then
        gate || exit 3
        step session_info "$LOGS/$i-session.log" \
          pnpm --silent --dir "$REPO" exec tsx src/integration/session-info.ts --token-file "$MYCO_TOKEN_OUT"
        S_RC=$STEP_RC S_S=$STEP_S
      fi
    fi
  fi
  # session_info's documented stdout JSON line, stored whole: the desktop proof
  # fields plus the guest account name (`user`). No token is in that line.
  SESSION=null
  if [ "$S_RC" = 0 ]; then
    SESSION=$(grep -m1 '^{"session_id"' "$LOGS/$i-session.log" || echo null)
  fi
  # Values pass through the environment, never interpolated into the program.
  B_SNAP=$SNAPSHOT B_LABEL=$LABEL B_MODE=$MODE B_RUN=$i B_STARTED=$STARTED B_L0=$L0 B_TIMING=$TIMING \
  B_FIRST=$FIRST B_R_RC=$R_RC B_R_S=$R_S B_C_RC=$C_RC B_D_RC=$D_RC B_D_S=$D_S \
  B_SW0=$SW0 B_SW1=$SW1 B_MF0=$MF0 B_QRSS=$QRSS B_PI0=$PI0 B_PI1=$PI1 B_S_RC=$S_RC B_S_S=$S_S B_SESSION=$SESSION B_HEAD=$(git -C "$REPO" rev-parse --short HEAD) python3 - "$OUT" <<'PY'
import json, os, sys
e = os.environ
num = lambda k: None if e[k] in ("", "null") else int(e[k])
timing = {}
for kv in e["B_TIMING"].split():
    k, _, v = kv.partition("=")
    timing[k] = int(v)
row = {
    "label": e["B_LABEL"], "mode": e["B_MODE"], "run": int(e["B_RUN"]), "commit": e["B_HEAD"], "snapshot": e["B_SNAP"],
    "started_utc": e["B_STARTED"], "load1_at_start": float(e["B_L0"]),
    "reset_rc": num("B_R_RC"), "reset_s": num("B_R_S"), "phases_s": timing,
    "first_ssh_answer_s": num("B_FIRST"),
    "host_swap_used_mb_at_start": round(float(e["B_SW0"])) if e["B_SW0"] else None,
    "host_swap_used_mb_after_reset": round(float(e["B_SW1"])) if e["B_SW1"] else None,
    "host_mem_free_pct_at_start": num("B_MF0"),
    "qemu_rss_mb_after_reset": num("B_QRSS"),
    "host_pageins_during_reset": (int(e["B_PI1"]) - int(e["B_PI0"])) if e["B_PI0"] and e["B_PI1"] else None,
    "ready_check_rc": num("B_C_RC"),
    "deploy_rc": num("B_D_RC"), "deploy_s": num("B_D_S"),
    "session_info_rc": num("B_S_RC"), "session_info_s": num("B_S_S"),
    "session_info": json.loads(e["B_SESSION"]),
}
with open(sys.argv[1], "a") as f:
    f.write(json.dumps(row, sort_keys=True) + "\n")
PY
  [ "$R_RC" = 0 ] || { echo "reset-bench: reset $i failed (rc $R_RC); stopping" >&2; exit 1; }
done
