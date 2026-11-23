#!/usr/bin/env bash
# vm-state.sh — is a guest running on this host? Read-only; starts and stops nothing.
#
# usage: vm-state.sh [--quiet]
#   exit 0  a guest is running
#   exit 1  no guest
#   exit 2  cannot tell (unreadable ps, no osascript) — NEVER treat this as idle
#
# Why this exists (TIF-163): `pgrep -f qemu-system-aarch64` returns 0 while a UTM
# guest is live. UTM runs the guest as `QEMULauncher`, and the qemu binary name
# only appears inside that process's ARGUMENTS. Three separate owner notes on
# 2026-11-21 recorded the trap and nothing changed, because a warning in a log is
# not a check. This is the check.
#
# The three signals, strongest last:
#   1. argv[0] basename matches a known qemu launcher  (identity, not a regex)
#   2. a listener on the guest's forwarded SSH ports    (2222 UTM, 10022 boot.sh)
#   3. UTM's own AppleScript status                     (the authority when up)
#
# Fails closed: an unreadable host reports a guest, never an idle one.
set -uo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1
say() { [ "$QUIET" = "1" ] || printf '%s\n' "$*"; }

# 1. Identity by basename of argv[0]. Matches both this repo's CLI guests
#    (qemu-system-aarch64) and UTM's launcher (QEMULauncher), whose argv carries
#    the qemu binary in later arguments rather than in argv[0].
argv_match() {
  local table
  table="$(ps -Ao command)" || return 2
  [ -n "$table" ] || return 2
  awk '{
    n = split($1, a, "/"); base = a[n]
    if (base == "qemu-system-aarch64" || base == "QEMULauncher" ||
        base == "qemu-aarch64-softmmu" || base == "qemu-system-aarch64-headless") found = 1
  } END { exit !found }' <<<"$table"
}

# 2. A forwarded port. 2222 is UTM's (create-vm.sh SSH_PORT default), 10022 is
#    boot.sh's. A listener means a guest is up even if argv[0] is unexpected.
port_match() {
  local p out rc
  for p in 2222 10022; do
    # lsof exits 1 for "no matching file" and >1 for a real error. Mapping every
    # non-zero to unreadable made exit 1 (idle) unreachable on any host with
    # lsof: an idle host reported UNKNOWN. Only rc > 1 is unreadable.
    out="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null)"; rc=$?
    [ "$rc" -gt 1 ] && return 2
    [ -n "$out" ] && return 0
  done
  return 1
}

# 3. UTM's own view. Only consulted when osascript can actually answer; a TCC
#    denial must not read as "stopped".
utm_status() {
  local s
  s="$(osascript -e 'tell application "UTM"' \
      -e 'if (count of virtual machines) is 0 then return "none"' \
      -e 'set out to ""' \
      -e 'repeat with v in virtual machines' \
      -e 'set out to out & (name of v) & "=" & (status of v) & " "' \
      -e 'end repeat' \
      -e 'return out' -e 'end tell' 2>/dev/null)" || return 2
  [ -n "$s" ] || return 2
  case "$s" in
    *started*) return 0 ;;
    *) return 1 ;;
  esac
}

reasons=""
argv_match; a=$?
port_match; p=$?
utm_status; u=$?

[ "$a" = "0" ] && reasons="$reasons argv:yes"
[ "$p" = "0" ] && reasons="$reasons port:listening"
[ "$u" = "0" ] && reasons="$reasons utm:started"

if [ "$a" = "0" ] || [ "$p" = "0" ] || [ "$u" = "0" ]; then
  say "GUEST RUNNING:$reasons"
  exit 0
fi

# Nothing found. Only report idle if every signal was readable — otherwise a
# failed check would masquerade as an idle host, which is the whole bug.
if [ "$a" = "2" ] || [ "$p" = "2" ] || [ "$u" = "2" ]; then
  say "UNKNOWN: could not read the host (argv=$a port=$p utm=$u) — treat as running, not idle"
  exit 2
fi

say "no guest running (argv:no port:silent utm:stopped)"
exit 1
