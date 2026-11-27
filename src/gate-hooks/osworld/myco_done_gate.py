"""Myco's DONE gate for OSWorld's standard Claude runner (public-benchmark R1, #682).

Lead ruling 2026-11-27 ~13:55Z: the public R1 runs in OSWorld's OWN environment, action
server (the in-VM controller) and evaluator, with Claude via OSWorld's standard runner
(``scripts/python/run_multienv_claude.py`` at the pinned commit). Myco adds only the
completion gate before "done" is accepted. This module is that addition, plus the
self-check baseline arm (lead rulings 15:26Z and 18:11Z, #741).

How it hooks in: ``DoneGate`` wraps the runner's agent object (``AnthropicAgent``). The
runner's loop (``lib_run_single.run_single_example``) calls ``agent.predict(instruction,
obs)`` and passes each returned action to ``env.step``. ``DoneGate.predict`` returns the
inner agent's actions unchanged, object for object, except upstream's ``DONE`` special
action in the arms that check it:

* arm ``gate-before-done`` calls ``myco.gate/v1`` (tool ``myco_gate_check``) with
  ``taskId``, ``runId`` and ``claim`` only; on ``verified`` with ``accepted: true`` the DONE
  goes through unchanged; anything else (refuted, uncertain, malformed reply, gate
  unreachable: fail closed) is a refused DONE;
* arm ``self-check`` (the primary self-check arm, lead ruling 18:11Z) has no gate, no oracle
  and no Myco verdict, and the hook judges nothing. On the episode's first DONE it runs one
  fixed shell command (``SELF_CHECK_DUMP``) through the controller handle the runner patch
  passes (``ControllerHandle``: upstream's ``PythonController.run_bash_script``, the
  ``/run_bash_script`` endpoint of the desktop's own server). The command dumps the real
  saved content: the cells or text of the document files under the guest home that changed
  during the episode, or "not saved". That DONE becomes upstream's ``WAIT`` and the next
  turn hands the dump back with one fixed, oracle-free "re-verify your work against the task
  using this dump" message. The MODEL judges: its next DONE goes through unchanged. "Nothing
  saved" is never a refusal (OSWorld's own postconfig saves the open document after the
  episode on most tasks, and some tasks are graded from the application's settings, not a
  document);
* arm ``self-check-rules`` is a labelled ABLATION, never the headline baseline: the round-2
  fixed probe (``SELF_CHECK_PROBE``) whose rules refuse DONE on a missing named file, a
  container that does not match its extension, or nothing saved, on every DONE;
* a refused DONE is replaced by upstream's own ``WAIT`` special action, which the
  controller treats as a no-op in the guest, and the next ``predict`` first appends one
  user message to the agent: for the gate, the verdict and reason CODES only (never the
  gate's prose, never corrections); for the self-check, the fixed message and the dump; for
  the ablation, a fixed message with the probe's codes. Actions after a refused DONE in the
  same batch are dropped (upstream ends the episode at DONE, so none would have run).

Budget parity: the step budget is the runner's ``--max_steps`` in every arm. A refused DONE
uses the turn it was emitted in, and the check (gate call, dump or probe) runs inside that
turn: it costs no step and no model tokens, and its time counts against the shared
wall-clock cap. The gate client makes one call per checked DONE, with ``CHECK_TIMEOUT_S``.
The self-check makes exactly one ``run_bash_script`` call per episode (on the first DONE,
none on later DONEs or other turns); its script timeout plus the controller's fixed HTTP
margin is ``CHECK_TIMEOUT_S``. Upstream's controller retries a non-200 reply or a
connection error (``retry_times`` 3, ``retry_interval`` 5 s, a pause after every failed
attempt), so an unreachable desktop can hold the call for at most 3 x (120 + 5) = 375 s
before it fails closed; a read timeout returns at once. Arm ``no-gate`` checks nothing.

Integrity (lead ruling 18:11Z, B2): the hook never gets the environment. The runner patch
passes ``ControllerHandle``, built from the provider's address getter (``env.provider.
get_ip_address``), the image reference and upstream's ``PythonController`` class; nothing
in it closes over ``env``, so it has no path to DesktopEnv, the evaluator, the task
configuration or the cache directory. It exposes exactly one call, ``run_bash_script``.
Arms ``no-gate`` and ``gate-before-done`` take no handle. Arms are chosen by configuration.

Independence: this file imports only the Python standard library. It never imports
``desktop_env`` (the evaluator, getters, metrics), never reads evaluator output, gold
files, fixtures or the task configuration, and Myco's MOCK metric runner and R1 grader
never import it (test/benchmark/independence.test.ts).

Wiring: the pinned runner constructs ``AnthropicAgent`` inline. Using this hook needs a
small change there (see ``docs/benchmark/upstream/gate-hook.md``, "Patch surface"); this
repository does not vendor or modify upstream code, so that patch is documented, not
applied, until a run is approved.
"""

import json
import re
import shlex
import subprocess
import time

GATE_API_VERSION = "myco.gate/v1"
GATE_TOOL = "myco_gate_check"
# The three pre-registered arms.
ARMS = ("no-gate", "gate-before-done", "self-check")
# Labelled ablations: never a headline arm, never in the pre-registered analysis.
ABLATION_ARMS = ("self-check-rules",)
RUNNER_ARMS = ARMS + ABLATION_ARMS
SELF_CHECK_ARMS = ("self-check", "self-check-rules")
CLAIM_LIMIT = 4000

# One DONE check's time allowance, the same in every checking arm.
CHECK_TIMEOUT_S = 120
# PythonController.run_bash_script adds this fixed margin to the script timeout for its HTTP
# request (desktop_env/controllers/python.py at the pin), so a self-check call's allowance is
# PROBE_SCRIPT_TIMEOUT_S + CONTROLLER_HTTP_MARGIN_S = CHECK_TIMEOUT_S.
CONTROLLER_HTTP_MARGIN_S = 100
PROBE_SCRIPT_TIMEOUT_S = CHECK_TIMEOUT_S - CONTROLLER_HTTP_MARGIN_S
# Upstream's controller retry behaviour at the pin (PythonController.__init__).
CONTROLLER_RETRY_TIMES = 3
CONTROLLER_RETRY_INTERVAL_S = 5
# DesktopEnv's default controller port when a provider reports no ports.
DEFAULT_SERVER_PORT = 5000

# The most dump text one re-verify message carries (the dump itself caps at the same size).
DUMP_LIMIT = 6000

# The primary self-check (18:11Z): a fixed command, the same for every task. Its only input is
# the whole seconds since the episode started. It reads the guest user's home directory (never
# a hidden directory, at most 4 levels deep, no links, no other mount) and prints the content
# of every document file modified during the episode, or that nothing was saved, then END.
# Its SHA-256 is pinned in the pre-registration (arms[2].selfCheck.dumpSha256).
SELF_CHECK_DUMP = r"""#!/bin/bash
elapsed=__ELAPSED__
exec python3 -I - "${HOME:?}" "$elapsed" <<'DUMP'
import os, sys, time, zipfile
import xml.etree.ElementTree as ET

home, elapsed = sys.argv[1], int(sys.argv[2])
start = time.time() - elapsed
DOCS = (".xlsx", ".xls", ".csv", ".ods", ".docx", ".doc", ".odt", ".rtf", ".txt",
        ".pptx", ".ppt", ".odp", ".pdf")
PER_FILE, TOTAL, MAX_FILES = 2000, 6000, 20


def changed():
    found = []
    for d, dirs, names in os.walk(home):
        depth = d[len(home):].count(os.sep)
        dirs[:] = sorted(x for x in dirs if not x.startswith(".")
                         and not os.path.islink(os.path.join(d, x))
                         and not os.path.ismount(os.path.join(d, x))) if depth < 3 else []
        for n in sorted(names):
            p = os.path.join(d, n)
            if n.startswith(".") or not n.lower().endswith(DOCS) or os.path.islink(p):
                continue
            try:
                if os.path.isfile(p) and os.path.getmtime(p) >= start:
                    found.append(p)
            except OSError:
                pass
    return found


def local(tag):
    return tag.rsplit("}", 1)[-1]


def attr(el, name):
    for k, v in el.attrib.items():
        if local(k) == name:
            return v
    return None


def text(el):
    return "".join(el.itertext())


def col(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def xlsx(z, members):
    shared = []
    if "xl/sharedStrings.xml" in members:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")):
            shared.append("".join(t.text or "" for t in si.iter() if local(t.tag) == "t"))
    rels = {}
    if "xl/_rels/workbook.xml.rels" in members:
        for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")):
            rels[r.get("Id")] = r.get("Target") or ""
    out = []
    for s in ET.fromstring(z.read("xl/workbook.xml")).iter():
        if local(s.tag) != "sheet":
            continue
        target = rels.get(attr(s, "id"), "")
        part = target.lstrip(os.sep) if target.startswith(os.sep) else "xl" + os.sep + target
        out.append("[sheet %s]" % s.get("name"))
        if part not in members:
            continue
        for c in ET.fromstring(z.read(part)).iter():
            if local(c.tag) != "c":
                continue
            v = f = None
            for ch in c:
                if local(ch.tag) == "v":
                    v = ch.text
                elif local(ch.tag) == "f":
                    f = ch.text
                elif local(ch.tag) == "is":
                    v = text(ch)
            if c.get("t") == "s" and v is not None and v.isdigit() and int(v) < len(shared):
                v = shared[int(v)]
            if v is None and f is None:
                continue
            out.append("%s=%s%s" % (c.get("r"), v if v is not None else "",
                                    " (formula =%s)" % f if f else ""))
    return out


def ods(z):
    out = []
    for t in ET.fromstring(z.read("content.xml")).iter():
        if local(t.tag) != "table":
            continue
        out.append("[sheet %s]" % attr(t, "name"))
        r = 0
        for row in t.iter():
            if local(row.tag) != "table-row":
                continue
            r += 1
            c = 0
            for cell in row:
                if local(cell.tag) not in ("table-cell", "covered-table-cell"):
                    continue
                c += 1
                value = None
                for k in ("value", "date-value", "time-value", "boolean-value", "string-value"):
                    value = value if value is not None else attr(cell, k)
                shown = text(cell)
                f = attr(cell, "formula")
                if value is not None or shown or f:
                    out.append("%s%d=%s%s" % (col(c), r, shown if shown else value,
                                              " (formula %s)" % f if f else ""))
                c += int(attr(cell, "number-columns-repeated") or 1) - 1
            r += int(attr(row, "number-rows-repeated") or 1) - 1
    return out


def paragraphs(root, kinds=("p", "h")):
    return [text(p) for p in root.iter() if local(p.tag) in kinds and text(p).strip()]


def pptx(z, members):
    out = []
    slides = sorted((m for m in members if m.startswith("ppt/slides/slide") and m.endswith(".xml")),
                    key=lambda m: int("".join(ch for ch in m if ch.isdigit()) or 0))
    for i, m in enumerate(slides, 1):
        out.append("[slide %d]" % i)
        out.extend(paragraphs(ET.fromstring(z.read(m)), ("p",)))
    return out


def odp(z):
    out = []
    for page in ET.fromstring(z.read("content.xml")).iter():
        if local(page.tag) == "page":
            out.append("[slide %s]" % attr(page, "name"))
            out.extend(paragraphs(page))
    return out


def content(p):
    ext = os.path.splitext(p)[1].lower()
    if ext in (".csv", ".txt", ".rtf"):
        with open(p, "rb") as fh:
            return fh.read(PER_FILE + 1).decode("utf-8", "replace").splitlines()
    if ext in (".xls", ".doc", ".ppt", ".pdf"):
        return ["(binary %s file, content not dumped)" % ext]
    with zipfile.ZipFile(p) as z:
        members = set(z.namelist())
        if ext == ".xlsx":
            return xlsx(z, members)
        if ext == ".docx":
            return paragraphs(ET.fromstring(z.read("word/document.xml")), ("p",))
        if ext == ".pptx":
            return pptx(z, members)
        if ext == ".ods":
            return ods(z)
        if ext == ".odp":
            return odp(z)
        return paragraphs(ET.fromstring(z.read("content.xml")))


files = changed()
budget = TOTAL
if not files:
    print("NOT SAVED: no document file under the home directory was saved during this episode.")
for p in files[:MAX_FILES]:
    rel = "~" + p[len(home):]
    print("=== %s (%d bytes, saved %d s after the episode started) ==="
          % (rel, os.path.getsize(p), max(0, int(os.path.getmtime(p) - start))))
    try:
        body = "\n".join(content(p)) or "(no cells or text)"
    except Exception as exc:
        body = "(could not read: %s)" % type(exc).__name__
    if len(body) > min(PER_FILE, budget):
        body = body[:min(PER_FILE, budget)] + "\n[truncated]"
    budget = max(0, budget - len(body))
    print(body)
if len(files) > MAX_FILES:
    print("[%d more files not shown]" % (len(files) - MAX_FILES))
print("END")
DUMP
"""

# The fixed, oracle-free re-verify message (18:11Z). The dump follows it.
SELF_CHECK_REVERIFY = (
    "Self-check: before your DONE is accepted, re-verify your work against the task using "
    "this dump of the saved state. It lists the document files under your home directory "
    "that were saved during this episode, with their cell values or text, or says that none "
    "were saved. Check every requirement of the task against it and against the screen. If "
    "anything is wrong or missing, fix it. When you are satisfied the task is complete, "
    "finish again. This re-check happens once per task."
)
DUMP_UNAVAILABLE = "DUMP_UNAVAILABLE"

# ABLATION only (self-check-rules): the round-2 fixed probe. Only the two lines it is given
# differ: the seconds since the episode started and the file names the instruction mentions.
# Its SHA-256 is pinned in the pre-registration (ablations[0].probeSha256).
DOC_EXTENSIONS = ("xlsx", "xls", "csv", "ods", "docx", "doc", "odt", "rtf", "txt",
                  "pptx", "ppt", "odp", "pdf")
NAMED_FILE = re.compile(
    r"(?<![\w.\-])([\w\-.]+\.(?:%s))(?!\w)" % "|".join(DOC_EXTENSIONS), re.IGNORECASE)
NAMED_FILE_LIMIT = 10

SELF_CHECK_PROBE = r"""#!/bin/bash
elapsed=__ELAPSED__
names=(__NAMES__)
root="${HOME:?}"
start=$(( $(date +%s) - elapsed ))
fmt() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    *.xlsx|*.docx|*.pptx) python3 -m zipfile -l "$1" 2>/dev/null | grep -q '^\[Content_Types\]\.xml ' ;;
    *.ods|*.odt|*.odp) python3 -m zipfile -l "$1" 2>/dev/null | grep -q '^mimetype ' ;;
    *.pdf) [ "$(head -c 5 "$1" 2>/dev/null)" = "%PDF-" ] ;;
    *) [ -r "$1" ] ;;
  esac
}
report() {
  if fmt "$1"; then printf 'FORMAT_OK\t%s\n' "$1"; else printf 'FORMAT_BAD\t%s\n' "$1"; fi
}
for n in "${names[@]}"; do
  p=$(find "$root" -xdev -maxdepth 4 -type f -iname "$n" -not -path '*/.*' -print -quit 2>/dev/null)
  if [ -z "$p" ]; then printf 'MISSING\t%s\n' "$n"; else report "$p"; fi
done
saved=0
while IFS= read -r p; do
  saved=$((saved + 1))
  report "$p"
done < <(find "$root" -xdev -maxdepth 4 -type f \( -iname '*.xlsx' -o -iname '*.xls' -o -iname '*.csv' -o -iname '*.ods' -o -iname '*.docx' -o -iname '*.doc' -o -iname '*.odt' -o -iname '*.rtf' -o -iname '*.txt' -o -iname '*.pptx' -o -iname '*.ppt' -o -iname '*.odp' -o -iname '*.pdf' \) -not -path '*/.*' -newermt "@$start" -print 2>/dev/null | head -n 50)
printf 'SAVED\t%d\n' "$saved"
printf 'END\n'
"""

# The ablation's codes, in the order they are reported.
SELF_CHECK_CODES = ("SAVED_FILE_MISSING", "SAVED_FILE_FORMAT_MISMATCH", "NOTHING_SAVED",
                    "RECHECK_UNAVAILABLE")


class GateError(Exception):
    """The gate could not be asked or did not answer well-formed. Never an acceptance."""


class ControllerHandle:
    """The self-check's only route to the desktop (lead ruling 18:11Z, B2).

    Built by the runner patch from three things, none of which closes over the environment:
    the provider's address getter (``env.provider.get_ip_address``, a bound method of the
    provider, which holds no reference to DesktopEnv, its task configuration, its evaluator
    or its cache directory), the image reference it takes, and upstream's ``PythonController``
    class. Each call builds that controller from the address the provider reports, exactly as
    ``DesktopEnv._start_emulator`` builds ``env.controller`` (so it talks to the same
    ``desktop_env/server`` in the same desktop), and calls its ``run_bash_script``. That is the
    one call this handle exposes.
    """

    __slots__ = ("_address", "_vm_path", "_controller_class")

    def __init__(self, address, vm_path, controller_class):
        if not callable(address) or not isinstance(controller_class, type):
            raise ValueError("a controller handle needs the provider's address getter and "
                             "the controller class")
        self._address = address
        self._vm_path = vm_path
        self._controller_class = controller_class

    def run_bash_script(self, script, timeout):
        host, port = parse_address(self._address(self._vm_path))
        controller = self._controller_class(vm_ip=host, server_port=port)
        return controller.run_bash_script(script, timeout=timeout)


def parse_address(text):
    """DesktopEnv._start_emulator's parse: "<host>:<server>:<chromium>:<vnc>:<vlc>" or "<host>"."""
    parts = str(text).rsplit(":", 4)
    if len(parts) == 5:
        return parts[0], int(parts[1])
    return parts[0], DEFAULT_SERVER_PORT


def is_done(action):
    """True for upstream's DONE special action, as a string or as an action dict."""
    if action == "DONE":
        return True
    return isinstance(action, dict) and action.get("action_type") == "DONE"


def gate_request(task_id, run_id, claim):
    """The only request shape the hook sends: taskId, runId, claim."""
    text = claim if isinstance(claim, str) else ""
    return {"taskId": task_id, "runId": run_id, "claim": text[:CLAIM_LIMIT]}


def decide(reply):
    """Map a gate reply to (accepted, verdict, codes). Fail closed on anything malformed."""
    if not isinstance(reply, dict):
        return False, "uncertain", ["GATE_REPLY_MALFORMED"]
    verdict = reply.get("verdict")
    codes = reply.get("reasonCodes")
    if verdict not in ("verified", "refuted", "uncertain"):
        return False, "uncertain", ["GATE_REPLY_MALFORMED"]
    if not isinstance(codes, list) or not all(isinstance(c, str) for c in codes):
        return False, "uncertain", ["GATE_REPLY_MALFORMED"]
    if reply.get("apiVersion") != GATE_API_VERSION:
        return False, "uncertain", ["GATE_REPLY_MALFORMED"]
    accepted = verdict == "verified" and reply.get("accepted") is True
    return accepted, verdict, list(codes)


def feedback_text(verdict, codes):
    """The only text the agent ever gets from the gate: the verdict and reason codes."""
    return (
        "Myco completion gate: your DONE was not accepted (verdict %s; codes %s). "
        "The task is not complete according to the saved state. Continue working; when you "
        "believe the task is done, finish again." % (verdict, ", ".join(codes) or "none")
    )


def dump_script(elapsed):
    """The dump as sent: SELF_CHECK_DUMP with its one input filled in."""
    return SELF_CHECK_DUMP.replace("__ELAPSED__", str(int(elapsed)))


def assess_dump(result):
    """The dump text from the controller's run_bash_script result, or None if it is unusable.

    Unusable (fail closed: the re-verify turn still happens, with no dump): no result, a
    non-zero exit, output that does not end with the END record, or nothing before it.
    """
    if not isinstance(result, dict) or result.get("returncode") != 0:
        return None
    output = result.get("output")
    if not isinstance(output, str):
        return None
    lines = output.splitlines()
    if not lines or lines[-1] != "END":
        return None
    body = "\n".join(lines[:-1]).strip()
    if not body:
        return None
    return body[:DUMP_LIMIT]


def reverify_text(dump):
    """The re-verify message: the fixed text, then the dump (or that it is unavailable)."""
    shown = dump if dump is not None else "(the dump is unavailable: %s)" % DUMP_UNAVAILABLE
    return "%s\n\n<dump>\n%s\n</dump>" % (SELF_CHECK_REVERIFY, shown)


def self_check_feedback_text(codes):
    """ABLATION: the fixed re-check result message, the probe's codes and nothing else."""
    return (
        "Self-check: your DONE was not accepted. A re-check of the saved files in your home "
        "directory found a problem (codes %s). Continue working; when you believe the task "
        "is done, finish again." % ", ".join(codes)
    )


def named_files(instruction):
    """ABLATION: file names (with a document extension) the instruction mentions."""
    out = []
    for name in NAMED_FILE.findall(instruction if isinstance(instruction, str) else ""):
        if name.lower() not in [n.lower() for n in out]:
            out.append(name)
    return out[:NAMED_FILE_LIMIT]


def probe_script(names, elapsed):
    """ABLATION: SELF_CHECK_PROBE with its two inputs filled in, shell-quoted."""
    return SELF_CHECK_PROBE.replace("__ELAPSED__", str(int(elapsed))).replace(
        "__NAMES__", " ".join(shlex.quote(n) for n in names))


def assess_probe(result):
    """ABLATION: map the probe's run_bash_script result to codes; [] means no problem.

    Fails closed: no result, a non-zero exit, or output without the final END and SAVED
    records is RECHECK_UNAVAILABLE.
    """
    if not isinstance(result, dict) or result.get("returncode") != 0:
        return ["RECHECK_UNAVAILABLE"]
    output = result.get("output")
    if not isinstance(output, str):
        return ["RECHECK_UNAVAILABLE"]
    lines = output.splitlines()
    if not lines or lines[-1] != "END":
        return ["RECHECK_UNAVAILABLE"]
    saved = [line.split("\t", 1)[1] for line in lines if line.startswith("SAVED\t")]
    if len(saved) != 1 or not saved[0].isdigit():
        return ["RECHECK_UNAVAILABLE"]
    codes = []
    if any(line.startswith("MISSING\t") for line in lines):
        codes.append("SAVED_FILE_MISSING")
    if any(line.startswith("FORMAT_BAD\t") for line in lines):
        codes.append("SAVED_FILE_FORMAT_MISMATCH")
    if int(saved[0]) == 0:
        codes.append("NOTHING_SAVED")
    return codes


def append_user_message(agent, text):
    """Default feedback channel: one user turn in AnthropicAgent's own ``messages`` list."""
    agent.messages.append({"role": "user", "content": [{"type": "text", "text": text}]})


class DoneGate:
    """Wraps the runner's agent. Only DONE handling differs between arms."""

    def __init__(self, agent, arm, gate=None, task_id=None, run_id=None, feedback=None,
                 controller=None, clock=time.monotonic):
        if arm not in RUNNER_ARMS:
            raise ValueError("unknown arm: %r" % (arm,))
        if arm == "gate-before-done":
            if gate is None or not task_id or not run_id:
                raise ValueError("arm gate-before-done needs a gate, a task id and a run id")
        elif gate is not None:
            raise ValueError("arm %s takes no gate" % arm)
        if arm in SELF_CHECK_ARMS:
            if not isinstance(controller, ControllerHandle):
                raise ValueError("arm %s needs a ControllerHandle" % arm)
        elif controller is not None:
            raise ValueError("arm %s takes no controller" % arm)
        self.agent = agent
        self.arm = arm
        self.gate = gate
        self.controller = controller
        self.task_id = task_id
        self.run_id = run_id
        self.feedback = feedback or append_user_message
        self.clock = clock
        self.started = clock()
        self.decisions = []
        self._pending = None
        self._reverified = False

    def __getattr__(self, name):
        return getattr(self.agent, name)

    def reset(self, *args, **kwargs):
        self.decisions = []
        self._pending = None
        self._reverified = False
        self.started = self.clock()
        return self.agent.reset(*args, **kwargs)

    def predict(self, instruction, obs=None, *args, **kwargs):
        if self._pending is not None:
            self.feedback(self.agent, self._pending)
            self._pending = None
        response, actions = self.agent.predict(instruction, obs, *args, **kwargs)
        if self.arm == "no-gate":
            return response, actions
        out = []
        for action in actions:
            if not is_done(action):
                out.append(action)
                continue
            if self.arm == "gate-before-done":
                accepted, verdict, codes = self._check(response)
                self.decisions.append(
                    {"verdict": verdict, "accepted": accepted, "reasonCodes": codes})
                pending = feedback_text(verdict, codes)
            elif self.arm == "self-check":
                accepted, pending = self._reverify()
            else:
                codes = self._rules_check(instruction)
                accepted = not codes
                self.decisions.append({"selfCheck": "ok" if accepted else "problem",
                                       "accepted": accepted, "reasonCodes": codes})
                pending = self_check_feedback_text(codes)
            if accepted:
                out.append(action)
            else:
                out.append({"action_type": "WAIT"} if isinstance(action, dict) else "WAIT")
                self._pending = pending
            break
        return response, out

    def _check(self, response):
        try:
            reply = self.gate.check(gate_request(self.task_id, self.run_id, response))
        except Exception:  # noqa: BLE001 - any gate failure fails closed
            return False, "uncertain", ["GATE_UNAVAILABLE"]
        return decide(reply)

    def _reverify(self):
        """Primary self-check: the first DONE gets the dump and a re-verify turn; the model judges."""
        if self._reverified:
            self.decisions.append({"selfCheck": "model-finished", "accepted": True,
                                   "reasonCodes": []})
            return True, None
        self._reverified = True
        dump = self._dump()
        self.decisions.append({"selfCheck": "reverify", "accepted": False,
                               "reasonCodes": [] if dump is not None else [DUMP_UNAVAILABLE]})
        return False, reverify_text(dump)

    def _dump(self):
        """One run_bash_script call through the handle; any failure is no dump (fail closed)."""
        try:
            elapsed = int(self.clock() - self.started) + 1
            result = self.controller.run_bash_script(dump_script(elapsed),
                                                     timeout=PROBE_SCRIPT_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - any controller failure fails closed
            return None
        return assess_dump(result)

    def _rules_check(self, instruction):
        """ABLATION: run the fixed probe through the handle; any failure fails closed."""
        try:
            elapsed = int(self.clock() - self.started) + 1
            script = probe_script(named_files(instruction), elapsed)
            result = self.controller.run_bash_script(script, timeout=PROBE_SCRIPT_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - any controller failure fails closed
            return ["RECHECK_UNAVAILABLE"]
        return assess_probe(result)


class StdioGateClient:
    """Calls the ``myco-gate`` MCP server (src/gate/mcp-server.ts) over stdio.

    ``argv`` is the operator's command for the server, already bound to one task and one
    run (the gate is bound to one trial). Nothing secret passes through argv or the
    environment here; the server reads its own operator config.
    """

    def __init__(self, argv, timeout=CHECK_TIMEOUT_S):
        self.argv = list(argv)
        self.timeout = timeout

    def check(self, request):
        lines = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "myco-osworld-done-gate", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": GATE_TOOL, "arguments": request}},
        ]
        wire = "".join(json.dumps(m) + "\n" for m in lines)
        try:
            done = subprocess.run(self.argv, input=wire, capture_output=True, text=True,
                                  timeout=self.timeout, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            raise GateError("GATE_UNAVAILABLE") from exc
        for line in done.stdout.splitlines():
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") == 2:
                result = msg.get("result")
                if not isinstance(result, dict):
                    raise GateError("GATE_REPLY_MALFORMED")
                return result.get("structuredContent")
        raise GateError("GATE_NO_REPLY")


def wrap_agent(agent, arm, gate_argv=None, task_id=None, run_id=None, controller=None):
    """Entry point for the runner patch, called once per task (the gate is bound to one trial).

    ``gate_argv`` is the operator's server command; ``{taskId}`` and ``{runId}`` in it are
    replaced with this trial's ids. ``controller`` is the ``ControllerHandle`` the patch
    builds; only the self-check arms keep it. Arms other than gate-before-done build no gate
    client.
    """
    gate = None
    if arm == "gate-before-done":
        if not gate_argv:
            raise ValueError("arm gate-before-done needs the gate server command")
        gate = StdioGateClient(
            [a.replace("{taskId}", task_id or "").replace("{runId}", run_id or "") for a in gate_argv]
        )
    if arm not in SELF_CHECK_ARMS:
        controller = None
    return DoneGate(agent, arm, gate=gate, task_id=task_id, run_id=run_id, controller=controller)
