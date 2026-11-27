"""DesktopEnv provider for the Myco Linux fleet (public R1, #682; lead rulings 14:05Z and 14:37Z).

OSWorld's ``DesktopEnv`` asks a provider to start a machine, report where its controller
listens, and reset it. This provider does that with one container per desktop, from the fleet
image (``Dockerfile`` next to this file): Xvfb, the AT-SPI bus, LibreOffice with its GTK3 VCL
plugin, pyautogui and python-xlib, and OSWorld's own controller server (``desktop_env/server``
at the pin, unmodified). Everything else (task setup, the controller, the agent's actions, the
postconfig, the getters and the metrics) is OSWorld's own code at the pin. Every arm of the R1
uses this provider with the same image digest.

Registration: OSWorld picks a provider by name in ``desktop_env/providers/__init__.py`` and
lists clean-start providers in ``desktop_env/desktop_env.py``. The documented patch
``desktop_env_providers.patch`` adds the name ``myco-fleet`` to both, and nothing else; the
pinned harness stamp carries the patched digests (src/benchmark/upstream/pins.ts).

Behaviour:

* ``get_vm_path`` returns the image reference from ``MYCO_FLEET_IMAGE``. It must be pinned by
  digest (``name@sha256:<64 hex>``). It never downloads anything, and refuses any screen size
  but the image's 1920x1080.
* ``start_emulator`` runs ``docker run -d --rm`` with the guest ports published on 127.0.0.1
  only, then waits until the desktop is ready (``desktop_ready``): the controller answers a
  screenshot, the accessibility tree comes back from the AT-SPI bus, and a pyautogui command
  that opens the X display through python-xlib runs through the controller's ``/execute``. A
  desktop missing any of these is stopped and refused with a code, never used.
* ``revert_to_snapshot`` stops the container: a fresh container is the reset, as with OSWorld's
  own docker provider. ``save_state`` is not supported.

The docker CLI and the HTTP client are injectable so the tests drive this module with fakes
(test/benchmark/osworld-fleet.test.ts). It reads no secret and passes none through argv.
"""

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid

from desktop_env.providers.base import Provider, VMManager

PROVIDER_NAME = "myco-fleet"
IMAGE_ENV = "MYCO_FLEET_IMAGE"
MEMORY_ENV = "MYCO_FLEET_MEMORY"
DEFAULT_MEMORY = "2g"
SHM_SIZE = "512m"
SCREEN_SIZE = (1920, 1080)
CONTAINER_PREFIX = "myco-fleet-"
# DesktopEnv's own port order: controller server, chromium, vnc, vlc.
GUEST_PORTS = (5000, 9222, 8006, 8080)
READY_TIMEOUT_S = 180.0
READY_POLL_S = 0.5
IMAGE_REF = re.compile(r"^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$")
MEMORY = re.compile(r"^[1-9][0-9]*[mg]$")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# Run through the controller exactly as DesktopEnv runs an action: `python -c ...`.
PYAUTOGUI_PROBE = (
    "import pyautogui, Xlib.display; Xlib.display.Display(); "
    "w, h = pyautogui.size(); print('MYCO_PYAUTOGUI_OK %dx%d' % (w, h))"
)


class FleetError(RuntimeError):
    """A fleet desktop could not be used. The message is a code."""


def image_ref_problems(ref):
    """Codes for an image reference that is not pinned by digest; empty when it is."""
    if not isinstance(ref, str) or not IMAGE_REF.match(ref):
        return ["IMAGE_NOT_DIGEST_PINNED"]
    return []


def _http(method, url, body=None, timeout=10.0):
    """Default HTTP client: (status, bytes). Errors become status 0."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (urllib.error.URLError, OSError, ValueError):
        return 0, b""


def desktop_ready(base_url, http=_http):
    """Codes for every way the desktop behind ``base_url`` is not usable; empty when ready.

    SCREENSHOT_UNAVAILABLE: the controller does not return a PNG screenshot.
    A11Y_TREE_UNAVAILABLE: ``/accessibility`` does not return an AT-SPI desktop tree.
    PYAUTOGUI_UNAVAILABLE: pyautogui with python-xlib cannot drive the display.
    """
    out = []
    status, body = http("GET", base_url + "/screenshot")
    if status != 200 or not body.startswith(PNG_MAGIC):
        out.append("SCREENSHOT_UNAVAILABLE")
    status, body = http("GET", base_url + "/accessibility")
    tree = None
    if status == 200:
        try:
            tree = json.loads(body.decode("utf-8")).get("AT")
        except (ValueError, AttributeError, UnicodeDecodeError):
            tree = None
    if not isinstance(tree, str) or not tree.lstrip().startswith("<desktop-frame"):
        out.append("A11Y_TREE_UNAVAILABLE")
    status, body = http("POST", base_url + "/execute",
                        {"command": ["python", "-c", PYAUTOGUI_PROBE], "shell": False})
    result = {}
    if status == 200:
        try:
            result = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            result = {}
    output = result.get("output") if isinstance(result, dict) else None
    if (not isinstance(result, dict) or result.get("returncode") != 0
            or not isinstance(output, str)
            or ("MYCO_PYAUTOGUI_OK %dx%d" % SCREEN_SIZE) not in output):
        out.append("PYAUTOGUI_UNAVAILABLE")
    return out


def _docker(args):
    """Default docker CLI runner: stdout text; raises FleetError on failure."""
    try:
        done = subprocess.run(["docker"] + list(args), capture_output=True, text=True,
                              timeout=120, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise FleetError("DOCKER_UNAVAILABLE") from exc
    if done.returncode != 0:
        raise FleetError("DOCKER_FAILED")
    return done.stdout


class MycoFleetVMManager(VMManager):
    """No registry: every desktop is a fresh container from one digest-pinned image."""

    def __init__(self, registry_path=""):
        pass

    def initialize_registry(self, **kwargs):
        pass

    def add_vm(self, vm_path, **kwargs):
        pass

    def delete_vm(self, vm_path, region=None, **kwargs):
        pass

    def occupy_vm(self, vm_path, pid, region=None, **kwargs):
        pass

    def list_free_vms(self, **kwargs):
        return []

    def check_and_clean(self, **kwargs):
        pass

    def get_vm_path(self, os_type="Ubuntu", region=None, screen_size=SCREEN_SIZE, **kwargs):
        if tuple(screen_size) != SCREEN_SIZE:
            raise FleetError("SCREEN_SIZE_UNSUPPORTED")
        ref = os.environ.get(IMAGE_ENV, "")
        problems = image_ref_problems(ref)
        if problems:
            raise FleetError(problems[0])
        return ref


class MycoFleetProvider(Provider):
    """One container per desktop; a fresh container is the reset."""

    def __init__(self, region=None, docker=None, http=None, sleep=time.sleep,
                 clock=time.monotonic, ready_timeout=READY_TIMEOUT_S):
        super().__init__(region)
        self.docker = docker or _docker
        self.http = http or _http
        self.sleep = sleep
        self.clock = clock
        self.ready_timeout = ready_timeout
        self.container = None
        self.ports = None
        self.ready_problems = None

    def _memory(self):
        mem = os.environ.get(MEMORY_ENV, DEFAULT_MEMORY)
        if not MEMORY.match(mem):
            raise FleetError("MEMORY_LIMIT_INVALID")
        return mem

    def _published_port(self, guest_port):
        out = self.docker(["port", self.container, "%d/tcp" % guest_port])
        first = (out.strip().splitlines() or [""])[0]
        host, _, port = first.rpartition(":")
        if host != "127.0.0.1" or not port.isdigit():
            raise FleetError("PORT_NOT_PUBLISHED")
        return int(port)

    def start_emulator(self, path_to_vm, headless=True, os_type="Ubuntu"):
        problems = image_ref_problems(path_to_vm)
        if problems:
            raise FleetError(problems[0])
        if os_type != "Ubuntu":
            raise FleetError("OS_TYPE_UNSUPPORTED")
        memory = self._memory()
        name = CONTAINER_PREFIX + uuid.uuid4().hex[:12]
        args = ["run", "-d", "--rm", "--name", name, "--memory=" + memory,
                "--shm-size=" + SHM_SIZE, "--label", "myco.fleet=" + PROVIDER_NAME]
        for port in GUEST_PORTS:
            args += ["-p", "127.0.0.1::%d" % port]
        args.append(path_to_vm)
        self.docker(args)
        self.container = name
        try:
            self.ports = tuple(self._published_port(p) for p in GUEST_PORTS)
            base = "http://127.0.0.1:%d" % self.ports[0]
            deadline = self.clock() + self.ready_timeout
            while True:
                self.ready_problems = desktop_ready(base, self.http)
                if not self.ready_problems:
                    return
                if self.clock() >= deadline:
                    raise FleetError(self.ready_problems[0])
                self.sleep(READY_POLL_S)
        except Exception:
            self.stop_emulator(path_to_vm)
            raise

    def get_ip_address(self, path_to_vm):
        if self.ports is None:
            raise FleetError("NOT_STARTED")
        return "127.0.0.1:%d:%d:%d:%d" % self.ports

    def save_state(self, path_to_vm, snapshot_name):
        raise NotImplementedError("myco-fleet has no snapshots: a fresh container is the reset")

    def revert_to_snapshot(self, path_to_vm, snapshot_name):
        self.stop_emulator(path_to_vm)

    def stop_emulator(self, path_to_vm, *args, **kwargs):
        name, self.container, self.ports = self.container, None, None
        if name is None:
            return
        try:
            self.docker(["rm", "-f", name])
        except FleetError:
            pass
