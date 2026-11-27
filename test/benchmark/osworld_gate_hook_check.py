"""Scenario driver for test/benchmark/osworld-gate-hook.test.ts (MOCK, plumbing only).

Runs Myco's DONE gate hook (src/gate-hooks/osworld/myco_done_gate.py) with a scripted fake
agent, a fake environment and a fake gate, under the three R1 arms and the labelled
self-check-rules ablation, and writes <work_dir>/report.json. The TypeScript test makes
every assertion; this file only records what happened.

    python3 -I osworld_gate_hook_check.py <hook_dir> <work_dir> [<osworld_checkout>]

The self-check arms get their controller handle exactly as the runner patch builds it: the
expression after ``controller=`` in run_multienv_claude.gate.patch is evaluated against the
fake environment, with a stand-in for upstream's PythonController class.

With an OSWorld checkout at the pinned commit, the same scenarios also run through the REAL
upstream loop, ``lib_run_single.run_single_example`` (its third-party import
``wrapt_timeout_decorator`` and an os_symphony drawing helper that needs Pillow are stubbed;
its fixed sleeps are skipped), and the report records what that loop handed to ``env.step``
and the score ``env.evaluate()`` returned, which upstream writes to result.txt. No VM, no
model, no network: every agent turn, screen and score below is scripted.
"""

import ctypes
import ctypes.util
import gc
import hashlib
import importlib
import json
import os
import struct
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

# The self-check commands target the Ubuntu guest (GNU find, bash 5, python3); the fake
# controller runs them for real with the host's bash, so those scenarios run on Linux only.
LINUX = sys.platform.startswith("linux")
RUN_ARMS = hook.RUNNER_ARMS if LINUX else ("no-gate", "gate-before-done")

CLICK = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.click(10, 20)\n"}
TYPE = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.typewrite('42')\n"}
SAVE = {"name": "computer", "action_type": "tool_use", "command": "pyautogui.hotkey('ctrl', 's')\n"}
DONE = {"action_type": "DONE", "raw_response": "I have finished the task."}
INSTRUCTION = "Put 42 in B2 of the open sheet and save it as report.xlsx on the Desktop."

# Ground truth the self-check must never touch, planted next to the guest homes (outside them):
# a gold file in a cache directory, a task configuration with its evaluator, and a score file.
GROUND = os.path.join(WORK, "ground")
os.makedirs(os.path.join(GROUND, "cache", "task-1"), exist_ok=True)
os.makedirs(os.path.join(GROUND, "examples"), exist_ok=True)
GOLD = os.path.join(GROUND, "cache", "task-1", "report_gold.xlsx")
SCORE_FILE = os.path.join(GROUND, "result.txt")
TASK_CONFIG_FILE = os.path.join(GROUND, "examples", "task-1.json")
TASK_CONFIG = {"id": "task-1", "instruction": INSTRUCTION,
               "evaluator": {"func": "compare_table", "expected": {"type": "cloud_file",
                                                                   "path": GOLD}}}
for _path, _text in ((GOLD, "1.0\n"), (SCORE_FILE, "1.0\n"),
                     (TASK_CONFIG_FILE, json.dumps(TASK_CONFIG))):
    with open(_path, "w", encoding="utf-8") as _f:
        _f.write(_text)
GROUND_DIRS = [GROUND, os.path.join(GROUND, "cache"), os.path.join(GROUND, "cache", "task-1"),
               os.path.join(GROUND, "examples")]
# Guest scripts are written outside WORK, so writing and running them touches no watched dir.
SCRIPTS = tempfile.mkdtemp(prefix="guest-bin-")

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

# Object tripwires (B2, 18:11Z): while a self-check arm's predict runs, any attribute read on
# the environment, the provider or a controller instance (except the provider's address getter
# and the controller's run_bash_script) is recorded.
WATCH = {"on": False, "touched": []}


class Watched:
    """Records every attribute read while WATCH is on, except the names in ``allowed``."""

    allowed = ()
    label = "object"

    def __getattribute__(self, name):
        if WATCH["on"] and name not in type(self).allowed:
            WATCH["touched"].append("%s.%s" % (type(self).label, name))
        return object.__getattribute__(self, name)


# Guest-side tripwire (N1): an inotify watch on every directory that holds ground truth and on
# the homes' parent records any open or read there while a guest script runs. It does not rely
# on the script's text or its pinned hash.
IN_ACCESS, IN_OPEN, IN_NONBLOCK, IN_ISDIR = 0x1, 0x20, 0o4000, 0x40000000
_LIBC = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True) if LINUX else None


class GuestWatch:
    def __init__(self, dirs):
        self.fd = _LIBC.inotify_init1(IN_NONBLOCK) if _LIBC else -1
        self.dirs = {}
        if self.fd < 0:
            return
        for d in dirs:
            wd = _LIBC.inotify_add_watch(self.fd, d.encode(), IN_ACCESS | IN_OPEN)
            if wd >= 0:
                self.dirs[wd] = d

    @property
    def armed(self):
        return self.fd >= 0 and len(self.dirs) > 0

    def drain(self):
        out = []
        while self.fd >= 0:
            try:
                buf = os.read(self.fd, 65536)
            except BlockingIOError:
                break
            i = 0
            while i < len(buf):
                wd, mask, _cookie, size = struct.unpack_from("iIII", buf, i)
                name = buf[i + 16:i + 16 + size].rstrip(b"\0").decode("utf-8", "replace")
                out.append((self.dirs.get(wd, "?"), name, mask))
                i += 16 + size
        return out


GUEST_WATCH = GuestWatch(GROUND_DIRS + [WORK]) if LINUX else GuestWatch([])


def ooxml(path, mtime=None):
    """A minimal Office Open XML container with an empty workbook."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", "<workbook/>")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def xlsx_cells(path, cells, mtime=None):
    """An .xlsx as LibreOffice writes it: workbook, relationships, shared strings, one sheet.

    ``cells`` maps a cell reference to a number, a string (shared) or ("=", formula, value).
    """
    strings, xml = [], []
    for ref, v in cells.items():
        if isinstance(v, tuple):
            xml.append('<c r="%s"><f>%s</f><v>%s</v></c>' % (ref, v[1], v[2]))
        elif isinstance(v, str):
            strings.append(v)
            xml.append('<c r="%s" t="s"><v>%d</v></c>' % (ref, len(strings) - 1))
        else:
            xml.append('<c r="%s"><v>%s</v></c>' % (ref, v))
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", '<workbook xmlns="%s" xmlns:r="%s"><sheets><sheet '
                   'name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' % (S_NS, R_NS))
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/'
                   'relationships"><Relationship Id="rId1" Type="ws" '
                   'Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr("xl/sharedStrings.xml", '<sst xmlns="%s">%s</sst>' % (
            S_NS, "".join("<si><t>%s</t></si>" % s for s in strings)))
        z.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="%s"><sheetData><row>%s</row>'
                   '</sheetData></worksheet>' % (S_NS, "".join(xml)))
    if mtime is not None:
        os.utime(path, (mtime, mtime))


ODF_NS = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
          'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
          'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
          'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"')


def odf(path, mimetype="application/vnd.oasis.opendocument.spreadsheet", body="", mtime=None):
    """A minimal OpenDocument container (mimetype first, as ODF requires)."""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", mimetype)
        z.writestr("content.xml", '<office:document-content %s><office:body>%s</office:body>'
                   '</office:document-content>' % (ODF_NS, body))
    if mtime is not None:
        os.utime(path, (mtime, mtime))


ODS_BODY = ('<office:spreadsheet><table:table table:name="Data"><table:table-row '
            'table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="3"/>'
            '</table:table-row><table:table-row><table:table-cell/><table:table-cell '
            'office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>'
            '<table:table-cell table:formula="of:=[.B3]*6" office:value="42"><text:p>42</text:p>'
            '</table:table-cell></table:table-row></table:table></office:spreadsheet>')
ODT_BODY = '<office:text><text:h>Heading</text:h><text:p>Body line</text:p></office:text>'
ODP_BODY = ('<office:presentation><draw:page draw:name="page1"><text:p>Slide title</text:p>'
            '</draw:page></office:presentation>')


def docx(path, paragraphs):
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", '<w:document xmlns:w="%s"><w:body>%s</w:body>'
                   '</w:document>' % (w, "".join("<w:p><w:r><w:t>%s</w:t></w:r></w:p>" % p
                                                 for p in paragraphs)))


def pptx(path, slides):
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        for i, s in enumerate(slides, 1):
            z.writestr("ppt/slides/slide%d.xml" % i, '<p:sld xmlns:p="p" xmlns:a="%s"><a:p><a:r>'
                       '<a:t>%s</a:t></a:r></a:p></p:sld>' % (a, s))


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


# The fake desktops, by controller port: what a FakePythonController built for that address
# talks to (its home, its failure mode, and every script it was sent).
DESKTOPS = {}


class Desktop:
    def __init__(self, home, mode="real"):
        self.home = home
        self.mode = mode
        self.scripts = []
        self.timeouts = []
        self.call_turns = []
        self.guest_events = []
        self.agent = None

    def run(self, script, timeout):
        """Mirrors the server's /run_bash_script at the pin: /bin/bash as the guest user (HOME
        is the stand-in home), stderr merged into stdout, reply {status, output, error,
        returncode}."""
        self.scripts.append(script)
        self.timeouts.append(timeout)
        self.call_turns.append(self.agent.predicts if self.agent else None)
        if self.mode == "raises":
            raise RuntimeError("controller unreachable")
        if self.mode == "none":
            return None
        was, watch = GUARD["on"], WATCH["on"]
        GUARD["on"] = WATCH["on"] = False
        try:
            fd, path = tempfile.mkstemp(suffix=".sh", dir=SCRIPTS)
            with os.fdopen(fd, "w") as f:
                f.write(script)
            GUEST_WATCH.drain()
            done = subprocess.run(["/bin/bash", path], stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, timeout=timeout,
                                  env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                       "HOME": self.home, "LANG": "C.UTF-8"})
            home_name = os.path.basename(self.home)
            self.guest_events.extend(
                "%s/%s" % (d, n) for d, n, _m in GUEST_WATCH.drain()
                if not (d == WORK and n == home_name))
        finally:
            GUARD["on"], WATCH["on"] = was, watch
        out = {"status": "success" if done.returncode == 0 else "error", "output": done.stdout,
               "error": "", "returncode": done.returncode}
        if self.mode == "exit1":
            out.update(status="error", returncode=1)
        if self.mode == "noEnd":
            out["output"] = done.stdout.replace("END\n", "")
        return out


class FakePythonController(Watched):
    """Stands in for upstream's PythonController(vm_ip, server_port): talks to the fake desktop
    on that port. Under the watch only run_bash_script may be read."""

    allowed = ("run_bash_script",)
    label = "controller"

    def __init__(self, vm_ip, server_port):
        object.__setattr__(self, "_desktop", DESKTOPS[(vm_ip, server_port)])

    def run_bash_script(self, script, timeout=30, working_dir=None):
        return object.__getattribute__(self, "_desktop").run(script, timeout)

    def start_recording(self):
        pass

    def end_recording(self, path):
        pass


class FakeProvider(Watched):
    """Stands in for the myco-fleet provider: reports the desktop's address. Under the watch
    only get_ip_address may be read."""

    allowed = ("get_ip_address",)
    label = "provider"

    def __init__(self, port):
        object.__setattr__(self, "_port", port)
        object.__setattr__(self, "container", "fleet-%d" % port)

    def get_ip_address(self, path_to_vm):
        port = object.__getattribute__(self, "_port")
        return "127.0.0.1:%d:%d:%d:%d" % (port, port + 1, port + 2, port + 3)


class FakeEnv(Watched):
    """Mirrors DesktopEnv.step's contract: DONE/FAIL end the episode, WAIT is a no-op. Holds
    the ground truth a real DesktopEnv holds (task config, cache dir, the score); under the
    watch every attribute read is recorded."""

    label = "env"

    def __init__(self, score, provider, home):
        self.score = score
        self.received = []
        self.evaluations = 0
        self.vm_ip = "127.0.0.1"
        self.path_to_vm = "fleet@sha256:" + "a" * 64
        self.provider = provider
        self.controller = FakePythonController(
            *hook.parse_address(provider.get_ip_address(self.path_to_vm)))
        self.task_config = TASK_CONFIG
        self.cache_dir = os.path.join(GROUND, "cache", "task-1")
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
            xlsx_cells(os.path.join(self.home, "Desktop", "report.xlsx"), {"B2": 42})
        done = kind in ("DONE", "FAIL")
        return self._obs(), 0, done, {"done": True} if kind == "DONE" else {}

    def evaluate(self):
        self.evaluations += 1
        return self.score


class FakeAgent:
    """Scripted turns; records exactly what the runner and the hook hand it. Like
    AnthropicAgent, it holds the environment (``env``), which is watched."""

    def __init__(self, turns, env=None):
        self.turns = [list(t) for t in turns]
        self.messages = []
        self.system_prompt_suffix = ""
        self.seen_obs = []
        self.resets = 0
        self.predicts = 0
        self.max_steps = 10
        self.env = env

    def reset(self, *args, **kwargs):
        self.resets += 1

    def predict(self, instruction, obs=None):
        self.predicts += 1
        self.seen_obs.append((obs or {}).get("screenshot", b"").hex())
        turn = self.turns.pop(0) if self.turns else [dict(DONE)]
        self.messages.append({"role": "assistant", "content": [{"type": "text", "text": "turn"}]})
        return "I have finished the task.", [dict(a) for a in turn]


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

# The controller handle, exactly as the runner patch builds it: the expression after
# ``controller=`` in the patch's wrap call, evaluated with the patch's own names.
with open(os.path.join(HOOK_DIR, "run_multienv_claude.gate.patch"), encoding="utf-8") as _f:
    _patch = _f.read()
_call = "\n".join(line[1:] for line in _patch[_patch.index("+                        myco_wrap_agent("):]
                  .splitlines() if line.startswith("+"))
PATCH_CONTROLLER_EXPR = _call.split("controller=", 1)[1].strip()
assert PATCH_CONTROLLER_EXPR.endswith(")),"), PATCH_CONTROLLER_EXPR
PATCH_CONTROLLER_EXPR = PATCH_CONTROLLER_EXPR[:-2]


def patch_handle(env, example=None):
    """What the patched runner passes as ``controller=`` for this environment."""
    return eval(PATCH_CONTROLLER_EXPR, {  # noqa: S307 - the patch's own expression, test only
        "MycoControllerHandle": hook.ControllerHandle, "MycoPythonController": FakePythonController,
        "env": env, "example": example if example is not None else TASK_CONFIG})


PORTS = iter(range(20000, 30000, 10))


def make_desktop(home, mode="real"):
    port = next(PORTS)
    desktop = Desktop(home, mode)
    DESKTOPS[("127.0.0.1", port)] = desktop
    return desktop, FakeProvider(port)


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
    """Run fn with the host-side and object tripwires armed."""
    def call(*args, **kwargs):
        GUARD["on"] = WATCH["on"] = True
        try:
            return fn(*args, **kwargs)
        finally:
            GUARD["on"] = WATCH["on"] = False
    return call


def run(arm, turns, replies, score=1.0, max_steps=10, loop="local", tag=None, setup=None,
        mode="real"):
    home = new_home(setup)
    desktop, provider = make_desktop(home, mode)
    env = FakeEnv(score, provider, home)
    agent = FakeAgent(turns, env)
    desktop.agent = agent
    gate = FakeGate(replies) if arm == "gate-before-done" else None
    wrapped = hook.wrap_agent(agent, arm, None, task_id="task-1", run_id="run-1",
                              controller=patch_handle(env)) if arm != "gate-before-done" else \
        hook.DoneGate(agent, arm, gate=gate, task_id="task-1", run_id="run-1")
    GUARD["events"] = []
    WATCH["touched"] = []
    if arm in hook.SELF_CHECK_ARMS:
        wrapped.predict = guarded(wrapped.predict)
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
                probe={"scripts": desktop.scripts, "timeouts": desktop.timeouts,
                       "callTurns": desktop.call_turns},
                tripwires={"hostEvents": list(GUARD["events"]), "touched": list(WATCH["touched"]),
                           "guestEvents": list(desktop.guest_events)})


ACCEPT_TURNS = [[CLICK], [TYPE, SAVE], [DONE]]
REFUSE_TURNS = [[CLICK], [TYPE], [DONE], [SAVE], [DONE]]


def arms(turns, replies, loop="local", prefix=""):
    return {a: run(a, turns, replies, loop=loop, tag=prefix + a) for a in RUN_ARMS}


def with_instruction(instruction, fn):
    global INSTRUCTION
    saved, INSTRUCTION = INSTRUCTION, instruction
    try:
        return fn()
    finally:
        INSTRUCTION = saved


def at(*parts):
    return lambda home: os.path.join(home, *parts)


def dump_cases():
    """Primary self-check: one DONE, the dump it hands back, and the next DONE (Linux only)."""
    def two_files(h):
        xlsx_cells(at("Desktop", "report.xlsx")(h),
                   {"A1": "Total", "B2": 42, "B3": ("=", "SUM(B2)", 42)})
        plain(at("Desktop", "notes.csv")(h), "a,b\n1,2\n")

    cases = {
        # Cells of the saved workbook, by reference, shared strings and formulas resolved.
        "xlsx": two_files,
        # Nothing saved during the episode (the input predates it): "not saved", never a refusal.
        "notSaved": None,
        # Only hidden-directory files, a lock file, a link and a too-deep file changed.
        "hiddenAndDeep": lambda h: (os.makedirs(at(".config", "libreoffice")(h)),
                                    plain(at(".config", "libreoffice", "registrymodifications.xcu")(h), "<x/>"),
                                    plain(at("Desktop", ".~lock.report.xlsx#")(h), "lock"),
                                    os.symlink(GOLD, at("Desktop", "linked.xlsx")(h)),
                                    os.makedirs(at("a", "b", "c", "d")(h)),
                                    plain(at("a", "b", "c", "d", "deep.txt")(h), "deep")),
        "ods": lambda h: odf(at("Desktop", "out.ods")(h), body=ODS_BODY),
        "odt": lambda h: odf(at("Documents.odt")(h), "application/vnd.oasis.opendocument.text",
                             ODT_BODY),
        "odp": lambda h: odf(at("deck.odp")(h), "application/vnd.oasis.opendocument.presentation",
                             ODP_BODY),
        "docx": lambda h: docx(at("Desktop", "letter.docx")(h), ["Dear team,", "Thanks."]),
        "pptx": lambda h: pptx(at("Desktop", "pre.pptx")(h), ["First", "Second"]),
        "pdf": lambda h: plain(at("Desktop", "out.pdf")(h), "%PDF-1.7\n"),
        "unreadable": lambda h: plain(at("Desktop", "broken.xlsx")(h), "not a zip"),
        "big": lambda h: plain(at("Desktop", "big.txt")(h), "x" * 9000),
    }
    out = {name: run("self-check", [[DONE], [DONE]], [], setup=setup)
           for name, setup in cases.items()}
    for mode in ("raises", "none", "exit1", "noEnd"):
        out["unavailable-" + mode] = run("self-check", [[DONE], [DONE]], [], mode=mode,
                                         setup=lambda h: ooxml(at("Desktop", "report.xlsx")(h)))
    return out


def rules_cases():
    """ABLATION self-check-rules: one DONE against prepared guest homes (Linux only)."""
    cases = {
        "ok": lambda h: ooxml(at("Desktop", "report.xlsx")(h)),
        "missing": None,
        "formatBad": lambda h: odf(at("Desktop", "report.xlsx")(h)),
        "notSaved": lambda h: ooxml(at("Desktop", "report.xlsx")(h), mtime=OLD),
        "hiddenIgnored": lambda h: (os.makedirs(at(".cache")(h)),
                                    ooxml(at(".cache", "report.xlsx")(h)),
                                    plain(at("Desktop", ".~lock.report.xlsx#")(h), "lock")),
        "tooDeep": lambda h: (os.makedirs(at("a", "b", "c", "d")(h)),
                              ooxml(at("a", "b", "c", "d", "report.xlsx")(h))),
    }
    out = {name: run("self-check-rules", [[DONE]], [], setup=setup)
           for name, setup in cases.items()}
    for name, ext, make in (
        ("odsOk", "ods", lambda p: odf(p)),
        ("odtAsOds", "ods", lambda p: odf(p, "application/vnd.oasis.opendocument.text")),
        ("docxAsText", "docx", lambda p: plain(p, "not a zip")),
        ("pdfOk", "pdf", lambda p: plain(p, "%PDF-1.7\n")),
        ("pdfBad", "pdf", lambda p: plain(p, "<html>")),
        ("csvOk", "csv", lambda p: plain(p, "a,b\n1,2\n")),
    ):
        target = "out.%s" % ext
        out[name] = with_instruction(
            "Export the result as %s in the home folder." % target,
            lambda t=target, m=make: run("self-check-rules", [[DONE]], [],
                                         setup=lambda h: m(os.path.join(h, t))))
    for mode in ("raises", "none", "exit1", "noEnd"):
        out["unavailable-" + mode] = run("self-check-rules", [[DONE]], [], mode=mode,
                                         setup=lambda h: ooxml(at("Desktop", "report.xlsx")(h)))
    return out


def raises(fn):
    try:
        fn()
    except ValueError as exc:
        return str(exc)
    return None


def reachable(root, targets, limit=20000):
    """Which of ``targets`` (by identity) the instance graph from ``root`` reaches: instance
    dicts and slots, bound-method selves, closure cells, partial arguments and containers.
    Classes, modules and function globals are not followed (the static check forbids reaching
    them from the hook: test/benchmark/independence.test.ts)."""
    seen, stack, hits = set(), [root], set()
    ids = {id(t): name for name, t in targets.items()}
    while stack and len(seen) < limit:
        obj = stack.pop()
        if id(obj) in seen or isinstance(obj, (type, types.ModuleType)):
            continue
        seen.add(id(obj))
        if id(obj) in ids:
            hits.add(ids[id(obj)])
        if isinstance(obj, types.FunctionType):
            stack.extend(c.cell_contents for c in (obj.__closure__ or ()))
            stack.extend(obj.__defaults__ or ())
            continue
        if isinstance(obj, types.MethodType):
            stack.extend([obj.__self__, obj.__func__])
            continue
        if isinstance(obj, dict):
            stack.extend(obj.keys())
            stack.extend(obj.values())
            continue
        if isinstance(obj, (list, tuple, set, frozenset)):
            stack.extend(obj)
            continue
        if isinstance(obj, (str, bytes, int, float, bool)) or obj is None:
            continue
        stack.extend(r for r in gc.get_referents(obj) if not isinstance(r, (type, types.ModuleType)))
        for slot in getattr(type(obj), "__slots__", ()):
            try:
                stack.append(object.__getattribute__(obj, slot))
            except AttributeError:
                pass
    return sorted(hits)


def closure_route():
    """B2 (18:11Z): the handle the patch builds has no path to the environment or its ground
    truth; the round-2 getter (``lambda: env.controller``) had one. The verifier's W2c2 and
    W2b2 attacks, run against both."""
    home = new_home()
    _desktop, provider = make_desktop(home)
    env = FakeEnv(1.0, provider, home)
    handle = patch_handle(env)
    old = lambda: env.controller  # noqa: E731 - the round-2 route, for the bite check
    targets = {"env": env, "taskConfig": env.task_config, "cacheDir": env.cache_dir}

    def w2c2(getter):  # reads the task's evaluator config through the closure
        try:
            cfg = getter.__closure__[0].cell_contents.task_config["evaluator"]
            return "reached evaluator config: %s" % cfg["func"]
        except (AttributeError, TypeError, IndexError, KeyError) as exc:
            return "blocked: %s" % type(exc).__name__

    def w2b2(getter):  # reads the ground-truth score through the closure
        try:
            return "reached score: %s" % getter.__closure__[0].cell_contents.evaluate()
        except (AttributeError, TypeError, IndexError, KeyError) as exc:
            return "blocked: %s" % type(exc).__name__

    return {
        "expression": PATCH_CONTROLLER_EXPR,
        "handleType": type(handle).__name__,
        "publicAttributes": sorted(a for a in dir(handle) if not a.startswith("_")),
        "hasClosure": hasattr(handle, "__closure__"),
        "hasDict": hasattr(handle, "__dict__"),
        "handleReaches": reachable(handle, targets),
        "oldGetterReaches": reachable(old, targets),
        "w2c2": {"handle": w2c2(handle), "oldGetter": w2c2(old)},
        "w2b2": {"handle": w2b2(handle), "oldGetter": w2b2(old)},
        "lambdaRefused": raises(lambda: hook.DoneGate(FakeAgent([]), "self-check", controller=old)),
    }


report = {
    "constants": {"arms": list(hook.ARMS), "ablations": list(hook.ABLATION_ARMS),
                  "runnerArms": list(hook.RUNNER_ARMS),
                  "tool": hook.GATE_TOOL, "api": hook.GATE_API_VERSION,
                  "claimLimit": hook.CLAIM_LIMIT, "linux": LINUX,
                  "dump": hook.SELF_CHECK_DUMP,
                  "dumpSha256": hashlib.sha256(hook.SELF_CHECK_DUMP.encode()).hexdigest(),
                  "reverify": hook.SELF_CHECK_REVERIFY,
                  "reverifyUnavailable": hook.reverify_text(None),
                  "dumpLimit": hook.DUMP_LIMIT,
                  "probe": hook.SELF_CHECK_PROBE,
                  "probeSha256": hashlib.sha256(hook.SELF_CHECK_PROBE.encode()).hexdigest(),
                  "selfCheckCodes": list(hook.SELF_CHECK_CODES),
                  "checkTimeout": hook.CHECK_TIMEOUT_S,
                  "gateClientTimeout": hook.StdioGateClient([]).timeout,
                  "controllerMargin": hook.CONTROLLER_HTTP_MARGIN_S,
                  "retryTimes": hook.CONTROLLER_RETRY_TIMES,
                  "retryInterval": hook.CONTROLLER_RETRY_INTERVAL_S,
                  "selfCheckFeedback": hook.self_check_feedback_text(["CODE_A", "CODE_B"]),
                  "hasSuffix": hasattr(hook, "SELF_CHECK_SUFFIX"),
                  "guestWatch": GUEST_WATCH.armed},
    "instruction": INSTRUCTION,
    "ground": {"gold": GOLD, "score": SCORE_FILE, "taskConfig": TASK_CONFIG_FILE},
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
            # N4: `accepted` must be exactly true, not merely truthy.
            "acceptedOne": reply("verified", 1, ["ORACLE_PASS"]),
            "acceptedString": reply("verified", "true", ["ORACLE_PASS"]),
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
        "rulesWithLambda": raises(
            lambda: hook.DoneGate(FakeAgent([]), "self-check-rules", controller=lambda: None)),
        "noGateWithController": raises(
            lambda: hook.DoneGate(FakeAgent([]), "no-gate", controller=lambda: None)),
        "gateArmWithController": raises(
            lambda: hook.DoneGate(FakeAgent([]), "gate-before-done", gate=FakeGate([]),
                                  task_id="t", run_id="r", controller=lambda: None)),
        "handleWithoutClass": raises(lambda: hook.ControllerHandle(lambda p: "h", "p", None)),
    },
    "parseAddress": [hook.parse_address("127.0.0.1:5011:9222:8006:8080"),
                     hook.parse_address("10.0.0.5"),
                     hook.parse_address("[2001:db8::1]:5000:9222:8006:8080")],
}

# The runner patch hands wrap_agent the same handle in every arm; only the self-check arms keep it.
_h = patch_handle(FakeEnv(1.0, make_desktop(new_home())[1], WORK))
report["wrapController"] = {
    arm: hook.wrap_agent(FakeAgent([]), arm, ["true"] if arm == "gate-before-done" else None,
                         "t", "r", controller=_h).controller is _h
    for arm in hook.RUNNER_ARMS
}
report["closureRoute"] = closure_route()

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

# The pre-registered task set's instructions (for the ablation's named-file count and the
# config-graded task below).
_tasks = os.path.join(HOOK_DIR, "..", "..", "..", "benchmark", "upstream", "osworld-office-v1",
                      "tasks.jsonl")
with open(_tasks, encoding="utf-8") as _f:
    _rows = [json.loads(line) for line in _f if line.strip()]
_instructions = [r["instruction"] for r in _rows]
report["taskSetNamed"] = {"tasks": len(_instructions),
                          "withNames": sum(1 for t in _instructions if hook.named_files(t))}
EF9D12BD = next(r["instruction"] for r in _rows
                if r["taskId"] == "ef9d12bd-bcee-4ba0-a40e-918400f43ddf")


def config_graded(arm, loop="local", tag=None):
    """ef9d12bd (restore Impress's slide panel; graded from the accessibility tree, no
    document) and the tasks graded from ~/.config/libreoffice: the agent does the work in the
    application, saves no document, and says DONE. Only LibreOffice's own settings file in the
    hidden profile changes."""
    def setup(h):
        os.makedirs(at(".config", "libreoffice", "4", "user")(h))
        plain(at(".config", "libreoffice", "4", "user", "registrymodifications.xcu")(h), "<x/>")
    return with_instruction(EF9D12BD, lambda: run(arm, [[CLICK], [DONE], [DONE], [DONE]], [],
                                                   max_steps=4, loop=loop, tag=tag, setup=setup))


if LINUX:
    report["dump"] = dump_cases()
    report["rules"] = rules_cases()
    report["configGraded"] = {"self-check": config_graded("self-check"),
                              "self-check-rules": config_graded("self-check-rules"),
                              "no-gate": config_graded("no-gate")}
    # A refused DONE on the last step: the turn is used, nothing is accepted.
    report["selfCheckBudget"] = run("self-check", [[CLICK], [CLICK], [DONE]], [], max_steps=3)
    report["rulesBudget"] = run("self-check-rules", [[DONE]] * 3, [], max_steps=3)
    report["selfCheckBatch"] = run("self-check", [[CLICK, DONE, TYPE], [SAVE], [DONE]], [])
    # N2: probe calls per DONE, many DONEs in one episode.
    report["manyDones"] = {
        "self-check": run("self-check", [[DONE], [CLICK], [DONE]], []),
        "self-check-rules": run("self-check-rules", [[DONE]] * 4, [], max_steps=4),
    }
    ticks = iter([0.0, 0.0, 3600.0])
    slow_desktop, slow_provider = make_desktop(new_home())
    slow_env = FakeEnv(1.0, slow_provider, slow_desktop.home)
    gated = hook.DoneGate(FakeAgent([[DONE]]), "self-check", controller=patch_handle(slow_env),
                          clock=lambda: next(ticks))
    gated.reset()
    gated.predict(INSTRUCTION, {"screenshot": b"s"})
    report["selfCheckSlowClock"] = {"scripts": slow_desktop.scripts}

# Positive controls: the tripwires record a planted gold read, score-file read and task-config
# read on the host, a planted evaluator call and config read through the agent's env, and a
# guest script that reads ground truth next to the home (the verifier's W3 line) or lists it.
bite_home = new_home()
bite_desktop, bite_provider = make_desktop(bite_home)
bite_env = FakeEnv(1.0, bite_provider, bite_home)
bite_agent = FakeAgent([], bite_env)
GUARD["events"] = []
WATCH["touched"] = []


def _planted():
    for path in (GOLD, SCORE_FILE, TASK_CONFIG_FILE):
        try:
            open(path, "rb").close()
        except OSError:
            pass
    bite_agent.env.evaluate()
    bite_agent.env.task_config.get("evaluator")
    bite_provider.container  # noqa: B018 - a provider attribute other than get_ip_address


guarded(_planted)()
report["tripwireBite"] = {"hostEvents": list(GUARD["events"]), "touched": list(WATCH["touched"])}
GUARD["events"] = []
WATCH["touched"] = []
guest_bites = {}
if LINUX:
    for name, line in {
        "w3": 'd=$(dirname "$HOME"); cat "$d/ground/re"*"t.txt" >/dev/null 2>&1',
        "listSiblings": 'ls "$HOME/.." >/dev/null 2>&1',
        "configRead": 'cat "$HOME/../ground/examples/"*.json >/dev/null 2>&1',
        "goldGlob": 'cat "$(dirname "$HOME")"/ground/cache/*/* >/dev/null 2>&1',
    }.items():
        before = len(bite_desktop.guest_events)
        bite_desktop.run(hook.dump_script(5).replace("exec python3", line + "\nexec python3", 1), 20)
        guest_bites[name] = bite_desktop.guest_events[before:]
report["guestBite"] = guest_bites

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

# N1 (#741 round 1) and N4 (round 2): the real stdio transport fails closed when the server
# exits without a reply, replies with a non-object result, or replies with a result object
# that has no structuredContent. Recorded at the client and through DoneGate.
STUB_HEAD = (
    "import json, sys\n"
    "for line in sys.stdin:\n"
    "    m = json.loads(line)\n"
    "    if m.get('method') == 'initialize':\n"
    "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': {}}))\n"
    "    elif m.get('method') == 'tools/call':\n"
)
STUBS = {
    "silent": "import sys\nfor line in sys.stdin:\n    pass\n",
    "nonObject": STUB_HEAD
    + "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': 'verified'}))\n",
    "noStructuredContent": STUB_HEAD
    + "        print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result':"
    " {'content': [{'type': 'text', 'text': 'verified'}], 'isError': False}}))\n",
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
    if LINUX:
        report["upstream"]["configGraded"] = config_graded("self-check", loop="upstream",
                                                           tag="config-graded")
    # Upstream's controller at the pin, read from its source: the retry behaviour the budget
    # text states, the HTTP margin, and the address a controller is built from.
    with open(os.path.join(OSWORLD, "desktop_env", "controllers", "python.py"), encoding="utf-8") as f:
        py = f.read()
    with open(os.path.join(OSWORLD, "desktop_env", "desktop_env.py"), encoding="utf-8") as f:
        de = f.read()
    run_bash = py[py.index("def run_bash_script"):py.index("def ", py.index("def run_bash_script") + 10)]
    report["upstream"]["controllerSource"] = {
        "retryTimes": "self.retry_times = %d" % hook.CONTROLLER_RETRY_TIMES in py,
        "retryInterval": "self.retry_interval = %d" % hook.CONTROLLER_RETRY_INTERVAL_S in py,
        "httpMargin": "timeout=timeout + %d" % hook.CONTROLLER_HTTP_MARGIN_S in run_bash,
        "retriesInRunBash": "for _ in range(self.retry_times):" in run_bash
        and "time.sleep(self.retry_interval)" in run_bash,
        "readTimeoutReturns": "except requests.exceptions.ReadTimeout:" in run_bash,
        "httpServerFromAddress": 'self.http_server = f"http://{vm_ip}:{server_port}"' in py,
        "envParse": "ip_ports_str.rsplit(':', 4)" in de
        and "self.controller = PythonController(vm_ip=self.vm_ip, server_port=self.server_port)" in de,
        "providerAddress": "ip_ports_str = self.provider.get_ip_address(self.path_to_vm)" in de,
        "defaultPort": "self.server_port = %d" % hook.DEFAULT_SERVER_PORT in de,
    }

with open(os.path.join(WORK, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f)
for _name in os.listdir(SCRIPTS):
    os.remove(os.path.join(SCRIPTS, _name))
os.rmdir(SCRIPTS)
