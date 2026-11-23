#!/usr/bin/env bash
# RT-013 (TIF-47): prove the idle-shutdown policy fires when idle and holds when
# active — on the host, with no VM. This is the acceptance "a test or script
# demonstrates idle shutdown", made runnable in CI-shaped environments.
#
# It drives `idle-watchdog.sh` in dry-run against a controlled heartbeat file and a
# shrunk interval, so the whole check runs in seconds instead of the real timeout.
# The two directions matter equally:
#   - stale heartbeat  => the watchdog DECIDES to shut down (else idle guests leak)
#   - fresh heartbeat  => the watchdog does NOT (else working sessions die)
# A test that only proves the first direction would pass for a watchdog that kills
# every guest on sight.
#
# No `timeout(1)`: it is absent on macOS. A background job plus a bounded wait is
# used instead, so this runs on the dev host as well as Linux.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG="$HERE/idle-watchdog.sh"
[[ -f "$WATCHDOG" ]] || { echo "missing $WATCHDOG" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() { # check <name> <expected-substring> <output>
  if grep -qF "$2" <<<"$3"; then
    echo "PASS: $1"
    pass=$((pass+1))
  else
    echo "FAIL: $1 — wanted '$2' in:" >&2
    echo "$3" >&2
    fail=$((fail+1))
  fi
}

# Run the watchdog for at most <secs>, capturing output. It exits on its own when it
# decides to reap; otherwise it is killed at the deadline.
run_for() { # run_for <secs> <env...> -- <args>
  local secs="$1"; shift
  local outfile="$TMP/out.$$"
  "$@" >"$outfile" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < secs*10 )); do
    sleep 0.1; waited=$((waited+1))
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  cat "$outfile"; rm -f "$outfile"
}

# 1. Disabled by default: an unset timeout must NOT reap. This is the guard against
#    silently enabling a policy that would make sessions vanish.
out=$(MYCO_RT_STATE_DIR="$TMP" MYCO_RT_IDLE_SECS=0 "$WATCHDOG")
check "disabled when Idle Secs=0" "reaping disabled" "$out"

# 2. Stale heartbeat => shut down. Heartbeat mtime set into the past, timeout 2s,
#    interval 1s so the first wake already sees it stale.
touch -t 200001010000 "$TMP/heartbeat"
out=$(run_for 6 env MYCO_RT_STATE_DIR="$TMP" MYCO_RT_IDLE_SECS=2 \
      MYCO_RT_WATCHDOG_INTERVAL=1 MYCO_RT_WATCHDOG_DRY_RUN=1 "$WATCHDOG")
check "fires on stale heartbeat" "shutting down" "$out"

# 3. Fresh heartbeat => hold. Long timeout, freshly-touched heartbeat: within the
#    observation window the watchdog must NOT decide to shut down.
touch "$TMP/heartbeat"
out=$(run_for 3 env MYCO_RT_STATE_DIR="$TMP" MYCO_RT_IDLE_SECS=3600 \
      MYCO_RT_WATCHDOG_INTERVAL=1 MYCO_RT_WATCHDOG_DRY_RUN=1 "$WATCHDOG")
if grep -qF "shutting down" <<<"$out"; then
  echo "FAIL: held on fresh heartbeat — it decided to shut down" >&2
  fail=$((fail+1))
else
  echo "PASS: holds on fresh heartbeat"
  pass=$((pass+1))
fi

# 4. No heartbeat at all => still reaps. A guest booted and never touched is the
#    exact leak case; its heartbeat is absent, which must count as infinitely idle.
rm -f "$TMP/heartbeat"
out=$(run_for 6 env MYCO_RT_STATE_DIR="$TMP" MYCO_RT_IDLE_SECS=2 \
      MYCO_RT_WATCHDOG_INTERVAL=1 MYCO_RT_WATCHDOG_DRY_RUN=1 "$WATCHDOG")
check "fires when heartbeat absent" "shutting down" "$out"

# 5. Bad timeout is a loud error, not a silent default.
out=$(MYCO_RT_STATE_DIR="$TMP" MYCO_RT_IDLE_SECS=abc "$WATCHDOG" 2>&1 || true)
check "rejects a non-integer timeout" "must be an integer" "$out"

echo
echo "idle-watchdog-test: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
