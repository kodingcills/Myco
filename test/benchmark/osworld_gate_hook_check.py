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

import hashlib
import importlib
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import zipfile

HOOK_DIR, WORK = sys.argv[1], sys.argv[2]
OSWORLD = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
sys.path.insert(0, HOOK_DIR)
import myco_done_gate as hook  # noqa: E402

# The self-check probe targets the Ubuntu guest (GNU find, bash 5); the fake controller runs
# it for real with the host's bash, so the self-check scenarios run on Linux only.
LINUX = sys.platform.startswith("linux")
RUN_ARMS = hook.ARMS if LINUX else tuple(a for a in hook.ARMS if a != "self-check")

CLICK = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.click(10, 20)\n"}
TYPE = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.typewrite('42')\n"}
SAVE = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.hotkey('ctrl', 's')\n"}
DONE = {"action_type": "DONE", "raw_response": "I have finished the task."}
INSTRUCTION = "Put 42 in B2 of the open sheet and save it as report.xlsx on the Desktop."

# Ground truth the self-check must never touch (planted outside the guest home).
GROUND = os.path.join(WORK, "ground")
os.makedirs(os.path.join(GROUND, "cache", "task-1"), exist_ok=True)
GOLD = os.path.join(GROUND, "cache", "task-1", "report_gold.xlsx")
SCORE_FILE = os.path.join(GROUND, "result.txt")
for _path in (GOLD, SCORE_FILE):
    with open(_path, "w", encoding="utf-8") as _f:
        _f.write("1.0\n")

# Host-side tripwire: while a self-check arm's predict runs, any host file open, directory
# listing, process launch or socket connect by the hook is recorded (the fake controller
# turns the guard off while it stands in for the guest).
GUARD = {"on": False, "events": []}
WATCHED = {"open", "os.listdir", "os.scandir", "glob.glob", "subprocess.Popen", "os.system",
           "socket.connect", "shutil.copyfile", "os.exec", "os.posix_spawn"}


def _audit(event, args):
    if GUARD["on"] and event in WATCHED:
        GUARD["events"].append("%s %s" % (event, str(args[0] if args else "")[:200]))


sys.addaudithook(_audit)


def ooxml(path, mtime=None):
    """A minimal Office Open XML container (what LibreOffice writes for .xlsx/.docx/.pptx)."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", "<workbook/>")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def odf(path, mimetype="application/vnd.oasis.opendocument.spreadsheet", mtime=None):
    """A minimal OpenDocument container (mimetype first, as ODF requires)."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", mimetype)
        z.writestr("content.xml", "<office:document-content/>")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def plain(path, text, mtime=None):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    if mtime is not None:
        os.utime(path, (mtime, mtime))


OLD = time.time() - 7200  # two hours before any episode here


def new_home(setup=None):
    """A fresh stand-in for the guest's /home/user: Desktop with an old input workbook."""
    home = tempfile.mkdtemp(prefix="home-", dir=WORK)
    os.makedirs(os.path.join(home, "Desktop"))
    ooxml(os.path.join(home, "Desktop", "input.xlsx"), mtime=OLD)
    if setup:
        setup(home)
    return home


class Tripwire:
    """Any attribute read is recorded: the self-check must never touch it."""

    def __init__(self, name, touched):
        object.__setattr__(self, "_name", name)
        object.__setattr__(self, "_touched", touched)

    def __getattr__(self, attr):
        self._touched.append("%s.%s" % (self._name, attr))
        raise AttributeError(attr)


class FakeController:
    """Stands in for upstream's PythonController for the self-check's probe.

    run_bash_script mirrors the server's /run_bash_script at the pin: the script runs under
    /bin/bash as the guest user (HOME is the stand-in home), stderr merged into stdout, and
    the reply is {status, output, error, returncode}. Every other attribute is a tripwire.
    """

    def __init__(self, home, touched, mode="real"):
        self.home = home
        self.touched = touched
        self.mode = mode
        self.scripts = []
        self.timeouts = []

    def __getattr__(self, attr):
        self.touched.append("controller.%s" % attr)
        raise AttributeError(attr)

    def start_recording(self):
        pass

    def end_recording(self, path):
        pass

    def run_bash_script(self, script, timeout=30, working_dir=None):
        self.scripts.append(script)
        self.timeouts.append(timeout)
        if self.mode == "raises":
            raise RuntimeError("controller unreachable")
        if self.mode == "none":
            return None
        was = GUARD["on"]
        GUARD["on"] = False
        try:
            fd, path = tempfile.mkstemp(suffix=".sh", dir=WORK)
            with os.fdopen(fd, "w") as f:
                f.write(script)
            done = subprocess.run(["/bin/bash", path], stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, timeout=timeout,
                                  cwd=working_dir, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                                        "HOME": self.home, "LANG": "C.UTF-8"})
        finally:
            GUARD["on"] = was
        out = {"status": "success" if done.returncode == 0 else "error", "output": done.stdout,
               "error": "", "returncode": done.returncode}
        if self.mode == "exit1":
            out.update(status="error", returncode=1)
        if self.mode == "noEnd":
            out["output"] = done.stdout.replace("END\n", "")
        return out


class FakeAgent:
    """Scripted turns; records exactly what the runner and the hook hand it."""

    def __init__(self, turns, touched=None):
        self.turns = [list(t) for t in turns]
        self.messages = []
        self.system_prompt_suffix = ""
        self.seen_obs = []
        self.resets = 0
        self.predicts = 0
        self.max_steps = 10
        # AnthropicAgent holds the env; the self-check must never reach it through the agent.
        self.env = Tripwire("agent.env", touched if touched is not None else [])

    def reset(self, *args, **kwargs):
        self.resets += 1

    def predict(self, instruction, obs=None):
        self.predicts += 1
        self.seen_obs.append((obs or {}).get("screenshot", b"").hex())
        turn = self.turns.pop(0) if self.turns else [dict(DONE)]
        self.messages.append({"role": "assistant", "content": [{"type": "text", "text": "turn"}]})
        return "I have finished the task.", [dict(a) for a in turn]


class FakeEnv:
    """Mirrors DesktopEnv.step's contract: DONE/FAIL end the episode, WAIT is a no-op."""

    def __init__(self, score, controller, home):
        self.score = score
        self.received = []
        self.evaluations = 0
        self.vm_ip = "127.0.0.1"
        self.controller = controller
        self.home = home
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
        if isinstance(action, dict) and action.get("command") == SAVE["command"]:
            # The guest's effect of the agent's save: the workbook lands under its name.
            ooxml(os.path.join(self.home, "Desktop", "report.xlsx"))
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
        _response, actions = agent.predict(INSTRUCTION, obs)
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
    UPSTREAM.run_single_example(agent, env, {"id": tag, "instruction": INSTRUCTION}, max_steps,
                                INSTRUCTION, args, out, scores)
    with open(os.path.join(out, "result.txt"), encoding="utf-8") as f:
        written = f.read()
    return {"scores": scores, "resultTxt": written, "resultDir": out}


def guarded(fn):
    """Run fn with the host-side tripwire armed."""
    def call(*args, **kwargs):
        GUARD["on"] = True
        try:
            return fn(*args, **kwargs)
        finally:
            GUARD["on"] = False
    return call


def run(arm, turns, replies, score=1.0, max_steps=10, loop="local", tag=None, setup=None,
        mode="real"):
    touched = []
    home = new_home(setup)
    controller = FakeController(home, touched, mode)
    agent = FakeAgent(turns, touched)
    env = FakeEnv(score, controller, home)
    gate = FakeGate(replies) if arm == "gate-before-done" else None
    getter = (lambda: env.controller) if arm == "self-check" else None
    wrapped = hook.DoneGate(agent, arm, gate=gate, task_id="task-1", run_id="run-1",
                            controller=getter)
    GUARD["events"] = []
    if arm == "self-check":
        wrapped.predict = guarded(wrapped.predict)
    extra = {}
    if loop == "upstream":
        extra = upstream_loop(wrapped, env, max_steps, tag or arm)
    else:
        extra = {"score": local_loop(wrapped, env, max_steps)}
    feedback = [m["content"][0]["text"] for m in agent.messages if m["role"] == "user"]
    return dict(extra, arm=arm, envActions=env.received, agentObs=agent.seen_obs,
                gateRequests=gate.requests if gate else [], decisions=wrapped.decisions,
                feedback=feedback, suffix=agent.system_prompt_suffix,
                evaluations=env.evaluations, agentPredicts=agent.predicts,
                agentMaxSteps=agent.max_steps,
                probe={"scripts": controller.scripts, "timeouts": controller.timeouts},
                tripwires={"hostEvents": list(GUARD["events"]), "touched": touched})


ACCEPT_TURNS = [[CLICK], [TYPE, SAVE], [DONE]]
REFUSE_TURNS = [[CLICK], [TYPE], [DONE], [SAVE], [DONE]]


def arms(turns, replies, loop="local", prefix=""):
    return {a: run(a, turns, replies, loop=loop, tag=prefix + a) for a in RUN_ARMS}


def self_check_cases():
    """One DONE through the self-check arm against prepared guest homes (Linux only)."""
    if not LINUX:
        return {}
    def at(*parts):
        return lambda home: os.path.join(home, *parts)

    cases = {
        # The named workbook saved during the episode, valid OOXML: no problem.
        "ok": lambda h: ooxml(at("Desktop", "report.xlsx")(h)),
        # The named file is nowhere under home, and nothing was saved.
        "missing": None,
        # Saved under the named .xlsx name, but the bytes are an ODF spreadsheet.
        "formatBad": lambda h: odf(at("Desktop", "report.xlsx")(h)),
        # The named file exists and is valid, but predates the episode (never saved).
        "notSaved": lambda h: ooxml(at("Desktop", "report.xlsx")(h), mtime=OLD),
        # Recent documents only in a hidden directory and a lock file: not read, so nothing saved.
        "hiddenIgnored": lambda h: (os.makedirs(at(".cache")(h)),
                                    ooxml(at(".cache", "report.xlsx")(h)),
                                    plain(at("Desktop", ".~lock.report.xlsx#")(h), "lock")),
        # Deeper than the probe's depth limit (4 below home): not found.
        "tooDeep": lambda h: (os.makedirs(at("a", "b", "c", "d")(h)),
                              ooxml(at("a", "b", "c", "d", "report.xlsx")(h))),
    }
    out = {name: run("self-check", [[DONE]], [], setup=setup) for name, setup in cases.items()}
    # Other formats under a different instruction-named file, through the probe's format rule.
    for name, ext, make in (
        ("odsOk", "ods", lambda p: odf(p)),
        ("odtAsOds", "ods", lambda p: odf(p, "application/vnd.oasis.opendocument.text")),
        ("docxAsText", "docx", lambda p: plain(p, "not a zip")),
        ("pdfOk", "pdf", lambda p: plain(p, "%PDF-1.7\n")),
        ("pdfBad", "pdf", lambda p: plain(p, "<html>")),
        ("csvOk", "csv", lambda p: plain(p, "a,b\n1,2\n")),
    ):
        target = "out.%s" % ext
        out[name] = run_with_instruction(
            "Export the result as %s in the home folder." % target,
            lambda h, t=target, m=make: m(os.path.join(h, t)))
    for mode in ("raises", "none", "exit1", "noEnd"):
        out["unavailable-" + mode] = run("self-check", [[DONE]], [], mode=mode,
                                         setup=lambda h: ooxml(at("Desktop", "report.xlsx")(h)))
    return out


def run_with_instruction(instruction, setup):
    global INSTRUCTION
    saved, INSTRUCTION = INSTRUCTION, instruction
    try:
        return run("self-check", [[DONE]], [], setup=setup)
    finally:
        INSTRUCTION = saved


def raises(fn):
    try:
        fn()
    except ValueError as exc:
        return str(exc)
    return None


report = {
    "constants": {"arms": list(hook.ARMS), "tool": hook.GATE_TOOL, "api": hook.GATE_API_VERSION,
                  "claimLimit": hook.CLAIM_LIMIT, "linux": LINUX,
                  "probe": hook.SELF_CHECK_PROBE,
                  "probeSha256": hashlib.sha256(hook.SELF_CHECK_PROBE.encode()).hexdigest(),
                  "selfCheckCodes": list(hook.SELF_CHECK_CODES),
                  "checkTimeout": hook.CHECK_TIMEOUT_S,
                  "gateClientTimeout": hook.StdioGateClient([]).timeout,
                  "controllerMargin": hook.CONTROLLER_HTTP_MARGIN_S,
                  "selfCheckFeedback": hook.self_check_feedback_text(["CODE_A", "CODE_B"]),
                  "hasSuffix": hasattr(hook, "SELF_CHECK_SUFFIX")},
    "instruction": INSTRUCTION,
    "ground": {"gold": GOLD, "score": SCORE_FILE},
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
        "selfCheckWithoutController": raises(lambda: hook.DoneGate(FakeAgent([]), "self-check")),
        "noGateWithController": raises(
            lambda: hook.DoneGate(FakeAgent([]), "no-gate", controller=lambda: None)),
        "gateArmWithController": raises(
            lambda: hook.DoneGate(FakeAgent([]), "gate-before-done", gate=FakeGate([]),
                                  task_id="t", run_id="r", controller=lambda: None)),
    },
}

# The runner patch hands wrap_agent the controller getter in every arm; only self-check keeps it.
report["wrapController"] = {
    arm: hook.wrap_agent(FakeAgent([]), arm, ["true"] if arm == "gate-before-done" else None,
                         "t", "r", controller=lambda: None).controller is not None
    for arm in hook.ARMS
}

report["namedFiles"] = {
    text: hook.named_files(text)
    for text in (
        INSTRUCTION,
        "Open /home/user/Desktop/Q3 data.xlsx and save a copy as Q3_summary.ODS in ~/Documents.",
        "Convert notes.docx to PDF (notes.pdf); keep notes.docx unchanged.",
        "Sum column B. No file name here, just 3.5 and v1.2 numbers.",
        "Rename draft.txt; then x.y.z.csv, a-b_c.pptx and 'quoted.odt'.",
        "Many: " + " ".join("f%d.txt" % i for i in range(12)),
        None,
    )
}

# How many of the pre-registered task set's instructions name a file the probe would look for.
_tasks = os.path.join(HOOK_DIR, "..", "..", "..", "benchmark", "upstream", "osworld-office-v1",
                      "tasks.jsonl")
with open(_tasks, encoding="utf-8") as _f:
    _instructions = [json.loads(line)["instruction"] for line in _f if line.strip()]
report["taskSetNamed"] = {"tasks": len(_instructions),
                          "withNames": sum(1 for t in _instructions if hook.named_files(t))}

if LINUX:
    report["selfCheck"] = self_check_cases()
    report["selfCheckBudget"] = run("self-check", [[DONE]] * 3, [], max_steps=3)
    report["selfCheckBatch"] = run("self-check", [[CLICK, DONE, TYPE], [SAVE], [DONE]], [])
    report["selfCheckSlowClock"] = None
    ticks = iter([0.0, 0.0, 3600.0])
    slow_home = new_home()
    slow = FakeController(slow_home, [])
    gated = hook.DoneGate(FakeAgent([[DONE]]), "self-check", controller=lambda: slow,
                          clock=lambda: next(ticks))
    gated.reset()
    gated.predict(INSTRUCTION, {"screenshot": b"s"})
    report["selfCheckSlowClock"] = {"scripts": slow.scripts}

# Positive control: the tripwires record a planted gold read, a planted score-file read and a
# planted evaluator call made inside a guarded call (each failure is swallowed, as the hook
# swallows controller failures, so only the tripwire can see it).
bite_touched = []
bite_agent = FakeAgent([], bite_touched)
GUARD["events"] = []


def _planted():
    for path in (GOLD, SCORE_FILE):
        try:
            open(path, "rb").close()
        except OSError:
            pass
    try:
        bite_agent.env.evaluate()
    except AttributeError:
        pass


guarded(_planted)()
report["tripwireBite"] = {"hostEvents": list(GUARD["events"]), "touched": bite_touched}
GUARD["events"] = []

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

# N2 (#741 round 1): the runId that reaches the server is the one wrap_agent was given, sent by
# DoneGate itself on the agent's DONE (not a direct client call).
open(record, "w", encoding="utf-8").close()
wrapped = hook.wrap_agent(FakeAgent([[DONE]]), "gate-before-done",
                          [sys.executable, "-I", server, record], "task-7", "run-7")
_, passed = wrapped.predict("instruction", {"screenshot": b"s"})
with open(record, encoding="utf-8") as f:
    saw = [json.loads(line) for line in f]
report["stdio"]["throughWrap"] = {
    "actions": [a.get("action_type") for a in passed],
    "decisions": wrapped.decisions,
    "calls": [m["params"]["arguments"] for m in saw if m.get("method") == "tools/call"],
}

# N1 (#741 round 1): the real stdio transport fails closed when the server exits without a
# reply, or replies with a non-object result. Recorded at the client and through DoneGate.
STUBS = {
    "silent": "import sys\nfor line in sys.stdin:\n    pass\n",
    "nonObject": (
        "import json, sys\n"
        "for line in sys.stdin:\n"
        "    m = json.loads(line)\n"
        "    if m.get('method') == 'initialize':\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': {}}))\n"
        "    elif m.get('method') == 'tools/call':\n"
        "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': 'verified'}))\n"
    ),
}
report["stdioFailClosed"] = {}
for name, body in STUBS.items():
    path = os.path.join(WORK, "stub_%s.py" % name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    argv = [sys.executable, "-I", path]
    entry = {"client": None, "clientReturned": None}
    try:
        entry["clientReturned"] = hook.StdioGateClient(argv).check(
            hook.gate_request("t", "r", "done"))
    except hook.GateError as exc:
        entry["client"] = str(exc)
    gated = hook.wrap_agent(FakeAgent([[DONE]]), "gate-before-done", argv, "t", "r")
    _, out = gated.predict("instruction", {"screenshot": b"s"})
    entry["actions"] = [a.get("action_type") for a in out]
    entry["decisions"] = gated.decisions
    report["stdioFailClosed"][name] = entry

if UPSTREAM is not None:
    report["upstream"] = {
        "accept": arms(ACCEPT_TURNS, [VERIFIED], loop="upstream", prefix="accept-"),
        "refuse": arms(REFUSE_TURNS, [REFUTED, VERIFIED], loop="upstream", prefix="refuse-"),
        "failScore": run("no-gate", ACCEPT_TURNS, [], score=0.0, loop="upstream", tag="fail-score"),
    }

with open(os.path.join(WORK, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f)
