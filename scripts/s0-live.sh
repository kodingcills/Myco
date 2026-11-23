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

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="${S0_RUN_DIR:-/tmp/myco-s0}"
PID_FILE="$RUN_DIR/s0.pid"
LOG="$RUN_DIR/s0.log"
PROBE="$RUN_DIR/probe.txt"
mkdir -p "$RUN_DIR"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

probe() {
  {
    echo "# S0 pre-run gate, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "swap:            $(sysctl -n vm.swapusage 2>/dev/null || echo unavailable)"
    echo "memory_pressure: $(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{print $2}' || echo unavailable)"
    echo "pages_free_kb:   $(vm_stat | awk '/Pages free/{gsub(/\./,"",$3); print $3*16}')"
    echo "load:            $(sysctl -n vm.loadavg)"
    echo "qemu:            $(pgrep -f qemu-system-aarch64 >/dev/null && echo RUNNING || echo down)"
    echo "vm_lock:         $(ls /tmp/myco-*.lock 2>/dev/null | tr '\n' ' ' || echo none)"
    echo "git_head:        $(git -C "$ROOT" rev-parse --short HEAD)"
  } | tee "$PROBE"
}

gate() {
  # Refuse to start a guest while another one is running. Memory pressure is
  # reported, not gated: TIF-123/#244 made the live check informational.
  if pgrep -f qemu-system-aarch64 >/dev/null; then
    say "REFUSED: a qemu guest is already running; the window is not ours"
    return 2
  fi
  return 0
}

run_sequence() {
  say "starting S0 sequence (detached child)"
  (
    cd "$ROOT"
    exec pnpm exec tsx scripts/s0-live.ts --live
  ) >>"$LOG" 2>&1
  say "child exited with $?"
}

watchdog() {
  # The watchdog holds the pid file and reports the child's exit, so a run that
  # dies while no agent is watching still leaves a record.
  probe >>"$LOG" 2>&1
  gate || { say "gate refused; not starting"; rm -f "$PID_FILE"; exit 2; }
  run_sequence
  say "watchdog done"
  rm -f "$PID_FILE"
}

case "${1:-}" in
  --probe) probe ;;
  --status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running: pid $(cat "$PID_FILE")"; else echo "not running"; fi
    echo "log:  $LOG"; tail -n 5 "$LOG" 2>/dev/null || true ;;
  --stop)
    if [[ -f "$PID_FILE" ]]; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; echo stopped; else echo "not running"; fi ;;
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
