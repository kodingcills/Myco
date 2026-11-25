"""Drive scripts/vm-session.sh from an interactive bash on a pseudo-terminal.

Used by test/vm-session.test.ts ("under a terminal ..."). Run as
    python3 -I vm-session-pty.py <wrapper> <work dir>
with MYCO_VM_LOCK_PATH set to a private lock path and GUARD to scripts/vm-lock.sh.

Every session uses the runbook's multi-step form, `bash -c '<step>; <next step>'`,
and the step accepts the session lock (vm_lock_owned_by_parent) before it loops:
  A. Ctrl-Z stops the whole job (wrapper and step), the shell gets the terminal
     back, the step does not run on while stopped, and `fg` resumes it: the step
     finishes, the next step runs, and the session exits 0.
  B. Ctrl-C ends the session: 130, no step left, the record cleared, the lock
     free, and the next step never runs.
  C. A SIGTERM sent to the wrapper alone, with a step that is slow to stop:
     143 only once the step has gone.
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


def wait_for(fd, pattern, seconds, what):
    end = time.time() + seconds
    regex = re.compile(pattern)
    while time.time() < end:
        found = regex.search(transcript.decode(errors="replace"))
        if found:
            return found
        pump(fd, 0.05)
    fail(f"timed out after {seconds}s waiting for {what} ({pattern!r})")


def send(fd, text):
    os.write(fd, text.encode())


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


def write_step(name, extra=""):
    step = os.path.join(WORK, f"{name}.sh")
    with open(step, "w") as f:
        f.write(
            f"""source "$GUARD"
vm_lock_owned_by_parent || {{ echo STEP-NOT-INHERITED; exit 9; }}
{extra}
echo $$ > "{WORK}/{name}.pid"
echo STEP-STARTED-{name}
while [ ! -e "{WORK}/{name}.go" ]; do sleep 0.1; done
echo STEP-DONE-{name}
"""
        )
    return step


def session(fd, step, tail=""):
    # NEXT""-STEP-RAN keeps the typed line from matching what the next step prints.
    send(fd, f"{WRAPPER} -- bash -c 'bash {step}; echo NEXT\"\"-STEP-RAN-{os.path.basename(step)}'{tail}\n")


def step_pid(fd, name):
    wait_for(fd, f"STEP-STARTED-{name}", 15, f"step {name} to start under the session")
    with open(os.path.join(WORK, f"{name}.pid")) as f:
        pid = int(f.read().strip())
    known_pids.add(pid)
    known_groups.add(os.getpgid(pid))
    return pid


def wrapper_pid():
    fields = record().split()
    if len(fields) != 2 or fields[1] != "vm-session.sh":
        fail(f"expected a vm-session.sh record while the session runs, got {record()!r}")
    known_pids.add(int(fields[0]))
    return int(fields[0])


def check_done(name, rc, code):
    if rc != code:
        fail(f"session {name}: exit {rc}, expected {code}")


def terminate(*_):
    raise SystemExit(f"FAIL: stopped by signal\n{transcript.decode(errors='replace')}")


def main():
    signal.signal(signal.SIGTERM, terminate)
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("bash", ["bash", "--norc", "--noprofile", "-i"])
    known_pids.add(pid)
    try:
        send(fd, "stty -echo; echo SHELL\"\"-READY\n")
        wait_for(fd, r"SHELL-READY", 15, "the interactive shell")

        # A: Ctrl-Z stops the whole job, `fg` resumes it and it completes.
        step = write_step("a")
        session(fd, step)
        a = step_pid(fd, "a")
        w = wrapper_pid()
        if ps_field(a, "pgid") != str(w):
            fail(f"step a runs in group {ps_field(a, 'pgid')}, not the wrapper's job {w}")
        send(fd, "\x1a")
        wait_for(fd, r"Stopped", 10, "the shell to report the job stopped (it has the terminal back)")
        for who, p in (("wrapper", w), ("step", a)):
            if "T" not in ps_field(p, "stat"):
                fail(f"after Ctrl-Z the {who} is not stopped (stat {ps_field(p, 'stat')!r})")
        if lock_is_free():
            fail("the lock went free while the session was stopped")
        open(os.path.join(WORK, "a.go"), "w").close()
        pump(fd, 1.0)
        if "STEP-DONE-a" in transcript.decode(errors="replace"):
            fail("the step ran on while the job was stopped")
        send(fd, "fg; echo FG\"\"RC=$?\n")
        found = wait_for(fd, r"FGRC=(\d+)", 15, "the resumed session to finish")
        text = transcript.decode(errors="replace")
        if "STEP-DONE-a" not in text or "NEXT-STEP-RAN-a.sh" not in text:
            fail("after fg the step did not finish and hand over to the next step")
        check_done("a", int(found.group(1)), 0)
        if record() != "" or not lock_is_free():
            fail(f"after session a: record {record()!r}, lock free {lock_is_free()}")

        # B: Ctrl-C ends the session, with nothing left behind.
        step = write_step("b")
        session(fd, step, "; echo B\"\"RC=$?")
        b = step_pid(fd, "b")
        wrapper_pid()
        send(fd, "\x03")
        found = wait_for(fd, r"BRC=(\d+)", 15, "the session to end on Ctrl-C")
        check_done("b", int(found.group(1)), 130)
        if alive(b):
            fail("a step survived Ctrl-C")
        if record() != "" or not lock_is_free():
            fail(f"after Ctrl-C: record {record()!r}, lock free {lock_is_free()}")
        pump(fd, 0.3)
        if "NEXT-STEP-RAN-b.sh" in transcript.decode(errors="replace"):
            fail("the next step ran after Ctrl-C")

        # C: a SIGTERM to the wrapper alone waits for a step that is slow to stop.
        step = write_step("c", "trap 'sleep 0.5; exit 0' TERM")
        session(fd, step, "; echo C\"\"RC=$?")
        c = step_pid(fd, "c")
        os.kill(wrapper_pid(), signal.SIGTERM)
        found = wait_for(fd, r"CRC=(\d+)", 15, "the session to end on SIGTERM")
        if alive(c):
            fail("the wrapper returned while a step was still stopping")
        check_done("c", int(found.group(1)), 143)
        if record() != "" or not lock_is_free():
            fail(f"after SIGTERM: record {record()!r}, lock free {lock_is_free()}")
        pump(fd, 0.3)
        if "NEXT-STEP-RAN-c.sh" in transcript.decode(errors="replace"):
            fail("the next step ran after SIGTERM")

        send(fd, "exit\n")
        pump(fd, 1.0)
        print("PTY-OK")
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
