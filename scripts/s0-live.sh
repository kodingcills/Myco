#!/usr/bin/env bash
# S0 live run (TIF-89) — detached launcher.
#
# Prepares the run so that, once the Coordinator hands over the window, S0 starts
# with no build step and survives the turn that launched it.
#
#   scripts/s0-live.sh --probe        # memory-pressure + gate report only, no VM
#   scripts/s0-live.sh --run          # probe, then run the S0 sequence (needs the window)
#   scripts/s0-live.sh --status       # what the pid file and log say
#   scripts/s0-live.sh --stop
#
# Everything long-running goes through nohup + a pid file + a watchdog that records
# the exit code. macOS has no setsid; `nohup ... &` is the portable equivalent and is
# what the C1 arm does.
set -euo pipefail

# `pwd -P`: on macOS /tmp is a symlink to /private/tmp, and a child launched with
# the /tmp spelling carries that spelling in argv, so a lexical $ROOT would miss it.
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
RUN_DIR="${S0_RUN_DIR:-/tmp/myco-s0}"
PID_FILE="$RUN_DIR/s0.pid"
CHILD_FILE="$RUN_DIR/s0.child"
LOG="$RUN_DIR/s0.log"
PROBE="$RUN_DIR/probe.txt"
RT_MCP="$ROOT/runtime/target/debug/myco-rt-mcp"
mkdir -p "$RUN_DIR"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

probe() {
  {
    echo "# S0 pre-run gate, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "swap:            $(sysctl -n vm.swapusage 2>/dev/null || echo unavailable)"
    echo "memory_pressure: $(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{print $2}' || echo unavailable)"
    echo "pages_free_kb:   $(vm_stat | awk '/Pages free/{gsub(/\./,"",$3); print $3*16}')"
    echo "load:            $(sysctl -n vm.loadavg)"
    echo "qemu:            $(qemu_running && echo RUNNING || echo down)"
    echo "rt_mcp:          $([[ -x "$RT_MCP" ]] && echo present || echo MISSING)"
    echo "coordinator_go:  ${MYCO_COORDINATOR_GO:-no}"
    echo "host_lock:       ${MYCO_HOST_LOCK:-no}"
    echo "vm_lock:         $(ls /tmp/myco-*.lock 2>/dev/null | tr '\n' ' ' || echo none)"
    echo "git_head:        $(git -C "$ROOT" rev-parse --short HEAD)"
  } | tee "$PROBE"
}

# A guest is identified by the basename of its argv[0], so an absolute path or an
# `exec -a` wrapper still counts. A failed `ps` is not evidence of an idle host:
# the gate must fail closed, so an unreadable table reports a guest.
qemu_running() {
  local table
  table="$(ps -Ao command)" || return 0
  [[ -n "$table" ]] || return 0
  awk '{n=split($1,a,"/"); if (a[n]=="qemu-system-aarch64") found=1} END{exit !found}' <<<"$table"
}

gate() {
  # Refuse to start a guest while another one is running. Memory pressure is
  # reported, not gated: TIF-123/#244 made the live check informational.
  # Identity comes from the process table's command column, not a regex over
  # argv: on 2026-11-23 `pgrep -f` matched a file path in an unrelated argv and
  # would have been self-defeating by refusing on its own text.
  if qemu_running; then
    say "REFUSED: a qemu guest is already running; the window is not ours"
    return 2
  fi
  # The gate the runtime and the human own: no boot, and no probe, without them.
  # Environment variables are a stopgap until the coordinator's lock backend is
  # named in the runbook; they are read here and nowhere else.
  if [[ "${MYCO_COORDINATOR_GO:-}" != "1" ]]; then
    say "REFUSED: no Coordinator GO (set MYCO_COORDINATOR_GO=1 only on an explicit GO)"
    return 2
  fi
  if [[ "${MYCO_HOST_LOCK:-}" != "1" ]]; then
    say "REFUSED: the shared host lock is not held by this run (MYCO_HOST_LOCK=1 when it is)"
    return 2
  fi
  # The runtime binary is the only transport; a missing one must refuse here so
  # the detached child never starts and never has to fail on it.
  if [[ ! -x "$RT_MCP" ]]; then
    say "REFUSED: $RT_MCP is missing; build it with cargo build -p myco-rt-mcp"
    return 2
  fi
  return 0
}

run_sequence() {
  say "starting S0 sequence (detached child)"
  (
    cd "$ROOT"
    exec pnpm exec tsx scripts/s0-live.ts --live
  ) >>"$LOG" 2>&1 &
  CHILD=$!
  echo "$CHILD" >"$CHILD_FILE"
  # `set -e` would abort the watchdog on a non-zero child, losing the exit code
  # and leaving the pid files behind — the one case the record exists for.
  local rc=0
  wait "$CHILD" || rc=$?
  say "child $CHILD exited with $rc"
  rm -f "$CHILD_FILE"
  return "$rc"
}

watchdog() {
  # The watchdog holds the pid file and reports the child's exit, so a run that
  # dies while no agent is watching still leaves a record.
  probe >>"$LOG" 2>&1
  gate || { say "gate refused; not starting"; rm -f "$PID_FILE"; exit 2; }
  local rc=0
  run_sequence || rc=$?
  say "watchdog done (rc $rc)"
  rm -f "$PID_FILE"
  exit "$rc"
}

case "${1:-}" in
  --probe) probe ;;
  --status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running: pid $(cat "$PID_FILE")"; else echo "not running"; fi
    echo "log:  $LOG"; pgrep -fl "scripts/s0-live.ts --live|target/debug/myco-rt-mcp" || echo "children: none"; tail -n 5 "$LOG" 2>/dev/null || true ;;
  --stop)
    # Stop the whole tree: the MCP server is a grandchild, and killing only the
    # watchdog leaves it holding the guest tools (seen 2026-11-23).
    STALE=0
    for FILE in "$PID_FILE" "$CHILD_FILE"; do
      if [[ -f "$FILE" ]]; then
        PID="$(cat "$FILE")"
        pkill -P "$PID" 2>/dev/null || true
        kill "$PID" 2>/dev/null || true
        STALE=1
      fi
      rm -f "$FILE"
    done
    # Scoped to this worktree: an unscoped pkill aborts another workstream's run
    # on a host with a dozen worktrees.
    pkill -f "$ROOT/.*scripts/s0-live.ts --live" 2>/dev/null || true
    pkill -f "$ROOT/runtime/target/debug/myco-rt-mcp" 2>/dev/null || true
    [[ "$STALE" == 1 ]] && echo stopped || echo "not running" ;;
  --run)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "already running: pid $(cat "$PID_FILE")"; exit 1
    fi
    say "launching detached; log $LOG"
    nohup "$0" --watchdog >>"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
    say "pid $(cat "$PID_FILE")"
    echo "watch with: $0 --status" ;;
  --watchdog) watchdog ;;
  *)
    echo "usage: $0 --probe | --run | --status | --stop" >&2; exit 2 ;;
esac
