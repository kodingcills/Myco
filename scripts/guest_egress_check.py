#!/usr/bin/env python3
"""The live half of `scripts/guest-egress.sh verify` (TIF-275).

Reads the running guest's EXACT argv and accepts exactly one launch shape: every
option must be on a fixed ALLOWLIST taken from UTM's own launch, with its value
in the shape UTM writes. Anything else, and anything that cannot be read or
parsed, fails. See docs/security/guest-egress.md for the list, why each entry
is there, and how to update it when UTM changes.

usage:
  guest_egress_check.py live     check the running guest; prints "ok: <netdev>" or
                                 "FAIL: <reason>"; exit 0 / 1
  guest_egress_check.py names    print the running guest's option NAMES (no values),
                                 one per line with "allowed" or "NOT ALLOWED"; a name
                                 outside the fixed QEMU vocabulary prints as its index
  guest_egress_check.py argv     print the running guest's argv, one element per
                                 line (operator inspection): only elements that pass
                                 the allowlist print; every other element prints as
                                 "<redacted argv[i]>"

Exact argv (round 3, verifier D6): `ps -Ao command=` joins argv with spaces, so
an element containing spaces looked like real options. The argv is read from
the kernel instead: sysctl KERN_PROCARGS2 for each candidate pid. Exactly argc
strings are decoded, starting at the pointer-aligned offset after the exec
path (follow-up D9: an empty argv[0] used to shift the environment into argv).

Nothing unvetted is ever printed (round-2 verifier V1). argc comes from the
kernel, but the string area is the process's own memory: a process that
rewrites it (setproctitle-style) can leave fewer argv strings than argc, so the
tail of what we decode is the ENVIRONMENT. It cannot be told apart, so no mode
prints an element's text unless it passed the allowlist: refusals name only the
argv index, fixed text and words from the fixed vocabularies below (option
names, QEMU property names, drivers); `argv` prints only elements accepted as
an allowed option name or value; `names` prints only vocabulary names.

Allowlist (follow-up D7/D8): a denylist misses every option it does not name
(JSON `-object` filters, `-qmp-pretty`, `-vnc`, `-debugcon`, ...). So each
option is checked against ALLOWED below and refused if absent.

Tests: MYCO_PROCARGS_DIR=<dir> reads <dir>/<pid>.bin (fixed KERN_PROCARGS2
buffers) instead of calling sysctl. Candidate pids come from `ps -Ao pid=` only.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import re
import struct
import subprocess
import sys
from collections.abc import Callable, Collection

EXPECTED_HOSTFWD = ["tcp:127.0.0.1:2222-:22"]
QEMU = {"qemu-system-aarch64", "qemu-aarch64-softmmu"}
NETDEV_KEYS = {"id", "restrict", "hostfwd"}
CTL_KERN, KERN_ARGMAX, KERN_PROCARGS2 = 1, 8, 49
# xnu pads the exec path in the string area to the process's pointer size
# (exec_extract_strings); every guest is a 64-bit process.
PTR_SIZE = 8

UUID = r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
# A host path as UTM writes it. No ':' (so no nbd:, json:, http:// block
# protocols), no ',' (QEMU's separator), no whitespace (refused globally).
PATH = r"[A-Za-z0-9_./+-]+"
WORD = r"[A-Za-z0-9_.-]+"


class Refused(Exception):
    pass


def parse_procargs2(buf: bytes) -> list[str]:
    """argv from a KERN_PROCARGS2 buffer: int32 argc, the exec path NUL-padded
    to a multiple of PTR_SIZE, then argc NUL-terminated strings (then the
    environment, never read). Raises Refused on anything malformed, including
    an empty argv[0]: it is indistinguishable from padding, and skipping it
    would read the first environment string as the last argument (D9)."""
    if len(buf) < 4:
        raise Refused("procargs buffer too short")
    (argc,) = struct.unpack_from("<i", buf, 0)
    if argc < 1 or argc > 4096:
        raise Refused(f"implausible argc {argc}")
    end = buf.find(b"\0", 4)  # end of the exec path
    if end < 0:
        raise Refused("procargs: unterminated exec path")
    if end == 4:
        raise Refused("procargs: empty exec path")
    pos = 4 + -(-(end - 4 + 1) // PTR_SIZE) * PTR_SIZE
    if pos > len(buf) or buf[end:pos].strip(b"\0"):
        raise Refused("procargs: malformed exec path padding")
    if pos >= len(buf) or buf[pos] == 0:
        raise Refused("procargs: empty argv[0] (or padding longer than the pointer size)")
    argv = []
    for _ in range(argc):
        stop = buf.find(b"\0", pos)
        if stop < 0:
            raise Refused("procargs: truncated argv")
        try:
            argv.append(buf[pos:stop].decode("utf-8"))
        except UnicodeDecodeError as e:
            raise Refused("procargs: argv is not UTF-8") from e
        pos = stop + 1
    return argv


def exec_path(buf: bytes) -> str:
    """The exec path of a KERN_PROCARGS2 buffer, or "" if it cannot be read.
    Only compared against QEMU names, never printed."""
    end = buf.find(b"\0", 4)
    if len(buf) < 4 or end < 0:
        return ""
    return buf[4:end].decode("utf-8", "replace")


def read_procargs2(pid: int) -> bytes:
    fixtures = os.environ.get("MYCO_PROCARGS_DIR")
    if fixtures:
        path = os.path.join(fixtures, f"{pid}.bin")
        if not os.path.exists(path):
            raise Refused(f"no procargs for pid {pid}")
        with open(path, "rb") as f:
            return f.read()
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    argmax = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    mib2 = (ctypes.c_int * 2)(CTL_KERN, KERN_ARGMAX)
    if libc.sysctl(mib2, 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0:
        raise Refused("sysctl KERN_ARGMAX failed")
    buf = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(argmax.value)
    mib3 = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
    if libc.sysctl(mib3, 3, buf, ctypes.byref(size), None, 0) != 0:
        raise Refused(f"sysctl KERN_PROCARGS2 failed for pid {pid} (errno {ctypes.get_errno()})")
    return buf.raw[: size.value]


def candidate_pids() -> list[int]:
    try:
        out = subprocess.run(["ps", "-Ao", "pid="], capture_output=True, text=True, timeout=10)
    except Exception as e:  # noqa: BLE001 - any failure to list processes fails closed
        raise Refused(f"could not list processes: {e}") from e
    if out.returncode != 0 or not out.stdout.strip():
        raise Refused("could not list processes")
    pids = []
    for tok in out.stdout.split():
        if not tok.isdigit():
            raise Refused(f"unparseable pid {tok!r}")
        pids.append(int(tok))
    return pids


def base(tok: str) -> str:
    return tok.rsplit("/", 1)[-1]


def is_guest(argv: list[str]) -> bool:
    b0 = base(argv[0])
    # A guest is a qemu binary, or UTM's QEMULauncher running one. UTM's swtpm
    # also runs under QEMULauncher and is not a guest.
    return b0 in QEMU or (b0 == "QEMULauncher" and len(argv) > 1 and base(argv[1]) in QEMU)


def find_guest_argv() -> list[str]:
    guests = []
    for pid in candidate_pids():
        if pid == os.getpid():
            continue
        try:
            buf = read_procargs2(pid)
        except Refused:
            # Processes we may not read (other users, exited) cannot be guests
            # we launched; but a fixture-driven run must not hide one.
            if os.environ.get("MYCO_PROCARGS_DIR"):
                raise
            continue
        try:
            argv = parse_procargs2(buf)
        except Refused:
            # A readable buffer that does not parse is skipped only when it is
            # not a qemu (or QEMULauncher) executable: a second guest with an
            # empty argv[0] must not go uncounted (round-2 nit).
            if os.environ.get("MYCO_PROCARGS_DIR") or base(exec_path(buf)) in QEMU | {"QEMULauncher"}:
                raise
            continue
        if is_guest(argv):
            guests.append(argv)
    if len(guests) != 1:
        raise Refused(f"expected exactly one running guest, found {len(guests)}")
    return guests[0]


# ---------------------------------------------------------------------------
# Value parsing
#
# Refusal messages never contain argv text (round-2 verifier V1): the decoded
# tail may be the environment block (see the module docstring). A message is
# built from fixed text, argv indexes, constants of the allowlist, and words
# passed through key()/said(), which print a word only if it is in one of the
# fixed vocabularies below. So a refusal can never print an environment string.

# QEMU option names (as normalised: one leading '-'). Printing one of these is
# printing a word of this file, not of the process.
QEMU_OPTIONS = {
    "-machine", "-M", "-cpu", "-accel", "-smp", "-numa", "-add-fd", "-set", "-global",
    "-boot", "-m", "-mem-path", "-mem-prealloc", "-k", "-audio", "-audiodev", "-soundhw",
    "-device", "-name", "-uuid", "-fda", "-fdb", "-hda", "-hdb", "-hdc", "-hdd", "-cdrom",
    "-blockdev", "-drive", "-mtdblock", "-sd", "-pflash", "-snapshot", "-fsdev", "-virtfs",
    "-iscsi", "-usb", "-usbdevice", "-display", "-nographic", "-curses", "-alt-grab",
    "-ctrl-grab", "-no-quit", "-sdl", "-spice", "-portrait", "-rotate", "-vga",
    "-full-screen", "-g", "-vnc", "-win2k-hack", "-no-fd-bootchk", "-no-acpi", "-no-hpet",
    "-acpitable", "-smbios", "-nic", "-netdev", "-net", "-chardev", "-tpmdev", "-bt",
    "-kernel", "-append", "-initrd", "-dtb", "-compat", "-fw_cfg", "-serial", "-parallel",
    "-monitor", "-qmp", "-qmp-pretty", "-mon", "-debugcon", "-pidfile", "-singlestep",
    "-one-insn-per-tb", "-S", "-overcommit", "-gdb", "-s", "-d", "-D", "-dfilter", "-seed",
    "-L", "-bios", "-enable-kvm", "-xen-domid", "-xen-attach", "-no-reboot", "-no-shutdown",
    "-action", "-loadvm", "-daemonize", "-option-rom", "-rtc", "-icount", "-watchdog",
    "-watchdog-action", "-echr", "-incoming", "-only-migratable", "-nodefaults", "-chroot",
    "-runas", "-sandbox", "-readconfig", "-no-user-config", "-nodefconfig", "-trace",
    "-plugin", "-qtest", "-qtest-log", "-enable-fips", "-msg", "-dump-vmstate",
    "-enable-sync-profile", "-object", "-run-with", "-semihosting", "-semihosting-config",
    "-prom-env", "-tb-size", "-preconfig", "-async-teardown", "-h", "-help", "-version",
}  # fmt: skip

# QEMU property and sub-option names (-device, -netdev, -chardev, -drive, -spice, ...).
PROPERTY_NAMES = {
    "id", "bus", "addr", "port", "tls-port", "host", "password", "password-secret",
    "x509-dir", "tls-ciphers", "tls-creds", "sasl", "ipv4", "ipv6", "driver", "url",
    "snapshot", "aio", "copy-on-read", "werror", "rerror", "server", "wait", "nodelay",
    "telnet", "websocket", "reconnect", "path", "logfile", "logappend", "mux", "signal",
    "queue", "outdev", "indev", "netdev", "chardev", "romfile", "rombar", "mac",
    "vectors", "tpmdev", "drive", "serial", "bootindex", "name", "debug", "guest-cid",
    "file", "filename", "file.filename", "file.locking", "format", "if", "unit", "index",
    "readonly", "media", "discard", "detect-zeroes", "cache", "mode", "pretty", "model",
    "vlan", "fd", "fds", "script", "downscript", "br", "helper", "vhost", "vhostfd",
    "sock", "socket", "listen", "connect", "mcast", "localaddr", "udp", "guestfwd",
    "hostfwd", "restrict", "smb", "smbserver", "tftp", "tftp-server-name", "bootfile",
    "dns", "dhcpstart", "hostname", "net", "domainname", "dnssearch", "ipv6-net",
    "ipv6-host", "ipv6-dns", "ipv6-prefix", "ipv6-prefixlen", "type", "qom-type",
    "props", "memdev", "share", "mem-path", "size", "unix", "gl", "rendernode",
    "streaming-video", "image-compression", "playback-compression", "disable-ticketing",
    "jpeg-wan-compression", "zlib-glz-wan-compression", "agent-mouse",
    "seamless-migration", "disable-copy-paste", "disable-agent-file-xfer", "menu", "order",
    "splash-time", "base", "clock", "driftfix", "highmem", "gic-version", "virtualization",
    "secure", "mte", "iommu", "its", "ras", "cpus", "sockets", "cores", "threads",
    "maxcpus", "emulator", "policy", "multifunction", "x-pci-vendor-id",
}  # fmt: skip

CHARDEV_BACKENDS = {
    "socket", "udp", "pty", "file", "pipe", "stdio", "null", "vc", "ringbuf", "memory",
    "serial", "tty", "parallel", "parport", "spiceport", "spicevmc", "mux", "msmouse",
    "wctablet", "braille", "testdev", "qemu-vdagent", "dbus",
}  # fmt: skip

NETDEV_TYPES = {
    "user", "tap", "bridge", "socket", "stream", "dgram", "l2tpv3", "vde", "netmap",
    "vhost-user", "vhost-vdpa", "af-xdp", "vmnet-host", "vmnet-shared", "vmnet-bridged",
    "hubport",
}  # fmt: skip


def said(word: str, vocab: Collection[str], other: str) -> str:
    """`word` if it is in a fixed vocabulary, else `other`: never argv text."""
    return word if word in vocab else other


def key(k: str, *vocabs: Collection[str]) -> str:
    """`k=` for a vocabulary property name, else a neutral phrase."""
    return f"{k}=" if k in PROPERTY_NAMES or any(k in v for v in vocabs) else "(an unrecognised key)"


def split_value(value: str, what: str) -> list[str]:
    """QEMU `a,k=v,...` fields; refuses JSON form, escaped commas and empties."""
    if value.startswith("{"):
        raise Refused(f"{what} in JSON form is refused (only UTM's key=value form is allowed)")
    if not value:
        raise Refused(f"{what} with an empty value")
    if ",," in value:
        raise Refused(f"unparseable {what} (escaped comma)")
    return value.split(",")


def keyvals(fields: list[str], what: str) -> list[tuple[str, str]]:
    out = []
    for p in fields:
        k, eq, v = p.partition("=")
        if not eq or not k:
            raise Refused(f"unparseable {what} option (a field without 'key=')")
        out.append((k, v))
    return out


def options(value: str, what: str) -> list[tuple[str, str]]:
    """The k=v options after the first field."""
    return keyvals(split_value(value, what)[1:], what)


def kv_rule(
    what: str,
    keys: dict[str, str],
    head: str | None = None,
    required: dict[str, str] | None = None,
) -> Callable[[str], None]:
    """A value of the form `[head,]k=v,...`: head must fullmatch `head` (None =
    no head field), every key must be in `keys`, and its value must fullmatch
    the key's pattern. `required` keys must be present with that exact value."""

    def rule(value: str) -> None:
        fields = split_value(value, what)
        if head is not None:
            if "=" in fields[0] or not re.fullmatch(head, fields[0]):
                raise Refused(f"{what} type is not in the allowlist")
            fields = fields[1:]
        seen: dict[str, str] = {}
        for k, v in keyvals(fields, what):
            if k not in keys:
                raise Refused(f"{what} option {key(k)} is not in the allowlist")
            if k in seen:
                raise Refused(f"{what} option {k}= given twice")
            if not re.fullmatch(keys[k], v):
                raise Refused(f"{what} option {k}= has a value not in the allowed shape")
            seen[k] = v
        for k, v in (required or {}).items():
            if seen.get(k) != v:
                raise Refused(f"{what} needs {k}={v}")

    return rule


def exact(what: str, *allowed: str) -> Callable[[str], None]:
    def rule(value: str) -> None:
        if value not in allowed:
            raise Refused(f"{what} value is not in the allowlist (want {' or '.join(allowed)})")

    return rule


def shape(what: str, pattern: str) -> Callable[[str], None]:
    def rule(value: str) -> None:
        if value.startswith("{"):
            raise Refused(f"{what} in JSON form is refused")
        if not re.fullmatch(pattern, value):
            raise Refused(f"{what} value is not in the allowed shape")

    return rule


# ---------------------------------------------------------------------------
# THE ALLOWLIST. Every option in the guest's argv must be a key here. Source:
# UTM 5.0.9's QEMU launch for myco-win11 (wizard-default Windows 11 ARM64:
# HVF, NVMe disk, virtio-ramfb, TPM, SPICE). Entries marked LIVE are confirmed
# in the evidence pack (docs/research/experiments/tif-275-egress/
# 10-round3-verify-live.txt); the rest come from UTM's argument builder for
# this VM type and are confirmed by `guest_egress_check.py names` on the live
# guest. To update for a new UTM: run `names` (prints names only), review each
# NOT ALLOWED option against the threat model in docs/security/guest-egress.md,
# add it here with the tightest value rule, and add a test. Never add -object,
# -netdev variants, -nic, -net, -qmp*, -monitor, -gdb, -readconfig, -set,
# -global, -add-fd, -incoming, -vnc, -display, -debugcon or -parallel.

FLAGS = {"-nodefaults", "-S"}  # LIVE: -nodefaults. -S: UTM starts paused, resumes over QMP.

SAFE = r"[A-Za-z0-9_.:/+@-]*"  # a device property value: no ',' '=' '{' or whitespace

# Device drivers UTM's builder emits for an ARM64 guest. Notably absent: any
# other NIC (e1000, usb-net, ...), vhost-*, vfio-*, ivshmem, virtio-9p, usb-host.
DEVICE_DRIVERS = {
    "virtio-net-pci",  # LIVE: the one NIC
    "virtio-ramfb", "virtio-ramfb-gl", "ramfb", "virtio-gpu-pci", "virtio-gpu-gl-pci",
    "intel-hda", "ich9-intel-hda", "hda-duplex", "hda-output",
    "nec-usb-xhci", "qemu-xhci", "usb-tablet", "usb-mouse", "usb-kbd",
    "usb-redir", "usb-storage", "nvme", "virtio-blk-pci",
    "virtio-serial", "virtio-serial-pci", "virtserialport",
    "tpm-tis-device", "virtio-rng-pci", "virtio-balloon-pci",
    "virtio-keyboard-pci", "virtio-mouse-pci", "virtio-tablet-pci",
}  # fmt: skip

# Drivers that are refused but may be NAMED in a refusal (vocabulary only).
REFUSED_DRIVERS = {
    "e1000", "e1000e", "e1000-82544gc", "e1000-82545em", "igb", "rtl8139", "usb-net",
    "vmxnet3", "ne2k_pci", "pcnet", "i82550", "i82559er", "virtio-net-device",
    "vhost-vsock-pci", "vhost-vsock-device", "vhost-user-fs-pci", "vhost-user-vsock-pci",
    "virtio-9p-pci", "virtio-9p-device", "usb-host", "vfio-pci", "vfio-platform",
    "ivshmem", "ivshmem-plain", "ivshmem-doorbell", "usb-serial", "pci-serial",
}  # fmt: skip


def device_rule(value: str) -> None:
    fields = split_value(value, "-device")
    if "=" in fields[0] or fields[0] not in DEVICE_DRIVERS:
        drv = said(fields[0], REFUSED_DRIVERS, "driver")
        raise Refused(f"-device {drv} is not in the allowlist")
    seen = set()
    for k, v in keyvals(fields[1:], "-device"):
        if not re.fullmatch(WORD, k) or not re.fullmatch(SAFE, v):
            raise Refused(f"-device option {key(k)} is not in the allowed shape")
        if k in seen:
            raise Refused(f"-device option {key(k)} given twice")
        seen.add(k)


def chardev_rule(value: str) -> None:
    # LIVE: exactly these four shapes. pty only as UTM's term0 (D7: a second pty
    # was a filter's outdev); socket only the swtpm unix socket.
    backend = split_value(value, "-chardev")[0]
    if backend == "spiceport":
        kv_rule("-chardev spiceport", {"name": WORD, "id": WORD}, head="spiceport")(value)
    elif backend == "spicevmc":
        kv_rule("-chardev spicevmc", {"name": WORD, "id": WORD, "debug": r"\d"}, head="spicevmc")(value)
    elif backend == "pty":
        if value != "pty,id=term0":
            raise Refused("-chardev pty other than UTM's term0 is refused")
    elif backend == "socket":
        if not re.fullmatch(rf"socket,id=chrtpm0,path={UUID}\.swtpm", value):
            raise Refused("-chardev socket other than UTM's swtpm socket is refused")
    else:
        b = said(backend, CHARDEV_BACKENDS, "(unrecognised)")
        raise Refused(f"-chardev backend {b} is not in UTM's allowlist")
    if "id" not in dict(options(value, "-chardev")):
        raise Refused("-chardev without id=")


def netdev_rule(value: str) -> None:
    """The one netdev, checked as a whole value; check() adds the count and
    who references it. Vetting it here lets `argv` mode print it."""
    fields = split_value(value, "-netdev")
    if fields[0] != "user":
        raise Refused(f"netdev is not user-mode (type {said(fields[0], NETDEV_TYPES, 'unrecognised')})")
    opts: dict[str, list[str]] = {}
    for k, v in keyvals(fields[1:], "netdev"):
        if k not in NETDEV_KEYS:
            kind = "guest-initiated channel" if k == "guestfwd" else "not in the allowlist"
            raise Refused(f"netdev option {key(k)} is not allowed ({kind})")
        opts.setdefault(k, []).append(v)
    ids = opts.get("id", [])
    if len(ids) != 1 or not re.fullmatch(WORD, ids[0]):
        raise Refused("expected exactly one id= (a word) in the netdev")
    restrict = opts.get("restrict", [])
    if not restrict or any(v != "on" for v in restrict):
        raise Refused("restrict=on missing or overridden in the netdev")
    hostfwd = opts.get("hostfwd", [])
    if sorted(hostfwd) != EXPECTED_HOSTFWD:
        raise Refused(f"hostfwd set is not exactly {EXPECTED_HOSTFWD} ({len(hostfwd)} forward(s) given)")


ALLOWED: dict[str, Callable[[str], None]] = {
    # LIVE
    "-spice": kv_rule(
        "-spice",
        {
            "unix": "on",
            "addr": PATH,
            "disable-ticketing": "on",
            "image-compression": WORD,
            "playback-compression": "on|off",
            "streaming-video": WORD,
            "gl": "on|off",
            "rendernode": PATH,
        },
        required={"unix": "on"},  # a unix socket only: no port=, tls-port=, IP addr
    ),
    "-chardev": chardev_rule,
    "-mon": exact("-mon", "chardev=org.qemu.monitor.qmp,mode=control"),
    "-netdev": netdev_rule,
    "-device": device_rule,
    "-serial": exact("-serial", "chardev:term0"),
    "-tpmdev": exact("-tpmdev", "emulator,id=tpm0,chardev=chrtpm0"),
    # UTM's argument builder for this VM type
    "-L": shape("-L", "/" + PATH),
    "-vga": exact("-vga", "none"),
    "-cpu": shape("-cpu", r"[A-Za-z0-9_.-]+(,[A-Za-z0-9_.+-]+(=[A-Za-z0-9_.-]+)?)*"),
    "-smp": kv_rule(
        "-smp",
        {k: r"\d{1,3}" for k in ("cpus", "sockets", "cores", "threads", "maxcpus")},
        head=None,
    ),
    "-machine": kv_rule(
        "-machine",
        {k: WORD for k in ("highmem", "gic-version", "virtualization", "secure", "mte", "iommu", "its", "ras")},
        head=r"virt(-\d+\.\d+)?",
    ),
    "-accel": kv_rule("-accel", {}, head="hvf|tcg"),
    "-drive": kv_rule(
        "-drive",
        {
            "if": "pflash|none",
            "format": "raw|qcow2",
            "unit": r"\d",
            "index": r"\d",
            "file": PATH,  # no ':' so no network block protocol
            "file.filename": PATH,
            "file.locking": "on|off",
            "readonly": "on|off",
            "media": "disk|cdrom",
            "id": WORD,
            "discard": "unmap|ignore",
            "detect-zeroes": "unmap|on|off",
            "cache": WORD,
        },
    ),
    "-boot": kv_rule("-boot", {"menu": "on|off", "order": "[a-z]+", "splash-time": r"\d+"}),
    "-m": shape("-m", r"\d{1,6}[MG]?"),
    "-name": shape("-name", WORD),
    "-uuid": shape("-uuid", UUID),
    "-rtc": kv_rule("-rtc", {"base": "localtime|utc", "clock": "host|rt|vm", "driftfix": "none|slew"}),
}

# Why the obvious tempting options stay off the list (the refusal names it).
WHY_NOT = {
    "-object": "can attach filter-redirector/filter-mirror to the netdev before slirp (D5, D7)",
    "-qmp": "a QMP monitor can add netdevs and filters at run time",
    "-qmp-pretty": "a QMP monitor can add netdevs and filters at run time (D8)",
    "-monitor": "a monitor can add netdevs and filters at run time",
    "-gdb": "a debug stub on a host socket",
    "-readconfig": "adds configuration the command line does not show",
    "-set": "changes configuration the command line does not show",
    "-global": "sets device properties (netdev=) outside a -device",
    "-nic": "a second NIC; only the one -netdev is allowed",
    "-net": "a second NIC; only the one -netdev is allowed",
    "-parallel": "a host channel",
    "-debugcon": "a host channel",
    "-incoming": "a host listener",
    "-vnc": "a host listener",
    "-display": "can open a VNC listener",
    "-add-fd": "passes host file descriptors",
}


def offset(argv: list[str]) -> int:
    """Index of the first QEMU option: after QEMULauncher and the qemu path."""
    return 2 if base(argv[0]) == "QEMULauncher" else 1


def is_positional(t: str) -> bool:
    return not t.startswith("-") or t in ("-", "--")


def norm(t: str) -> str:
    return t[1:] if t.startswith("--") else t


def tokens(args: list[str], off: int) -> list[tuple[int, str, str, str | None]]:
    """(argv index, as written, normalised name, value) per option, using
    ALLOWED for arity. Refuses positionals (QEMU would take one as a disk
    image), `-opt=value` forms, unknown options and a missing value. Names are
    printed only when they are vocabulary words; anything else by index."""
    out: list[tuple[int, str, str, str | None]] = []
    i = 0
    while i < len(args):
        t, at = args[i], f"argv[{i + off}]"
        if is_positional(t):
            raise Refused(f"positional argument at {at} (QEMU would take it as a disk image)")
        name = norm(t)
        if "=" in name:
            raise Refused(f"unparseable option at {at} (an -opt=value form)")
        if name in FLAGS:
            out.append((i + off, t, name, None))
            i += 1
            continue
        if name not in ALLOWED:
            why = WHY_NOT.get(name)
            if why:
                raise Refused(f"{t} is not in the launch allowlist ({why})")
            if name in QEMU_OPTIONS:
                raise Refused(f"{t} is not in the launch allowlist ({at})")
            raise Refused(f"the option at {at} is not in the launch allowlist (not a known QEMU option name)")
        if i + 1 >= len(args):
            raise Refused(f"{t} without a value ({at})")
        out.append((i + off, t, name, args[i + 1]))
        i += 2
    return out


def names_lines(argv: list[str]) -> list[str]:
    """`names` mode: option names only, never values. A name outside the fixed
    vocabulary prints as its index. Unknown options are assumed to take a
    value, which is what nearly all QEMU options do."""
    off = offset(argv)
    args = argv[off:]
    out = []
    i = 0
    while i < len(args):
        t, at = args[i], f"argv[{i + off}]"
        if is_positional(t):
            out.append(f"<positional {at}>\tNOT ALLOWED")
            i += 1
            continue
        name, eq, _ = norm(t).partition("=")
        allowed = not eq and (name in FLAGS or name in ALLOWED)
        shown = said(name, QEMU_OPTIONS | FLAGS | ALLOWED.keys() | WHY_NOT.keys(), f"<unrecognised option {at}>")
        out.append(f"{shown}\t{'allowed' if allowed else 'NOT ALLOWED'}")
        i += 1 if eq or name in FLAGS else 2
    return out


def vets(name: str, value: str) -> bool:
    if any(c.isspace() for c in value):
        return False
    try:
        ALLOWED[name](value)
    except Refused:
        return False
    return True


def argv_lines(argv: list[str]) -> list[str]:
    """`argv` mode: an element prints only if it is accepted as an allowed
    option name or as a value its option's rule accepts; every other element
    prints as `<redacted argv[i]>` (V1: the tail may be the environment)."""
    off = offset(argv)
    out = [a if re.fullmatch("/" + PATH, a) else f"<redacted argv[{j}]>" for j, a in enumerate(argv[:off])]
    args = argv[off:]
    i = 0
    while i < len(args):
        t, at = args[i], i + off
        name = norm(t)
        if is_positional(t) or "=" in name or any(c.isspace() for c in t):
            out.append(f"<redacted argv[{at}]>")
            i += 1
        elif name in FLAGS:
            out.append(t)
            i += 1
        elif name in ALLOWED:
            out.append(t)
            if i + 1 < len(args):
                v = args[i + 1]
                out.append(v if vets(name, v) else f"<redacted argv[{at + 1}]>")
            i += 2
        else:
            known = name in QEMU_OPTIONS or name in WHY_NOT
            out.append(t if known else f"<redacted argv[{at}]>")
            i += 1
    return out


def check(argv: list[str]) -> str:
    """Raise Refused unless argv is the one allowed configuration; return the netdev."""
    off = offset(argv)
    args = argv[off:]
    for i, a in enumerate(args):
        if any(c.isspace() for c in a):
            raise Refused(f"argv[{i + off}] contains whitespace")
    toks = tokens(args, off)
    if not any(n == "-nodefaults" for _, _, n, _ in toks):
        raise Refused("-nodefaults missing: QEMU would add its default, unrestricted NIC")
    n_netdevs = sum(n == "-netdev" for _, _, n, _ in toks)
    if n_netdevs != 1:
        raise Refused(f"expected exactly one -netdev, found {n_netdevs}")
    values: dict[str, list[str]] = {}
    for at, _, name, value in toks:
        if value is not None:
            try:
                ALLOWED[name](value)
            except Refused as e:
                raise Refused(f"{e} (argv[{at + 1}])") from None
            values.setdefault(name, []).append(value)

    nd = values["-netdev"][0]  # the only one, fully vetted by netdev_rule
    nid = dict(options(nd, "netdev"))["id"]

    # Chardev ids and what may reference them.
    chardevs: dict[str, str] = {}
    for c in values.get("-chardev", []):
        cid = dict(options(c, "-chardev"))["id"]
        if cid in chardevs:
            raise Refused("a -chardev id is declared twice")
        chardevs[cid] = c.split(",")[0]
    spice_ids = {i for i, b in chardevs.items() if b in ("spiceport", "spicevmc")}
    if values.get("-mon") and chardevs.get("org.qemu.monitor.qmp") != "spiceport":
        raise Refused("-mon must sit on UTM's spiceport chardev org.qemu.monitor.qmp")
    if values.get("-serial") and chardevs.get("term0") != "pty":
        raise Refused("-serial chardev:term0 without UTM's pty term0")
    if values.get("-tpmdev") and "chrtpm0" not in chardevs:
        raise Refused("-tpmdev without UTM's swtpm socket chrtpm0")

    # D5: nothing may attach to the netdev but the one NIC; device chardevs are SPICE only.
    refs = []
    for dev in values.get("-device", []):
        driver = dev.split(",")[0]  # in DEVICE_DRIVERS: a vocabulary word
        for k, v in options(dev, "device"):
            if k == "netdev":
                if driver != "virtio-net-pci":
                    raise Refused(f"netdev= on a {driver} device")
                refs.append(v)
            if k == "chardev" and v not in spice_ids:
                pty = " (it names UTM's pty term0)" if v == "term0" else ""
                raise Refused(f"a -device chardev= is not one of UTM's SPICE chardevs{pty}")
    if len(refs) != 1:
        raise Refused(f"netdev references: {len(refs)} NIC devices name a netdev, want exactly one")
    if refs[0] != nid:
        raise Refused("netdev references: the NIC names a netdev other than the -netdev's id")
    return nd


def main(argv: list[str]) -> int:
    mode = argv[0] if argv else ""
    try:
        if mode not in ("argv", "live", "names"):
            print(__doc__, file=sys.stderr)
            return 2
        guest = find_guest_argv()
        if mode == "argv":
            print("\n".join(argv_lines(guest)))
            return 0
        if mode == "names":
            print("\n".join(names_lines(guest)))
            return 0
        print("ok: " + check(guest))
        return 0
    except Refused as e:
        print(f"FAIL: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
