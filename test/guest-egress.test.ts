/**
 * TIF-275: `scripts/guest-egress.sh verify` accepts exactly ONE network
 * configuration and refuses everything else (rounds 2-3, verifier D1-D6).
 *
 * The live half reads the guest's EXACT argv from the kernel (sysctl
 * KERN_PROCARGS2, scripts/guest_egress_check.py), because `ps` flattens argv
 * and a netdev quoted inside another argument looked real (D6). Here the
 * buffers are fixed bytes built by `procargs()` below and served through
 * MYCO_PROCARGS_DIR; `ps` and `osascript` are stubs first on PATH, so the real
 * VM and UTM are never contacted. Each stub writes a marker, so a stub shadowed
 * by a host binary fails the test instead of reading the real host.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "guest-egress.sh");
const CHECK = join(import.meta.dirname, "..", "scripts", "guest_egress_check.py");
const LAUNCHER =
  "/Applications/UTM.app/Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS/QEMULauncher.app/Contents/MacOS/QEMULauncher";
const QEMU_BIN =
  "/Applications/UTM.app/Contents/Frameworks/qemu-aarch64-softmmu.framework/Versions/A/qemu-aarch64-softmmu";
const UUID = "6C6414A1-9449-4E30-9503-F3F6726C8FFE";
const GOOD_NETDEV = "user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22";
const GOOD_UTM = "nics=1;mode=emulated;isolate=true;pfs=1;pf=TCP|127.0.0.1|2222||22";
// A fake secret in the environment block: it must never be printed.
const ENV_SECRET = "MYCO_FAKE_ENV_SECRET=do-not-print-me";

/** UTM's default launch, trimmed, with the network part supplied by the test. */
function guestArgv(net: string[] = ["-netdev", GOOD_NETDEV], extra: string[] = []): string[] {
  return [
    LAUNCHER,
    QEMU_BIN,
    "-spice",
    `unix=on,addr=${UUID}.spice,disable-ticketing=on`,
    "-chardev",
    "spiceport,name=org.qemu.monitor.qmp.0,id=org.qemu.monitor.qmp",
    "-mon",
    "chardev=org.qemu.monitor.qmp,mode=control",
    "-nodefaults",
    "-device",
    "virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=net0",
    ...net,
    "-chardev",
    "pty,id=term0",
    "-serial",
    "chardev:term0",
    "-chardev",
    "spicevmc,name=usbredir,id=usbredirchardev0",
    "-chardev",
    `socket,id=chrtpm0,path=${UUID}.swtpm`,
    "-tpmdev",
    "emulator,id=tpm0,chardev=chrtpm0",
    ...extra,
  ];
}
const SWTPM = [LAUNCHER, "/Applications/UTM.app/Contents/Frameworks/swtpm.0.framework/swtpm.0"];

/**
 * UTM's full default launch for myco-win11 as the allowlist models it. The 13
 * elements in 10-round3-verify-live.txt are copied verbatim (every -chardev,
 * -mon, -netdev, -serial and -nodefaults); the rest is UTM 5.0.9's argument
 * builder for a wizard-default Windows 11 ARM64 VM (HVF, NVMe, virtio-ramfb,
 * TPM, SPICE). Host paths are placeholders.
 */
const VM_DATA = "/Volumes/vms/myco-win11.utm/Data";
const DISK = "drive4D2F3A10-1B2C-4D5E-8F90-A1B2C3D4E5F6";
function utmDefaultArgv(): string[] {
  return [
    LAUNCHER,
    QEMU_BIN,
    "-L",
    "/Applications/UTM.app/Contents/Resources/qemu",
    "-S",
    "-spice",
    `unix=on,addr=${UUID}.spice,disable-ticketing=on,image-compression=off,playback-compression=off,streaming-video=off,gl=on`,
    "-chardev",
    "spiceport,name=org.qemu.monitor.qmp.0,id=org.qemu.monitor.qmp",
    "-mon",
    "chardev=org.qemu.monitor.qmp,mode=control",
    "-nodefaults",
    "-vga",
    "none",
    "-device",
    "virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=net0",
    "-netdev",
    GOOD_NETDEV,
    "-device",
    "virtio-ramfb-gl",
    "-device",
    "intel-hda",
    "-device",
    "hda-duplex",
    "-chardev",
    "pty,id=term0",
    "-serial",
    "chardev:term0",
    "-cpu",
    "host",
    "-smp",
    "cpus=6,sockets=1,cores=6,threads=1",
    "-machine",
    "virt,highmem=on",
    "-accel",
    "hvf",
    "-drive",
    "if=pflash,format=raw,unit=0,file.filename=/Applications/UTM.app/Contents/Resources/qemu/edk2-aarch64-code.fd,file.locking=off,readonly=on",
    "-drive",
    `unit=1,if=pflash,format=raw,file=${VM_DATA}/efi_vars.fd`,
    "-boot",
    "menu=on",
    "-m",
    "6144",
    "-device",
    "nec-usb-xhci,id=usb-bus",
    "-device",
    "usb-tablet,bus=usb-bus.0",
    "-device",
    "usb-mouse,bus=usb-bus.0",
    "-device",
    "usb-kbd,bus=usb-bus.0",
    "-device",
    "qemu-xhci,id=usb-controller-0",
    "-chardev",
    "spicevmc,name=usbredir,id=usbredirchardev0",
    "-device",
    "usb-redir,chardev=usbredirchardev0,id=usbredirdev0,bus=usb-controller-0.0",
    "-chardev",
    "spicevmc,name=usbredir,id=usbredirchardev1",
    "-device",
    "usb-redir,chardev=usbredirchardev1,id=usbredirdev1,bus=usb-controller-0.0",
    "-chardev",
    "spicevmc,name=usbredir,id=usbredirchardev2",
    "-device",
    "usb-redir,chardev=usbredirchardev2,id=usbredirdev2,bus=usb-controller-0.0",
    "-device",
    `nvme,drive=${DISK},serial=${DISK},bootindex=0`,
    "-drive",
    `if=none,media=disk,id=${DISK},file=${VM_DATA}/${UUID}.qcow2,discard=unmap,detect-zeroes=unmap`,
    "-device",
    "virtio-serial",
    "-device",
    "virtserialport,chardev=org.qemu.guest_agent,name=org.qemu.guest_agent.0",
    "-chardev",
    "spiceport,name=org.qemu.guest_agent.0,id=org.qemu.guest_agent",
    "-device",
    "virtserialport,chardev=vdagent,name=com.redhat.spice.0",
    "-chardev",
    "spicevmc,id=vdagent,debug=0,name=vdagent",
    "-device",
    "virtserialport,chardev=charchannel1,id=channel1,name=org.spice-space.webdav.0",
    "-chardev",
    "spiceport,name=org.spice-space.webdav.0,id=charchannel1",
    "-chardev",
    `socket,id=chrtpm0,path=${UUID}.swtpm`,
    "-tpmdev",
    "emulator,id=tpm0,chardev=chrtpm0",
    "-device",
    "tpm-tis-device,tpmdev=tpm0",
    "-name",
    "myco-win11",
    "-uuid",
    UUID,
    "-rtc",
    "base=localtime",
  ];
}

/**
 * A KERN_PROCARGS2 buffer as xnu writes it: int32 argc, the exec path NUL-padded
 * to a multiple of 8 (the pointer size), argv, then the environment.
 */
function procargs(
  argv: string[],
  env = `${ENV_SECRET}\0HOME=/nowhere\0`,
  execPath?: string,
): Buffer {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(argv.length);
  const path = Buffer.from(`${execPath ?? argv[0]}\0`);
  const exec = Buffer.concat([path, Buffer.alloc((8 - (path.length % 8)) % 8)]);
  const args = Buffer.from(`${argv.join("\0")}\0`);
  return Buffer.concat([argc, exec, args, Buffer.from(env)]);
}

let dir = "";

/** procs: argv per process (raw Buffer for a malformed one); null = ps fails. */
function run(
  procs: (string[] | Buffer)[] | null,
  utm: string | null = GOOD_UTM,
  args = ["verify"],
) {
  const stub = join(dir, "bin");
  const pa = join(dir, "procargs");
  mkdirSync(stub, { recursive: true });
  mkdirSync(pa, { recursive: true });
  const pids = (procs ?? []).map((p, i) => {
    const pid = 1000 + i;
    writeFileSync(join(pa, `${pid}.bin`), Buffer.isBuffer(p) ? p : procargs(p));
    return pid;
  });
  writeFileSync(
    join(stub, "ps"),
    `#!/bin/bash\necho ran >> "${join(dir, "ps.marker")}"\n${
      procs ? `printf '%s\\n' ${pids.join(" ")}` : "exit 1"
    }\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "utm.out"), utm ?? "");
  writeFileSync(
    join(stub, "osascript"),
    `#!/bin/bash\necho ran >> "${join(dir, "osascript.marker")}"\n${
      utm === null ? "exit 1" : `cat "${join(dir, "utm.out")}"`
    }\n`,
    { mode: 0o755 },
  );
  const env = { PATH: `${stub}:/usr/bin:/bin`, HOME: dir, MYCO_PROCARGS_DIR: pa };
  // argv/names/live call the Python check directly; anything else goes through the script.
  const r = ["argv", "names", "live"].includes(args[0])
    ? spawnSync("python3", ["-I", CHECK, args[0]], { encoding: "utf8", env })
    : spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
  return {
    ...r,
    psRan: existsSync(join(dir, "ps.marker")),
    osaRan: existsSync(join(dir, "osascript.marker")),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myco-egress-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("guest-egress.sh verify: the one accepted configuration", () => {
  it("passes for UTM's launch with the allowlisted netdev, live and in UTM", () => {
    const r = run([["/usr/bin/login"], guestArgv(), SWTPM]);
    expect(r.psRan).toBe(true);
    expect(r.osaRan).toBe(true);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("egress closed");
  });

  it("passes whatever the netdev option order", () => {
    const r = run([
      guestArgv(["-netdev", "user,hostfwd=tcp:127.0.0.1:2222-:22,id=net0,restrict=on"]),
    ]);
    expect(r.status).toBe(0);
  });

  it("ignores processes that merely mention qemu, like the readiness gate's pgrep", () => {
    const r = run([
      ["pgrep", "-f", "qemu-aarch64-softmmu|qemu-system-aarch64"],
      ["vim", "/tmp/qemu-aarch64-softmmu", "-netdev", "user,id=x"],
      guestArgv(),
      SWTPM,
    ]);
    expect(r.status).toBe(0);
  });
});

describe("exact argv from KERN_PROCARGS2 (D6)", () => {
  it("prints argv only, never the environment block", () => {
    const r = run([guestArgv()], GOOD_UTM, ["argv"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("-nodefaults\n");
    expect(r.stdout).not.toContain("MYCO_FAKE_ENV_SECRET");
    expect(r.stdout).not.toContain("do-not-print-me");
  });

  it("refuses a netdev quoted inside another element (the -name trick)", () => {
    const argv = guestArgv([], ["-name", `guest -netdev ${GOOD_NETDEV}`]);
    const r = run([argv]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("contains whitespace");
  });

  it("refuses when -nodefaults is missing (QEMU's default NIC is unrestricted)", () => {
    const r = run([guestArgv().filter((a) => a !== "-nodefaults")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("-nodefaults missing");
  });

  it("does not take -nodefaults glued into another element", () => {
    const argv = guestArgv().filter((a) => a !== "-nodefaults");
    argv.push("-name", "x-nodefaults");
    const r = run([argv]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("-nodefaults missing");
  });

  it("fails closed on a truncated procargs buffer", () => {
    const good = procargs(guestArgv());
    const r = run([good.subarray(0, 200)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("truncated argv");
  });

  it("fails closed on an implausible argc", () => {
    const bad = procargs(guestArgv());
    bad.writeInt32LE(0, 0);
    const r = run([bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("implausible argc");
  });

  it("fails closed on a buffer too short to hold argc", () => {
    const r = run([Buffer.from([1, 0])]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("too short");
  });
});

describe("guest-egress.sh verify refuses: network options (D1-D3)", () => {
  const refuse = (argv: string[], why: string) => {
    const r = run([argv]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(why);
  };
  const withNet = (...net: string[]) => guestArgv(net);

  it("a second -netdev that is unrestricted", () => {
    refuse(
      withNet("-netdev", GOOD_NETDEV, "-netdev", "user,id=net1,hostfwd=tcp:127.0.0.1:2223-:22"),
      "expected exactly one -netdev, found 2",
    );
  });
  it("a second -netdev even when it is restricted", () => {
    refuse(withNet("-netdev", GOOD_NETDEV, "-netdev", "user,id=net1,restrict=on"), "found 2");
  });
  it("a -nic beside the netdev", () => {
    refuse(
      withNet("-netdev", GOOD_NETDEV, "-nic", "user,model=virtio"),
      "-nic is not in the launch allowlist",
    );
  });
  it("a legacy -net beside the netdev", () => {
    refuse(withNet("-netdev", GOOD_NETDEV, "-net", "user"), "-net is not in the launch allowlist");
  });
  it("the double-dash spelling --netdev counts as a second NIC", () => {
    refuse(withNet("-netdev", GOOD_NETDEV, "--netdev", "user,id=net1"), "found 2");
  });
  it("-readconfig", () => {
    refuse(withNet("-netdev", GOOD_NETDEV, "-readconfig", "/tmp/x.cfg"), "-readconfig");
  });
  it("guestfwd on the restricted netdev", () => {
    refuse(
      withNet("-netdev", `${GOOD_NETDEV},guestfwd=tcp:10.0.2.100:80-cmd:nc`),
      "guestfwd= is not allowed",
    );
  });
  it("any netdev option outside id/restrict/hostfwd (smb=)", () => {
    refuse(withNet("-netdev", `${GOOD_NETDEV},smb=/Users`), "smb= is not allowed");
  });
  it("a 0.0.0.0 bind", () => {
    refuse(
      withNet("-netdev", "user,id=net0,restrict=on,hostfwd=tcp:0.0.0.0:2222-:22"),
      "hostfwd set is",
    );
  });
  it("an all-interfaces bind with the address omitted", () => {
    refuse(withNet("-netdev", "user,id=net0,restrict=on,hostfwd=tcp::2222-:22"), "hostfwd set is");
  });
  it("an extra forward such as ::8765", () => {
    refuse(withNet("-netdev", `${GOOD_NETDEV},hostfwd=tcp::8765-:8765`), "hostfwd set is");
  });
  it("no forward at all", () => {
    refuse(withNet("-netdev", "user,id=net0,restrict=on"), "hostfwd set is");
  });
  it("restrict=on missing", () => {
    refuse(
      withNet("-netdev", "user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22"),
      "restrict=on missing",
    );
  });
  it("restrict=on overridden by a later restrict=off", () => {
    refuse(withNet("-netdev", `${GOOD_NETDEV},restrict=off`), "restrict=on missing or overridden");
  });
  it("an unparseable option without '='", () => {
    refuse(withNet("-netdev", `${GOOD_NETDEV},bogus`), "unparseable netdev option");
  });
  it("an escaped comma (named as such)", () => {
    refuse(withNet("-netdev", `${GOOD_NETDEV},hostfwd=tcp:127.0.0.1:2223-:22,,x`), "escaped comma");
  });
  it("a -netdev=value form", () => {
    refuse(withNet(`-netdev=${GOOD_NETDEV}`), "unparseable option");
  });
  it("a non-user netdev", () => {
    refuse(withNet("-netdev", "socket,id=net0,connect=203.0.113.9:9"), "not user-mode");
  });
  it("no guest running", () => {
    const r = run([["/usr/bin/login"], SWTPM]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("found 0");
  });
  it("two guests (ambiguous)", () => {
    const r = run([guestArgv(), guestArgv()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("found 2");
  });
  it("an unreadable process list", () => {
    const r = run(null);
    expect(r.psRan).toBe(true);
    expect(r.status).toBe(1);
  });
});

describe("guest-egress.sh verify refuses: tunnels past slirp (D5)", () => {
  const refuse = (extra: string[], why: string) => {
    const r = run([guestArgv(undefined, extra)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(why);
  };

  it("-object filter-redirector on net0 (the verifier's bidirectional tunnel)", () => {
    refuse(
      [
        "-object",
        "filter-redirector,id=r0,netdev=net0,queue=tx,outdev=c0",
        "-object",
        "filter-redirector,id=r1,netdev=net0,queue=rx,indev=c1",
        "-chardev",
        "socket,id=c0,host=203.0.113.9,port=9",
        "-chardev",
        "socket,id=c1,host=203.0.113.9,port=10",
      ],
      "-object is not in the launch allowlist (can attach filter-redirector",
    );
  });
  it("-object filter-mirror (one-way exfil)", () => {
    refuse(
      ["-object", "filter-mirror,id=m0,netdev=net0,queue=tx,outdev=c0"],
      "-object is not in the launch allowlist",
    );
  });
  it("-object type=filter-dump", () => {
    refuse(
      ["-object", "type=filter-dump,id=d0,netdev=net0,file=/tmp/x"],
      "-object is not in the launch allowlist",
    );
  });
  it("any other -object that references a netdev", () => {
    refuse(["-object", "colo-compare,id=cc,netdev=net0"], "-object is not in the launch allowlist");
  });
  it("a second NIC device on the same netdev", () => {
    refuse(["-device", "e1000,netdev=net0"], "-device e1000 is not in the allowlist");
  });
  it("a netdev= reference outside any -device", () => {
    refuse(["-global", "virtio-net-pci.netdev=net0"], "-global is not in the launch allowlist");
  });
  it("a TCP socket chardev (host=)", () => {
    refuse(
      ["-chardev", "socket,id=c0,host=203.0.113.9,port=9"],
      "-chardev socket other than UTM's swtpm socket is refused",
    );
  });
  it("a socket chardev listening on a port (no host=)", () => {
    refuse(["-chardev", "socket,id=c0,port=9,server=on"], "socket other than UTM's swtpm");
  });
  it("a udp chardev", () => {
    refuse(["-chardev", "udp,id=c0,host=203.0.113.9,port=9"], "not in UTM's allowlist");
  });
  it("a unix socket chardev other than UTM's swtpm one", () => {
    refuse(["-chardev", "socket,id=c0,path=/tmp/x.sock"], "socket other than UTM's swtpm");
  });
  it("a virtserialport on a host socket", () => {
    refuse(
      ["-chardev", "socket,id=c0,host=203.0.113.9,port=9", "-device", "virtserialport,chardev=c0"],
      "socket other than UTM's swtpm",
    );
  });
  it("-serial tcp:", () => {
    refuse(["-serial", "tcp:203.0.113.9:9"], "-serial tcp:203.0.113.9:9 is not in the allowlist");
  });
  it("-serial udp:", () => {
    refuse(["-serial", "udp:203.0.113.9:9"], "is not in the allowlist");
  });
  it("-serial telnet:", () => {
    refuse(["-serial", "telnet:0.0.0.0:23,server"], "is not in the allowlist");
  });
  it("-parallel tcp:", () => {
    refuse(["-parallel", "tcp:203.0.113.9:9"], "-parallel is not in the launch allowlist");
  });
  it("-monitor tcp:", () => {
    refuse(["-monitor", "tcp:203.0.113.9:9"], "-monitor is not in the launch allowlist");
  });
  it("-qmp tcp:", () => {
    refuse(["-qmp", "tcp:203.0.113.9:9"], "-qmp is not in the launch allowlist");
  });
});

describe("follow-up: option allowlist (D7, D8, unknown options)", () => {
  const refuse = (argv: string[], why: string) => {
    const r = run([argv]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(why);
    return r;
  };
  const withExtra = (...extra: string[]) => [...utmDefaultArgv(), ...extra];

  it("passes UTM's full default launch (live elements + argument builder)", () => {
    const r = run([utmDefaultArgv(), SWTPM]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("D7: a JSON -object filter-redirector pair on net0 to two ptys", () => {
    refuse(
      withExtra(
        "-chardev",
        "pty,id=c0",
        "-chardev",
        "pty,id=c1",
        "-object",
        '{"qom-type":"filter-redirector","id":"r0","netdev":"net0","queue":"tx","outdev":"c0"}',
        "-object",
        '{"qom-type":"filter-redirector","id":"r1","netdev":"net0","queue":"rx","indev":"c1"}',
      ),
      "-object is not in the launch allowlist",
    );
  });
  it("D7: a JSON -object filter-mirror on net0 to a spiceport", () => {
    refuse(
      withExtra(
        "-chardev",
        "spiceport,name=x.0,id=sp0",
        "-object",
        '{"qom-type":"filter-mirror","id":"m0","netdev":"net0","queue":"tx","outdev":"sp0"}',
      ),
      "-object is not in the launch allowlist",
    );
  });
  it("D7: the --object spelling", () => {
    refuse(
      withExtra("--object", '{"qom-type":"filter-mirror","netdev":"net0"}'),
      "--object is not in",
    );
  });
  it("D7: JSON form on an allowlisted option (-device)", () => {
    refuse(
      withExtra("-device", '{"driver":"virtio-net-pci","netdev":"net0"}'),
      "-device in JSON form is refused",
    );
  });
  it("D7: JSON form on an allowlisted option (-chardev)", () => {
    refuse(
      withExtra("-chardev", '{"id":"c0","backend":{"type":"pty"}}'),
      "-chardev in JSON form is refused",
    );
  });
  it("D7: JSON form for the netdev itself", () => {
    const argv = utmDefaultArgv().map((a) =>
      a === GOOD_NETDEV ? '{"type":"user","id":"net0","restrict":true}' : a,
    );
    refuse(argv, "in JSON form is refused");
  });
  it("D7: a second pty chardev", () => {
    refuse(withExtra("-chardev", "pty,id=c0"), "-chardev pty other than UTM's term0 is refused");
  });
  it("D7: UTM's pty with an extra option", () => {
    const argv = utmDefaultArgv().map((a) => (a === "pty,id=term0" ? "pty,id=term0,logfile=x" : a));
    refuse(argv, "pty other than UTM's term0");
  });
  it("a device wired to the pty instead of a SPICE chardev", () => {
    refuse(
      withExtra("-device", "virtserialport,chardev=term0,name=x"),
      "chardev=term0 is not one of UTM's SPICE",
    );
  });
  it("the monitor moved off UTM's spiceport", () => {
    const argv = utmDefaultArgv().map((a) =>
      a === "chardev=org.qemu.monitor.qmp,mode=control" ? "chardev=term0,mode=control" : a,
    );
    refuse(argv, "-mon chardev=term0,mode=control is not in the allowlist");
  });
  it("D8: -qmp-pretty on a TCP listener", () => {
    refuse(
      withExtra("-qmp-pretty", "tcp:0.0.0.0:4444,server=on,wait=off"),
      "-qmp-pretty is not in the launch allowlist (a QMP monitor can add netdevs and filters at run time (D8))",
    );
  });
  it("D8: the --qmp-pretty spelling", () => {
    refuse(
      withExtra("--qmp-pretty", "tcp:0.0.0.0:4444,server=on,wait=off"),
      "--qmp-pretty is not in the launch allowlist",
    );
  });
  it("an unknown option (no special reason)", () => {
    refuse(withExtra("-frobnicate", "x"), "-frobnicate is not in the launch allowlist");
  });
  it("the round-3 N10 listeners and channels", () => {
    refuse(withExtra("-vnc", "0.0.0.0:0"), "-vnc is not in the launch allowlist");
    refuse(withExtra("-debugcon", "tcp:203.0.113.9:9"), "-debugcon is not in the launch allowlist");
    refuse(withExtra("-incoming", "tcp:0.0.0.0:4444"), "-incoming is not in the launch allowlist");
    refuse(withExtra("-display", "vnc=0.0.0.0:1"), "-display is not in the launch allowlist");
    refuse(withExtra("-add-fd", "fd=3,set=1"), "-add-fd is not in the launch allowlist");
  });
  it("SPICE on a TCP port instead of a unix socket", () => {
    const argv = utmDefaultArgv().map((a) =>
      a.startsWith("unix=on,") ? "port=5930,addr=0.0.0.0,disable-ticketing=on" : a,
    );
    refuse(argv, "-spice option port= is not in the allowlist");
  });
  it("SPICE without unix=on", () => {
    const argv = utmDefaultArgv().map((a) =>
      a.startsWith("unix=on,") ? a.replace("unix=on,", "") : a,
    );
    refuse(argv, "-spice needs unix=on");
  });
  it("an extra SPICE TCP port beside the unix socket", () => {
    const argv = utmDefaultArgv().map((a) => (a.startsWith("unix=on,") ? `${a},tls-port=5931` : a));
    refuse(argv, "-spice option tls-port= is not in the allowlist");
  });
  it("a network block device as a drive", () => {
    refuse(
      withExtra("-drive", "if=none,id=d9,file=nbd://203.0.113.9:10809/x"),
      "file=nbd://203.0.113.9:10809/x is not in the allowed shape",
    );
  });
  it("a drive that names its own block driver", () => {
    refuse(
      withExtra("-drive", "if=none,id=d9,driver=http,url=x"),
      "-drive option driver= is not in the allowlist",
    );
  });
  it("a positional argument (QEMU takes it as a disk image)", () => {
    refuse(withExtra("disk.img"), "positional argument 'disk.img'");
  });
  it("netdev= on an allowlisted device that is not the NIC", () => {
    refuse(withExtra("-device", "usb-storage,netdev=net0"), "netdev= on a usb-storage device");
  });
  it("a device option given twice", () => {
    refuse(withExtra("-device", "virtio-rng-pci,id=a,id=b"), "-device option id= given twice");
  });
  it("a device not in the allowlist (vhost-vsock is a guest-host channel)", () => {
    refuse(
      withExtra("-device", "vhost-vsock-pci,guest-cid=3"),
      "-device vhost-vsock-pci is not in the allowlist",
    );
  });
});

describe("follow-up: an empty argv[0] never exposes the environment (D9)", () => {
  // argv[0] is empty; the real argv has no -nodefaults, and the environment's
  // first string is "-nodefaults". The old parser skipped the empty argv[0] as
  // padding, read "-nodefaults" from the environment and passed.
  const PLANTED = "MYCO_PLANTED_SECRET=sk-planted-do-not-print";
  const argv = ["", ...utmDefaultArgv().filter((a) => a !== "-nodefaults")];
  const buf = () => procargs(argv, `-nodefaults\0${PLANTED}\0`, QEMU_BIN);

  for (const mode of ["verify", "status", "live", "argv", "names"]) {
    it(`refuses, and prints nothing from the environment (${mode})`, () => {
      const r = run([buf()], GOOD_UTM, [mode]);
      const all = `${r.stdout}${r.stderr}`;
      expect(all).toContain("empty argv[0]");
      expect(all).not.toContain("sk-planted-do-not-print");
      expect(all).not.toContain("MYCO_PLANTED_SECRET");
      // status is read-only and always exits 0; it reports the failure.
      expect(r.status).toBe(mode === "status" ? 0 : 1);
    });
  }

  it("argv mode never prints a secret that is the first environment string", () => {
    // The verifier's D9 shape: the shifted parse would print exactly this string.
    const r = run([procargs(argv, `${PLANTED}\0HOME=/nowhere\0`, QEMU_BIN)], GOOD_UTM, ["argv"]);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).not.toContain("sk-planted-do-not-print");
  });

  it("refuses an empty exec path", () => {
    const r = run([procargs(utmDefaultArgv(), `${ENV_SECRET}\0`, "")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("empty exec path");
  });

  it("refuses padding that is not NUL", () => {
    const b = procargs(utmDefaultArgv());
    const end = b.indexOf(0, 4);
    if ((end - 4 + 1) % 8 === 0) throw new Error("fixture needs padding");
    b[end + 1] = 0x41;
    const r = run([b]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("malformed exec path padding");
  });
});

describe("names mode: option names only", () => {
  it("prints each option name and whether it is allowed, never a value or the environment", () => {
    const r = run([utmDefaultArgv()], GOOD_UTM, ["names"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("-nodefaults\tallowed\n");
    expect(r.stdout).toContain("-netdev\tallowed\n");
    expect(r.stdout).not.toContain("NOT ALLOWED");
    expect(r.stdout).not.toContain("restrict=on");
    expect(r.stdout).not.toContain(UUID);
    expect(r.stdout).not.toContain("do-not-print-me");
  });

  it("marks an option that is not on the list", () => {
    const r = run([[...utmDefaultArgv(), "-qmp-pretty", "tcp:0.0.0.0:4444"]], GOOD_UTM, ["names"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("-qmp-pretty\tNOT ALLOWED\n");
    expect(r.stdout).not.toContain("4444");
  });
});

describe("guest-egress.sh verify refuses: UTM configuration", () => {
  const refuseUtm = (utm: string | null, why: string) => {
    const r = run([guestArgv()], utm);
    expect(r.osaRan).toBe(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(why);
  };
  it("a second NIC in UTM", () => {
    refuseUtm(
      `${GOOD_UTM};mode=emulated;isolate=false;pfs=0`.replace("nics=1", "nics=2"),
      "not the allowlist",
    );
  });
  it("isolate-from-host off in UTM", () => {
    refuseUtm(GOOD_UTM.replace("isolate=true", "isolate=false"), "not the allowlist");
  });
  it("an extra port forward in UTM", () => {
    refuseUtm(`${GOOD_UTM.replace("pfs=1", "pfs=2")};pf=TCP||8765||8765`, "not the allowlist");
  });
  it("a forward bound on all interfaces in UTM", () => {
    refuseUtm(GOOD_UTM.replace("127.0.0.1", ""), "not the allowlist");
  });
  it("UTM cannot be read", () => {
    refuseUtm(null, "could not read UTM");
  });
});

describe("guest-egress.sh usage", () => {
  it("rejects an unknown subcommand", () => {
    const r = run([], GOOD_UTM, ["open-it"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});
