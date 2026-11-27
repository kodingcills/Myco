"""DesktopEnv provider for the parity REFERENCE run only (lead ruling 2026-11-27 15:21Z).

The parity check (benchmark/upstream/osworld-office-v1/parity.json) scores the same scripted
action sequences on the Myco fleet and on OSWorld's reference environment. The reference is
OSWorld's own guest image (``Ubuntu-arm.zip`` from the Hugging Face dataset
``xlangai/ubuntu_osworld``, the image OSWorld's VMware manager selects on a Mac), with its
in-guest controller and OSWorld's evaluator unchanged. STATED DEVIATION from OSWorld's VMware
reference: the hypervisor is UTM (QEMU with HVF) booting the same split vmdk, because VMware
Fusion's download needs a Broadcom account. Never VMware, never any account.

This module is never run by Myco's tooling or CI. The reference run waits for Tiffany's OK and
the ~40 GB disk question (docs/benchmark/upstream/host-requirements.md). It does not download,
import or convert any image: the operator imports the unzipped vmdk into UTM by hand, names the
VM, and sets UTM's emulated-VLAN port forwards to the guest's ports 5000, 9222, 8006 and 8080.

* ``get_vm_path`` returns the UTM VM name from ``MYCO_REFERENCE_VM``.
* ``start_emulator`` runs ``utmctl start --disposable <vm>`` (UTM's disposable mode discards
  every change on stop, so each start is the clean image) and waits until the controller is
  ready (the same ``desktop_ready`` probe as the fleet).
* ``get_ip_address`` returns ``MYCO_REFERENCE_ENDPOINT``: ``127.0.0.1:<server>:<chromium>:<vnc>:<vlc>``
  as forwarded by UTM.
* ``revert_to_snapshot`` and ``stop_emulator`` run ``utmctl stop <vm>``.

Registered as ``utm-reference`` by desktop_env_providers.patch, in DesktopEnv's dirty-start set
(as OSWorld's vmware provider), so the first reset reverts before the first task.
"""

import os
import re
import subprocess
import time

from desktop_env.providers.base import Provider, VMManager

from myco_fleet_provider import READY_POLL_S, READY_TIMEOUT_S, SCREEN_SIZE, _http, desktop_ready

PROVIDER_NAME = "utm-reference"
VM_ENV = "MYCO_REFERENCE_VM"
ENDPOINT_ENV = "MYCO_REFERENCE_ENDPOINT"
VM_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
ENDPOINT = re.compile(r"^127\.0\.0\.1(?::[1-9][0-9]{0,4}){4}$")


class ReferenceError(RuntimeError):
    """The reference VM could not be used. The message is a code."""


def _utmctl(args):
    try:
        done = subprocess.run(["utmctl"] + list(args), capture_output=True, text=True,
                              timeout=300, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ReferenceError("UTMCTL_UNAVAILABLE") from exc
    if done.returncode != 0:
        raise ReferenceError("UTMCTL_FAILED")
    return done.stdout


def _vm_name():
    name = os.environ.get(VM_ENV, "")
    if not VM_NAME.match(name):
        raise ReferenceError("REFERENCE_VM_UNNAMED")
    return name


def _endpoint():
    value = os.environ.get(ENDPOINT_ENV, "")
    if not ENDPOINT.match(value):
        raise ReferenceError("REFERENCE_ENDPOINT_INVALID")
    return value


class UtmReferenceVMManager(VMManager):
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
            raise ReferenceError("SCREEN_SIZE_UNSUPPORTED")
        return _vm_name()


class UtmReferenceProvider(Provider):
    def __init__(self, region=None, utmctl=None, http=None, sleep=time.sleep,
                 clock=time.monotonic, ready_timeout=READY_TIMEOUT_S):
        super().__init__(region)
        self.utmctl = utmctl or _utmctl
        self.http = http or _http
        self.sleep = sleep
        self.clock = clock
        self.ready_timeout = ready_timeout
        self.ready_problems = None

    def start_emulator(self, path_to_vm, headless=True, os_type="Ubuntu"):
        if not isinstance(path_to_vm, str) or not VM_NAME.match(path_to_vm):
            raise ReferenceError("REFERENCE_VM_UNNAMED")
        endpoint = _endpoint()
        self.utmctl(["start", "--disposable", path_to_vm])
        base = "http://127.0.0.1:%s" % endpoint.split(":")[1]
        deadline = self.clock() + self.ready_timeout
        while True:
            self.ready_problems = desktop_ready(base, self.http)
            if not self.ready_problems:
                return
            if self.clock() >= deadline:
                self.stop_emulator(path_to_vm)
                raise ReferenceError(self.ready_problems[0])
            self.sleep(READY_POLL_S)

    def get_ip_address(self, path_to_vm):
        return _endpoint()

    def save_state(self, path_to_vm, snapshot_name):
        raise NotImplementedError("utm-reference uses UTM's disposable mode, not snapshots")

    def revert_to_snapshot(self, path_to_vm, snapshot_name):
        self.stop_emulator(path_to_vm)

    def stop_emulator(self, path_to_vm, *args, **kwargs):
        try:
            self.utmctl(["stop", path_to_vm])
        except ReferenceError:
            pass
