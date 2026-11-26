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
  const mode = args[0] ?? "";
  const r = ["argv", "names", "live"].includes(mode)
    ? spawnSync("python3", ["-I", CHECK, mode], { encoding: "utf8", env })
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
  it("an e1000 NIC on the same netdev (driver not allowlisted)", () => {
    refuse(["-device", "e1000,netdev=net0"], "-device e1000 is not in the allowlist");
  });
  // V2 (round 2): these reach the netdev-references rule in check(); removing
  // that rule must fail them.
  it("a second virtio-net-pci on the same netdev", () => {
    refuse(["-device", "virtio-net-pci,netdev=net0"], "netdev references: 2 NIC devices");
  });
  it("a second virtio-net-pci on another netdev id (net1)", () => {
    refuse(["-device", "virtio-net-pci,netdev=net1"], "netdev references: 2 NIC devices");
  });
  it("the one NIC naming a netdev other than the -netdev's id", () => {
    const argv = guestArgv().map((a) =>
      a === "virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=net0"
        ? "virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=net1"
        : a,
    );
    const r = run([argv]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("netdev references: the NIC names a netdev other");
  });
  it("no NIC device on the netdev", () => {
    const argv = guestArgv().filter(
      (a, i, all) => !(a.startsWith("virtio-net-pci") || all[i + 1]?.startsWith("virtio-net-pci")),
    );
    const r = run([argv]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("netdev references: 0 NIC devices");
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
    const r = run([guestArgv(undefined, ["-serial", "tcp:203.0.113.9:9"])]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("-serial value is not in the allowlist (want chardev:term0)");
    expect(r.stderr).not.toContain("203.0.113.9");
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
      "chardev= is not one of UTM's SPICE chardevs (it names UTM's pty term0)",
    );
  });
  it("the monitor moved off UTM's spiceport", () => {
    const argv = utmDefaultArgv().map((a) =>
      a === "chardev=org.qemu.monitor.qmp,mode=control" ? "chardev=term0,mode=control" : a,
    );
    const r = refuse(argv, "-mon value is not in the allowlist");
    expect(r.stderr).not.toContain("chardev=term0");
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
  it("an unknown option (no special reason), named by index only", () => {
    const r = refuse(
      withExtra("-frobnicate", "x"),
      `the option at argv[${utmDefaultArgv().length}] is not in the launch allowlist`,
    );
    expect(r.stderr).not.toContain("frobnicate");
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
    const r = refuse(
      withExtra("-drive", "if=none,id=d9,file=nbd://203.0.113.9:10809/x"),
      "-drive option file= has a value not in the allowed shape",
    );
    expect(r.stderr).not.toContain("nbd://");
  });
  it("a drive that names its own block driver", () => {
    refuse(
      withExtra("-drive", "if=none,id=d9,driver=http,url=x"),
      "-drive option driver= is not in the allowlist",
    );
  });
  it("a positional argument (QEMU takes it as a disk image)", () => {
    const r = refuse(withExtra("disk.img"), "positional argument at argv[");
    expect(r.stderr).not.toContain("disk.img");
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

describe("round 2 V1: argc larger than the argv strings never prints the environment", () => {
  // A process that rewrites its own argv area (setproctitle-style) can leave
  // fewer argv strings than the kernel's argc, so the parser's last elements
  // are environment strings. They cannot be told apart, so nothing unvetted
  // may print. MARKER is a clearly fake planted value, never key-shaped.
  const MARKER = "PLANTED_FAKE_MARKER";
  const ENV_TAIL = [
    `${MARKER}=planted-fake-value`,
    `-${MARKER}`,
    `--${MARKER}=1`,
    "-netdev",
    `user,id=${MARKER},restrict=on`,
    "-device",
    `e1000,${MARKER}=1`,
    `{"${MARKER}":1}`,
    "HOME=/nowhere",
  ];
  const overshoot = (argv: string[], extra: number) => {
    const b = procargs(argv, `${ENV_TAIL.join("\0")}\0`);
    b.writeInt32LE(argv.length + extra, 0);
    return b;
  };

  for (const extra of [1, 2, 3, 5, 7, 8]) {
    for (const mode of ["verify", "status", "live", "argv", "names"]) {
      it(`argc+${extra}: ${mode} never prints the planted marker`, () => {
        const argv = utmDefaultArgv();
        const r = run([overshoot(argv, extra)], GOOD_UTM, [mode]);
        expect(`${r.stdout}${r.stderr}`).not.toContain(MARKER);
        expect(`${r.stdout}${r.stderr}`).not.toContain("planted-fake-value");
        if (mode === "verify" || mode === "live") expect(r.status).toBe(1);
        else expect(r.status).toBe(0);
        if (mode === "argv") expect(r.stdout).toContain(`<redacted argv[${argv.length}]>`);
        if (mode === "live") expect(r.stdout).toContain(`argv[${argv.length}]`);
      });
    }
  }

  it("argc+1 on the minimal launch: live refuses by index, argv redacts", () => {
    const argv = guestArgv();
    const live = run([overshoot(argv, 1)], GOOD_UTM, ["live"]);
    expect(live.stdout).toContain(`positional argument at argv[${argv.length}]`);
    const dump = run([overshoot(argv, 1)], GOOD_UTM, ["argv"]);
    expect(dump.stdout.trimEnd().split("\n").at(-1)).toBe(`<redacted argv[${argv.length}]>`);
    expect(dump.stdout).toContain("-nodefaults\n");
    expect(`${live.stdout}${dump.stdout}`).not.toContain(MARKER);
  });

  it("no refusal, names line or redacted argv line echoes a planted element (sweep)", () => {
    // Every element of UTM's launch, replaced in turn by planted variants. A
    // refusal and a `names` line may hold only fixed words and indexes; `argv`
    // may hold an element only if its option's rule accepts it, and no rule
    // accepts ';'.
    const driver = `
import json, sys
sys.path.insert(0, sys.argv[1])
import guest_egress_check as g
M = "${MARKER}"
argv = json.load(sys.stdin)
variants = lambda a: [M, "-" + M, "--" + M, "--" + M + "=1", "-name=" + M, a + "," + M + "=1",
                      a + "," + M, a + "," + M + "=x;y", a + ",id=" + M + ";", a + "," + M + "=1," + M + "=1",
                      "{" + M + "}", M + "=1", a + ";" + M, "-device", "-chardev", "-netdev"]
leaks, refused, n = [], 0, 0
for i in range(2, len(argv)):
    for v in variants(argv[i]):
        bad = argv[:i] + [v] + argv[i + 1:]
        n += 1
        try:
            g.check(bad)
        except g.Refused as e:
            refused += 1
            if M in str(e): leaks.append(("check", i, str(e)))
        if any(M in line for line in g.names_lines(bad)): leaks.append(("names", i))
        if ";" in v and any(M in line for line in g.argv_lines(bad)): leaks.append(("argv", i))
print(json.dumps({"n": n, "refused": refused, "leaks": leaks[:5]}))
`;
    const r = spawnSync(
      "python3",
      ["-I", "-c", driver, join(import.meta.dirname, "..", "scripts")],
      {
        input: JSON.stringify(utmDefaultArgv()),
        encoding: "utf8",
      },
    );
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout) as { n: number; refused: number; leaks: unknown[] };
    expect(out.leaks).toEqual([]);
    expect(out.n).toBeGreaterThan(1000);
    expect(out.refused).toBeGreaterThan(out.n * 0.9);
  });
});

describe("round 3 V3: one negative case per rule that survived its own removal", () => {
  const refuse = (p: string[] | Buffer, why: string) => {
    const r = run([p]);
    expect(r.stderr).toContain(why);
    expect(r.status).toBe(1);
    return r;
  };
  /** UTM's launch with argv[i] (an option) and its value replaced by `with`. */
  const swap = (opt: string, value: string | null, ...with_: string[]) => {
    const a = utmDefaultArgv();
    const i = a.findIndex((t, j) => t === opt && (value === null || a[j + 1] === value));
    expect(i).toBeGreaterThan(1);
    a.splice(i, 2, ...with_);
    return a;
  };

  it("an argv element that is not UTF-8 (raw buffer)", () => {
    // 0xff is never valid UTF-8. If the element were dropped instead, the
    // option/value pairing after it would shift.
    const argv = utmDefaultArgv();
    const i = argv.indexOf("myco-win11");
    const good = procargs(argv);
    const at = good.indexOf(Buffer.from("\0myco-win11\0")) + 1;
    const bad = Buffer.concat([good.subarray(0, at), Buffer.from([0xff]), good.subarray(at + 1)]);
    expect(i).toBeGreaterThan(1);
    refuse(bad, "procargs: argv is not UTF-8");
  });
  it("a key=value option given twice (-smp cpus=6,cpus=8)", () => {
    refuse(swap("-smp", null, "-smp", "cpus=6,cpus=8"), "-smp option cpus= given twice");
  });
  it("a -chardev without id= is a clean refusal", () => {
    const r = refuse(
      [...utmDefaultArgv(), "-chardev", "spiceport,name=org.example.x.0"],
      "not the allowlist: -chardev without id=",
    );
    expect(r.stderr).not.toContain("Traceback");
  });
  it("an option with no value (trailing -m) is a clean refusal", () => {
    const r = refuse([...swap("-m", "6144"), "-m"], "not the allowlist: -m without a value");
    expect(r.stderr).not.toContain("Traceback");
  });
  it("a chardev id declared twice (a second pty,id=term0)", () => {
    refuse([...utmDefaultArgv(), "-chardev", "pty,id=term0"], "a -chardev id is declared twice");
  });
  it("-mon on a chardev that is not the spiceport", () => {
    refuse(
      swap(
        "-chardev",
        "spiceport,name=org.qemu.monitor.qmp.0,id=org.qemu.monitor.qmp",
        "-chardev",
        "spicevmc,name=org.qemu.monitor.qmp.0,id=org.qemu.monitor.qmp",
      ),
      "-mon must sit on UTM's spiceport chardev",
    );
  });
  it("-serial chardev:term0 without the pty term0", () => {
    refuse(swap("-chardev", "pty,id=term0"), "-serial chardev:term0 without UTM's pty term0");
  });
  it("-tpmdev without the swtpm chardev chrtpm0", () => {
    refuse(
      swap("-chardev", `socket,id=chrtpm0,path=${UUID}.swtpm`),
      "-tpmdev without UTM's swtpm socket chrtpm0",
    );
  });
  it("N3: a netdev id that is not a word, even when the NIC names it", () => {
    const a = swap("-netdev", GOOD_NETDEV, "-netdev", GOOD_NETDEV.replace("id=net0", "id=n/0"));
    const nic = a.indexOf("virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=net0");
    a[nic] = "virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=n/0";
    refuse(a, "expected exactly one id= (a word) in the netdev");
  });
  it("N3: a netdev with two ids", () => {
    refuse(
      swap("-netdev", GOOD_NETDEV, "-netdev", `${GOOD_NETDEV},id=net0`),
      "expected exactly one id= (a word) in the netdev",
    );
  });
});

describe("round 3 N1: an option UTM writes once is refused when repeated", () => {
  const MARKER = "PLANTED_FAKE_MARKER";
  // UTM's launch repeats only -chardev, -device and -drive.
  const once: [string, string][] = [
    ["-name", "myco-win11"],
    ["-uuid", UUID],
    ["-m", "6144"],
    ["-smp", "cpus=6,sockets=1,cores=6,threads=1"],
    ["-machine", "virt,highmem=on"],
    ["-accel", "hvf"],
    ["-cpu", "host"],
    ["-L", "/Applications/UTM.app/Contents/Resources/qemu"],
    ["-vga", "none"],
    ["-rtc", "base=localtime"],
    ["-boot", "menu=on"],
    ["-mon", "chardev=org.qemu.monitor.qmp,mode=control"],
    ["-serial", "chardev:term0"],
    ["-tpmdev", "emulator,id=tpm0,chardev=chrtpm0"],
    ["-spice", `unix=on,addr=${UUID}.spice,disable-ticketing=on`],
  ];
  for (const [opt, value] of once) {
    it(`${opt} given twice`, () => {
      const r = run([[...utmDefaultArgv(), opt, value]]);
      expect(r.stderr).toContain(`${opt} given more than once`);
      expect(r.status).toBe(1);
    });
  }
  for (const flag of ["-nodefaults", "-S"]) {
    it(`the flag ${flag} given twice`, () => {
      const r = run([[...utmDefaultArgv(), flag]]);
      expect(r.stderr).toContain(`${flag} given more than once`);
      expect(r.status).toBe(1);
    });
  }
  it("UTM's own launch repeats -chardev, -device and -drive and still passes", () => {
    const a = utmDefaultArgv();
    for (const o of ["-chardev", "-device", "-drive"]) {
      expect(a.filter((t) => t === o).length).toBeGreaterThan(1);
    }
    for (const [o] of once) expect(a.filter((t) => t === o).length).toBe(1);
    expect(run([a, SWTPM]).status).toBe(0);
  });

  // The verifier's probe: env strings "-name" and a bare marker read past a
  // short argv (argc+2) form an allowlisted-looking pair.
  const planted = () => {
    const argv = utmDefaultArgv();
    const b = procargs(argv, `-name\0${MARKER}\0HOME=/nowhere\0`);
    b.writeInt32LE(argv.length + 2, 0);
    return { argv, b };
  };
  for (const mode of ["live", "verify"]) {
    it(`${mode} refuses "-name" + a bare marker planted at argc+2, without printing it`, () => {
      const { argv, b } = planted();
      const r = run([b], GOOD_UTM, [mode]);
      expect(`${r.stdout}${r.stderr}`).toContain(`-name given more than once (argv[${argv.length}]`);
      expect(`${r.stdout}${r.stderr}`).not.toContain(MARKER);
      expect(r.status).toBe(1);
    });
  }
  for (const mode of ["argv", "names", "status"]) {
    it(`${mode} never prints the marker planted after "-name" at argc+2`, () => {
      const { argv, b } = planted();
      const r = run([b], GOOD_UTM, [mode]);
      expect(`${r.stdout}${r.stderr}`).not.toContain(MARKER);
      expect(r.status).toBe(0);
      if (mode === "argv") {
        const lines = r.stdout.trimEnd().split("\n");
        expect(lines.slice(-2)).toEqual(["-name", `<redacted argv[${argv.length + 1}]>`]);
        expect(lines).toContain("myco-win11");
      }
    });
  }
});

describe("round 2 nit: an unparseable qemu process is never skipped", () => {
  // Outside fixture mode, processes whose procargs do not parse are skipped
  // (other users' processes, exited ones). A qemu executable must not be: a
  // second guest with an empty argv[0] would go uncounted.
  const driver = (badExec: string) => `
import struct, sys
sys.path.insert(0, sys.argv[1])
import guest_egress_check as g
def buf(argv, exec_path):
    p = exec_path.encode() + b"\\0"
    p += b"\\0" * (-len(p) % 8)
    return struct.pack("<i", len(argv)) + p + b"\\0".join(a.encode() for a in argv) + b"\\0HOME=/x\\0"
good = ["/a/QEMULauncher", "/a/qemu-aarch64-softmmu", "-nodefaults"]
bad = buf(["", "-nodefaults"], ${JSON.stringify(badExec)})
bufs = {1: buf(good, good[0]), 2: bad}
g.candidate_pids = lambda: [1, 2]
g.read_procargs2 = lambda pid: bufs[pid]
try:
    print("guest argv of", len(g.find_guest_argv()))
except g.Refused as e:
    print("FAIL:", e)
`;
  const go = (badExec: string) =>
    spawnSync(
      "python3",
      ["-I", "-c", driver(badExec), join(import.meta.dirname, "..", "scripts")],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );

  it("refuses when an unparseable buffer's exec path is a qemu binary", () => {
    const r = go(QEMU_BIN);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("FAIL: procargs: empty argv[0]");
  });
  it("refuses when it is QEMULauncher", () => {
    expect(go(LAUNCHER).stdout).toContain("FAIL: procargs: empty argv[0]");
  });
  it("still skips an unparseable non-qemu process", () => {
    const r = go("/usr/bin/login");
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("guest argv of 3");
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
