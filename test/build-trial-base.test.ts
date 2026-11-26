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

  // Round 2 (verifier D1, mutants S1 and S2b): pin the exact busy test and the whole retry loop,
  // so "every HRESULT is busy" and "the busy branch exits instead of waiting" both fail.
  const lines = stage
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  it("classifies busy by exactly the two 0x80070652 forms, nothing else", () => {
    expect(lines).toContain(
      "$busy = ($_.FullyQualifiedErrorId -like 'HRESULT 0x80070652,*') -or ($_.Exception.HResult -eq -2147023278)",
    );
    expect(lines.filter((l) => l.startsWith("$busy")).length).toBe(1);
  });

  it("the busy branch logs and falls through to the deadline-then-wait path: no exit or break in catch", () => {
    const from = lines.indexOf("catch {");
    const to = lines.indexOf("}", from);
    const body = lines.slice(from, to + 1);
    expect(body.some((l) => /\bexit\b|\bbreak\b|\breturn\b/.test(l))).toBe(false);
  });

  it("the retry loop is exactly: try, catch (busy or rethrow), deadline exit 1, wait 60 s, version check", () => {
    const from = lines.indexOf("while ($true) {");
    expect(from).toBeGreaterThan(0);
    expect(lines.slice(from, from + 14)).toEqual([
      "while ($true) {",
      "$attempt++",
      "try { Update-MpSignature; break }",
      "catch {",
      "$busy = ($_.FullyQualifiedErrorId -like 'HRESULT 0x80070652,*') -or ($_.Exception.HResult -eq -2147023278)",
      "if (-not $busy) { throw }",
      // PowerShell's ${attempt}, split so it is not read as a JS template placeholder.
      '"signatures: attempt $' + '{attempt}: another install is in progress (HRESULT 0x80070652)"',
      "}",
      'if ((Get-Date) -gt $deadline) { "signatures: FAIL still 0x80070652 after 25 min ($attempt attempts); version $before"; exit 1 }',
      "Start-Sleep -Seconds 60",
      "$now = (Get-MpComputerStatus).AntivirusSignatureVersion",
      'if ($now -ne $before) { "signatures: the other install moved the version to $now"; break }',
      "}",
      "$after = Get-MpComputerStatus",
    ]);
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

/**
 * Idle stage (lead ruling 2026-11-26 05:37Z): exactly three not-counted tasks (two always-running, plus WDI\\ResolutionHost on cold boots, lead ruling 20:3xZ)
 * are not counted, matched by full path with no wildcards. Build run 2 had them
 * running in all 115 samples (and the deadline line). Every other \Microsoft\Windows task still has to
 * be idle, and the stage fails closed (exit 1) at the 60 min deadline.
 */
describe("guest-maintenance.ps1 idle stage", () => {
  const ps = readFileSync(join(ROOT, "scripts", "trial-base", "guest-maintenance.ps1"), "utf8");
  const start = ps.indexOf("if ($Stage -eq 'idle') {");
  const end = ps.indexOf("if ($Stage -eq", start + 1);
  const stage = ps
    .slice(start, end)
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

  it("is found", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("does not count exactly the three tasks, by full path, with no wildcards", () => {
    const m = stage.match(/\$notCounted = @\(([^)]*)\)/);
    expect(m).not.toBeNull();
    const paths = [...(m?.[1] ?? "").matchAll(/'([^']*)'/g)].map((x) => x[1]);
    expect(paths).toEqual([
      "\\Microsoft\\Windows\\Multimedia\\SystemSoundsService",
      "\\Microsoft\\Windows\\Wininet\\CacheTask",
      // Lead ruling 2026-11-26 20:3xZ (trial-base-v3, cold boot): see the script comment.
      "\\Microsoft\\Windows\\WDI\\ResolutionHost",
    ]);
    // Nothing else between the parentheses (no unquoted or extra entries).
    expect((m?.[1] ?? "").replace(/'[^']*'/g, "").replace(/[\s,]/g, "")).toBe("");
    for (const p of paths) expect(p).not.toMatch(/[*?[\]]/);
    // Exact matching only: no -like / -match family anywhere in the stage.
    expect(stage).not.toMatch(/-(not)?(i|c)?(like|match)\b/i);
    expect(stage).toContain("Where-Object { $notCounted -notcontains $_ }");
  });

  it("still requires every other task to be idle", () => {
    expect(stage).toMatch(/\$running = RunningWindowsTasks/);
    expect(stage).toMatch(/\$counted = @\(\$running \| Where-Object/);
    expect(stage).toMatch(/if \(\$counted\.Count -eq 0 -and \$cpu -lt 15\) \{ \$quiet\+\+ \}/);
  });

  // Round 2 (verifier D1, mutant I8): the counted set is exactly "running minus the not-counted tasks", with no
  // further filter that could drop every task.
  it("counts exactly the running tasks minus the not-counted tasks, with no extra filter", () => {
    const lines = stage
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const counted = lines.filter((l) => l.startsWith("$counted"));
    expect(counted).toEqual([
      "$counted = @($running | Where-Object { $notCounted -notcontains $_ })",
    ]);
    const from = lines.indexOf("while ($quiet -lt 3) {");
    expect(lines.slice(from + 2, from + 5)).toEqual([
      "Start-Sleep -Seconds 30",
      "$running = RunningWindowsTasks",
      "$counted = @($running | Where-Object { $notCounted -notcontains $_ })",
    ]);
  });

  it("fails closed at the 60 min deadline", () => {
    expect(stage).toContain("$deadline = (Get-Date).AddMinutes(60)");
    expect(stage).toMatch(/if \(\(Get-Date\) -gt \$deadline\) \{[^}]*exit 1 \}/);
  });
});

/**
 * Round 3 (verifier round-2 D3): the error mode every stage relies on, and the idle loop pinned
 * line for line. Under 'Continue', a failed Update-MpSignature would skip `catch` and the stage
 * would exit 0 with stale signatures (R6, R8). Without `else { $quiet = 0 }` the gate would take
 * 3 cumulative quiet samples instead of 3 consecutive ones (I6). An inserted reassignment of
 * $counted after its computation would empty it before the test (I4, I5).
 */
describe("guest-maintenance.ps1 error mode and idle loop (exact)", () => {
  const ps = readFileSync(join(ROOT, "scripts", "trial-base", "guest-maintenance.ps1"), "utf8");
  const code = ps
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  it("sets $ErrorActionPreference = 'Stop' script-wide, before any stage", () => {
    const first = code.findIndex((l) => l.includes("ErrorActionPreference"));
    expect(code[first]).toBe("$ErrorActionPreference = 'Stop'");
    expect(first).toBeLessThan(code.findIndex((l) => l.startsWith("if ($Stage -eq")));
  });

  it("changes the error mode nowhere else except inside the Native helper (which restores it)", () => {
    expect(code.filter((l) => /ErrorActionPreference/i.test(l))).toEqual([
      "$ErrorActionPreference = 'Stop'",
      "$saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'",
      "try { & $b } finally { $ErrorActionPreference = $saved }",
    ]);
    // Those two helper lines sit inside `function Native(...) { ... }`.
    const fn = code.indexOf("function Native([scriptblock]$b) {");
    expect(code.slice(fn + 1, fn + 4)).toEqual([
      "$saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'",
      "try { & $b } finally { $ErrorActionPreference = $saved }",
      "}",
    ]);
  });

  it("the signatures and check stages override the error mode per command nowhere", () => {
    for (const name of ["signatures", "check"]) {
      const start = code.indexOf(`if ($Stage -eq '${name}') {`);
      const end = code.findIndex((l, i) => i > start && l.startsWith("if ($Stage -eq"));
      const body = code.slice(start, end < 0 ? undefined : end);
      expect(start).toBeGreaterThan(0);
      expect(body.filter((l) => /-ErrorAction\b|-EA\b/i.test(l))).toEqual([]);
    }
  });

  it("the idle loop is exactly: deadline exit 1, wait 30 s, running, counted, cpu, log, consecutive-quiet test", () => {
    const from = code.indexOf("while ($quiet -lt 3) {");
    expect(from).toBeGreaterThan(0);
    expect(code.slice(from, from + 10)).toEqual([
      "while ($quiet -lt 3) {",
      `if ((Get-Date) -gt $deadline) { "idle: not quiet after 60 min; running: $((RunningWindowsTasks) -join ', ')"; exit 1 }`,
      "Start-Sleep -Seconds 30",
      "$running = RunningWindowsTasks",
      "$counted = @($running | Where-Object { $notCounted -notcontains $_ })",
      "$cpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average, 0)",
      `"idle: $(Get-Date -Format HH:mm:ss) cpu=$cpu% running=$($running.Count) counted=$($counted.Count) $($running -join ', ')"`,
      "if ($counted.Count -eq 0 -and $cpu -lt 15) { $quiet++ } else { $quiet = 0 }",
      "}",
      '"idle: quiet for 3 samples"',
    ]);
  });

  it("nothing in the script reassigns $counted or its variable besides its one computation", () => {
    const writes = code.filter(
      (l) => /\$counted\s*(\+|-)?=(?!=)/.test(l) || /(Set|New|Clear|Remove)-Variable\b/i.test(l),
    );
    expect(writes).toEqual([
      "$counted = @($running | Where-Object { $notCounted -notcontains $_ })",
    ]);
  });
});
