"""Myco's DONE gate for OSWorld's standard Claude runner (public-benchmark R1, #682).

Lead ruling 2026-11-27 ~13:55Z: the public R1 runs in OSWorld's OWN environment, action
server (the in-VM controller) and evaluator, with Claude via OSWorld's standard runner
(``scripts/python/run_multienv_claude.py`` at the pinned commit). Myco adds only the
completion gate before "done" is accepted. This module is that addition and nothing else.

How it hooks in: ``DoneGate`` wraps the runner's agent object (``AnthropicAgent``). The
runner's loop (``lib_run_single.run_single_example``) calls ``agent.predict(instruction,
obs)`` and passes each returned action to ``env.step``. ``DoneGate.predict`` returns the
inner agent's actions unchanged, object for object, except in arm ``gate-before-done`` when
an action is upstream's ``DONE`` special action:

* it calls ``myco.gate/v1`` (tool ``myco_gate_check``) with ``taskId``, ``runId`` and
  ``claim`` only;
* on ``verified`` with ``accepted: true`` the DONE goes through unchanged;
* otherwise (refuted, uncertain, malformed reply, gate unreachable: fail closed) the DONE is
  replaced by upstream's own ``WAIT`` special action, which the controller treats as a
  no-op in the guest, and the next ``predict`` first appends one user message to the agent
  telling it the verdict and reason CODES (never the gate's prose, never corrections).
  Actions after a refused DONE in the same batch are dropped (upstream ends the episode at
  DONE, so none would have run).

The hook never sees the environment, the controller or the evaluator: it takes only the
agent, so the action layer and the observation path are the runner's own in every arm.
Arms ``no-gate`` and ``self-check`` bypass the gate by configuration (no gate client is
accepted); ``self-check`` sets upstream's own ``system_prompt_suffix`` attribute to the
pre-registered self-verification text. The step budget is the runner's ``--max_steps`` in
every arm: a refused DONE uses the step it was emitted in, as any other turn does.

Independence: this file imports only the Python standard library. It never imports
``desktop_env`` (the evaluator, getters, metrics), never reads evaluator output or gold
files, and Myco's MOCK metric runner and R1 grader never import it
(test/benchmark/independence.test.ts).

Wiring: the pinned runner constructs ``AnthropicAgent`` inline. Using this hook needs a
3-line change there (see ``docs/benchmark/upstream/gate-hook.md``, "Patch surface"); this
repository does not vendor or modify upstream code, so that patch is documented, not
applied, until a run is approved.
"""

import json
import subprocess

GATE_API_VERSION = "myco.gate/v1"
GATE_TOOL = "myco_gate_check"
ARMS = ("no-gate", "gate-before-done", "self-check")
CLAIM_LIMIT = 4000

# The pre-registered prompt-level self-verification for arm (c). Appended through
# AnthropicAgent's own ``system_prompt_suffix`` attribute; the budget is unchanged.
SELF_CHECK_SUFFIX = (
    "Before you finish, verify your own work. Take a screenshot and check every "
    "requirement of the task against what is actually on screen and in the saved file: the "
    "exact values, the cells, text or slides the task names, nothing else changed, and the "
    "document saved under the requested name, location and format. If anything is wrong or "
    "unsaved, fix it and check again. Only stop calling tools when you have checked that the "
    "task is fully complete."
)


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


def append_user_message(agent, text):
    """Default feedback channel: one user turn in AnthropicAgent's own ``messages`` list."""
    agent.messages.append({"role": "user", "content": [{"type": "text", "text": text}]})


class DoneGate:
    """Wraps the runner's agent. Only DONE handling differs between arms."""

    def __init__(self, agent, arm, gate=None, task_id=None, run_id=None, feedback=None):
        if arm not in ARMS:
            raise ValueError("unknown arm: %r" % (arm,))
        if arm == "gate-before-done":
            if gate is None or not task_id or not run_id:
                raise ValueError("arm gate-before-done needs a gate, a task id and a run id")
        elif gate is not None:
            raise ValueError("arm %s takes no gate" % arm)
        self.agent = agent
        self.arm = arm
        self.gate = gate
        self.task_id = task_id
        self.run_id = run_id
        self.feedback = feedback or append_user_message
        self.decisions = []
        self._pending = None
        if arm == "self-check":
            existing = getattr(agent, "system_prompt_suffix", "") or ""
            if SELF_CHECK_SUFFIX not in existing:  # the runner reuses one agent across tasks
                agent.system_prompt_suffix = (existing + " " + SELF_CHECK_SUFFIX).strip()

    def __getattr__(self, name):
        return getattr(self.agent, name)

    def reset(self, *args, **kwargs):
        self.decisions = []
        self._pending = None
        return self.agent.reset(*args, **kwargs)

    def predict(self, instruction, obs=None, *args, **kwargs):
        if self._pending is not None:
            self.feedback(self.agent, self._pending)
            self._pending = None
        response, actions = self.agent.predict(instruction, obs, *args, **kwargs)
        if self.arm != "gate-before-done":
            return response, actions
        out = []
        for action in actions:
            if not is_done(action):
                out.append(action)
                continue
            accepted, verdict, codes = self._check(response)
            self.decisions.append({"verdict": verdict, "accepted": accepted, "reasonCodes": codes})
            if accepted:
                out.append(action)
            else:
                out.append({"action_type": "WAIT"} if isinstance(action, dict) else "WAIT")
                self._pending = feedback_text(verdict, codes)
            break
        return response, out

    def _check(self, response):
        try:
            reply = self.gate.check(gate_request(self.task_id, self.run_id, response))
        except Exception:  # noqa: BLE001 - any gate failure fails closed
            return False, "uncertain", ["GATE_UNAVAILABLE"]
        return decide(reply)


class StdioGateClient:
    """Calls the ``myco-gate`` MCP server (src/gate/mcp-server.ts) over stdio.

    ``argv`` is the operator's command for the server, already bound to one task and one
    run (the gate is bound to one trial). Nothing secret passes through argv or the
    environment here; the server reads its own operator config.
    """

    def __init__(self, argv, timeout=120.0):
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


def wrap_agent(agent, arm, gate_argv=None, task_id=None, run_id=None):
    """Entry point for the runner patch, called once per task (the gate is bound to one trial).

    ``gate_argv`` is the operator's server command; ``{taskId}`` and ``{runId}`` in it are
    replaced with this trial's ids. Arms no-gate and self-check build no client.
    """
    gate = None
    if arm == "gate-before-done":
        if not gate_argv:
            raise ValueError("arm gate-before-done needs the gate server command")
        gate = StdioGateClient(
            [a.replace("{taskId}", task_id or "").replace("{runId}", run_id or "") for a in gate_argv]
        )
    return DoneGate(agent, arm, gate=gate, task_id=task_id, run_id=run_id)
