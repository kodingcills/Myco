/**
 * TIF-98 follow-up: scripts/build-trial-base.sh builds trial-base-v2 from
 * clean-base. These tests pin the properties the brief makes non-negotiable:
 *   - it runs only under scripts/vm-session.sh (the VM held for the whole build);
 *   - it never overwrites an existing trial base and never touches clean-base
 *     beyond restoring it (no snapshot of it, no delete of anything);
 *   - egress is opened only for the maintenance window, re-denied before the
 *     snapshot, proven denied by the probe, and re-denied on any failure;
 *   - nothing but the maintenance script is copied into the guest;
 *   - a failed Defender check or a reachable probe target stops the build
 *     before the snapshot.
 *
 * Everything is stubbed: vm.sh, vssh, scp, the egress/reset/gate scripts. The
 * session wrapper is the real scripts/vm-session.sh on a private lock path.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const BUILD = join(ROOT, "scripts", "build-trial-base.sh");
const SESSION = join(ROOT, "scripts", "vm-session.sh");

let dir = "";
let log = "";

function stub(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

interface Opts {
  existing?: string[];
  checkFails?: boolean;
  probeReachable?: boolean;
}

function install(opts: Opts = {}): Record<string, string> {
  const vm = join(dir, "vm");
  const bin = join(dir, "bin");
  mkdirSync(vm);
  mkdirSync(bin);
  const snaps = join(dir, "snapshots");
  writeFileSync(snaps, ["clean-base", "clean-base-live", ...(opts.existing ?? [])].join(", "));
  stub(
    join(vm, "vm.sh"),
    `echo "vm.sh $*" >> "${log}"
case "$1" in
  status) echo stopped ;;
  snapshots) cat "${snaps}" ;;
  snapshot) printf ', %s' "$2" >> "${snaps}" ;;
esac
exit 0`,
  );
  stub(
    join(vm, "vssh"),
    `echo "vssh $*" >> "${log}"
case "$*" in
  *"-Stage state"*) echo '{"state":"recorded"}' ;;
  *"-Stage check"*) ${opts.checkFails ? 'echo "check: FAIL"; exit 1' : 'echo "check: ok"'} ;;
  *) echo ok ;;
esac
exit 0`,
  );
  stub(join(bin, "scp"), `echo "scp $*" >> "${log}"\nexit 0`);
  const egress = join(dir, "egress.sh");
  stub(
    egress,
    `echo "egress $1" >> "${log}"
case "$1" in
  probe) ${
    opts.probeReachable
      ? `echo '{"dns_pypi_org":"timeout","tcp_1_1_1_1_443":"ok"}'`
      : `echo '{"dns_pypi_org":"timeout","tcp_1_1_1_1_443":"SocketException"}'`
  } ;;
  status) echo "utm isolate-from-host: true" ;;
esac
exit 0`,
  );
  const reset = join(dir, "reset.sh");
  stub(reset, `echo "reset $* egress=\${MYCO_GUEST_EGRESS:-closed}" >> "${log}"\nexit 0`);
  const gate = join(dir, "gate.sh");
  stub(gate, `echo "gate $*" >> "${log}"\nexit 0`);
  return {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: dir,
    MYCO_VM_LOCK_PATH: join(dir, "vm.lock"),
    MYCO_VM_SCRIPTS: vm,
    MYCO_EGRESS_SCRIPT: egress,
    MYCO_RESET_SCRIPT: reset,
    MYCO_GATE_SCRIPT: gate,
    VM_SSH_CONFIG: join(dir, "ssh_config"),
  };
}

function run(env: Record<string, string>, underSession = true) {
  const out = join(dir, "evidence");
  const args = underSession ? [SESSION, "--", "bash", BUILD, out] : [BUILD, out];
  return new Promise<{ status: number | null; stderr: string; calls: string[] }>((resolve) => {
    const child = spawn("bash", args, { env });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.stdout.on("data", () => {});
    child.on("close", (status) => {
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      resolve({ status, stderr, calls });
    });
  });
}

/** Index of the first call containing `needle`, or -1. */
const at = (calls: string[], needle: string) => calls.findIndex((c) => c.includes(needle));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myco-base-v2-"));
  log = join(dir, "calls.log");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SLOW = 60_000;

describe("build-trial-base.sh", () => {
  it("refuses to run outside scripts/vm-session.sh", { timeout: SLOW }, async () => {
    const r = await run(install(), false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("run me under scripts/vm-session.sh");
    expect(r.calls).toEqual([]);
  });

  it("builds in order: open window, maintain, disable, check, deny, prove, snapshot", {
    timeout: SLOW,
  }, async () => {
    const r = await run(install());
    expect(r.stderr).not.toContain("build-trial-base: ");
    expect(r.status).toBe(0);
    const c = r.calls;
    const order = [
      "egress allow",
      "reset clean-base egress=open",
      "scp ",
      "-Stage state",
      "-Stage signatures",
      "-Stage ngen",
      "-Stage idle",
      "-Stage scan",
      "-Stage disable",
      "-Stage check",
      "Remove-Item",
      "egress deny",
      "vm.sh start",
      "gate ",
      "egress verify",
      "egress probe",
      "egress status",
      "vm.sh snapshot trial-base-v2",
    ];
    const idx = order.map((n) => at(c, n));
    for (const [i, n] of order.entries()) expect(idx[i], n).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < idx.length; i++) expect(idx[i], order[i]).toBeGreaterThan(idx[i - 1] ?? -1);
    // The only file copied into the guest is the maintenance script.
    const copies = c.filter((x) => x.startsWith("scp "));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain("guest-maintenance.ps1");
    // clean-base: restored once, never snapshotted or deleted; no restore after the work.
    expect(c.filter((x) => x.startsWith("reset "))).toHaveLength(1);
    expect(c.some((x) => x.includes("delete-snapshot"))).toBe(false);
    expect(c.some((x) => x.includes("vm.sh snapshot clean-base"))).toBe(false);
    expect(c.some((x) => x.includes("vm.sh restore"))).toBe(false);
    // Egress denied before the snapshot and not re-opened after.
    expect(c.filter((x) => x === "egress allow")).toHaveLength(1);
  });

  it("refuses to overwrite an existing trial base, before opening egress", {
    timeout: SLOW,
  }, async () => {
    const r = await run(install({ existing: ["trial-base-v2"] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(r.calls.some((x) => x.startsWith("egress"))).toBe(false);
    expect(r.calls.some((x) => x.includes("vm.sh snapshot "))).toBe(false);
  });

  it("stops before the snapshot when Defender is off or has exclusions, and re-denies egress", {
    timeout: SLOW,
  }, async () => {
    const r = await run(install({ checkFails: true }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Defender check failed");
    expect(r.calls.some((x) => x.includes("vm.sh snapshot "))).toBe(false);
    expect(r.calls.at(-1)).toBe("egress deny");
  });

  it("stops before the snapshot when any probe target is reachable after deny", {
    timeout: SLOW,
  }, async () => {
    const r = await run(install({ probeReachable: true }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("reachable with egress denied");
    expect(r.calls.some((x) => x.includes("vm.sh snapshot "))).toBe(false);
  });
});

/**
 * The guest half cannot run here (no PowerShell on the host or in CI), so this
 * pins the `signatures` stage's retry contract in its source (run 1 on
 * 2026-11-26 failed on HRESULT 0x80070652, another install in progress):
 * retry only on that HRESULT, rethrow anything else, stop early when the
 * signature version moves, and fail closed (exit 1) at a deadline of 20-30 min.
 */
describe("guest-maintenance.ps1 signatures stage", () => {
  const ps = readFileSync(join(ROOT, "scripts", "trial-base", "guest-maintenance.ps1"), "utf8");
  const start = ps.indexOf("if ($Stage -eq 'signatures') {");
  const end = ps.indexOf("if ($Stage -eq", start + 1);
  const stage = ps
    .slice(start, end)
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  const catchBlock = stage.slice(stage.indexOf("catch {"), stage.indexOf("Start-Sleep"));

  it("is found", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("retries Update-MpSignature in a loop, only on 0x80070652, rethrowing anything else", () => {
    expect(stage).toMatch(/while \(\$true\) \{[\s\S]*try \{ Update-MpSignature; break \}/);
    expect(catchBlock).toContain("'HRESULT 0x80070652,*'");
    expect(catchBlock).toContain("-eq -2147023278");
    expect(catchBlock).toMatch(/if \(-not \$busy\) \{ throw \}/);
    expect(stage).toMatch(/Start-Sleep -Seconds \d+/);
  });

  it("stops waiting when the signature version moves", () => {
    const loop = stage.slice(stage.indexOf("Start-Sleep"));
    expect(loop).toMatch(/\$now = \(Get-MpComputerStatus\)\.AntivirusSignatureVersion/);
    expect(loop).toMatch(/if \(\$now -ne \$before\) \{[^}]*break \}/);
  });

  it("fails closed at a bounded deadline of 20-30 minutes", () => {
    const m = stage.match(/\$deadline = \(Get-Date\)\.AddMinutes\((\d+)\)/);
    expect(m).not.toBeNull();
    const minutes = Number(m?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(20);
    expect(minutes).toBeLessThanOrEqual(30);
    expect(stage).toMatch(/if \(\(Get-Date\) -gt \$deadline\) \{[^}]*exit 1 \}/);
  });
});
