#!/usr/bin/env python3
"""The live half of `scripts/guest-egress.sh verify` (TIF-275).

Reads the running guest's EXACT argv and accepts exactly one network
configuration. Everything else, and anything that cannot be read or parsed,
fails. See docs/security/guest-egress.md for the rule list and why each exists.

usage:
  guest_egress_check.py live     check the running guest; prints "ok: <netdev>" or
                                 "FAIL: <reason>"; exit 0 / 1
  guest_egress_check.py argv     print the running guest's argv, one element per
                                 line (operator inspection; argv only, never the
                                 environment)

Exact argv (round 3, verifier D6): `ps -Ao command=` joins argv with spaces, so
an element containing spaces (`-name "x -netdev user,...,restrict=on"`) looked
like real options. The argv is read from the kernel instead: sysctl
KERN_PROCARGS2 for each candidate pid. Only the argc argument strings are
decoded; the environment block that follows them is never decoded or printed.

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

EXPECTED_HOSTFWD = ["tcp:127.0.0.1:2222-:22"]
QEMU = {"qemu-system-aarch64", "qemu-aarch64-softmmu"}
NETDEV_KEYS = {"id", "restrict", "hostfwd"}
# Chardev backends UTM's default launch uses (confirmed on the live guest,
# 2026-11-26): spiceport, spicevmc and pty, plus one unix socket to swtpm,
# `socket,id=chrtpm0,path=<VM-UUID>.swtpm`. Exactly those are allowed.
CHARDEV_BACKENDS = {"spiceport", "spicevmc", "pty"}
SWTPM_SOCKET = re.compile(r"^socket,id=chrtpm0,path=[0-9A-Fa-f-]{36}\.swtpm$")
CTL_KERN, KERN_ARGMAX, KERN_PROCARGS2 = 1, 8, 49


class Refused(Exception):
    pass


def parse_procargs2(buf: bytes) -> list[str]:
    """argv from a KERN_PROCARGS2 buffer: int32 argc, the exec path, NUL
    padding, then argc NUL-terminated strings (then the environment, ignored).
    Raises Refused on anything malformed."""
    if len(buf) < 4:
        raise Refused("procargs buffer too short")
    (argc,) = struct.unpack_from("<i", buf, 0)
    if argc < 1 or argc > 4096:
        raise Refused(f"implausible argc {argc}")
    pos = buf.find(b"\0", 4)  # end of the exec path
    if pos < 0:
        raise Refused("procargs: unterminated exec path")
    while pos < len(buf) and buf[pos] == 0:
        pos += 1
    argv = []
    for _ in range(argc):
        end = buf.find(b"\0", pos)
        if end < 0:
            raise Refused("procargs: truncated argv")
        try:
            argv.append(buf[pos:end].decode("utf-8"))
        except UnicodeDecodeError as e:
            raise Refused("procargs: argv is not UTF-8") from e
        pos = end + 1
    return argv


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
            argv = parse_procargs2(read_procargs2(pid))
        except Refused as e:
            # Processes we may not read (other users, exited) cannot be guests
            # we launched; but a fixture-driven run must not hide one.
            if os.environ.get("MYCO_PROCARGS_DIR"):
                raise
            del e
            continue
        if is_guest(argv):
            guests.append(argv)
    if len(guests) != 1:
        raise Refused(f"expected exactly one running guest, found {len(guests)}")
    return guests[0]


def options(value: str, what: str) -> list[tuple[str, str]]:
    """QEMU `a,k=v,...` options after the first field; refuses anything unparseable."""
    if ",," in value:
        raise Refused(f"unparseable {what} (escaped comma): {value}")
    out = []
    for p in value.split(",")[1:]:
        k, eq, v = p.partition("=")
        if not eq or not k:
            raise Refused(f"unparseable {what} option {p!r} in {value}")
        out.append((k, v))
    return out


def check(argv: list[str]) -> str:
    """Raise Refused unless argv is the one allowed configuration; return the netdev."""
    args = argv[2:] if base(argv[0]) == "QEMULauncher" else argv[1:]
    for a in args:
        if any(c.isspace() for c in a):
            raise Refused(f"argv element contains whitespace: {a!r}")
    if "-nodefaults" not in args:
        raise Refused("-nodefaults missing: QEMU would add its default, unrestricted NIC")

    def flag(t: str) -> str:
        return t[1:] if t.startswith("--") else t

    values: dict[str, list[str]] = {}
    for i, t in enumerate(args):
        f = flag(t)
        if f in ("-readconfig", "-set"):
            raise Refused(f"{t} can add configuration the command line does not show")
        if f in ("-qmp", "-monitor", "-gdb"):
            raise Refused(f"{t} is not part of UTM's launch")
        for name in ("-netdev", "-nic", "-net", "-object", "-chardev", "-serial", "-parallel", "-device"):
            if f == name:
                if i + 1 >= len(args):
                    raise Refused(f"{t} without a value")
                values.setdefault(name, []).append(args[i + 1])
            elif f.startswith(name + "="):
                raise Refused(f"unparseable option {t!r}")

    if values.get("-nic") or values.get("-net"):
        raise Refused("-nic/-net present: only one -netdev is allowed")
    nds = values.get("-netdev", [])
    if len(nds) != 1:
        raise Refused(f"expected exactly one -netdev, found {len(nds)}")
    nd = nds[0]
    if nd.split(",")[0] != "user":
        raise Refused(f"netdev is not user-mode: {nd}")
    opts: dict[str, list[str]] = {}
    for k, v in options(nd, "netdev"):
        if k not in NETDEV_KEYS:
            kind = "guest-initiated channel" if k == "guestfwd" else "not in the allowlist"
            raise Refused(f"netdev option {k}= is not allowed ({kind}): {nd}")
        opts.setdefault(k, []).append(v)
    if len(opts.get("id", [])) != 1:
        raise Refused(f"expected exactly one id= in {nd}")
    nid = opts["id"][0]
    restrict = opts.get("restrict", [])
    if not restrict or any(v != "on" for v in restrict):
        raise Refused(f"restrict=on missing or overridden in {nd}")
    if sorted(opts.get("hostfwd", [])) != EXPECTED_HOSTFWD:
        raise Refused(f"hostfwd set is {opts.get('hostfwd', [])}, want exactly {EXPECTED_HOSTFWD}: {nd}")

    # D5: nothing may attach to the netdev's packet queue but the one NIC.
    for obj in values.get("-object", []):
        first = obj.split(",")[0]
        typ = first[5:] if first.startswith("type=") else first
        if typ.startswith("filter-"):
            raise Refused(f"-object {typ} attaches to a netdev's packets and can bypass slirp: {obj}")
        if re.search(r"(^|,)netdev=", obj):
            raise Refused(f"-object references a netdev: {obj}")
    refs = []
    for dev in values.get("-device", []):
        for k, v in options(dev, "device"):
            if k == "netdev":
                refs.append(v)
    if refs != [nid]:
        raise Refused(f"netdev references {refs}, want exactly one NIC device on {nid}")
    for a in args:
        if re.search(r"(^|,)netdev=", a) and not any(a == d for d in values.get("-device", [])):
            raise Refused(f"netdev= outside a -device: {a}")

    # D5: no host-network chardev or serial backend; UTM's own are allowed exactly.
    for c in values.get("-chardev", []):
        backend = c.split(",")[0]
        if backend in CHARDEV_BACKENDS:
            options(c, "chardev")
            continue
        if SWTPM_SOCKET.match(c):
            continue
        raise Refused(f"-chardev backend not in UTM's allowlist: {c}")
    for name in ("-serial", "-parallel"):
        for v in values.get(name, []):
            if not (v == "none" or re.fullmatch(r"chardev:[A-Za-z0-9_.-]+", v)):
                raise Refused(f"{name} {v} is not a chardev reference (tcp:, udp:, telnet:, unix: and files are refused)")
    return nd


def main(argv: list[str]) -> int:
    mode = argv[0] if argv else ""
    try:
        guest = find_guest_argv()
        if mode == "argv":
            print("\n".join(guest))
            return 0
        if mode == "live":
            print("ok: " + check(guest))
            return 0
    except Refused as e:
        print(f"FAIL: {e}")
        return 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
