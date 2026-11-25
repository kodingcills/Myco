#!/usr/bin/env bash
# Operator session lock (TIF-210): hold the VM lock across several runbook steps.
#
#   scripts/vm-session.sh -- <cmd> [args...]
#
# Takes the VM flock once (scripts/vm-lock.sh, driver name `vm-session.sh`),
# runs <cmd> with FD 9 inherited, and releases on exit: normal exit, a crashing
# child, and SIGTERM/SIGINT/SIGHUP. A signal to the wrapper reaches the
# command's whole process group (every step of a `bash -c '<step>; <step>'`)
# exactly once (see "Process groups and the terminal" for who sends it). The
# wrapper then waits until the command has exited and the rest of its group is
# gone, and exits 128+signal. A signal that was ignored when the wrapper started
# (SIGHUP under nohup, SIGINT for a background job of a script) stays ignored:
# it is neither forwarded nor un-ignored for the command.
#
# Every forwarded signal is followed by a SIGCONT to the group, so a stopped
# step still receives it. A later signal is forwarded too.
#
# While it waits after a signal, the wrapper keeps the lock and its record. If
# any process of the session is still there 5 s after the signal, it prints
# which ones to stderr (and again every 30 s) and says that a SIGTERM to the
# wrapper is forwarded to them. It never gives up on its own.
#
# A background descendant that kept FD 9 keeps the lock held after the wrapper
# exits, until it exits too: the flock belongs to the open file description, not
# to the wrapper. On a normal exit (no signal) the wrapper does not wait for such
# a descendant; after a signal it waits for it as above, when it is still in the
# session's process group.
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
#     command as one job: a step can read the terminal, Ctrl-Z stops the whole
#     job including the wrapper, and the shell's `fg` resumes it.
#     SIGINT and SIGHUP are NOT sent again by the wrapper in this mode: the
#     terminal (Ctrl-C, a hangup) and the shell (a hangup) already deliver them
#     to every process of the job. A second copy would interrupt a step's EXIT
#     trap halfway through (a token file left behind, a tunnel left running).
#     SIGTERM never comes from the terminal, so it is forwarded. To stop a
#     terminal session from elsewhere, send SIGTERM to the wrapper; a SIGINT or
#     SIGHUP sent with `kill` to the wrapper alone does not reach the steps, and
#     after 5 s the wrapper says so. A signal the wrapper forwards reaches the
#     wrapper too; it takes that copy back at once. It drains by waiting for the
#     group's other members (listed with ps).
#   - Started any other way (a script, a launcher, nohup without job control):
#     the wrapper shares its group with whoever started it, which must not get
#     forwarded signals, so the command gets its own process group, and every
#     signal is forwarded there. If that started from a script running in a
#     terminal, the terminal's Ctrl-C reaches the script and the wrapper, and the
#     wrapper forwards it once. The command's group is then a background group of
#     the terminal: a step that reads (or, under `stty tostop`, writes) the
#     terminal is stopped by SIGTTIN/SIGTTOU, and nothing would resume it. The
#     wrapper checks for stopped processes of the session once a second while it
#     has a controlling terminal, and reports them to stderr with what to do
#     (end the session with `kill <wrapper pid>`, which is forwarded with a
#     SIGCONT so the stopped step receives it). Ctrl-Z stops the script and the
#     wrapper, but not the command, which keeps running and holding the lock. To
#     use the terminal inside a session, start the wrapper straight from an
#     interactive shell.
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
#     the command's process group (unless the terminal already did, see the
#     header), then SIGCONT; once the command has exited and no member other
#     than the wrapper is left, exit 128+n of the first one. A later signal is
#     forwarded too, so a step that ignores TERM can still be stopped.
#   - the command cannot be run: 127
# "holding" is printed only once signals are blocked.
shopt -s execfail
exec python3 -c '
import os, signal, subprocess, sys, time

CANDIDATES = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
# Ignored at entry (nohup, a background job of a script) means ignored for the
# whole session: no handler, no forwarding, and the command inherits SIG_IGN.
IGNORED = {s for s in CANDIDATES if signal.getsignal(s) == signal.SIG_IGN}
if signal.getsignal(signal.SIGQUIT) == signal.SIG_IGN:
    IGNORED.add(signal.SIGQUIT)
FORWARD = tuple(s for s in CANDIDATES if s not in IGNORED)
TICK = signal.SIGALRM
WAITED = set(FORWARD) | {signal.SIGCHLD, TICK}
REPORT_AFTER, REPORT_EVERY = 5.0, 30.0
path, cmd = sys.argv[1], sys.argv[2:]
me = f"{os.getpid()} vm-session.sh"
# See "Process groups and the terminal" in the header. A wrapper that leads its
# own group is a job of its own: the command shares that group, so the terminal
# stops, resumes and interrupts them together. Otherwise the group belongs to
# whoever started the wrapper, and the command gets a group of its own.
shared = os.getpgrp() == os.getpid()
# In a shared group the terminal and the shell deliver these to every process
# of the job themselves; sending them again would cut the EXIT trap of a step short.
NOT_RESENT = {signal.SIGINT, signal.SIGHUP} if shared else set()
# Only a session with a controlling terminal can have a step stopped by
# SIGTTIN/SIGTTOU in a background group; only then is it worth looking.
watch_stops = False
if not shared:
    try:
        os.close(os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY))
        watch_stops = True
    except OSError:
        pass

# Block first, then install handlers: a blocked signal stays pending for sigwait,
# and a handler (rather than SIG_DFL) keeps SIGCHLD from being discarded.
# SIGTSTP is left alone, so Ctrl-Z stops this process with the rest of its job.
signal.pthread_sigmask(signal.SIG_BLOCK, WAITED)
for s in WAITED:
    signal.signal(s, lambda *_: None)
print(f"vm-session: holding {path} as {me}", file=sys.stderr, flush=True)

def say(text):
    print(f"vm-session: {text}", file=sys.stderr, flush=True)

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

def members():
    """The processes of the session group other than this one, as (pid, stat, command),
    or None when ps cannot run."""
    try:
        ps = subprocess.Popen(["ps", "-A", "-o", "pid=,pgid=,stat=,command="],
                              stdout=subprocess.PIPE, text=True)
        out = ps.communicate()[0]
    except OSError:
        return None
    found = []
    for line in out.splitlines():
        fields = line.split(None, 3)
        if len(fields) >= 3 and fields[1] == str(group):
            if int(fields[0]) not in (os.getpid(), ps.pid):
                found.append((int(fields[0]), fields[2], fields[3] if len(fields) > 3 else ""))
    return found

def describe(procs):
    return "; ".join(f"{p} {c[:80]}" for p, _, c in procs)

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
    return bool(members())

def send(sig):
    try:
        os.killpg(group, sig)
    except ProcessLookupError:
        return
    if shared and sig in signal.sigpending():
        # Our own copy of what we just sent; take it back.
        signal.sigwait({sig})
    # A stopped process only acts on a signal once it continues.
    try:
        os.killpg(group, signal.SIGCONT)
    except ProcessLookupError:
        pass

first = None
signalled_at = None
next_report = None
reported_stops = set()
last_stop_check = 0.0
status = None
if watch_stops:
    signal.setitimer(signal.ITIMER_REAL, 1.0, 1.0)
try:
    while True:
        got = signal.sigwait(WAITED)
        now = time.monotonic()
        if got in FORWARD:
            if first is None:
                first, signalled_at = got, now
                next_report = now + REPORT_AFTER
                # Poll the group while it drains; members other than the
                # direct child are not ours to wait for.
                signal.setitimer(signal.ITIMER_REAL, 0.05, 0.05)
            if got not in NOT_RESENT:
                send(got)
        if status is None:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done == pid:
                status = raw
        if status is not None and first is None:
            break
        # ps runs only on the tick: in a shared group every ps run ends with a
        # SIGCHLD, which would otherwise trigger the next check at once.
        if got != TICK:
            continue
        if watch_stops and now - last_stop_check >= 1.0:
            last_stop_check = now
            stopped = {p for p, stat, _ in (members() or []) if stat.startswith("T")}
            if stopped - reported_stops:
                say(f"session process(es) {sorted(stopped)} are stopped and hold the lock. "
                    "The command runs in its own process group here (the wrapper was not "
                    "started as a job of its own), so a step that reads or writes the "
                    "terminal is stopped by SIGTTIN/SIGTTOU and nothing resumes it. End the "
                    f"session with `kill {os.getpid()}`, or run the wrapper straight from an "
                    "interactive shell.")
            reported_stops = stopped
        if first is None:
            continue
        if status is not None and not group_alive():
            break
        if now >= next_report:
            next_report = now + REPORT_EVERY
            left = members()
            if status is None:
                left_text = f"the command (pid {pid}) is still running"
            else:
                left_text = f"{len(left or [])} process(es) of the session are still running: {describe(left or [])}"
            hint = ""
            if first in NOT_RESENT:
                hint = (f" {signal.Signals(first).name} reached the session from the terminal or the shell "
                        "only (a `kill` aimed at the wrapper alone does not reach the steps).")
            say(f"still waiting after {signal.Signals(first).name}, holding the lock: {left_text}."
                f"{hint} A SIGTERM to {os.getpid()} is forwarded to them.")
finally:
    signal.setitimer(signal.ITIMER_REAL, 0, 0)
    release()
sys.exit(128 + first if first else as_status(status))
' "$VM_LOCK_PATH" "$@"
echo "vm-session: cannot start the python3 supervisor; the command did not run" >&2
vm_session_abort 125
