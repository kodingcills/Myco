#!/usr/bin/env bash
# Operator session lock (TIF-210): hold the VM lock across several runbook steps.
#
#   scripts/vm-session.sh -- <cmd> [args...]
#
# Takes the VM flock once (scripts/vm-lock.sh, driver name `vm-session.sh`),
# runs <cmd> with FD 9 inherited, and releases on exit: normal exit, a crashing
# child, and SIGTERM/SIGINT/SIGHUP. A signal to the wrapper is forwarded to the
# command's whole process group (every step of a `bash -c '<step>; <step>'`),
# the wrapper waits until that group is empty, then exits 128+signal. A signal
# that was ignored when the wrapper started (SIGHUP under nohup, SIGINT for a
# background job of a script) stays ignored: it is neither forwarded nor
# un-ignored for the command.
#
# A step script started under it (reset-trial-vm.sh, run-live.ts,
# session-info.ts) accepts the lock through vm_lock_owned_by_parent /
# lockOwnedByAncestor, which for this driver require a descendant of the
# wrapper that carries the inherited FD 9 itself: the same open file description
# that holds the flock. A process that only names the wrapper's pid, or opens
# the lock file on its own, is refused.
#
# On exit the wrapper clears its own record (under the flock) before closing
# FD 9. Three cases leave `<pid> vm-session.sh` behind: a SIGKILL of the
# wrapper, a signal in the few ms while the python3 supervisor starts (before it
# blocks its signals), and anything that kills the wrapper between taking the
# lock and starting the supervisor without running its traps. No command runs in
# the last two. A stale record is still safe: the gate refuses a non-descendant
# of the recorded pid, and a dead pid outright (vm_lock_fd_is_holders).
#
# The terminal: the command runs in its own process group so a signal can reach
# all of it. When the wrapper is the terminal's foreground job, that group is
# made the foreground group for the session (so Ctrl-C reaches the command and
# a step can read the terminal), and the terminal is handed back afterwards.
# Ctrl-Z is ignored inside a terminal session: a stopped command would leave the
# terminal with a group nobody resumes. Without a terminal on stdin nothing of
# this applies; stdin is passed to the command unchanged either way.
#
# Run several steps as one session with a shell:
#   scripts/vm-session.sh -- bash -c 'scripts/reset-trial-vm.sh && ...'
#
# Exit codes: 10 the lock is held (REFUSED_VM_LOCKED names the holder), 2 usage,
# 125 the python3 supervisor could not be started (the command did not run),
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
# signals BEFORE forking, and the child resets them and only then unblocks, so a
# signal in that window is delivered to it, not lost.
#
# Paths out, all of which clear the record (only if it is still ours) while FD 9
# still holds the flock, then close FD 9:
#   - the command exits: its status, or 128+n if a signal killed it
#   - SIGTERM / SIGINT / SIGHUP to the wrapper (unless ignored at entry): sent to
#     the command's process group; once the group is empty, exit 128+n of the
#     first one. A later signal is forwarded too, so a step that ignores TERM can
#     still be stopped with INT or HUP.
#   - the command cannot be run: 127
# "holding" is printed only once signals are blocked.
shopt -s execfail
exec python3 -c '
import os, signal, sys

CANDIDATES = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
# Ignored at entry (nohup, a background job of a script) means ignored for the
# whole session: no handler, no forwarding, and the command inherits SIG_IGN.
IGNORED = {s for s in CANDIDATES if signal.getsignal(s) == signal.SIG_IGN}
if signal.getsignal(signal.SIGQUIT) == signal.SIG_IGN:
    IGNORED.add(signal.SIGQUIT)
FORWARD = tuple(s for s in CANDIDATES if s not in IGNORED)
TICK = signal.SIGALRM
WAITED = set(FORWARD) | {signal.SIGCHLD, TICK}
path, cmd = sys.argv[1], sys.argv[2:]
me = f"{os.getpid()} vm-session.sh"

# Block first, then install handlers: a blocked signal stays pending for sigwait,
# and a handler (rather than SIG_DFL) keeps SIGCHLD from being discarded. SIGTTOU
# is blocked so this process may hand the terminal back from the background.
signal.pthread_sigmask(signal.SIG_BLOCK, WAITED | {signal.SIGTTOU})
for s in WAITED:
    signal.signal(s, lambda *_: None)
print(f"vm-session: holding {path} as {me}", file=sys.stderr, flush=True)

tty = None
try:
    if os.isatty(0) and os.tcgetpgrp(0) == os.getpgrp():
        tty = 0
except OSError:
    tty = None

def release():
    if tty is not None:
        try:
            os.tcsetpgrp(tty, os.getpgrp())
        except OSError:
            pass
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
        # Its own process group, so the whole command can be signalled. SIGTTOU
        # is still blocked here, which lets it take the terminal from the
        # background before anything of the command runs.
        os.setpgid(0, 0)
        if tty is not None:
            os.tcsetpgrp(tty, os.getpgrp())
        # Python ignores SIGPIPE and SIGXFSZ; an ignored disposition survives
        # exec, so restore those and everything this process touched, except
        # what was ignored at entry.
        for s in (WAITED | {signal.SIGQUIT, signal.SIGPIPE, signal.SIGXFSZ, signal.SIGTTOU}) - IGNORED:
            signal.signal(s, signal.SIG_DFL)
        if tty is not None:
            signal.signal(signal.SIGTSTP, signal.SIG_IGN)
        signal.pthread_sigmask(signal.SIG_SETMASK, [])
        os.execvp(cmd[0], cmd)
    except OSError as error:
        print(f"vm-session: cannot run {cmd[0]}: {error.strerror}", file=sys.stderr)
    os._exit(127)
# Both sides set the group, so neither can signal it before it exists.
try:
    os.setpgid(pid, pid)
except OSError:
    pass

def group_alive():
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

first = None
status = None
try:
    while True:
        got = signal.sigwait(WAITED)
        if got in FORWARD:
            first = first or got
            try:
                os.killpg(pid, got)
            except ProcessLookupError:
                pass
            # Poll the group while it drains; members other than the direct
            # child are not ours to wait for.
            signal.setitimer(signal.ITIMER_REAL, 0.05, 0.05)
        if status is None:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = raw
        if status is not None and (first is None or not group_alive()):
            break
finally:
    signal.setitimer(signal.ITIMER_REAL, 0, 0)
    release()
sys.exit(128 + first if first else as_status(status))
' "$VM_LOCK_PATH" "$@"
echo "vm-session: cannot start the python3 supervisor; the command did not run" >&2
vm_session_abort 125
