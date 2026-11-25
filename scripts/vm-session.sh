#!/usr/bin/env bash
# Operator session lock (TIF-210): hold the VM lock across several runbook steps.
#
#   scripts/vm-session.sh -- <cmd> [args...]
#
# Takes the VM flock once (scripts/vm-lock.sh, driver name `vm-session.sh`),
# runs <cmd> with FD 9 inherited, and releases on exit: normal exit, a crashing
# child, and SIGTERM/SIGINT/SIGHUP. A signal to the wrapper is forwarded to the
# command's whole process group (every step of a `bash -c '<step>; <step>'`),
# the wrapper waits until the rest of that group is gone, then exits
# 128+signal. A signal that was ignored when the wrapper started (SIGHUP under
# nohup, SIGINT for a background job of a script) stays ignored: it is neither
# forwarded nor un-ignored for the command.
#
# A background descendant that kept FD 9 keeps the lock held after the wrapper
# exits, until it exits too: the flock belongs to the open file description, not
# to the wrapper.
#
# A step script started under it (reset-trial-vm.sh, run-live.ts,
# session-info.ts) accepts the lock through vm_lock_owned_by_parent /
# lockOwnedByAncestor, which for this driver require a descendant of the
# wrapper that carries the inherited FD 9 itself: the same open file description
# that holds the flock. A process that only names the wrapper's pid, or opens
# the lock file on its own, is refused.
#
# On exit the wrapper clears its own record (under the flock) before closing
# FD 9. Three cases leave `<pid> vm-session.sh` behind:
#   1. a SIGKILL of the wrapper;
#   2. a signal in the few ms while the python3 supervisor starts (before it
#      blocks its signals);
#   3. anything else that kills the wrapper between taking the lock and starting
#      the supervisor without running its traps.
# No command runs in cases 2 and 3. A stale record is still safe: the gate
# refuses a non-descendant of the recorded pid, and a dead pid outright
# (vm_lock_fd_is_holders).
#
# Process groups and the terminal. The wrapper never hands the terminal to
# another group. Which group the command runs in depends on how the wrapper was
# started:
#   - Started as a job by a shell with job control (the terminal case: the
#     wrapper leads its own process group): the command stays in the wrapper's
#     group. The group is exactly this job, so the terminal treats wrapper and
#     command as one job: Ctrl-C reaches every step (and the wrapper, which then
#     forwards it to the group as well), a step can read the terminal, Ctrl-Z
#     stops the whole job including the wrapper, and the shell's `fg` resumes
#     it. A signal the wrapper forwards reaches the wrapper too; it takes that
#     copy back at once, and drains by waiting for the group's other members
#     (listed with ps).
#   - Started any other way (a script, a launcher, nohup without job control):
#     the wrapper shares its group with whoever started it, which must not get
#     forwarded signals, so the command gets its own process group and signals
#     go there. Such a wrapper is not a terminal job of its own, so nothing
#     above applies.
# stdin is passed to the command unchanged either way.
#
# Run several steps as one session with a shell:
#   scripts/vm-session.sh -- bash -c 'scripts/reset-trial-vm.sh && ...'
#
# Exit codes: 10 the lock is held (REFUSED_VM_LOCKED names the holder), 2 usage,
# 125 python3 is missing or the python3 supervisor could not be started (the
# command did not run), otherwise <cmd>'s own status (127 if it cannot be run).
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

# vm_lock_acquire needs python3 too and would exit 127, which reads as "<cmd>
# cannot be run". Nothing is taken or written yet.
if ! command -v python3 > /dev/null 2>&1; then
  echo "vm-session: python3 not found; the lock was not taken and the command did not run" >&2
  exit 125
fi

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
#     the command's process group; once no member other than the wrapper is
#     left, exit 128+n of the first one. A later signal is forwarded too, so a
#     step that ignores TERM can still be stopped with INT or HUP.
#   - the command cannot be run: 127
# "holding" is printed only once signals are blocked.
shopt -s execfail
exec python3 -c '
import os, signal, subprocess, sys

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
# See "Process groups and the terminal" in the header. A wrapper that leads its
# own group is a job of its own: the command shares that group, so the terminal
# stops, resumes and interrupts them together. Otherwise the group belongs to
# whoever started the wrapper, and the command gets a group of its own.
shared = os.getpgrp() == os.getpid()

# Block first, then install handlers: a blocked signal stays pending for sigwait,
# and a handler (rather than SIG_DFL) keeps SIGCHLD from being discarded.
# SIGTSTP is left alone, so Ctrl-Z stops this process with the rest of its job.
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
        if not shared:
            # Its own process group, so the whole command can be signalled.
            os.setpgid(0, 0)
        # Python ignores SIGPIPE and SIGXFSZ; an ignored disposition survives
        # exec, so restore those and everything this process touched, except
        # what was ignored at entry.
        for s in (WAITED | {signal.SIGQUIT, signal.SIGPIPE, signal.SIGXFSZ}) - IGNORED:
            signal.signal(s, signal.SIG_DFL)
        signal.pthread_sigmask(signal.SIG_SETMASK, [])
        os.execvp(cmd[0], cmd)
    except OSError as error:
        print(f"vm-session: cannot run {cmd[0]}: {error.strerror}", file=sys.stderr)
    os._exit(127)
if shared:
    group = os.getpgrp()
else:
    group = pid
    # Both sides set the group, so neither can signal it before it exists.
    try:
        os.setpgid(pid, pid)
    except OSError:
        pass

def group_alive():
    if not shared:
        try:
            os.killpg(group, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    # The group holds this process too, so look for any other member. If ps
    # cannot run, stop waiting: a step still alive keeps the flock through its
    # own FD 9 anyway.
    try:
        ps = subprocess.Popen(["ps", "-A", "-o", "pid=,pgid="], stdout=subprocess.PIPE, text=True)
        out = ps.communicate()[0]
    except OSError:
        return False
    for line in out.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[1] == str(group):
            if int(fields[0]) not in (os.getpid(), ps.pid):
                return True
    return False

first = None
status = None
try:
    while True:
        got = signal.sigwait(WAITED)
        if got in FORWARD:
            first = first or got
            try:
                os.killpg(group, got)
            except ProcessLookupError:
                pass
            if shared and got in signal.sigpending():
                # Our own copy of what we just sent; take it back.
                signal.sigwait({got})
            # Poll the group while it drains; members other than the direct
            # child are not ours to wait for.
            signal.setitimer(signal.ITIMER_REAL, 0.05, 0.05)
        if status is None:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = raw
        if status is None:
            continue
        if first is None:
            break
        # In a shared group every ps run ends with a SIGCHLD; check on the
        # tick instead, or each check would trigger the next one at once.
        if shared and got == signal.SIGCHLD:
            continue
        if not group_alive():
            break
finally:
    signal.setitimer(signal.ITIMER_REAL, 0, 0)
    release()
sys.exit(128 + first if first else as_status(status))
' "$VM_LOCK_PATH" "$@"
echo "vm-session: cannot start the python3 supervisor; the command did not run" >&2
vm_session_abort 125
