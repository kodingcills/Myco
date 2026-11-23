#!/usr/bin/env bash
# RT-013 (TIF-47): idle-shutdown policy for the Myco runtime guest.
#
# The stated gap this closes (docs/env/linux-runtime.md §4): "idle reaping — a
# session left alone stays up until destroy". A guest that a crashed host agent
# forgets does not free itself, and on this host that borrowed memory is exactly the
# pressure the post-M1 second-VM question (TIF-92) cannot afford.
#
# How it works
# ------------
# The host touches a heartbeat file on every op (see heartbeat_path below). This
# watchdog — run *inside* the guest by the provisioning seed — wakes on an interval
# and shuts the guest down when the heartbeat has not moved for MYCO_RT_IDLE_SECS.
# Putting the reaper in the guest, not the host, is deliberate: a host-side timer
# dies with the host agent, which is the failure mode this must survive.
#
# Policy
# ------
# - MYCO_RT_IDLE_SECS unset/0 => reaping DISABLED (the development default; matches
#   SessionConfig.idle_timeout = None). Never silently enabled: a session that
#   vanishes mid-inspection with no log is worse than one that lingers.
# - When enabled, the timeout is reported once at start and on shutdown, so the
#   guest's own log explains why it went away.
#
# Testing without a VM: `MYCO_RT_WATCHDOG_DRY_RUN=1` prints the decision it *would*
# make instead of shutting down, so `runtime/guest/idle-watchdog-test.sh` can prove
# both directions (fire on stale heartbeat, hold on fresh) on the host.
set -euo pipefail

STATE_DIR="${MYCO_RT_STATE_DIR:-/home/myco/.myco}"
HEARTBEAT="${STATE_DIR}/heartbeat"
IDLE_SECS="${MYCO_RT_IDLE_SECS:-0}"
INTERVAL="${MYCO_RT_WATCHDOG_INTERVAL:-10}"
DRY_RUN="${MYCO_RT_WATCHDOG_DRY_RUN:-0}"

if ! [[ "$IDLE_SECS" =~ ^[0-9]+$ ]]; then
  echo "idle-watchdog: MYCO_RT_IDLE_SECS must be an integer, got '$IDLE_SECS'" >&2
  exit 1
fi

if [[ "$IDLE_SECS" -eq 0 ]]; then
  echo "idle-watchdog: reaping disabled (MYCO_RT_IDLE_SECS=0); guest will not self-shut-down."
  exit 0
fi

echo "idle-watchdog: reaping after ${IDLE_SECS}s idle, checking every ${INTERVAL}s (heartbeat ${HEARTBEAT})."

now() { date +%s; }
# mtime of the heartbeat, or the epoch if it does not exist yet (so a guest that
# boots and is never touched still reaps — the whole point).
hb_mtime() {
  if [[ -f "$HEARTBEAT" ]]; then
    stat -c %Y "$HEARTBEAT" 2>/dev/null || stat -f %m "$HEARTBEAT"
  else
    echo 0
  fi
}

while true; do
  sleep "$INTERVAL"
  age=$(( $(now) - $(hb_mtime) ))
  if [[ "$age" -ge "$IDLE_SECS" ]]; then
    msg="idle-watchdog: no heartbeat for ${age}s (>= ${IDLE_SECS}s); shutting down."
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "DRY-RUN: $msg"
      exit 0
    fi
    echo "$msg"
    sudo systemctl poweroff || sudo poweroff || exit 1
    exit 0
  fi
done
