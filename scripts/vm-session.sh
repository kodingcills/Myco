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
# On exit the wrapper clears its own record (under the flock) before closing
# FD 9, so the lock file is empty after a session that was not SIGKILLed. A background descendant that
# kept FD 9 keeps the lock held after the wrapper exits, until it exits too.
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

# A signal before the supervisor below has blocked its signals: clear our record
# if we wrote one (we then hold the flock), and exit. No command has started yet.
vm_session_abort() {
  local pid driver
  if read -r pid driver < "$VM_LOCK_PATH" 2>/dev/null &&
    [ "$pid" = "$$" ] && [ "$driver" = "vm-session.sh" ]; then
    : > "$VM_LOCK_PATH"
  fi
  exit "$1"
}
trap 'vm_session_abort 143' TERM
trap 'vm_session_abort 130' INT
trap 'vm_session_abort 129' HUP

vm_lock_acquire vm-session.sh || exit "$?"

# The supervisor is python3 (already required by vm-lock.sh), exec'd so it keeps
# this pid (the recorded owner, MYCO_VM_LOCK_OWNER) and FD 9. Bash cannot do this
# part safely: a background job of a non-interactive shell starts with SIGINT
# ignored, and a signal forwarded while the forked child has not exec'd yet runs
# the parent's trap inside the child and is lost (measured: 9 of 10 SIGTERMs
# landed there and the command ran to completion). The supervisor blocks the
# signals BEFORE forking, and the child resets them to their defaults and only
# then unblocks, so a signal in that window is delivered to it, not lost.
#
# Paths out, all of which clear the record (only if it is still ours) while FD 9
# still holds the flock, then close FD 9:
#   - the command exits: its status, or 128+n if a signal killed it
#   - SIGTERM / SIGINT / SIGHUP to the wrapper: forwarded to the command; once it
#     has exited, exit 128+n of the first one
#   - the command cannot be run: 127
# A SIGKILL of the wrapper leaves the record, and so does a signal in the few ms
# between this exec and the supervisor blocking its signals (python3 startup; no
# command exists yet, so nothing is orphaned and the kernel frees the lock). The
# gate's ancestry check is what keeps such a stale record from being reused (see
# vm_lock_fd_is_holders). "holding" is printed only once signals are blocked.
exec python3 -c '
import os, signal, sys

FORWARD = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
WAITED = set(FORWARD) | {signal.SIGCHLD}
path, cmd = sys.argv[1], sys.argv[2:]
me = f"{os.getpid()} vm-session.sh"

# Block first, then install handlers: a blocked signal stays pending for sigwait,
# and a handler (rather than SIG_DFL) keeps SIGCHLD from being discarded.
signal.pthread_sigmask(signal.SIG_BLOCK, WAITED)
for s in WAITED:
    signal.signal(s, lambda *_: None)
print(f"vm-session: holding {path} as {me}", file=sys.stderr, flush=True)

def release():
    try:
        with open(path) as f:
            if f.read().strip() == me:
                os.ftruncate(9, 0)
    except OSError:
        pass
    try:
        os.close(9)
    except OSError:
        pass

def as_status(status):
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)

pid = os.fork()
if pid == 0:
    try:
        # Python ignores SIGPIPE and SIGXFSZ; an ignored disposition survives
        # exec, so restore every one this process touched.
        for s in WAITED | {signal.SIGQUIT, signal.SIGPIPE, signal.SIGXFSZ}:
            signal.signal(s, signal.SIG_DFL)
        signal.pthread_sigmask(signal.SIG_SETMASK, [])
        os.execvp(cmd[0], cmd)
    except OSError as error:
        print(f"vm-session: cannot run {cmd[0]}: {error.strerror}", file=sys.stderr)
    os._exit(127)

first = None
try:
    while True:
        got = signal.sigwait(WAITED)
        if got in FORWARD:
            first = first or got
            try:
                os.kill(pid, got)
            except ProcessLookupError:
                pass
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            break
finally:
    release()
sys.exit(128 + first if first else as_status(status))
' "$VM_LOCK_PATH" "$@"
