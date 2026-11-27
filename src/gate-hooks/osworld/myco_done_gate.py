"""Myco's DONE gate for OSWorld's standard Claude runner (public-benchmark R1, #682).

Lead ruling 2026-11-27 ~13:55Z: the public R1 runs in OSWorld's OWN environment, action
server (the in-VM controller) and evaluator, with Claude via OSWorld's standard runner
(``scripts/python/run_multienv_claude.py`` at the pinned commit). Myco adds only the
completion gate before "done" is accepted. This module is that addition, plus the
self-check baseline arm the lead ruled at 15:26Z (#741 comment 7222035806, N3).

How it hooks in: ``DoneGate`` wraps the runner's agent object (``AnthropicAgent``). The
runner's loop (``lib_run_single.run_single_example``) calls ``agent.predict(instruction,
obs)`` and passes each returned action to ``env.step``. ``DoneGate.predict`` returns the
inner agent's actions unchanged, object for object, except when an action is upstream's
``DONE`` special action in arm ``gate-before-done`` or ``self-check``:

* arm ``gate-before-done`` calls ``myco.gate/v1`` (tool ``myco_gate_check``) with
  ``taskId``, ``runId`` and ``claim`` only; on ``verified`` with ``accepted: true`` the DONE
  goes through unchanged; anything else (refuted, uncertain, malformed reply, gate
  unreachable: fail closed) is a refused DONE;
* arm ``self-check`` (the stronger honest baseline, 15:26Z) has no gate, no oracle and no
  Myco verdict. It runs one fixed, task-agnostic shell probe of the saved end state
  (``SELF_CHECK_PROBE``) through upstream's own controller (``PythonController.
  run_bash_script``, the controller every arm's actions go through). The probe reads only
  the user's home directory in the guest and the task instruction the agent itself was
  given. If the probe finds a problem, or cannot run (fail closed, as the gate), the DONE is
  refused exactly as the gate arm refuses one;
* a refused DONE is replaced by upstream's own ``WAIT`` special action, which the
  controller treats as a no-op in the guest, and the next ``predict`` first appends one
  user message to the agent with the verdict and reason CODES only (never the gate's prose,
  never corrections; for the self-check, a fixed message with the probe's codes). Actions
  after a refused DONE in the same batch are dropped (upstream ends the episode at DONE, so
  none would have run).

Budget parity: the step budget is the runner's ``--max_steps`` in every arm. A refused DONE
uses the turn it was emitted in, in both arms, and the check itself (gate call or probe)
runs inside that turn: it costs no step and no model tokens, and its time counts against
the shared wall-clock cap. One check is allowed ``CHECK_TIMEOUT_S`` in both arms: the gate
client's subprocess timeout, and for the probe its script timeout plus the controller's own
fixed HTTP margin. Arm ``no-gate`` checks nothing.

The hook never sees the environment or the evaluator. Arm ``gate-before-done`` takes no
controller; arm ``self-check`` takes a zero-argument callable returning the environment's
controller and calls only its ``run_bash_script``. Arms are chosen by configuration only.

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
ARMS = ("no-gate", "gate-before-done", "self-check")
CLAIM_LIMIT = 4000

# One DONE check's time allowance, the same in both checking arms.
CHECK_TIMEOUT_S = 120
# PythonController.run_bash_script adds this fixed margin to the script timeout for its HTTP
# request (desktop_env/controllers/python.py at the pin), so a probe's allowance is
# PROBE_SCRIPT_TIMEOUT_S + CONTROLLER_HTTP_MARGIN_S = CHECK_TIMEOUT_S.
CONTROLLER_HTTP_MARGIN_S = 100
PROBE_SCRIPT_TIMEOUT_S = CHECK_TIMEOUT_S - CONTROLLER_HTTP_MARGIN_S

# Document extensions the self-check recognises in the instruction and in the home directory.
DOC_EXTENSIONS = ("xlsx", "xls", "csv", "ods", "docx", "doc", "odt", "rtf", "txt",
                  "pptx", "ppt", "odp", "pdf")
NAMED_FILE = re.compile(
    r"(?<![\w.\-])([\w\-.]+\.(?:%s))(?!\w)" % "|".join(DOC_EXTENSIONS), re.IGNORECASE)
NAMED_FILE_LIMIT = 10

# The self-check probe: a fixed bash script, the same for every task. Only the two lines it
# is given differ: the seconds since the episode started and the file names the instruction
# mentions. It reads the user's home directory in the guest (never a hidden directory), and
# prints one record per finding; ``assess_probe`` turns the records into codes. Its SHA-256
# is pinned in the pre-registration (arms[2].selfCheck.probeSha256).
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

# The self-check's codes, in the order they are reported.
SELF_CHECK_CODES = ("SAVED_FILE_MISSING", "SAVED_FILE_FORMAT_MISMATCH", "NOTHING_SAVED",
                    "RECHECK_UNAVAILABLE")


class GateError(Exception):
    """The gate could not be asked or did not answer well-formed. Never an acceptance."""


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


def self_check_feedback_text(codes):
    """The fixed, oracle-free re-check result message: the probe's codes and nothing else."""
    return (
        "Self-check: your DONE was not accepted. A re-check of the saved files in your home "
        "directory found a problem (codes %s). Continue working; when you believe the task "
        "is done, finish again." % ", ".join(codes)
    )


def named_files(instruction):
    """File names (with a document extension) the instruction mentions, in order, deduplicated."""
    out = []
    for name in NAMED_FILE.findall(instruction if isinstance(instruction, str) else ""):
        if name.lower() not in [n.lower() for n in out]:
            out.append(name)
    return out[:NAMED_FILE_LIMIT]


def probe_script(names, elapsed):
    """The probe as sent: SELF_CHECK_PROBE with its two inputs filled in, shell-quoted."""
    return SELF_CHECK_PROBE.replace("__ELAPSED__", str(int(elapsed))).replace(
        "__NAMES__", " ".join(shlex.quote(n) for n in names))


def assess_probe(result):
    """Map the controller's run_bash_script result to self-check codes; [] means no problem.

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
        if arm not in ARMS:
            raise ValueError("unknown arm: %r" % (arm,))
        if arm == "gate-before-done":
            if gate is None or not task_id or not run_id:
                raise ValueError("arm gate-before-done needs a gate, a task id and a run id")
        elif gate is not None:
            raise ValueError("arm %s takes no gate" % arm)
        if arm == "self-check":
            if not callable(controller):
                raise ValueError("arm self-check needs the controller")
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

    def __getattr__(self, name):
        return getattr(self.agent, name)

    def reset(self, *args, **kwargs):
        self.decisions = []
        self._pending = None
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
            else:
                codes = self._self_check(instruction)
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

    def _self_check(self, instruction):
        """Run the probe through the controller; any failure fails closed."""
        try:
            elapsed = int(self.clock() - self.started) + 1
            script = probe_script(named_files(instruction), elapsed)
            result = self.controller().run_bash_script(script, timeout=PROBE_SCRIPT_TIMEOUT_S)
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
    replaced with this trial's ids. ``controller`` is a zero-argument callable returning the
    environment's controller; only arm self-check receives it. Arms no-gate and self-check
    build no gate client.
    """
    gate = None
    if arm == "gate-before-done":
        if not gate_argv:
            raise ValueError("arm gate-before-done needs the gate server command")
        gate = StdioGateClient(
            [a.replace("{taskId}", task_id or "").replace("{runId}", run_id or "") for a in gate_argv]
        )
    if arm != "self-check":
        controller = None
    return DoneGate(agent, arm, gate=gate, task_id=task_id, run_id=run_id, controller=controller)
