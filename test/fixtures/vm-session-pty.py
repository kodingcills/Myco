"""Drive scripts/vm-session.sh from an interactive bash on a pseudo-terminal.

Used by test/vm-session.test.ts ("under a terminal ..."). Run as
    python3 -I vm-session-pty.py <wrapper> <work dir> [scenarios] [repeat]
with MYCO_VM_LOCK_PATH set to a private lock path and GUARD to scripts/vm-lock.sh.
`scenarios` is a string of letters (default: all of them, in order) and `repeat`
how many times to run that list (default 1).

Unless noted, a session uses the runbook's multi-step form,
`bash -c '<step>; <next step>'`, and the step accepts the session lock
(vm_lock_owned_by_parent) before it loops:
  a. Ctrl-Z stops the whole job (wrapper and step), the shell gets the terminal
     back, the step does not run on while stopped, and `fg` resumes it: the step
     finishes, the next step runs, and the session exits 0.
  b. Ctrl-C ends the session: 130, no step left, the record cleared, the lock
     free, and the next step never runs.
  c. A SIGTERM sent to the wrapper alone, with a step whose EXIT trap is slow
     (sleep 0.5, then a done marker): the trap finishes (one SIGTERM reaches the
     step, not a stream of them), and 143 comes only once the step has gone.
  d. Ctrl-C with a step shaped like agent/bootstrap/deploy-to-vm.sh: a token
     temp file, a background child that ignores SIGINT and keeps FD 9 (the ssh
     tunnel), and an EXIT trap that removes the file, waits, kills the child and
     marks itself done. The trap must run to the end, and the session must end
     with 130 and the lock free.
  e. As d, but the step waits in a builtin (`read -t` on a FIFO) instead of in
     `sleep`, so bash starts its EXIT trap within microseconds of the Ctrl-C.
     A second SIGINT sent by the wrapper would then land inside the trap almost
     every time; in d it lands there only some of the time.
  f. Ctrl-C leaving a background child that ignores SIGINT and keeps FD 9 (the
     documented caveat): the wrapper keeps waiting, holding the lock under its
     own record, says which process is left within 8 s, and a SIGTERM to the
     wrapper then ends it (130, lock free).
  g. The wrapper started from a script running in the terminal (own process
     group for the command): a step that reads the terminal is stopped by
     SIGTTIN; the wrapper reports it within 5 s, and a SIGTERM to the wrapper,
     forwarded with SIGCONT, ends the session (143, lock free). The step traps
     TERM, so without the SIGCONT the signal would stay pending while it is
     stopped (a default-action TERM kills even a stopped process).
Prints "PTY-OK" and exits 0, or prints what failed and the terminal transcript
and exits 1.
"""

import fcntl
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time

WRAPPER, WORK = sys.argv[1], sys.argv[2]
SCENARIOS = sys.argv[3] if len(sys.argv) > 3 else "abcdefg"
REPEAT = int(sys.argv[4]) if len(sys.argv) > 4 else 1
LOCK = os.environ["MYCO_VM_LOCK_PATH"]
transcript = b""
known_pids = set()
known_groups = set()


def fail(message):
    print(f"FAIL: {message}")
    print("--- terminal transcript ---")
    print(transcript.decode(errors="replace"))
    sys.exit(1)


def pump(fd, seconds):
    global transcript
    end = time.time() + seconds
    while True:
        left = end - time.time()
        if left <= 0:
            return
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            return
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            return
        if not chunk:
            return
        transcript += chunk


def text():
    return transcript.decode(errors="replace")


def wait_for(fd, pattern, seconds, what, since=0):
    end = time.time() + seconds
    regex = re.compile(pattern)
    while time.time() < end:
        found = regex.search(text(), since)
        if found:
            return found
        pump(fd, 0.05)
    fail(f"timed out after {seconds}s waiting for {what} ({pattern!r})")


def send(fd, line):
    os.write(fd, line.encode())


def record():
    try:
        with open(LOCK) as f:
            return f.read()
    except FileNotFoundError:
        return ""


def lock_is_free():
    fd = os.open(LOCK, os.O_WRONLY | os.O_APPEND | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def ps_field(pid, field):
    out = subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)], capture_output=True, text=True)
    return out.stdout.strip()


def path(name, suffix):
    return os.path.join(WORK, f"{name}.{suffix}")


def long_wait(name):
    """The wait of a step that a signal must end: one long `sleep`.

    A non-interactive bash that gets a SIGINT while it waits for a foreground
    child takes the SIGINT as handled when that child does not
    die of it (bash's wait-and-cooperative-exit rule), and then carries on. Two
    windows give that: a sleep that exits normally at the instant of the Ctrl-C,
    and the fork of the next sleep, before the child has put SIGINT back to its
    default (the child then catches it in bash's own handler, execs, and the
    sleep runs its full length). In either window the step runs on, and the
    session outlasts any deadline: that is bash's choice, not the wrapper's, which
    does not send SIGINT again on a shared terminal (CI run 45722931958: scenario
    d timed out after 15 s that way, with `while :; do sleep 10; done`).

    So the step waits in a `sh` that marks itself waiting once it runs (a fresh
    exec, so its SIGINT is already back to the default) and then execs one sleep
    longer than any scenario. A Ctrl-C or a SIGTERM sent once the mark exists (see
    in_long_wait) kills that sh or sleep, so the step's bash sees its child die of
    the signal and exits through its EXIT trap, every time. There is no loop: if
    the sleep ever ended, the step would print STEP-DONE and the scenario would
    fail loudly instead of hanging."""
    waiting = path(name, "waiting")
    return f"sh -c ': > \"{waiting}\"; exec sleep 300'"


def in_long_wait(name):
    """Return once the step waits in the sleep of long_wait, past both windows.

    Every scenario that ends a long_wait step with a signal calls this first."""
    waiting = path(name, "waiting")
    end = time.time() + 15
    while not os.path.exists(waiting):
        if time.time() > end:
            fail(f"session {name}: the step never reached its wait (no {waiting})")
        time.sleep(0.02)


def write_step(name, extra="", body=None):
    step = path(name, "sh")
    loop = body or f'while [ ! -e "{path(name, "go")}" ]; do sleep 0.1; done'
    with open(step, "w") as f:
        f.write(
            f"""source "$GUARD"
vm_lock_owned_by_parent || {{ echo STEP-NOT-INHERITED; exit 9; }}
{extra}
echo $$ > "{path(name, "pid")}"
echo STEP-STARTED-{name}
{loop}
echo STEP-DONE-{name}
"""
        )
    return step


def session(fd, name, step, rc=True):
    # The "" pairs keep the typed line from matching what the session prints.
    tail = f'; echo RC""-{name}=$?' if rc else ""
    send(fd, f"{WRAPPER} -- bash -c 'bash {step}; echo NEXT\"\"-STEP-RAN-{name}'{tail}\n")


def session_rc(fd, name, seconds, what):
    return int(wait_for(fd, f"RC-{name}=(\\d+)", seconds, what).group(1))


def step_pid(fd, name):
    wait_for(fd, f"STEP-STARTED-{name}\\b", 15, f"step {name} to start under the session")
    with open(path(name, "pid")) as f:
        pid = int(f.read().strip())
    known_pids.add(pid)
    known_groups.add(os.getpgid(pid))
    return pid


def background_pid(name):
    """The pid of the step's background child, once that child has ignored SIGINT.

    The step writes `$!` right after forking it, but the child may not have run
    yet: on a loaded runner a Ctrl-C sent then reaches it before it ignores
    SIGINT and kills it, and the scenario no longer tests what it says. So the
    child marks itself ready after its `trap '' INT`, and this waits for that."""
    ready = path(name, "ready")
    end = time.time() + 15
    while not os.path.exists(ready):
        if time.time() > end:
            fail(f"session {name}: the background child never got ready (no {ready})")
        time.sleep(0.02)
    with open(path(name, "bg")) as f:
        pid = int(f.read().strip())
    known_pids.add(pid)
    return pid


def wrapper_pid():
    fields = record().split()
    if len(fields) != 2 or fields[1] != "vm-session.sh":
        fail(f"expected a vm-session.sh record while the session runs, got {record()!r}")
    known_pids.add(int(fields[0]))
    return int(fields[0])


def expect_rc(name, rc, code):
    if rc != code:
        fail(f"session {name}: exit {rc}, expected {code}")


def expect_released(name):
    if record() != "" or not lock_is_free():
        fail(f"after session {name}: record {record()!r}, lock free {lock_is_free()}")


def expect_no_next_step(fd, name):
    pump(fd, 0.3)
    if f"NEXT-STEP-RAN-{name}" in text():
        fail(f"session {name}: the next step ran")


def scenario_a(fd, name):
    step = write_step(name)
    session(fd, name, step, rc=False)
    s = step_pid(fd, name)
    w = wrapper_pid()
    if ps_field(s, "pgid") != str(w):
        fail(f"step {name} runs in group {ps_field(s, 'pgid')}, not the wrapper's job {w}")
    send(fd, "\x1a")
    wait_for(fd, r"Stopped", 10, "the shell to report the job stopped (it has the terminal back)")
    for who, p in (("wrapper", w), ("step", s)):
        if "T" not in ps_field(p, "stat"):
            fail(f"after Ctrl-Z the {who} is not stopped (stat {ps_field(p, 'stat')!r})")
    if lock_is_free():
        fail("the lock went free while the session was stopped")
    open(path(name, "go"), "w").close()
    pump(fd, 1.0)
    if f"STEP-DONE-{name}" in text():
        fail("the step ran on while the job was stopped")
    send(fd, f'fg; echo RC""-{name}=$?\n')
    rc = session_rc(fd, name, 15, "the resumed session to finish")
    if f"STEP-DONE-{name}" not in text() or f"NEXT-STEP-RAN-{name}" not in text():
        fail("after fg the step did not finish and hand over to the next step")
    expect_rc(name, rc, 0)
    expect_released(name)


def scenario_b(fd, name):
    session(fd, name, write_step(name, body=long_wait(name)))
    s = step_pid(fd, name)
    wrapper_pid()
    in_long_wait(name)
    send(fd, "\x03")
    rc = session_rc(fd, name, 15, "the session to end on Ctrl-C")
    expect_rc(name, rc, 130)
    if alive(s):
        fail("a step survived Ctrl-C")
    expect_released(name)
    expect_no_next_step(fd, name)


def scenario_c(fd, name):
    done = path(name, "done")
    session(fd, name, write_step(name, f"trap 'sleep 0.5; touch \"{done}\"' EXIT", long_wait(name)))
    s = step_pid(fd, name)
    in_long_wait(name)
    os.kill(wrapper_pid(), signal.SIGTERM)
    rc = session_rc(fd, name, 15, "the session to end on SIGTERM")
    if alive(s):
        fail("the wrapper returned while a step was still stopping")
    if not os.path.exists(done):
        fail(f"session {name}: the step's EXIT trap was cut short (no done marker)")
    expect_rc(name, rc, 143)
    expect_released(name)
    expect_no_next_step(fd, name)


def deploy_like(fd, name, fast):
    token, done, bg = path(name, "token"), path(name, "done"), path(name, "bg")
    extra = f"""tmp="{token}"; : > "$tmp"
( trap '' INT; : > "{path(name, "ready")}"; exec sleep 300 ) &
tunnel=$!
echo "$tunnel" > "{bg}"
trap 'rm -f "$tmp"; sleep 0.2; kill "$tunnel" 2>/dev/null; touch "{done}"' EXIT"""
    body = long_wait(name)
    if fast:
        fifo = path(name, "fifo")
        os.mkfifo(fifo)
        body = f'exec 3<>"{fifo}"\nwhile [ ! -e "{path(name, "go")}" ]; do read -r -t 1 -u 3; done'
    session(fd, name, write_step(name, extra, body))
    step_pid(fd, name)
    wrapper_pid()
    tunnel = background_pid(name)
    if not fast:
        in_long_wait(name)
    send(fd, "\x03")
    rc = session_rc(fd, name, 15, "the session to end on Ctrl-C")
    if not os.path.exists(done):
        fail(f"session {name}: the step's EXIT trap was cut short (no done marker)")
    if os.path.exists(token):
        fail(f"session {name}: the token temp file was left behind")
    if alive(tunnel):
        fail(f"session {name}: the background child survived")
    expect_rc(name, rc, 130)
    expect_released(name)
    expect_no_next_step(fd, name)


def scenario_d(fd, name):
    deploy_like(fd, name, fast=False)


def scenario_e(fd, name):
    deploy_like(fd, name, fast=True)


def scenario_f(fd, name):
    bg = path(name, "bg")
    extra = f"""( trap '' INT; : > "{path(name, "ready")}"; exec sleep 300 ) &
echo "$!" > "{bg}\""""
    session(fd, name, write_step(name, extra, long_wait(name)))
    s = step_pid(fd, name)
    w = wrapper_pid()
    left = background_pid(name)
    in_long_wait(name)
    mark = len(text())
    send(fd, "\x03")
    found = wait_for(fd, r"vm-session: still waiting after SIGINT[^\n]*", 8,
                     "the wrapper to say what it is waiting for", mark)
    if str(left) not in found.group(0) or f"SIGTERM to {w}" not in found.group(0):
        fail(f"session {name}: the waiting message does not name {left} and the way out: {found.group(0)!r}")
    if alive(s) or not alive(left) or not alive(w):
        fail(f"session {name}: expected only the background child and the wrapper left")
    if lock_is_free() or record().split()[:1] != [str(w)]:
        fail(f"session {name}: while waiting, the lock must stay held under the wrapper's record")
    os.kill(w, signal.SIGTERM)
    rc = session_rc(fd, name, 15, "the session to end on SIGTERM")
    if alive(left):
        fail(f"session {name}: the background child survived the forwarded SIGTERM")
    expect_rc(name, rc, 130)
    expect_released(name)


def scenario_g(fd, name):
    step = write_step(name, "trap 'exit 0' TERM", body="read -r line")
    # Two commands, so the outer bash does not exec the wrapper: the wrapper is
    # then not a job of its own, and the command gets its own process group.
    mark = len(text())
    send(fd, f'bash -c "{WRAPPER} -- bash {step}; echo RC\\"\\"-{name}=\\$?"\n')
    s = step_pid(fd, name)
    w = wrapper_pid()
    if ps_field(s, "pgid") == ps_field(w, "pgid"):
        fail(f"session {name}: the command shares the wrapper's group; expected its own")
    found = wait_for(fd, r"vm-session: session process\(es\) [^\n]* are stopped[^\n]*", 5,
                     "the wrapper to report the stopped step", mark)
    if str(s) not in found.group(0) or f"kill {w}" not in found.group(0):
        fail(f"session {name}: the report does not name the step and the way out: {found.group(0)!r}")
    if "T" not in ps_field(s, "stat"):
        fail(f"session {name}: the step is not stopped (stat {ps_field(s, 'stat')!r})")
    os.kill(w, signal.SIGTERM)
    rc = session_rc(fd, name, 15, "the session to end on SIGTERM")
    if alive(s):
        fail(f"session {name}: the stopped step survived the forwarded SIGTERM")
    expect_rc(name, rc, 143)
    expect_released(name)


def terminate(*_):
    raise SystemExit(f"FAIL: stopped by signal\n{text()}")


def main():
    signal.signal(signal.SIGTERM, terminate)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("bash", ["bash", "--norc", "--noprofile", "-i"])
    known_pids.add(pid)
    try:
        send(fd, 'stty -echo; echo SHELL""-READY\n')
        wait_for(fd, r"SHELL-READY", 15, "the interactive shell")
        for round_ in range(REPEAT):
            for letter in SCENARIOS:
                globals()[f"scenario_{letter}"](fd, f"{letter}{round_}")
        send(fd, "exit\n")
        pump(fd, 1.0)
        print(f"PTY-OK {SCENARIOS} x{REPEAT}")
        known_pids.clear()
        known_groups.clear()
    finally:
        # Only after a failure: whatever is left of the shell and the sessions,
        # including a `bash -c` whose pid the driver never learned.
        for g in known_groups - {os.getpgrp()}:
            try:
                os.killpg(g, signal.SIGKILL)
            except OSError:
                pass
        for p in known_pids:
            for sig in (signal.SIGKILL, signal.SIGCONT):
                try:
                    os.kill(p, sig)
                except OSError:
                    pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass


main()
