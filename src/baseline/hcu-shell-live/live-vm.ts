/**
 * TIF-268 - the LIVE trial environment for the `hcu+shell` arm on the Windows trial VM
 * (`myco-win11`), the same VM, lock and reset path as the myco-gate arm:
 *
 *  1. **Reset**: `scripts/reset-trial-vm.sh trial-base-v3` (cold, disk-only), run under the VM
 *     lock the CLI holds. Its stderr line `reset-trial-vm: boot class=<cold|fast>` (#546) is
 *     parsed and returned; the runner halts on anything but `cold`.
 *  2. **Guest agent**: `myco-agent` started in the interactive session (as the C1 sweep does),
 *     reached over the SSH tunnel.
 *  3. **Fixture**: the PUBLISHED fc-v1 fixture (`fixtures/<sha256>.csv` in the bundle), checked
 *     against the task's `fixtureSha256`, converted to `.xlsx` in the guest under
 *     `C:\myco\work\<trialKey>`, and opened in Calc.
 *  4. **GUI channel**: Microsoft HCU's `computer-use mcp` over SSH (`../hcu-shell/hcu-gui.ts`),
 *     probed once (initialise, `GUI` tool present, one screenshot); the driver precondition is
 *     ready only if that probe passed.
 *  5. **Shell**: the committed guest helper (`scripts/guest/hcu-shell.ps1`), copied into
 *     `C:\myco\harness\` and run over SSH per call (`./guest-shell.ts`). The policy reads only
 *     the document directory and the arm's scratch dir, and denies the harness dir and the
 *     verifier's conversion dir (`C:\Users\myco\AppData\Local\Temp`).
 *  6. **Judge** (internal cross-check only, never the benchmark's ground truth): the C1
 *     independent judge over the guest agent (`../c1-judge.ts`).
 *  7. **Capture**: the HARNESS reads the saved `.xlsx` bytes from the guest after the agent
 *     stopped (`AgentClient.readFile` of the path the harness itself created). The agent
 *     never names, supplies or touches this evidence.
 *
 * Every VM-touching step is a `LiveDeps` seam. `defaultLiveDeps` is the real one and is used
 * only by the CLI's `launch`, after every refusal passed; tests pass fakes and never reach it.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanupTrialGuest } from "../../integration/guest-health.ts";
import { WindowsFixtureConverter } from "../../integration/windows-fixture.ts";
import { groundTruth } from "../../tasks/intent.ts";
import { AgentClient, SshTunnel } from "../../win/agent-client.ts";
import type { Mcp } from "../c1.ts";
import { independentC1Judge } from "../c1-judge.ts";
import { connectHcuGui } from "../hcu-shell/hcu-gui.ts";
import { createShellPolicy } from "../hcu-shell/shell-tool.ts";
import type { HcuGui, PersistedDocument, PreparedHcuShell } from "../hcu-shell/trial.ts";
import type { DriverPrecondition, Observation } from "../index.ts";
import { mcpStdio } from "../mcp-stdio.ts";
import { GUEST_SHELL_SCRIPT, sshGuestShell } from "./guest-shell.ts";
import {
  type FcTask,
  type PreparedTrial,
  TASK_BUNDLE,
  TRIAL_SNAPSHOT,
  type TrialEnvironment,
} from "./runner.ts";

/** HCU's stdio MCP server in the guest. Operator-provided; see the runbook. Part of the plan. */
export const DEFAULT_HCU_GUEST_COMMAND = "C:\\myco\\bin\\computer-use.exe mcp";
export const GUEST_SHELL_SOURCE = "scripts/guest/hcu-shell.ps1";
export const WORK_ROOT = "C:\\myco\\work";
export const SCRATCH_ROOT = "C:\\myco\\scratch";
/** Where the independent verifier converts (`src/verify/uno-verifier.ts`): denied to the arm. */
export const VERIFIER_TEMP = "C:\\Users\\myco\\AppData\\Local\\Temp";
export const HARNESS_DIR = "C:\\myco\\harness";
const UNO_SOCKET = "2002";

export function guestShellSha256(repoRoot: string): string {
  return createHash("sha256")
    .update(readFileSync(join(repoRoot, GUEST_SHELL_SOURCE)))
    .digest("hex");
}

/** #546's boot class from `reset-trial-vm.sh` stderr (its last `boot class=` line); null if none. */
export function parseBootClass(stderr: string): "cold" | "fast" | null {
  const matches = [...stderr.matchAll(/^reset-trial-vm: boot class=(cold|fast)\b/gm)];
  const last = matches.at(-1)?.[1];
  return last === "cold" || last === "fast" ? last : null;
}

/** The guest-agent operations this environment uses (an `AgentClient` in a live run). */
export interface LiveAgent {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<number>;
  launch(argv: readonly string[], cwd?: string): Promise<number>;
  uiaTree(params: { pid?: number; title?: string; depth?: number }): Promise<unknown>;
}

export interface LiveDeps {
  reset(snapshot: string): Promise<{ code: number | null; stderr: string; ms: number }>;
  startAgent(): Promise<{ agent: LiveAgent; stop(): Promise<void> }>;
  /** Run one guest command over SSH. */
  guest(command: string): Promise<{ stdout: string; code: number | null }>;
  /** Start HCU's MCP server in the guest over SSH. */
  openHcu(command: string): { mcp: Mcp; close(): void };
  /** Convert the fixture CSV to `.xlsx` in the guest; returns the harness-created path. */
  convertFixture(
    agent: LiveAgent,
    csv: Buffer,
    guestDir: string,
  ): Promise<{ xlsxPath: string; cleanup(): Promise<void> }>;
  /** Open the document in Calc and wait until UNO answers; returns soffice's pid. */
  openCalc(agent: LiveAgent, xlsxPath: string, cellRef: string): Promise<number>;
  judge(
    agent: LiveAgent,
    xlsxPath: string,
    params: PreparedTrial["params"],
    pid: number,
  ): Pick<PreparedHcuShell, "judge" | "audit">;
  host(): { acPower: boolean; caffeinate: boolean; loadAvg1: number };
}

export class LiveTrialError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LiveTrialError";
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The judge target: the real cell for a satisfiable task, the B2 stand-in otherwise. */
function judgeTarget(
  task: FcTask,
  params: PreparedTrial["params"],
  csv: string,
): PreparedTrial["target"] {
  if (task.satisfiable) {
    const t = groundTruth(params);
    return { cellRef: t.cellRef, previousValue: t.previousValue, expected: t.expectedValue };
  }
  // fc-v1's invalid-target tasks name no real cell (groundTruth refuses them). The arm's own
  // judge needs one, so it watches B2; the benchmark verdict is the grader's, never this.
  const b2 = csv.split("\n")[1]?.split(",")[1] ?? "";
  return { cellRef: "B2", previousValue: b2, expected: task.intent.newValue };
}

export function liveEnvironment(
  repoRoot: string,
  deps: LiveDeps,
  hcuGuestCommand: string = DEFAULT_HCU_GUEST_COMMAND,
): TrialEnvironment {
  const shellScript = readFileSync(join(repoRoot, GUEST_SHELL_SOURCE));
  return {
    simulated: false,
    async prepare(task, trialKey) {
      const fixture = readFileSync(join(repoRoot, TASK_BUNDLE, task.fixtureFile));
      if (sha256(fixture) !== task.fixtureSha256) throw new LiveTrialError("fixture-mismatch");
      const params = {
        fixtureSeed: task.fixtureSeed,
        rowKey: task.intent.rowKey,
        column: task.intent.column,
        newValue: task.intent.newValue,
      } as PreparedTrial["params"];
      const target = judgeTarget(task, params, fixture.toString("utf8"));

      const reset = await deps.reset(TRIAL_SNAPSHOT);
      if (reset.code !== 0) throw new LiveTrialError("reset-failed");
      const bootClass = parseBootClass(reset.stderr);
      const started = await deps.startAgent();
      const releases: (() => Promise<void>)[] = [() => started.stop()];
      const release = async () => {
        for (const r of releases.reverse()) await r().catch(() => undefined);
      };
      try {
        const agent = started.agent;
        const host = deps.host();
        const workDir = `${WORK_ROOT}\\${trialKey}`;
        const scratchDir = `${SCRATCH_ROOT}\\${trialKey}`;
        await agent.writeFile(`${HARNESS_DIR}\\hcu-shell.ps1`, shellScript);
        await agent.writeFile(`${scratchDir}\\.keep`, Buffer.alloc(0));
        const converted = await deps.convertFixture(agent, fixture, workDir);
        releases.push(() => converted.cleanup());
        const xlsxPath = converted.xlsxPath;
        // Seed read-back (as #598): the harness reads the seeded document before the agent runs,
        // and records its hash in the host-capture provenance. Unreadable or empty fails closed.
        let seeded: Buffer;
        try {
          seeded = await agent.readFile(xlsxPath);
        } catch {
          throw new LiveTrialError("seed-readback-failed");
        }
        if (seeded.length === 0) throw new LiveTrialError("seed-readback-failed");
        const seededSha256 = sha256(seeded);
        const pid = await deps.openCalc(agent, xlsxPath, target.cellRef);
        const docDir = xlsxPath.replaceAll("/", "\\").replace(/\\[^\\]+$/, "");
        const shellPolicy = createShellPolicy({
          style: "windows",
          documentPath: xlsxPath,
          documentDir: docDir,
          scratchDir,
          groundTruthDirs: [VERIFIER_TEMP, HARNESS_DIR],
        });

        // Probe HCU once; the same session then serves the trial (one process per trial).
        // An unreachable HCU is a HARNESS fault with its own code (round-2 verifier D3): the
        // attempt fails before the agent or the planner runs, nothing is counted, and the
        // runner's repeat rule aborts on the second one. It never produces a row.
        let hcu: ReturnType<LiveDeps["openHcu"]> | null = null;
        let gui: HcuGui;
        try {
          hcu = deps.openHcu(hcuGuestCommand);
          releases.push(async () => hcu?.close());
          gui = await connectHcuGui(hcu.mcp);
          await gui.screenshot();
        } catch {
          throw new LiveTrialError("hcu-unreachable");
        }
        const driver: DriverPrecondition = {
          hostVersion: "hcu",
          guestVersion: "hcu",
          pipeReachable: true,
          sessionIdentityMatches: true,
        };
        const judged = deps.judge(agent, xlsxPath, params, pid);
        const prepared: PreparedHcuShell = {
          driver,
          snapshot: TRIAL_SNAPSHOT,
          resetMs: reset.ms,
          fixtureSha256: sha256(fixture),
          acPower: host.acPower,
          caffeinate: host.caffeinate,
          loadAvg1: host.loadAvg1,
          shellPolicy,
          async connectGui() {
            return gui;
          },
          shell: sshGuestShell(deps.guest, scratchDir, GUEST_SHELL_SCRIPT),
          async closeTransport() {
            hcu?.close();
            hcu = null;
          },
          judge: (): Promise<Observation> => judged.judge(),
          audit: () => judged.audit(),
          // Host-side capture by the harness, from the path the harness created.
          async capturePersisted(): Promise<PersistedDocument | null> {
            const bytes = await agent.readFile(xlsxPath);
            return bytes.length > 0 ? { format: "xlsx", bytes: new Uint8Array(bytes) } : null;
          },
        };
        return {
          prepared,
          params,
          target,
          bootClass,
          capture: { guestPath: xlsxPath, seededSha256 },
          release,
        };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The real seams. Reached only from the CLI's `launch`, after every refusal passed.
// ---------------------------------------------------------------------------------------------

const GUEST_TIMEOUT_MS = 150_000;

function run(
  command: string,
  args: readonly string[],
  timeout = GUEST_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

/** Window titles that mean a dialog is up over the document. */
const DIALOG = /keep current format|save|confirm|error/i;

/**
 * The reset's stdio: stdin ignored, stdout and stderr piped, FDs 3-8 closed, and FD 9 passed
 * through. The CLI runs under `scripts/vm-session.sh`, which holds the VM flock on FD 9; the
 * reset script accepts that lock only from a process carrying the same FD 9
 * (`vm_lock_owned_by_parent`, TIF-210). The runner itself must be started with
 * `node --import tsx` (a Node launcher such as `npx` replaces FD 9; round-2 verifier D4).
 */
export const RESET_STDIO: readonly ("ignore" | "pipe" | number)[] = [
  "ignore",
  "pipe",
  "pipe",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  "ignore",
  9,
];

/** A reset that has not exited after this long is killed and reported as failed. */
export const RESET_TIMEOUT_MS = 20 * 60_000;

/**
 * Run the reset with `RESET_STDIO` (FD 9 passed through) and a kill deadline. Exported so a
 * test proves, with a stub script under a real `exec 9>lock`, that the lock descriptor reaches
 * the reset process.
 */
export function spawnReset(
  command: string,
  args: readonly string[],
  timeoutMs: number = RESET_TIMEOUT_MS,
  echo: (d: Buffer) => void = (d) => process.stderr.write(d),
): Promise<{ code: number | null; stderr: string; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: [...RESET_STDIO] });
    } catch {
      resolve({ code: null, stderr: "", ms: 0 });
      return;
    }
    let stderr = "";
    let done = false;
    const end = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve({ code, stderr, ms: Math.round(performance.now() - t0) });
    };
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      end(null);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => echo(d));
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      echo(d);
    });
    child.on("error", () => end(null));
    child.on("close", (c) => end(c));
  });
}

export function defaultLiveDeps(repoRoot: string): LiveDeps {
  // A test must never reach the VM (as #598's `realVmBackend`): refused, not skipped.
  if (process.env.VITEST !== undefined)
    throw new Error("defaultLiveDeps is never built under a test runner: inject fake LiveDeps");
  const vmDir = join(os.homedir(), "VMs/myco-win11");
  const vssh = join(vmDir, "scripts/vssh");
  const sshArgs = ["-F", join(vmDir, "ssh_config"), "-o", "LogLevel=ERROR", "myco-win11"];
  return {
    reset(snapshot) {
      return spawnReset("bash", [join(repoRoot, "scripts/reset-trial-vm.sh"), snapshot]);
    },
    async startAgent() {
      // As the C1 sweep: start myco-agent in the interactive session, then tunnel to it.
      await run(vssh, [
        "& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\\myco\\bin\\run-interactive.ps1' -Exe 'C:\\Program Files\\LibreOffice\\program\\python.exe' -ArgList '-m myco_agent --host 127.0.0.1 --port 8765 --token-file C:\\ProgramData\\Myco\\agent.token --backend windows' -Name 'myco-agent' -WorkDir 'C:\\Program Files\\Myco\\agent'",
      ]);
      let token = "";
      for (let i = 0; i < 10 && token.length <= 20; i++) {
        await sleep(1000);
        // The guest agent's per-boot token: kept in memory, never logged or written.
        token = (await run(vssh, ["Get-Content C:\\ProgramData\\Myco\\agent.token"])).stdout.trim();
      }
      if (token.length <= 20) throw new LiveTrialError("agent-token-unavailable");
      const tunnel = new SshTunnel();
      await tunnel.start();
      const client = AgentClient.overTunnel(tunnel, { token });
      for (let i = 0; ; i++) {
        try {
          await client.ping();
          break;
        } catch {
          if (i >= 15) {
            await tunnel.stop();
            throw new LiveTrialError("agent-unreachable");
          }
          await sleep(1000);
        }
      }
      return { agent: client, stop: () => tunnel.stop() };
    },
    async guest(command) {
      const r = await run("ssh", [...sshArgs, command]);
      return { stdout: r.stdout, code: r.code };
    },
    openHcu(command) {
      const child = spawn("ssh", [...sshArgs, command], { stdio: ["pipe", "pipe", "ignore"] });
      if (child.stdin === null || child.stdout === null)
        throw new LiveTrialError("hcu-spawn-failed");
      const mcp = mcpStdio(child.stdin, child.stdout);
      return {
        mcp,
        close() {
          mcp.close();
          child.kill();
        },
      };
    },
    async convertFixture(agent, csv, guestDir) {
      const converter = new WindowsFixtureConverter({
        client: agent as AgentClient,
        guestDir,
        timeoutMs: 90_000,
      });
      await converter.convert(csv);
      const xlsxPath = converter.lastXlsxPath;
      if (!xlsxPath) throw new LiveTrialError("fixture-convert-failed");
      const tail = (p: string | null) => (p ? p.split(/[\\/]/).pop() : undefined);
      return {
        xlsxPath: xlsxPath.replaceAll("/", "\\"),
        cleanup: async () => {
          await cleanupTrialGuest({
            client: agent as AgentClient,
            runRoot: guestDir,
            runDirName: tail(converter.lastRunDir),
            profileDirName: tail(converter.lastProfileDir),
          });
        },
      };
    },
    async openCalc(agent, xlsxPath, cellRef) {
      const pid = await agent.launch([
        "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
        `--accept=socket,host=127.0.0.1,port=${UNO_SOCKET};urp;`,
        "--norestore",
        "--nologo",
        xlsxPath,
      ]);
      const client = agent as AgentClient;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        try {
          await client.unoEval({ call: "get_string", cell: cellRef, socket: UNO_SOCKET });
          return pid;
        } catch {
          await sleep(500);
        }
      }
      throw new LiveTrialError("calc-uno-timeout");
    },
    judge(agent, xlsxPath, params, pid) {
      return independentC1Judge({
        client: agent as AgentClient,
        socket: UNO_SOCKET,
        xlsxPath,
        params,
        async documentState() {
          try {
            const tree = (await agent.uiaTree({ depth: 1 })) as {
              windows?: { pid?: number; title?: string }[];
            };
            const mine = (tree.windows ?? []).filter((w) => w.pid === pid);
            if (mine.length === 0) return "closed";
            return mine.some((w) => DIALOG.test(w.title ?? "") && !/calc/i.test(w.title ?? ""))
              ? "dialog"
              : "open";
          } catch {
            return "unavailable";
          }
        },
      });
    },
    host() {
      // Recorded, not enforced (as the C1 sweep: never gate VM work on charger state).
      const batt = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" });
      const caff = spawnSync("pgrep", ["caffeinate"], { encoding: "utf8" });
      return {
        acPower: batt.status === 0 && String(batt.stdout).includes("AC Power"),
        caffeinate: caff.status === 0 && String(caff.stdout).trim().length > 0,
        loadAvg1: os.loadavg()[0] ?? 0,
      };
    },
  };
}
