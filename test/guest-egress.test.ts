/**
 * TIF-275: `scripts/guest-egress.sh verify` must pass ONLY on positive evidence
 * that the running guest's user-mode netdev has `restrict=on`, and fail closed
 * on everything else: no guest, two guests, an unreadable process table, a
 * netdev without the option, `restrict=off`, or the string hidden inside
 * another option.
 *
 * Drives the real script against a stub `ps` first on PATH. The real VM is
 * never contacted: verify reads only the process table, and the stub writes a
 * marker so a stub shadowed by the host's `ps` fails the test.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "guest-egress.sh");
const QEMU =
  "/Applications/UTM.app/Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS/QEMULauncher.app/Contents/MacOS/QEMULauncher /Applications/UTM.app/Contents/Frameworks/qemu-aarch64-softmmu.framework/Versions/A/qemu-aarch64-softmmu -nodefaults -device virtio-net-pci,mac=4A:50:C3:24:9B:33,netdev=net0";

let dir = "";

function run(psLines: string[] | null, args = ["verify"]) {
  const stub = join(dir, "bin");
  mkdirSync(stub, { recursive: true });
  const table = join(dir, "ps.out");
  writeFileSync(table, psLines ? `${psLines.join("\n")}\n` : "");
  writeFileSync(
    join(stub, "ps"),
    `#!/bin/bash\necho ran >> "${join(dir, "ps.marker")}"\n${psLines ? `cat "${table}"` : "exit 1"}\n`,
    { mode: 0o755 },
  );
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${stub}:/usr/bin:/bin`, HOME: dir },
  });
  return { ...r, psRan: existsSync(join(dir, "ps.marker")) };
}

const guest = (netdev: string) => `${QEMU} -netdev ${netdev} -cpu host`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myco-egress-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("guest-egress.sh verify (TIF-275)", () => {
  it("passes when the running netdev has restrict=on", () => {
    const r = run(["/usr/bin/login", guest("user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22")]);
    expect(r.psRan).toBe(true);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("egress closed");
  });

  it("passes whatever the option order", () => {
    const r = run([guest("user,hostfwd=tcp:127.0.0.1:2222-:22,id=net0,restrict=on")]);
    expect(r.status).toBe(0);
  });

  it("fails when the netdev has no restrict option (today's open guest)", () => {
    const r = run([guest("user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("egress is OPEN");
  });

  it("fails on restrict=off", () => {
    const r = run([guest("user,id=net0,restrict=off,hostfwd=tcp:127.0.0.1:2222-:22")]);
    expect(r.status).toBe(1);
  });

  it("does not accept restrict=on hidden inside another option", () => {
    // Only a whole comma-separated option counts, not a substring.
    const r = run([guest("user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,guestfwd=xrestrict=on")]);
    expect(r.status).toBe(1);
  });

  it("does not accept a non-user netdev", () => {
    const r = run([guest("vmnet-shared,id=net0,restrict=on")]);
    expect(r.status).toBe(1);
  });

  it("ignores processes that merely mention qemu, like the readiness gate's pgrep", () => {
    const r = run([
      "pgrep -f qemu-aarch64-softmmu|qemu-system-aarch64",
      "vim /tmp/notes-qemu-aarch64-softmmu -netdev user,id=x",
      guest("user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22"),
      "/Applications/UTM.app/Contents/XPCServices/QEMUHelper.xpc/Contents/MacOS/QEMULauncher.app/Contents/MacOS/QEMULauncher /Applications/UTM.app/Contents/Frameworks/swtpm.0.framework/Versions/A/swtpm.0 --ctrl type=unixio",
    ]);
    expect(r.status).toBe(0);
  });

  it("fails closed with no guest running", () => {
    const r = run(["/usr/bin/login", "/bin/zsh"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot prove egress is closed");
  });

  it("fails closed with two guests (ambiguous)", () => {
    const r = run([guest("user,id=net0,restrict=on"), guest("user,id=net0,restrict=on")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot prove egress is closed");
  });

  it("fails closed when the process table cannot be read", () => {
    const r = run(null);
    expect(r.psRan).toBe(true);
    expect(r.status).toBe(1);
  });

  it("rejects an unknown subcommand with usage", () => {
    const r = run([], ["open-it"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
});
