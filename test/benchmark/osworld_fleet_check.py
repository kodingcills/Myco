"""Scenario driver for test/benchmark/osworld-fleet.test.ts (MOCK, plumbing only).

Drives the Myco fleet provider (src/benchmark/upstream/fleet/myco_fleet_provider.py), the UTM
parity-reference provider and the parity harness (osworld_parity.py) with fakes: a fake docker
CLI, a fake utmctl, a stand-in for OSWorld's controller server on 127.0.0.1 (one per behaviour:
healthy, no accessibility tree, pyautogui or python-xlib missing, no screenshot), and fake
DesktopEnv objects. Writes <work_dir>/report.json; the TypeScript test makes every assertion.

    python3 -I osworld_fleet_check.py <fleet_dir> <work_dir> [<osworld_checkout>]

Without a checkout, ``desktop_env.providers.base`` is a stand-in with upstream's two abstract
classes. With an OSWorld checkout at the pin (the upstream CI job), the real base classes are
used, and the provider registration patch is applied to a copy of upstream's
``desktop_env/providers/__init__.py`` to show ``create_vm_manager_and_provider`` resolves both
names. No container, VM, image, model or network beyond 127.0.0.1.
"""

import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading

FLEET_DIR, WORK = sys.argv[1], sys.argv[2]
OSWORLD = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16
TREE = '<desktop-frame xmlns:st="uri:deskat:state.at-spi.gnome.org"><application name="soffice"/></desktop-frame>'

if OSWORLD:
    sys.path.insert(0, OSWORLD)
else:
    stub = os.path.join(WORK, "stub")
    os.makedirs(os.path.join(stub, "desktop_env", "providers"), exist_ok=True)
    open(os.path.join(stub, "desktop_env", "__init__.py"), "w").close()
    with open(os.path.join(stub, "desktop_env", "providers", "__init__.py"), "w") as f:
        f.write("")
    with open(os.path.join(stub, "desktop_env", "providers", "base.py"), "w") as f:
        f.write(
            "from abc import ABC\n"
            "class Provider(ABC):\n"
            "    def __init__(self, region=None):\n"
            "        self.region = region\n"
            "class VMManager(ABC):\n"
            "    pass\n"
        )
    sys.path.insert(0, stub)
sys.path.insert(0, FLEET_DIR)
import myco_fleet_provider as fleet  # noqa: E402
import osworld_parity as parity  # noqa: E402
import utm_reference_provider as ref  # noqa: E402

DIGEST_REF = "myco-osworld-desktop@sha256:" + "a" * 64


class Controller(http.server.BaseHTTPRequestHandler):
    """Stand-in for OSWorld's desktop_env/server, with one behaviour per server instance."""

    def log_message(self, *args):
        pass

    def _send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        mode = self.server.mode
        self.server.seen.append(("GET", self.path, None))
        if self.path == "/screenshot":
            if mode == "noScreenshot":
                return self._send(500, b"")
            return self._send(200, PNG, "image/png")
        if self.path == "/accessibility":
            if mode == "noA11y":  # pyatspi cannot reach the AT-SPI registry: Flask's 500
                return self._send(500, b"<html>Internal Server Error</html>", "text/html")
            if mode == "a11yNotTree":
                return self._send(200, json.dumps({"AT": "Currently not implemented"}).encode())
            return self._send(200, json.dumps({"AT": TREE}).encode())
        return self._send(404, b"")

    def do_POST(self):
        mode = self.server.mode
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode())
        self.server.seen.append(("POST", self.path, body))
        if self.path != "/execute":
            return self._send(404, b"")
        if mode == "noPyautogui":
            out = {"status": "success", "output": "", "returncode": 1,
                   "error": "ModuleNotFoundError: No module named 'pyautogui'"}
        elif mode == "noXlib":
            out = {"status": "success", "output": "", "returncode": 1,
                   "error": "Xlib.error.DisplayNameError: Bad display name"}
        elif mode == "wrongSize":
            out = {"status": "success", "output": "MYCO_PYAUTOGUI_OK 1280x800\n",
                   "returncode": 0, "error": ""}
        else:
            out = {"status": "success", "output": "MYCO_PYAUTOGUI_OK 1920x1080\n",
                   "returncode": 0, "error": ""}
        return self._send(200, json.dumps(out).encode())


def serve(mode):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Controller)
    srv.mode = mode
    srv.seen = []
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


MODES = ["healthy", "noA11y", "a11yNotTree", "noPyautogui", "noXlib", "wrongSize", "noScreenshot"]
servers = {m: serve(m) for m in MODES}


class FakeDocker:
    def __init__(self, port):
        self.port = port
        self.calls = []

    def __call__(self, args):
        self.calls.append(list(args))
        if args[0] == "port":
            return "127.0.0.1:%d\n" % (self.port if args[2] == "5000/tcp" else 40000 + len(self.calls))
        return ""


def fleet_start(mode, image=DIGEST_REF):
    docker = FakeDocker(servers[mode].server_address[1])
    provider = fleet.MycoFleetProvider(docker=docker, sleep=lambda s: None, ready_timeout=0)
    out = {"error": None, "ip": None}
    try:
        provider.start_emulator(image, True, "Ubuntu")
        out["ip"] = provider.get_ip_address(image)
        provider.revert_to_snapshot(image, "init_state")
    except fleet.FleetError as exc:
        out["error"] = str(exc)
    out["docker"] = docker.calls
    out["containerAfter"] = provider.container
    return out


report = {"constants": {"provider": fleet.PROVIDER_NAME, "ref": ref.PROVIDER_NAME,
                        "guestPorts": list(fleet.GUEST_PORTS), "probe": fleet.PYAUTOGUI_PROBE,
                        "screen": list(fleet.SCREEN_SIZE)}}
report["ready"] = {m: fleet.desktop_ready("http://127.0.0.1:%d" % s.server_address[1])
                   for m, s in servers.items()}
report["readyUnreachable"] = fleet.desktop_ready("http://127.0.0.1:9")
report["executeSent"] = [b for (meth, path, b) in servers["healthy"].seen if path == "/execute"][0]
report["start"] = {m: fleet_start(m) for m in ("healthy", "noA11y", "noPyautogui", "noXlib")}
report["startTagImage"] = fleet_start("healthy", image="myco-osworld-desktop:local")
report["imageRefs"] = {r: fleet.image_ref_problems(r) for r in
                       [DIGEST_REF, "myco-osworld-desktop:local", "", "x@sha256:" + "a" * 63,
                        "ubuntu@sha256:" + "A" * 64]}


def manager_path(env_value, screen=(1920, 1080)):
    if env_value is None:
        os.environ.pop(fleet.IMAGE_ENV, None)
    else:
        os.environ[fleet.IMAGE_ENV] = env_value
    try:
        return fleet.MycoFleetVMManager().get_vm_path("Ubuntu", None, screen_size=screen)
    except fleet.FleetError as exc:
        return "ERR:" + str(exc)


report["manager"] = {
    "digest": manager_path(DIGEST_REF),
    "tag": manager_path("myco-osworld-desktop:local"),
    "unset": manager_path(None),
    "otherScreen": manager_path(DIGEST_REF, (1280, 720)),
    "freeVms": fleet.MycoFleetVMManager().list_free_vms(),
}
try:
    fleet.MycoFleetProvider().save_state(DIGEST_REF, "s")
    report["saveState"] = "returned"
except NotImplementedError:
    report["saveState"] = "NotImplementedError"

# The UTM reference provider: never run for real; utmctl is a fake.
utm_calls = []
os.environ[ref.ENDPOINT_ENV] = "127.0.0.1:%d:9222:8006:8080" % servers["healthy"].server_address[1]
rp = ref.UtmReferenceProvider(utmctl=lambda a: utm_calls.append(list(a)) or "",
                              sleep=lambda s: None, ready_timeout=0)
rp.start_emulator("OSWorld Ubuntu arm", True, "Ubuntu")
report["utm"] = {"ip": rp.get_ip_address("OSWorld Ubuntu arm")}
rp.revert_to_snapshot("OSWorld Ubuntu arm", "init_state")
report["utm"]["calls"] = utm_calls
os.environ[ref.ENDPOINT_ENV] = "10.0.0.5:5000:9222:8006:8080"
try:
    rp.get_ip_address("OSWorld Ubuntu arm")
    report["utm"]["badEndpoint"] = None
except ref.ReferenceError as exc:
    report["utm"]["badEndpoint"] = str(exc)
os.environ[ref.ENDPOINT_ENV] = "127.0.0.1:%d:9222:8006:8080" % servers["noA11y"].server_address[1]
utm_calls.clear()
try:
    rp.start_emulator("OSWorld Ubuntu arm", True, "Ubuntu")
    report["utm"]["noA11y"] = None
except ref.ReferenceError as exc:
    report["utm"]["noA11y"] = str(exc)
report["utm"]["noA11yCalls"] = list(utm_calls)

# Upstream's own registry with the documented patch applied (only with a checkout).
if OSWORLD:
    reg = os.path.join(WORK, "registry")
    for rel in ("desktop_env/__init__.py", "desktop_env/providers/__init__.py",
                "desktop_env/providers/base.py"):
        os.makedirs(os.path.dirname(os.path.join(reg, rel)), exist_ok=True)
        shutil.copyfile(os.path.join(OSWORLD, rel), os.path.join(reg, rel))
    shutil.copyfile(os.path.join(OSWORLD, "desktop_env/desktop_env.py"),
                    os.path.join(reg, "desktop_env/desktop_env.py"))
    applied = subprocess.run(["git", "apply", os.path.join(FLEET_DIR, "desktop_env_providers.patch")],
                             cwd=reg, capture_output=True, text=True)
    probe = os.path.join(WORK, "registry_probe.py")
    with open(probe, "w", encoding="utf-8") as f:
        f.write(
            "import json, sys\n"
            "sys.path[:0] = [%r, %r]\n"
            "from desktop_env.providers import create_vm_manager_and_provider as f\n"
            "m1, p1 = f('myco-fleet', None)\n"
            "m2, p2 = f('utm-reference', None)\n"
            "print(json.dumps([type(m1).__name__, type(p1).__name__, type(m2).__name__,"
            " type(p2).__name__]))\n" % (reg, FLEET_DIR)
        )
    done = subprocess.run([sys.executable, "-I", probe], capture_output=True, text=True)
    report["registry"] = {"applied": applied.returncode, "classes": json.loads(done.stdout or "null"),
                          "stderr": done.stderr[-2000:]}

# The parity harness with fake DesktopEnv objects. Its own task-file hash check and stamping run.
osw = os.path.join(WORK, "osworld")
os.makedirs(os.path.join(osw, ".git"), exist_ok=True)
with open(os.path.join(osw, ".git", "HEAD"), "w") as f:
    f.write(parity.OSWORLD_COMMIT + "\n")
tasks = []
for i, name in enumerate(["calc-a", "writer-b"]):
    rel = "evaluation_examples/examples/x/%s.json" % name
    os.makedirs(os.path.dirname(os.path.join(osw, rel)), exist_ok=True)
    body = json.dumps({"id": name, "config": [], "evaluator": {"func": "x"}}).encode()
    with open(os.path.join(osw, rel), "wb") as f:
        f.write(body)
    tasks.append({"taskId": name, "taskFile": rel, "taskFileSha256": hashlib.sha256(body).hexdigest(),
                  "knownGood": [{"action_type": "tool_use", "command": "pyautogui.press('a')"},
                                {"action_type": "DONE"}],
                  "knownBad": [{"action_type": "DONE"}]})
sample = {"schema": "myco.parity.sample/1", "taskSet": "osworld-office-v1",
          "rule": "Parity must pass before any live run.",
          "envs": {"fleet": {"provider": "myco-fleet"}, "reference": {"provider": "utm-reference"}},
          "tasks": tasks}
with open(os.path.join(WORK, "sample.json"), "w") as f:
    json.dump(sample, f)


class FakeEnv:
    """Scores 1.0 iff the action list is a task's known-good list (or per `override`)."""

    log = []

    def __init__(self, override=None, raise_on=None):
        self.override = override or {}
        self.raise_on = raise_on
        self.task = None
        self.actions = []

    def reset(self, task_config=None):
        self.task = task_config["id"]
        FakeEnv.log.append(("reset", self.task))

    def step(self, action, pause=2):
        if self.raise_on == self.task:
            raise RuntimeError("controller down")
        self.actions.append(action)

    def evaluate(self):
        good = next(t for t in tasks if t["taskId"] == self.task)["knownGood"]
        score = 1.0 if self.actions == good else 0.0
        return self.override.get((self.task, score), score)

    def close(self):
        FakeEnv.log.append(("close", self.task))


def run_env(env_name, **kw):
    return parity.records_for(sample, osw, env_name, lambda: FakeEnv(**kw), "synthetic-host",
                              "sha256:" + "a" * 64 if env_name == "fleet" else None,
                              parity.OSWORLD_COMMIT, now=lambda: "2026-11-27T00:00:00Z")


report["parity"] = {
    "fleet": run_env("fleet"),
    "reference": run_env("reference"),
    # The fleet scores writer-b's known-good as 0.0: a gap.
    "fleetGap": run_env("fleet", override={("writer-b", 1.0): 0.0}),
    # The fleet's controller fails on calc-a: ungradable, never a score.
    "fleetRaises": run_env("fleet", raise_on="calc-a"),
    "envLog": FakeEnv.log,
    "sampleSha256": parity.sample_sha256(sample),
    "harnessFiles": list(parity.HARNESS_FILES),
    "fleetFiles": {k: list(v) for k, v in parity.FLEET_FILES.items()},
    "grader": parity.GRADER_VERSION,
}
with open(os.path.join(osw, tasks[0]["taskFile"]), "ab") as f:
    f.write(b" ")
try:
    run_env("fleet")
    report["parity"]["taskChanged"] = None
except parity.ParityError as exc:
    report["parity"]["taskChanged"] = str(exc)


def main_err(argv, env=None):
    saved = dict(os.environ)
    os.environ.pop("MYCO_FLEET_IMAGE", None)
    os.environ.update(env or {})
    try:
        parity.main(argv, make_env_for=lambda o, p: (lambda: FakeEnv()))
        return "OK"
    except parity.ParityError as exc:
        return str(exc)
    finally:
        os.environ.clear()
        os.environ.update(saved)


base = ["--osworld", osw, "--sample", os.path.join(WORK, "sample.json"), "--out",
        os.path.join(WORK, "main.jsonl"), "--host-label", "synthetic-host"]
report["parityMain"] = {
    "referenceUnapproved": main_err(base + ["--env", "reference"]),
    "referenceBadApproval": main_err(base + ["--env", "reference", "--reference-approved", "yes"]),
    "fleetNoImage": main_err(base + ["--env", "fleet"]),
    "fleetTagImage": main_err(base + ["--env", "fleet"], {"MYCO_FLEET_IMAGE": "x:local"}),
    "unlabelled": main_err(["--osworld", osw, "--sample", os.path.join(WORK, "sample.json"),
                            "--out", os.path.join(WORK, "main.jsonl"), "--host-label", " ",
                            "--env", "fleet"], {"MYCO_FLEET_IMAGE": DIGEST_REF}),
}

for s in servers.values():
    s.shutdown()
with open(os.path.join(WORK, "report.json"), "w", encoding="utf-8") as f:
    json.dump(report, f)
