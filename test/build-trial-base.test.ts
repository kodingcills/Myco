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
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  /** TIF-734: stubbed guest answers for the optional HCU stage. */
  hcu?: {
    installFails?: boolean;
    verifyFails?: boolean;
    noGui?: boolean;
    noAx?: boolean;
    noImage?: boolean;
    /** The image block's data: "" (empty) or base64 of bytes that are not an image. */
    imageData?: string;
    /** Per MCP session, in order: o = screenshot ok, f = screenshot runtime error. */
    shots?: string;
    /** identity stage answers (resume): the marker pid alive, and Windows' boot time. */
    identityAlive?: boolean;
    bootUtc?: number;
  };
  /** vm.sh status answer (default stopped). */
  vmStatus?: string;
  egressOpen?: boolean;
  egressVerifyFails?: boolean;
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
  status) if [ -f "${join(dir, "guest-shut-down")}" ]; then echo stopped; else echo ${opts.vmStatus ?? "stopped"}; fi ;;
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
  *"myco-hcu.ps1 -Stage install"*) ${opts.hcu?.installFails ? 'echo "install: FAIL computer-use.exe sha256"; exit 1' : 'echo "install: MycoHCU task registered"'} ;;
  *"shutdown.exe"*) touch "${join(dir, "guest-shut-down")}"; echo ok ;;
  *"myco-hcu.ps1 -Stage identity"*) echo "identity: pid=5364 alive=${opts.hcu?.identityAlive === false ? 0 : 1} session=1 boot_utc=${opts.hcu?.bootUtc ?? 1000}" ;;
  *"myco-hcu.ps1 -Stage verify"*) ${opts.hcu?.verifyFails ? 'echo "verify: FAIL no computer-use.exe in an interactive session"; exit 1' : 'echo "verify: computer-use.exe pid 7 session 1"; echo "socket=C:\\Users\\myco\\AppData\\Local\\Temp\\hcu--1\\desktop-default.sock"'} ;;
  *) echo ok ;;
esac
exit 0`,
  );
  stub(join(bin, "scp"), `echo "scp $*" >> "${log}"\nexit 0`);
  // #746 B1: GNU coreutils semantics for \`stat -f\` (prints the filesystem block, exits 1), so the
  // macOS run exercises what broke on Linux. The script must not depend on stat at all.
  stub(
    join(bin, "stat"),
    `if [ "$1" = -f ]; then printf '  File: "%s"\\n    ID: 0 Namelen: 255 Type: apfs\\nBlock size: 4096\\n' "\${3:-x}"; exit 1; fi
exec /usr/bin/stat "$@"`,
  );
  // TIF-734: the MCP probe over ssh (computer-use.exe mcp --attach); answers by request id.
  const tools = opts.hcu?.noGui
    ? '[{"name":"AX"}]'
    : opts.hcu?.noAx
      ? '[{"name":"GUI"}]'
      : '[{"name":"AX"},{"name":"GUI"}]';
  const data = opts.hcu?.imageData ?? "iVBORw0KGgo="; // base64 of the 8 PNG magic bytes
  const okShot = opts.hcu?.noImage
    ? '{"isError":false,"content":[{"type":"text","text":"{}"}]}'
    : `{"isError":false,"content":[{"type":"text","text":"{}"},{"type":"image","mimeType":"image/png","data":"${data}"}]}`;
  const badShot =
    '{"isError":true,"content":[{"type":"text","text":"{\\"ok\\":false,\\"code\\":\\"runtime_error\\"}"}]}';
  const shots = opts.hcu?.shots ?? "ooo";
  const counter = join(dir, "ssh-sessions");
  stub(
    join(bin, "ssh"),
    `echo "ssh $*" >> "${log}"
cat > /dev/null
n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo $n > "${counter}"
s="${shots}"; c="\${s:$((n-1)):1}"
echo '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"computer-use","version":"1.0.1"}}}'
echo '{"jsonrpc":"2.0","id":2,"result":{"tools":${tools}}}'
if [ "$c" = f ]; then echo '{"jsonrpc":"2.0","id":3,"result":${badShot}}'; else echo '{"jsonrpc":"2.0","id":3,"result":${okShot}}'; fi
exit 0`,
  );
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
  status) echo "utm isolate-from-host: ${opts.egressOpen ? "false" : "true"}" ;;
  verify) ${opts.egressVerifyFails ? "exit 1" : "true"} ;;
esac
exit 0`,
  );
  const reset = join(dir, "reset.sh");
  // The real reset prints its boot class (TIF-98 cold-boot check); a cold boot here.
  stub(
    reset,
    `echo "reset $* egress=\${MYCO_GUEST_EGRESS:-closed}" >> "${log}"\necho "reset-trial-vm: boot class=cold first_ssh_s=140 guest_cpu_first_ssh_s=280 attempts=1" >&2\nexit 0`,
  );
  const gate = join(dir, "gate.sh");
  // The real gate prints its first-ssh line with the guest CPU; a cold boot here.
  stub(
    gate,
    `echo "gate $*" >> "${log}"\necho "wait-guest-ready: first ssh answer after 140s (guest CPU 280s)" >&2\nexit 0`,
  );
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

/** The stubbed test's explicit flag: short HCU timings and pins matching the fixture's files. */
let fixturePins: { cu: string; provider: string } = { cu: "", provider: "" };
const testFlag = () => ({
  MYCO_BUILD_TRIAL_BASE_TEST: "1",
  MYCO_TEST_HCU_RETRY_S: "0",
  MYCO_TEST_HCU_PROBE_WAIT_S: "0",
  MYCO_TEST_HCU_PIN_CU: fixturePins.cu,
  MYCO_TEST_HCU_PIN_PROVIDER: fixturePins.provider,
});

/** A host HCU directory as build-trial-base.sh expects it, with a matching SHA256SUMS. */
function hcuDir(tamper = false): string {
  const d = join(dir, "hcu");
  mkdirSync(d);
  const files = [
    "computer-use.exe",
    "computer-use-windows-provider.exe",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ];
  for (const f of files) writeFileSync(join(d, f), `bytes of ${f}`);
  const sums = spawnSync("shasum", ["-a", "256", ...files], { cwd: d, encoding: "utf8" }).stdout;
  writeFileSync(join(d, "SHA256SUMS"), sums);
  const pin = (f: string) =>
    (sums.split("\n").find((l) => l.endsWith(`  ${f}`)) ?? "").slice(0, 64);
  fixturePins = { cu: pin("computer-use.exe"), provider: pin("computer-use-windows-provider.exe") };
  if (tamper) writeFileSync(join(d, "computer-use.exe"), "tampered");
  return d;
}

describe("build-trial-base.sh with HCU (TIF-734)", () => {
  const hcuEnv = (opts: Opts = {}, tamper = false) => ({
    ...install({ ...opts, hcu: opts.hcu ?? {} }),
    MYCO_TRIAL_BASE_NAME: "trial-base-v4",
    MYCO_TRIAL_BASE_HCU_DIR: hcuDir(tamper),
    ...testFlag(),
  });

  it("without MYCO_TRIAL_BASE_HCU_DIR nothing HCU runs or is copied", {
    timeout: SLOW,
  }, async () => {
    const r = await run(install());
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => /myco-hcu|computer-use|hcu-staging/.test(c))).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("ssh "))).toEqual([]);
  });

  it("installs in the maintenance window, proves HCU on the cold boot in place with egress denied, then snapshots", {
    timeout: SLOW,
  }, async () => {
    const r = await run(hcuEnv());
    expect(r.status).toBe(0);
    const install_ = at(r.calls, "myco-hcu.ps1 -Stage install");
    const verify = at(r.calls, "myco-hcu.ps1 -Stage verify");
    const mcp = at(r.calls, "mcp --attach");
    // Install: after the Defender check, before the tidy-up shutdown and the deny.
    expect(install_).toBeGreaterThan(at(r.calls, "-Stage check"));
    expect(install_).toBeLessThan(at(r.calls, "egress deny"));
    // Verify and the MCP probe: after deny, the boot in place and the denied probe; before the snapshot.
    expect(verify).toBeGreaterThan(at(r.calls, "egress probe"));
    expect(mcp).toBeGreaterThan(verify);
    expect(mcp).toBeLessThan(at(r.calls, "vm.sh snapshot trial-base-v4"));
    expect(r.calls[mcp]).toContain(
      "C:\\myco\\bin\\computer-use.exe mcp --attach C:\\Users\\myco\\AppData\\Local\\Temp\\hcu--1\\desktop-default.sock",
    );
    // Exactly the pinned files and the guest script are copied in for HCU.
    const scps = r.calls.filter((c) => c.startsWith("scp ") && /hcu|myco-hcu/.test(c));
    expect(scps.join(" ")).toContain("computer-use.exe");
    expect(scps.join(" ")).toContain("computer-use-windows-provider.exe");
    expect(scps.join(" ")).toContain("SHA256SUMS");
    expect(scps.join(" ")).toContain("myco-win11:C:/myco/bin/myco-hcu.ps1");
    const probe = JSON.parse(readFileSync(join(dir, "evidence", "14c-hcu-mcp-probe.json"), "utf8"));
    expect(probe.tools).toContain("GUI");
    expect(probe.screenshot_images).toEqual([{ mimeType: "image/png", base64Length: 12 }]);
    expect(existsSync(join(dir, "evidence", "14c-hcu-mcp.raw"))).toBe(false);
    expect(existsSync(join(dir, "evidence", "10b-hcu-sha256sums.txt"))).toBe(true);
  });

  it("refuses an HCU directory that does not match its SHA256SUMS before touching the VM", {
    timeout: SLOW,
  }, async () => {
    const r = await run(hcuEnv({}, true));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not match its SHA256SUMS");
    expect(r.calls.filter((c) => c.startsWith("egress") || c.startsWith("reset"))).toEqual([]);
  });

  for (const [name, hcu, msg] of [
    ["the guest install fails", { installFails: true }, "HCU install failed"],
    ["HCU is not in an interactive session", { verifyFails: true }, "HCU verify failed"],
    ["the MCP server lists no GUI tool", { noGui: true }, "HCU MCP probe failed"],
    ["the screenshot returns no image", { noImage: true }, "HCU MCP probe failed"],
  ] as const)
    it(`${name}: no snapshot, egress denied`, { timeout: SLOW }, async () => {
      const r = await run(hcuEnv({ hcu }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(msg);
      expect(r.calls.filter((c) => c.startsWith("vm.sh snapshot "))).toEqual([]);
      expect(r.calls.filter((c) => c === "egress deny").length).toBeGreaterThan(0);
    });
});

describe("build-trial-base.sh: HCU warm-up (TIF-734, lead ruling 15:44Z)", () => {
  const env = (hcu: NonNullable<Opts["hcu"]>) => ({
    ...install({ hcu }),
    MYCO_TRIAL_BASE_NAME: "trial-base-v4",
    MYCO_TRIAL_BASE_HCU_DIR: hcuDir(),
    ...testFlag(),
  });
  const sessions = (calls: string[]) =>
    calls.filter((c) => c.startsWith("ssh ") && c.includes("mcp --attach"));

  it("a first screenshot that times out is retried; the second succeeds; every attempt is recorded", {
    timeout: SLOW,
  }, async () => {
    const r = await run(env({ shots: "fo" }));
    expect(r.status).toBe(0);
    expect(sessions(r.calls)).toHaveLength(2);
    const a1 = JSON.parse(
      readFileSync(join(dir, "evidence", "14c-hcu-mcp-probe-attempt-1.json"), "utf8"),
    );
    const a2 = JSON.parse(
      readFileSync(join(dir, "evidence", "14c-hcu-mcp-probe-attempt-2.json"), "utf8"),
    );
    expect(a1.screenshot_is_error).toBe(true);
    expect(a2.screenshot_images).toHaveLength(1);
    const boots = readFileSync(join(dir, "evidence", "boot-classes.log"), "utf8");
    expect(boots).toContain("step 5b: HCU MCP probe attempt 1 of 3: failed");
    expect(boots).toContain("step 5b: HCU MCP probe attempt 2 of 3: ok");
    expect(at(r.calls, "vm.sh snapshot trial-base-v4")).toBeGreaterThan(-1);
  });

  it("at most 3 attempts; three failed screenshots mean no snapshot", {
    timeout: SLOW,
  }, async () => {
    // V3: the bound is fixed in code; an environment value asking for more is ignored.
    const r = await run({ ...env({ shots: "fffffffff" }), MYCO_HCU_PROBE_ATTEMPTS: "9" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HCU MCP probe failed on all 3 attempts");
    expect(sessions(r.calls)).toHaveLength(3);
    expect(r.calls.filter((c) => c.startsWith("vm.sh snapshot "))).toEqual([]);
  });

  it("both tools must be listed: GUI without AX is not HCU", { timeout: SLOW }, async () => {
    const r = await run(env({ noAx: true }));
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c.startsWith("vm.sh snapshot "))).toEqual([]);
  });
});

describe("build-trial-base.sh: resume from 5b (TIF-734, lead ruling 15:44Z)", () => {
  /** The evidence a build leaves when it stopped at 5b, and the resume's environment. */
  const resumeEnv = (
    opts: Opts = {},
    evidence: { marker?: boolean; coldBoot?: boolean; markMtime?: number } = {},
  ) => {
    const out = join(dir, "evidence");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "11-egress-deny.log"), "deny ok\n");
    writeFileSync(join(out, "13-egress-verify.log"), "egress closed\n");
    writeFileSync(join(out, "14-probe-denied.json"), '{"tcp_1_1_1_1_443":"SocketException"}\n');
    writeFileSync(
      join(out, "14b-hcu-verify.log"),
      evidence.marker === false
        ? "verify: daemon answers\n"
        : "verify: computer-use.exe pid 5364 session 1\nsocket=C:\\x.sock\n",
    );
    if (evidence.markMtime !== undefined)
      utimesSync(join(out, "14b-hcu-verify.log"), evidence.markMtime, evidence.markMtime);
    writeFileSync(join(out, "14c-hcu-mcp-probe.json"), '{"screenshot_is_error":true}\n');
    writeFileSync(
      join(out, "boot-classes.log"),
      evidence.coldBoot === false
        ? "step 1 reset: cold\n"
        : "step 1 reset: cold\nstep 5 boot in place: class=cold guest_cpu_first_ssh_s=274\n",
    );
    return {
      ...install({ vmStatus: "started", ...opts, hcu: opts.hcu ?? {} }),
      MYCO_TRIAL_BASE_NAME: "trial-base-v4",
      MYCO_TRIAL_BASE_HCU_DIR: hcuDir(),
      MYCO_TRIAL_BASE_RESUME_FROM: "5b",
      ...testFlag(),
    };
  };
  const noSnapshot = (calls: string[]) =>
    expect(calls.filter((c) => c.startsWith("vm.sh snapshot "))).toEqual([]);

  it("same instance, egress denied: re-proves egress and HCU, then snapshots; no restore, no egress change, no maintenance", {
    timeout: SLOW,
  }, async () => {
    const r = await run(resumeEnv());
    expect(r.status).toBe(0);
    for (const never of [
      "reset ",
      "egress allow",
      "egress deny",
      "-Stage signatures",
      "-Stage idle",
      "-Stage install",
      "vm.sh start",
    ])
      expect(r.calls.filter((c) => c.includes(never))).toEqual([]);
    const order = [
      "egress status",
      "-Stage identity -ExpectPid 5364",
      "egress verify",
      "egress probe",
      "myco-hcu.ps1 -Stage verify",
      "mcp --attach",
      "vm.sh snapshot trial-base-v4",
    ].map((n) => at(r.calls, n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The re-proofs come after the identity check and immediately before the shutdown and snapshot.
    expect(at(r.calls, "egress verify")).toBeGreaterThan(at(r.calls, "-Stage identity"));
    expect(existsSync(join(dir, "evidence", "before-resume", "14b-hcu-verify.log"))).toBe(true);
    // #746 B1: the 5b record's time is a plain integer, with a GNU-semantics stat on PATH.
    expect(readFileSync(join(dir, "evidence", "boot-classes.log"), "utf8")).toMatch(
      /^resume from 5b: same instance \(computer-use\.exe pid 5364 alive, boot_utc 1000 < 5b record \d+\)$/m,
    );
  });

  it("pins the 5b record time exactly: the file's mtime as an integer", {
    timeout: SLOW,
  }, async () => {
    const r = await run(resumeEnv({}, { markMtime: 1_900_000_000 }));
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "evidence", "boot-classes.log"), "utf8")).toContain(
      "boot_utc 1000 < 5b record 1900000000)",
    );
  });

  it("V1: a boot time equal to the 5b record is refused (strictly earlier only)", {
    timeout: SLOW,
  }, async () => {
    const r = await run(
      resumeEnv({ hcu: { bootUtc: 1_900_000_000 } }, { markMtime: 1_900_000_000 }),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("(boot_utc 1900000000 >= 1900000000): not the same instance");
    expect(at(r.calls, "egress verify")).toBe(-1);
    noSnapshot(r.calls);
  });

  it("refuses a different guest: the marker pid is not alive in an interactive session", {
    timeout: SLOW,
  }, async () => {
    const r = await run(resumeEnv({ hcu: { identityAlive: false } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not the same guest instance");
    expect(at(r.calls, "egress verify")).toBe(-1);
    expect(at(r.calls, "mcp --attach")).toBe(-1);
    noSnapshot(r.calls);
  });

  it("refuses a rebooted guest: Windows booted after the 5b record", {
    timeout: SLOW,
  }, async () => {
    const r = await run(resumeEnv({ hcu: { bootUtc: 9_999_999_999 } }));
    expect(r.status).toBe(1);
    // The right reason: an integer comparison against the record time, not a junk value (#746 B1).
    expect(r.stderr).toMatch(
      /the guest booted after the 5b record \(boot_utc 9999999999 >= \d+\): not the same instance/,
    );
    noSnapshot(r.calls);
  });

  it("refuses with egress open, before touching the guest", { timeout: SLOW }, async () => {
    const r = await run(resumeEnv({ egressOpen: true }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("resume: egress is not denied");
    expect(at(r.calls, "-Stage identity")).toBe(-1);
    expect(r.calls.filter((c) => c.startsWith("scp "))).toEqual([]);
    noSnapshot(r.calls);
  });

  it("refuses a stopped VM (not the running instance)", { timeout: SLOW }, async () => {
    const r = await run(resumeEnv({ vmStatus: "stopped" }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("resume: the VM is not running");
    noSnapshot(r.calls);
  });

  it("refuses without the earlier run's instance marker or cold boot record", {
    timeout: SLOW,
  }, async () => {
    const a = await run(resumeEnv({}, { marker: false }));
    expect(a.status).toBe(1);
    expect(a.stderr).toContain("no instance marker");
    noSnapshot(a.calls);
    rmSync(join(dir, "evidence"), { recursive: true, force: true });
    rmSync(log, { force: true });
  });

  it("refuses without a recorded cold boot in place", { timeout: SLOW }, async () => {
    const r = await run(resumeEnv({}, { coldBoot: false }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("records no cold boot in place");
    noSnapshot(r.calls);
  });

  it("the re-proofs gate the snapshot: a failed egress verify on resume means no snapshot", {
    timeout: SLOW,
  }, async () => {
    const r = await run(resumeEnv({ egressVerifyFails: true }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("egress verify failed");
    noSnapshot(r.calls);
  });

  it("the re-proofs gate the snapshot: a reachable probe target on resume means no snapshot", {
    timeout: SLOW,
  }, async () => {
    const r = await run(resumeEnv({ probeReachable: true }));
    expect(r.status).toBe(1);
    // The right reason: past identity, stopped by the probe (#746 B1).
    expect(r.stderr).toContain("a probe target was reachable with egress denied");
    expect(at(r.calls, "-Stage identity")).toBeGreaterThan(-1);
    noSnapshot(r.calls);
  });

  it("the HCU re-proof gates the snapshot on resume (three failed screenshots)", {
    timeout: SLOW,
  }, async () => {
    const r = await run(resumeEnv({ hcu: { shots: "fff" } }));
    expect(r.status).toBe(1);
    // The right reason: past identity and the egress re-proofs, stopped by HCU (#746 B1).
    expect(r.stderr).toContain("HCU MCP probe failed on all 3 attempts");
    expect(at(r.calls, "egress probe")).toBeGreaterThan(-1);
    noSnapshot(r.calls);
  });

  it("accepts only 5b as a resume point", { timeout: SLOW }, async () => {
    const r = await run({ ...resumeEnv(), MYCO_TRIAL_BASE_RESUME_FROM: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("accepts only 5b");
    noSnapshot(r.calls);
  });
});

describe("build-trial-base.sh: #746 round 2 (pins, real images, the test flag)", () => {
  it("the 10 s spacing, 25 s wait and pins are fixed: every MYCO_TEST_ read sits inside the test-flag block", () => {
    // A live run never sets the flag, and without it the pins refuse any test fixture, so this is
    // pinned on the source: the only reads of the test overrides are inside that one block.
    const src = readFileSync(BUILD, "utf8");
    const open = 'if [ "$' + '{MYCO_BUILD_TRIAL_BASE_TEST:-}" = 1 ]; then';
    const start = src.indexOf(open);
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  fi\n", start);
    const block = src.slice(start, end);
    const outside = src.slice(0, start) + src.slice(end);
    expect(outside).not.toMatch(/MYCO_TEST_/);
    expect(block).toContain("HCU_RETRY_S=$" + "{MYCO_TEST_HCU_RETRY_S:-$HCU_RETRY_S}");
    expect(src).toMatch(/^HCU_RETRY_S=10$/m);
    expect(src).toMatch(/^HCU_PROBE_WAIT_S=25$/m);
    expect(src).toMatch(/^HCU_PROBE_ATTEMPTS=3$/m);
  });

  const hcuOn = (opts: Opts = {}): Record<string, string> => ({
    ...install({ ...opts, hcu: opts.hcu ?? {} }),
    MYCO_TRIAL_BASE_NAME: "trial-base-v4",
    MYCO_TRIAL_BASE_HCU_DIR: hcuDir(),
    ...testFlag(),
  });
  const noSnapshot = (calls: string[]) =>
    expect(calls.filter((c) => c.startsWith("vm.sh snapshot "))).toEqual([]);

  it("refuses a self-consistent HCU build that is not the pinned one, before any VM call", {
    timeout: SLOW,
  }, async () => {
    // The fixture's SHA256SUMS matches its files; without the test pins, the script's own pins apply.
    const vars: Record<string, string> = hcuOn();
    delete vars.MYCO_TEST_HCU_PIN_CU;
    delete vars.MYCO_TEST_HCU_PIN_PROVIDER;
    const r = await run(vars);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "computer-use.exe is not the pinned HCU build (368345290f6979fbd6dc0e5aaaa3c41064c976f722768de7b99a2c52f6943800)",
    );
    expect(r.calls.filter((c) => c.startsWith("egress") || c.startsWith("reset"))).toEqual([]);
  });

  it("refuses a provider that is not the pinned one", { timeout: SLOW }, async () => {
    const r = await run({ ...hcuOn(), MYCO_TEST_HCU_PIN_PROVIDER: "0".repeat(64) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("computer-use-windows-provider.exe is not the pinned HCU build");
    expect(r.calls.filter((c) => c.startsWith("egress") || c.startsWith("reset"))).toEqual([]);
  });

  it("the test flag is refused when the VM scripts are the real default path", {
    timeout: SLOW,
  }, async () => {
    const vars = hcuOn();
    const real = join(dir, "VMs", "myco-win11", "scripts");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "vm.sh"), readFileSync(join(vars.MYCO_VM_SCRIPTS ?? "", "vm.sh")), {
      mode: 0o755,
    });
    const r = await run({ ...vars, MYCO_VM_SCRIPTS: real });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MYCO_BUILD_TRIAL_BASE_TEST=1 is for the stubbed host test only");
  });

  for (const [name, imageData] of [
    ["V9: an image block with empty data", ""],
    ["image data that decodes to neither a PNG nor a JPEG", "aGVsbG8gd29ybGQ="],
  ] as const)
    it(`${name} is not a screenshot: no snapshot`, { timeout: SLOW }, async () => {
      const r = await run(hcuOn({ hcu: { imageData } }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("HCU MCP probe failed on all 3 attempts");
      noSnapshot(r.calls);
    });

  it("a JPEG screenshot counts as a real image", { timeout: SLOW }, async () => {
    const r = await run(hcuOn({ hcu: { imageData: "/9j/4AAQSkZJRgABAQ==" } }));
    expect(r.status).toBe(0);
  });
});
