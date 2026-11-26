/**
 * TIF-275: `scripts/guest-egress.sh verify` accepts exactly ONE network
 * configuration and refuses everything else (round 2, verifier D1-D3):
 *   live argv: one guest; exactly one `-netdev` and no `-nic`/`-net`; no
 *   `-readconfig`/`-set`; a `user` netdev with only id/restrict/hostfwd; every
 *   restrict `on`; hostfwd set exactly {tcp:127.0.0.1:2222-:22};
 *   UTM config: one emulated NIC, isolate on, one forward 127.0.0.1:2222 -> :22.
 * Anything unreadable or unparseable fails.
 *
 * Drives the real script with stub `ps` and `osascript` first on PATH, so the
 * real VM and UTM are never contacted. Each stub writes a marker so a stub
 * shadowed by a host binary fails the test instead of reading the real host.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "guest-egress.sh");
const QEMU =
  "/Applications/UTM.app/Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS/QEMULauncher.app/Contents/MacOS/QEMULauncher /Applications/UTM.app/Contents/Frameworks/qemu-aarch64-softmmu.framework/Versions/A/qemu-aarch64-softmmu -nodefaults -device virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=net0";
const GOOD_NETDEV = "user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22";
const GOOD_UTM = "nics=1;mode=emulated;isolate=true;pfs=1;pf=TCP|127.0.0.1|2222||22";
const SWTPM =
  "/Applications/UTM.app/Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS/QEMULauncher.app/Contents/MacOS/QEMULauncher /Applications/UTM.app/Contents/Frameworks/swtpm.0.framework/Versions/A/swtpm.0 --ctrl type=unixio";

let dir = "";

/** `utm` is what osascript prints for the network-config query; null = osascript fails. */
function run(psLines: string[] | null, utm: string | null = GOOD_UTM, args = ["verify"]) {
  const stub = join(dir, "bin");
  mkdirSync(stub, { recursive: true });
  const table = join(dir, "ps.out");
  writeFileSync(table, psLines ? `${psLines.join("\n")}\n` : "");
  writeFileSync(
    join(stub, "ps"),
    `#!/bin/bash\necho ran >> "${join(dir, "ps.marker")}"\n${psLines ? `cat "${table}"` : "exit 1"}\n`,
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
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${stub}:/usr/bin:/bin`, HOME: dir },
  });
  return {
    ...r,
    psRan: existsSync(join(dir, "ps.marker")),
    osaRan: existsSync(join(dir, "osascript.marker")),
  };
}

const guest = (...net: string[]) => `${QEMU} ${net.join(" ")} -cpu host`;
const one = (netdev: string) => guest("-netdev", netdev);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myco-egress-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("guest-egress.sh verify: the one accepted configuration", () => {
  it("passes for the allowlist, live and in UTM", () => {
    const r = run(["/usr/bin/login", one(GOOD_NETDEV), SWTPM]);
    expect(r.psRan).toBe(true);
    expect(r.osaRan).toBe(true);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("egress closed");
  });

  it("passes whatever the option order", () => {
    const r = run([one("user,hostfwd=tcp:127.0.0.1:2222-:22,id=net0,restrict=on")]);
    expect(r.status).toBe(0);
  });

  it("ignores processes that merely mention qemu, like the readiness gate's pgrep", () => {
    const r = run([
      "pgrep -f qemu-aarch64-softmmu|qemu-system-aarch64",
      "vim /tmp/notes-qemu-aarch64-softmmu -netdev user,id=x",
      one(GOOD_NETDEV),
      SWTPM,
    ]);
    expect(r.status).toBe(0);
  });
});

describe("guest-egress.sh verify refuses: live command line (D1-D3)", () => {
  const refuse = (lines: string[], why: string) => {
    const r = run(lines);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(why);
    return r;
  };

  // D1: a second NIC, restricted or not.
  it("a second -netdev that is unrestricted", () => {
    refuse(
      [
        guest(
          "-netdev",
          GOOD_NETDEV,
          "-device",
          "x,netdev=net1",
          "-netdev",
          "user,id=net1,hostfwd=tcp:127.0.0.1:2223-:22",
        ),
      ],
      "expected exactly one -netdev, found 2",
    );
  });
  it("a second -netdev even when it is restricted", () => {
    refuse(
      [guest("-netdev", GOOD_NETDEV, "-netdev", "user,id=net1,restrict=on")],
      "expected exactly one -netdev, found 2",
    );
  });
  it("a -nic beside the netdev", () => {
    refuse([guest("-netdev", GOOD_NETDEV, "-nic", "user,model=virtio")], "-nic/-net present");
  });
  it("a legacy -net beside the netdev", () => {
    refuse([guest("-netdev", GOOD_NETDEV, "-net", "user")], "-nic/-net present");
  });
  it("the double-dash spelling --netdev counts as a second NIC", () => {
    refuse([guest("-netdev", GOOD_NETDEV, "--netdev", "user,id=net1")], "found 2");
  });
  it("-readconfig, which can add network config the argv does not show", () => {
    refuse([guest("-netdev", GOOD_NETDEV, "-readconfig", "/tmp/x.cfg")], "-readconfig");
  });

  // D2: guestfwd in any form.
  it("guestfwd on the restricted netdev", () => {
    refuse(
      [one(`${GOOD_NETDEV},guestfwd=tcp:10.0.2.100:80-cmd:nc example.org 80`)],
      "guestfwd= is not allowed",
    );
  });
  it("any option outside id/restrict/hostfwd (smb=)", () => {
    refuse([one(`${GOOD_NETDEV},smb=/Users`)], "smb= is not allowed");
  });

  // D3: the inbound allowlist, re-checked on every verify.
  it("a 0.0.0.0 bind", () => {
    refuse([one("user,id=net0,restrict=on,hostfwd=tcp:0.0.0.0:2222-:22")], "hostfwd set is");
  });
  it("an all-interfaces bind with the address omitted", () => {
    refuse([one("user,id=net0,restrict=on,hostfwd=tcp::2222-:22")], "hostfwd set is");
  });
  it("an extra forward such as ::8765", () => {
    refuse([one(`${GOOD_NETDEV},hostfwd=tcp::8765-:8765`)], "hostfwd set is");
  });
  it("an extra forward even on 127.0.0.1", () => {
    refuse([one(`${GOOD_NETDEV},hostfwd=tcp:127.0.0.1:8765-:8765`)], "hostfwd set is");
  });
  it("no forward at all", () => {
    refuse([one("user,id=net0,restrict=on")], "hostfwd set is");
  });

  // restrict=on.
  it("restrict=on missing (today's open guest)", () => {
    refuse([one("user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22")], "restrict=on missing");
  });
  it("restrict=off", () => {
    refuse(
      [one("user,id=net0,restrict=off,hostfwd=tcp:127.0.0.1:2222-:22")],
      "restrict=on missing",
    );
  });
  it("restrict=on overridden by a later restrict=off", () => {
    refuse([one(`${GOOD_NETDEV},restrict=off`)], "restrict=on missing or overridden");
  });
  it("restrict=on hidden inside another option", () => {
    refuse([one(`${GOOD_NETDEV.replace("restrict=on", "xrestrict=on")}`)], "not allowed");
  });

  // Unparseable or wrong type.
  it("an unparseable option without '='", () => {
    refuse([one(`${GOOD_NETDEV},bogus`)], "unparseable netdev option");
  });
  it("an escaped comma (named as such; the empty option it leaves is refused too)", () => {
    refuse([one(`${GOOD_NETDEV},hostfwd=tcp:127.0.0.1:2223-:22,,x`)], "escaped comma");
  });
  it("a -netdev=value form", () => {
    refuse([guest(`-netdev=${GOOD_NETDEV}`)], "unparseable network option");
  });
  it("a -netdev with no value", () => {
    refuse([`${QEMU} -cpu host -netdev`], "without a value");
  });
  it("a non-user netdev", () => {
    refuse([one("vmnet-shared,id=net0,restrict=on")], "not user-mode");
  });

  // The process table.
  it("no guest running", () => {
    refuse(["/usr/bin/login", "/bin/zsh", SWTPM], "found 0");
  });
  it("two guests (ambiguous)", () => {
    refuse([one(GOOD_NETDEV), one(GOOD_NETDEV)], "found 2");
  });
  it("an unreadable process table", () => {
    const r = run(null);
    expect(r.psRan).toBe(true);
    expect(r.status).toBe(1);
  });
});

describe("guest-egress.sh verify refuses: UTM configuration", () => {
  const refuseUtm = (utm: string | null, why: string) => {
    const r = run([one(GOOD_NETDEV)], utm);
    expect(r.osaRan).toBe(true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(why);
  };
  it("a second NIC in UTM", () => {
    refuseUtm(
      `nics=2;mode=emulated;isolate=true;pfs=1;pf=TCP|127.0.0.1|2222||22;mode=emulated;isolate=false;pfs=0`,
      "not the allowlist",
    );
  });
  it("isolate-from-host off in UTM", () => {
    refuseUtm(GOOD_UTM.replace("isolate=true", "isolate=false"), "not the allowlist");
  });
  it("an extra port forward in UTM", () => {
    refuseUtm(
      "nics=1;mode=emulated;isolate=true;pfs=2;pf=TCP|127.0.0.1|2222||22;pf=TCP||8765||8765",
      "not the allowlist",
    );
  });
  it("a forward bound on all interfaces in UTM", () => {
    refuseUtm(GOOD_UTM.replace("127.0.0.1", ""), "not the allowlist");
  });
  it("a shared or bridged NIC in UTM", () => {
    refuseUtm(GOOD_UTM.replace("emulated", "shared"), "not the allowlist");
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
