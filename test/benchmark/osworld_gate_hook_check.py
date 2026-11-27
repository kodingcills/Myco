"""Scenario driver for test/benchmark/osworld-gate-hook.test.ts (MOCK, plumbing only).

Runs Myco's DONE gate hook (src/gate-hooks/osworld/myco_done_gate.py) with a scripted fake
agent, a fake environment and a fake gate, under the three R1 arms, and writes
<work_dir>/report.json. The TypeScript test makes every assertion; this file only records what happened.

    python3 -I osworld_gate_hook_check.py <hook_dir> <work_dir> [<osworld_checkout>]

With an OSWorld checkout at the pinned commit, the same scenarios also run through the REAL
upstream loop, ``lib_run_single.run_single_example`` (its third-party import
``wrapt_timeout_decorator`` and an os_symphony drawing helper that needs Pillow are stubbed;
its fixed sleeps are skipped), and the report
records what that loop handed to ``env.step`` and the score ``env.evaluate()`` returned,
which upstream writes to result.txt. No VM, no model, no network: every agent turn, screen
and score below is scripted.
"""

import importlib
import json
import os
import sys
import types

HOOK_DIR, WORK = sys.argv[1], sys.argv[2]
OSWORLD = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
sys.path.insert(0, HOOK_DIR)
import myco_done_gate as hook  # noqa: E402

CLICK = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.click(10, 20)\n"}
TYPE = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.typewrite('42')\n"}
SAVE = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.hotkey('ctrl', 's')\n"}
DONE = {"action_type": "DONE", "raw_response": "I have finished the task."}


class FakeAgent:
    """Scripted turns; records exactly what the runner and the hook hand it."""

    def __init__(self, turns):
        self.turns = [list(t) for t in turns]
        self.messages = []
        self.system_prompt_suffix = ""
        self.seen_obs = []
        self.resets = 0

    def reset(self, *args, **kwargs):
        self.resets += 1

    def predict(self, instruction, obs=None):
        self.seen_obs.append((obs or {}).get("screenshot", b"").hex())
        turn = self.turns.pop(0) if self.turns else [dict(DONE)]
        self.messages.append({"role": "assistant", "content": [{"type": "text", "text": "turn"}]})
        return "I have finished the task.", [dict(a) for a in turn]


class FakeController:
    def start_recording(self):
        pass

    def end_recording(self, path):
        pass


class FakeEnv:
    """Mirrors DesktopEnv.step's contract: DONE/FAIL end the episode, WAIT is a no-op."""

    def __init__(self, score):
        self.score = score
        self.received = []
        self.evaluations = 0
        self.vm_ip = "127.0.0.1"
        self.controller = FakeController()
        self.n = 0

    def reset(self, task_config=None):
        self.n = 0

    def _obs(self):
        return {"screenshot": ("screen-%d" % self.n).encode()}

    def _get_obs(self):
        return self._obs()

    def step(self, action, pause=2):
        self.received.append(json.dumps(action, sort_keys=True))
        self.n += 1
        kind = action.get("action_type") if isinstance(action, dict) else action
        done = kind in ("DONE", "FAIL")
        return self._obs(), 0, done, {"done": True} if kind == "DONE" else {}

    def evaluate(self):
        self.evaluations += 1
        return self.score


class FakeGate:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    def check(self, request):
        self.requests.append(request)
        reply = self.replies.pop(0) if self.replies else VERIFIED
        if isinstance(reply, Exception):
            raise reply
        return reply


def reply(verdict, accepted, codes, **extra):
    out = {"apiVersion": "myco.gate/v1", "verdict": verdict, "accepted": accepted,
           "reasonCodes": codes, "reasons": ["expected 42 in Sheet1!B2 (prose never shown)"],
           "corrections": [{"kind": "target-value", "requested": "42"}]}
    out.update(extra)
    return out


VERIFIED = reply("verified", True, ["ORACLE_PASS"])
REFUTED = reply("refuted", False, ["ORACLE_FAIL", "TARGET_MISMATCH"])


def local_loop(agent, env, max_steps):
    """The shape of lib_run_single.run_single_example's loop, for the clone-free run."""
    env.reset(task_config={"id": "t"})
    agent.reset(vm_ip=env.vm_ip)
    obs = env._get_obs()
    done = False
    step_idx = 0
    while not done and step_idx < max_steps:
        _response, actions = agent.predict("instruction", obs)
        for action in actions:
            obs, _reward, done, _info = env.step(action, 0)
            if done:
                break
        step_idx += 1
    return env.evaluate()


def load_upstream_loop():
    if OSWORLD is None:
        return None
    stub = types.ModuleType("wrapt_timeout_decorator")
    stub.__all__ = []
    sys.modules["wrapt_timeout_decorator"] = stub
    # lib_run_single imports a drawing helper for another agent (os_symphony) at module level;
    # it needs Pillow and is never used by run_single_example. Stub that one leaf module.
    helper = types.ModuleType("mm_agents.os_symphony.utils.common_utils")
    helper.draw_coordinates = lambda *a, **k: None
    sys.modules["mm_agents.os_symphony.utils.common_utils"] = helper
    sys.path.insert(0, OSWORLD)
    lrs = importlib.import_module("lib_run_single")
    lrs.time = types.SimpleNamespace(sleep=lambda s: None)  # skip the fixed 60 s / 20 s waits
    return lrs


UPSTREAM = load_upstream_loop()


def upstream_loop(agent, env, max_steps, tag):
    out = os.path.join(WORK, "results", tag)
    os.makedirs(out, exist_ok=True)
    args = types.SimpleNamespace(sleep_after_execution=0, result_dir=os.path.join(WORK, "results"))
    scores = []
    UPSTREAM.run_single_example(agent, env, {"id": tag, "instruction": "i"}, max_steps,
                                "instruction", args, out, scores)
    with open(os.path.join(out, "result.txt"), encoding="utf-8") as f:
        written = f.read()
    return {"scores": scores, "resultTxt": written, "resultDir": out}


def run(arm, turns, replies, score=1.0, max_steps=10, loop="local", tag=None):
    agent = FakeAgent(turns)
    env = FakeEnv(score)
    gate = FakeGate(replies) if arm == "gate-before-done" else None
    wrapped = hook.DoneGate(agent, arm, gate=gate, task_id="task-1", run_id="run-1")
    extra = {}
    if loop == "upstream":
        extra = upstream_loop(wrapped, env, max_steps, tag or arm)
    else:
        extra = {"score": local_loop(wrapped, env, max_steps)}
    feedback = [m["content"][0]["text"] for m in agent.messages if m["role"] == "user"]
    return dict(extra, arm=arm, envActions=env.received, agentObs=agent.seen_obs,
                gateRequests=gate.requests if gate else [], decisions=wrapped.decisions,
                feedback=feedback, suffix=agent.system_prompt_suffix,
                evaluations=env.evaluations)


ACCEPT_TURNS = [[CLICK], [TYPE, SAVE], [DONE]]
REFUSE_TURNS = [[CLICK], [TYPE], [DONE], [SAVE], [DONE]]


def arms(turns, replies, loop="local", prefix=""):
    return {a: run(a, turns, replies, loop=loop, tag=prefix + a) for a in hook.ARMS}


def raises(fn):
    try:
        fn()
    except ValueError as exc:
        return str(exc)
    return None


report = {
    "constants": {"arms": list(hook.ARMS), "tool": hook.GATE_TOOL, "api": hook.GATE_API_VERSION,
                  "selfCheck": hook.SELF_CHECK_SUFFIX, "claimLimit": hook.CLAIM_LIMIT},
    "accept": arms(ACCEPT_TURNS, [VERIFIED]),
    "refuse": arms(REFUSE_TURNS, [REFUTED, VERIFIED]),
    "batchRefused": run("gate-before-done", [[CLICK, DONE, TYPE], [DONE]], [REFUTED, VERIFIED]),
    "failClosed": {
        name: run("gate-before-done", [[DONE], [DONE]], [r, VERIFIED])
        for name, r in {
            "raises": RuntimeError("down"),
            "notADict": "verified",
            "acceptedButRefuted": reply("refuted", True, ["ORACLE_FAIL"]),
            "verifiedNotAccepted": reply("verified", False, ["ORACLE_PASS"]),
            "wrongApi": reply("verified", True, ["ORACLE_PASS"], apiVersion="myco.gate/v0"),
            "badCodes": reply("verified", True, "ORACLE_PASS"),
            "unknownVerdict": reply("passed", True, ["ORACLE_PASS"]),
        }.items()
    },
    "budgetExhausted": run("gate-before-done", [[DONE]] * 3, [REFUTED] * 3, max_steps=3),
    "config": {
        "noGateWithGate": raises(lambda: hook.DoneGate(FakeAgent([]), "no-gate", gate=FakeGate([]))),
        "selfCheckWithGate": raises(
            lambda: hook.DoneGate(FakeAgent([]), "self-check", gate=FakeGate([]))),
        "gateArmWithoutGate": raises(
            lambda: hook.DoneGate(FakeAgent([]), "gate-before-done", task_id="t", run_id="r")),
        "unknownArm": raises(lambda: hook.DoneGate(FakeAgent([]), "hcu-shell")),
        "wrapGateArmWithoutCmd": raises(
            lambda: hook.wrap_agent(FakeAgent([]), "gate-before-done", None, "t", "r")),
    },
}

reused = FakeAgent([])
hook.DoneGate(reused, "self-check")
hook.DoneGate(reused, "self-check")
report["selfCheckRewrapSuffix"] = reused.system_prompt_suffix

long_claim = hook.gate_request("t", "r", "x" * 9000)
report["longClaimLength"] = len(long_claim["claim"])
report["nonStringClaim"] = hook.gate_request("t", "r", None)

# The stdio client against a stand-in MCP server that records what it was sent.
server = os.path.join(WORK, "fake_gate_server.py")
record = os.path.join(WORK, "server_saw.jsonl")
with open(server, "w", encoding="utf-8") as f:
    f.write(
        "import json, sys\n"
        "rec = open(sys.argv[1], 'a')\n"
        "for line in sys.stdin:\n"
        "    m = json.loads(line)\n"
        "    rec.write(json.dumps(m) + '\\n')\n"
        "    if m.get('method') == 'initialize':\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': {}}))\n"
        "    elif m.get('method') == 'tools/call':\n"
        "        r = {'apiVersion': 'myco.gate/v1', 'verdict': 'verified', 'accepted': True,"
        " 'reasonCodes': ['ORACLE_PASS']}\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result':"
        " {'content': [], 'structuredContent': r, 'isError': False}}))\n"
    )
client = hook.wrap_agent(FakeAgent([[DONE]]), "gate-before-done",
                         [sys.executable, "-I", server, record, "--task", "{taskId}", "--run", "{runId}"],
                         "task-9", "run-9")
report["stdio"] = {"argv": client.gate.argv[3:], "reply": client.gate.check(
    hook.gate_request("task-9", "run-9", "done"))}
with open(record, encoding="utf-8") as f:
    report["stdio"]["serverSaw"] = [json.loads(line) for line in f]
report["stdio"]["unreachable"] = None
try:
    hook.StdioGateClient([os.path.join(WORK, "no-such-server")]).check({})
except hook.GateError as exc:
    report["stdio"]["unreachable"] = str(exc)

if UPSTREAM is not None:
    report["upstream"] = {
        "accept": arms(ACCEPT_TURNS, [VERIFIED], loop="upstream", prefix="accept-"),
        "refuse": arms(REFUSE_TURNS, [REFUTED, VERIFIED], loop="upstream", prefix="refuse-"),
        "failScore": run("no-gate", ACCEPT_TURNS, [], score=0.0, loop="upstream", tag="fail-score"),
    }

with open(os.path.join(WORK, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f)
