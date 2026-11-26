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

/** A KERN_PROCARGS2 buffer: int32 argc, exec path, NUL padding, argv, environment. */
function procargs(argv: string[]): Buffer {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(argv.length);
  const exec = Buffer.from(`${argv[0]}\0\0\0\0`);
  const args = Buffer.from(`${argv.join("\0")}\0`);
  const env = Buffer.from(`${ENV_SECRET}\0HOME=/nowhere\0`);
  return Buffer.concat([argc, exec, args, env]);
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
  const r =
    args[0] === "argv"
      ? spawnSync("python3", ["-I", CHECK, "argv"], { encoding: "utf8", env })
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
    refuse(withNet("-netdev", GOOD_NETDEV, "-nic", "user,model=virtio"), "-nic/-net present");
  });
  it("a legacy -net beside the netdev", () => {
    refuse(withNet("-netdev", GOOD_NETDEV, "-net", "user"), "-nic/-net present");
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
      "filter-redirector attaches",
    );
  });
  it("-object filter-mirror (one-way exfil)", () => {
    refuse(
      ["-object", "filter-mirror,id=m0,netdev=net0,queue=tx,outdev=c0"],
      "filter-mirror attaches",
    );
  });
  it("-object type=filter-dump", () => {
    refuse(["-object", "type=filter-dump,id=d0,netdev=net0,file=/tmp/x"], "filter-dump attaches");
  });
  it("any other -object that references a netdev", () => {
    refuse(["-object", "colo-compare,id=cc,netdev=net0"], "-object references a netdev");
  });
  it("a second NIC device on the same netdev", () => {
    refuse(["-device", "e1000,netdev=net0"], "netdev references");
  });
  it("a netdev= reference outside any -device", () => {
    refuse(["-global", "virtio-net-pci.netdev=net0,netdev=net0"], "netdev= outside a -device");
  });
  it("a TCP socket chardev (host=)", () => {
    refuse(
      ["-chardev", "socket,id=c0,host=203.0.113.9,port=9"],
      "-chardev backend not in UTM's allowlist",
    );
  });
  it("a socket chardev listening on a port (no host=)", () => {
    refuse(["-chardev", "socket,id=c0,port=9,server=on"], "not in UTM's allowlist");
  });
  it("a udp chardev", () => {
    refuse(["-chardev", "udp,id=c0,host=203.0.113.9,port=9"], "not in UTM's allowlist");
  });
  it("a unix socket chardev other than UTM's swtpm one", () => {
    refuse(["-chardev", "socket,id=c0,path=/tmp/x.sock"], "not in UTM's allowlist");
  });
  it("a virtserialport on a host socket", () => {
    refuse(
      ["-chardev", "socket,id=c0,host=203.0.113.9,port=9", "-device", "virtserialport,chardev=c0"],
      "not in UTM's allowlist",
    );
  });
  it("-serial tcp:", () => {
    refuse(["-serial", "tcp:203.0.113.9:9"], "is not a chardev reference");
  });
  it("-serial udp:", () => {
    refuse(["-serial", "udp:203.0.113.9:9"], "is not a chardev reference");
  });
  it("-serial telnet:", () => {
    refuse(["-serial", "telnet:0.0.0.0:23,server"], "is not a chardev reference");
  });
  it("-parallel tcp:", () => {
    refuse(["-parallel", "tcp:203.0.113.9:9"], "is not a chardev reference");
  });
  it("-monitor tcp:", () => {
    refuse(["-monitor", "tcp:203.0.113.9:9"], "-monitor is not part of UTM's launch");
  });
  it("-qmp tcp:", () => {
    refuse(["-qmp", "tcp:203.0.113.9:9"], "-qmp is not part of UTM's launch");
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
