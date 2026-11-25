#!/usr/bin/env bash
# Operator session lock (TIF-210): hold the VM lock across several runbook steps.
#
#   scripts/vm-session.sh -- <cmd> [args...]
#
# Takes the VM flock once (scripts/vm-lock.sh, driver name `vm-session.sh`),
# runs <cmd> with FD 9 inherited, and releases on exit: normal exit, a crashing
# child, and SIGTERM/SIGINT/SIGHUP (the signal is forwarded to <cmd>, the
# wrapper waits for it, then exits 128+signal). A step script started under it
# (reset-trial-vm.sh, run-live.ts, session-info.ts) accepts the lock through
# vm_lock_owned_by_parent / lockOwnedByAncestor, which for this driver require
# the inherited FD 9 itself: the same open file description that holds the
# flock. A process that only names the wrapper's pid, or opens the lock file on
# its own, is refused.
#
# Run several steps as one session with a shell:
#   scripts/vm-session.sh -- bash -c 'scripts/reset-trial-vm.sh && ...'
#
# Exit codes: 10 the lock is held (REFUSED_VM_LOCKED names the holder), 2 usage,
# otherwise <cmd>'s own status (127 if it cannot be run).
#
# Note: a Node launcher (pnpm exec, npx, the tsx CLI) spawns its child with only
# stdio, so FD 9 does not reach a TypeScript step started through one, and that
# step then refuses with exit 10. Start TypeScript steps as `node --import tsx`.
set -u

if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  echo "usage: $0 -- <cmd> [args...]" >&2
  exit 2
fi
shift

source "$(dirname "$0")/vm-lock.sh"
vm_lock_acquire vm-session.sh || exit "$?"
trap vm_lock_release EXIT

child=
forward() {
  local name=$1 number=$2
  trap '' TERM INT HUP
  if [ -n "$child" ]; then
    kill -"$name" "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  vm_lock_release
  exit $((128 + number))
}
trap 'forward TERM 15' TERM
trap 'forward INT 2' INT
trap 'forward HUP 1' HUP

echo "vm-session: holding $VM_LOCK_PATH as $$ vm-session.sh" >&2

# A non-interactive shell starts background jobs with SIGINT and SIGQUIT
# ignored, and `trap -` cannot undo that, so exec through a python3 shim that
# restores the defaults (python3 is already required by vm-lock.sh). `0<&0`
# keeps the operator's stdin instead of the /dev/null a background job gets.
python3 -c '
import os, signal, sys
for s in (signal.SIGINT, signal.SIGQUIT):
    signal.signal(s, signal.SIG_DFL)
try:
    os.execvp(sys.argv[1], sys.argv[1:])
except OSError as error:
    print(f"vm-session: cannot run {sys.argv[1]}: {error.strerror}", file=sys.stderr)
    sys.exit(127)
' "$@" 0<&0 &
child=$!
wait "$child"
status=$?
child=
exit "$status"
