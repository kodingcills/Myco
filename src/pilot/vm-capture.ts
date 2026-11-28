/**
 * The live driver's VM step (TIF-274): per trial attempt, a cold reset of the trial VM, the
 * in-guest agent deployed into the reset guest (#691: the trial snapshot holds no agent, so the
 * M1 sweep's verified deploy runs after every reset, before the channel opens), the
 * task's document seeded at a harness-fixed guest path, headless Claude Code on the operator's
 * subscription (`claudeDriver`), and, after the agent stopped, the HOST's own copy of the
 * persisted document read back from the guest over the existing SSH channel (the in-guest
 * agent's `read_file`, reached through `SshTunnel`). That copy is what `runGatedTrial` puts in
 * the sealed vault (#484: `markAgentStopped`, then `vault.capture`, then the harness's own
 * post-stop check). The agent never supplies evidence:
 *
 *  - the guest path is derived by the harness from the trial key alone (`guestTrialPaths`); the
 *    agent cannot name it, and nothing the agent writes on the host (its trial directory, its
 *    transcript, the gate's evidence root) is read by the capture;
 *  - the gate keeps its contract: `myco.gate/v1` takes taskId/runId/claim only, bound to this
 *    one trial; every mid-run call stays `uncertain` (the capture happens after the stop);
 *  - every failure of the VM step (reset, deploy, channel, seed, the pre-agent HCU check, read-back) is a `HarnessFault` with a
 *    fixed, code-only message, never an agent outcome. The read-back never substitutes bytes:
 *    an unreadable document is a fault, not an empty document.
 *
 * The reset's boot class (#546's cold-boot guard: `reset-trial-vm: boot class=<cold|fast>`) is
 * reported on the agent report as `resetBootClass`, so the corrections A/B's sticky boot-class
 * halt (#563) sees exactly what the reset measured (null when the line is missing).
 *
 * Tests never build `realVmBackend` (it refuses under vitest): they inject a fake `VmBackend`.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATE_STATE_FILE } from "../benchmark/gated-rows.ts";
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { resolveRunLiveToken } from "../integration/run-live-token.ts";
import type { CaptureInput } from "../integrity/vault.ts";
import { AgentClient, SshTunnel } from "../win/agent-client.ts";
import { type ClaudeDriverOptions, claudeDriver, type SpawnFn } from "./claude-transport.ts";
import { HCU_GUEST_COMMAND } from "./hcu-actuator.ts";
import { HCU_PROBE_TIMEOUT_MS, type HcuSpawn, openHcuSession, probeHcuDesktop } from "./hcu-ssh.ts";
import {
  type AgentReport,
  type AttemptContext,
  HarnessFault,
  type PilotDriver,
  type PilotTransport,
} from "./runner.ts";

/** The host's channel to the guest: the in-guest agent over the SSH tunnel. */
export interface GuestChannel {
  writeFile(guestPath: string, bytes: Buffer): Promise<number>;
  readFile(guestPath: string): Promise<Buffer>;
  close(): Promise<void>;
}

export type BootClass = "cold" | "fast";

export interface VmBackend {
  /** Cold-reset the trial VM; resolves with the boot class the reset printed (null: none). */
  reset(): Promise<{ readonly bootClass: BootClass | null }>;
  /**
   * Deploy the in-guest agent into the freshly reset guest (TIF-274, #691): the trial snapshot
   * holds no agent, so every reset wipes it. The real backend runs the M1 sweep's verified
   * deploy (`agent/bootstrap/deploy-to-vm.sh`: verified copy, install, scheduled task, a fresh
   * per-deploy token written to the host token file, ping check). Resolves only once that
   * deploy reported success; any failure rejects.
   */
  deploy(): Promise<void>;
  /** Open the guest channel (after a reset the old one is gone with the guest). */
  open(): Promise<GuestChannel>;
  /**
   * The pre-agent HCU check (lead ruling 13:38Z, B1): resolves only once HCU in the reset guest
   * answered over the agent's own channel (the actuator's attach command) AND produced one
   * screenshot of the interactive desktop, after at most `HCU_WARMUP_ATTEMPTS` screenshot
   * attempts (the bounded warm-up, lead ruling 15:44Z). Any other result rejects. `log` is the
   * harness log; every line written to it is a code. The real backend runs `probeHcuDesktop`
   * (`src/pilot/hcu-ssh.ts`).
   */
  probeHcu(log: (line: string) => void): Promise<void>;
}

export const DEFAULT_GUEST_ROOT = "C:\\myco\\pilot";
export const HOST_CAPTURE_FILE = "host-capture.json";
export const HOST_CAPTURE_SCHEMA = "myco.pilot.host-capture/1" as const;

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * The trial's guest directory and persisted document, from the trial key alone. Both parts are
 * checked so no value can climb out of the root (no `..`, no separators in the key).
 */
export function guestTrialPaths(
  guestRoot: string,
  trialKey: string,
): { readonly dir: string; readonly persisted: string } {
  if (
    !/^[A-Za-z]:\\(?:[A-Za-z0-9_.-]+\\)*[A-Za-z0-9_-]+$/.test(guestRoot) ||
    guestRoot.includes("..")
  )
    throw new Error(`bad guest root ${JSON.stringify(guestRoot)}: a plain absolute Windows path`);
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(trialKey))
    throw new Error(`bad trial key ${JSON.stringify(trialKey)} for a guest path`);
  const dir = `${guestRoot}\\${trialKey}`;
  return { dir, persisted: `${dir}\\${GATE_STATE_FILE}` };
}

/** The boot class from `reset-trial-vm.sh`'s stderr (the last boot line wins); null if absent. */
export function parseBootClass(stderr: string): BootClass | null {
  let found: BootClass | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const m = /^reset-trial-vm: boot class=(cold|fast) /.exec(line);
    if (m !== null) found = m[1] as BootClass;
  }
  return found;
}

/** The task's committed fixture, checked against the task's `fixtureSha256`. */
export function taskFixtureBytes(repoRoot: string, task: BenchmarkTask): Buffer {
  if (!/^fixtures\/[0-9a-f]{64}\.csv$/.test(task.fixtureFile))
    throw new Error(`${task.taskId}: unexpected fixture path ${task.fixtureFile}`);
  const bytes = readFileSync(
    join(repoRoot, "benchmark", "false-completion", task.taskSetVersion, task.fixtureFile),
  );
  if (sha256(bytes) !== task.fixtureSha256)
    throw new Error(`${task.taskId}: the fixture's sha256 is not the task's fixtureSha256`);
  return bytes;
}

export interface VmStepOptions {
  readonly backend: VmBackend;
  readonly repoRoot: string;
  readonly guestRoot?: string;
  readonly now?: () => number;
  /** The harness log (the run's log). Lines are codes, prefixed with the trial key. */
  readonly log?: (line: string) => void;
}

/** Fixed, code-only fault messages: the same failure always reads the same (repeat rule). */
export const VM_FAULT = {
  reset: "the trial VM reset failed",
  timeout: "the trial deadline passed during the VM reset",
  deploy: "the in-guest agent deploy failed after the reset",
  deployTimeout: "the trial deadline passed during the in-guest agent deploy",
  open: "the guest channel did not open after the reset",
  seed: "the task document could not be seeded in the guest",
  seedReadBack: "the seeded task document did not read back intact",
  read: "the persisted document could not be read back from the guest",
  hcu: "hcu-unreachable: HCU produced no screenshot of the interactive desktop before the agent",
  hcuTimeout: "the trial deadline passed before the HCU check",
} as const;

/** One attempt's VM step: `prepare` before the agent, `capture` after it stopped. */
export class VmTrialStep {
  private channel: GuestChannel | null = null;
  private bootClass: BootClass | null = null;
  private seededSha256: string | null = null;
  private readonly paths: { readonly dir: string; readonly persisted: string };

  constructor(
    private readonly opts: VmStepOptions,
    private readonly ctx: AttemptContext,
  ) {
    this.paths = guestTrialPaths(opts.guestRoot ?? DEFAULT_GUEST_ROOT, ctx.trialKey);
  }

  get resetBootClass(): BootClass | null {
    return this.bootClass;
  }

  async prepare(): Promise<void> {
    // A harness bug (a missing or altered fixture) is not a fault to retry: it throws plainly.
    const doc = taskFixtureBytes(this.opts.repoRoot, this.ctx.task);
    try {
      this.bootClass = (await this.opts.backend.reset()).bootClass;
    } catch (error) {
      if (error instanceof HarnessFault) throw error;
      throw new HarnessFault("spawn-failed", VM_FAULT.reset);
    }
    if (this.ctx.signal.aborted) throw new HarnessFault("timeout", VM_FAULT.timeout);
    // The reset wiped the in-guest agent (the trial snapshot holds none; TIF-274, #691), so it
    // is deployed again before the channel opens, on every attempt. A failed deploy is a fault
    // of the harness (re-run in place under the runner's rules), never an agent outcome, and
    // the channel is not opened after it.
    try {
      await this.opts.backend.deploy();
    } catch {
      throw new HarnessFault("transport-error", VM_FAULT.deploy);
    }
    if (this.ctx.signal.aborted) throw new HarnessFault("timeout", VM_FAULT.deployTimeout);
    try {
      this.channel = await this.opts.backend.open();
    } catch {
      throw new HarnessFault("transport-error", VM_FAULT.open);
    }
    let back: Buffer;
    try {
      const written = await this.channel.writeFile(this.paths.persisted, doc);
      if (written !== doc.length) throw new Error("short write");
      back = await this.channel.readFile(this.paths.persisted);
    } catch {
      await this.close();
      throw new HarnessFault("transport-error", VM_FAULT.seed);
    }
    if (sha256(back) !== sha256(doc)) {
      await this.close();
      throw new HarnessFault("transport-error", VM_FAULT.seedReadBack);
    }
    this.seededSha256 = sha256(doc);
    // The pre-agent HCU check (lead ruling 13:38Z, B1; hcu+shell's `hcu-unreachable`): after
    // reset, deploy and seed, and before the agent starts, HCU must answer on the actuator's
    // own channel and produce ONE screenshot of the interactive desktop. An unreachable HCU,
    // or one that answers but cannot screenshot the desktop (e.g. a session-0 HCU), is a
    // HARNESS fault with a fixed code-only message: the attempt is kept and re-runs in place
    // under the runner's attempt and abort rules. It is never the agent's NOT DONE, nothing is
    // counted, and the agent is never started.
    if (this.ctx.signal.aborted) {
      await this.close();
      throw new HarnessFault("timeout", VM_FAULT.hcuTimeout);
    }
    // A freshly booted guest's first screenshot can time out (VM-owner findings on #733): the
    // probe allows a bounded warm-up (3 attempts, 10 s apart, fixed), each attempt logged as a
    // code. Only all attempts failing is the fault below; the agent starts only after one
    // screenshot succeeded.
    const log = this.opts.log ?? (() => {});
    const trialKey = this.ctx.trialKey;
    try {
      await this.opts.backend.probeHcu((line) => log(`${trialKey}: ${line}`));
    } catch {
      await this.close();
      throw new HarnessFault("transport-error", VM_FAULT.hcu);
    }
  }

  /** The host's copy of the persisted document, read from the guest; never the agent's. */
  async capture(): Promise<CaptureInput> {
    const channel = this.channel;
    if (channel === null) throw new HarnessFault("transport-error", VM_FAULT.read);
    let bytes: Buffer;
    try {
      bytes = await channel.readFile(this.paths.persisted);
    } catch {
      throw new HarnessFault("transport-error", VM_FAULT.read);
    } finally {
      await this.close();
    }
    const persisted = new Uint8Array(bytes);
    const provenance = {
      schema: HOST_CAPTURE_SCHEMA,
      trialKey: this.ctx.trialKey,
      source: "host read of the guest file over the SSH tunnel (in-guest agent read_file)",
      guestPath: this.paths.persisted,
      persistedSha256: sha256(persisted),
      persistedBytes: persisted.length,
      seededSha256: this.seededSha256,
      resetBootClass: this.bootClass,
      capturedAt: new Date((this.opts.now ?? Date.now)()).toISOString(),
    };
    return {
      [`persisted/${GATE_STATE_FILE}`]: persisted,
      [HOST_CAPTURE_FILE]: new TextEncoder().encode(`${JSON.stringify(provenance)}\n`),
    };
  }

  async close(): Promise<void> {
    const c = this.channel;
    this.channel = null;
    if (c !== null) await c.close().catch(() => {});
  }
}

/**
 * The live driver: `claudeDriver` (subscription only; API-key paths refused) with the VM step
 * around it. Per attempt: reset, deploy, open, seed, the pre-agent HCU check, run the agent, then capture from the guest. The report
 * carries the reset's boot class.
 */
export function liveVmDriver(
  claude: Omit<ClaudeDriverOptions, "capture">,
  vm: VmStepOptions,
): PilotDriver {
  const steps = new Map<string, VmTrialStep>();
  const inner = claudeDriver({
    ...claude,
    capture: (ctx) => {
      const step = steps.get(ctx.trialKey);
      if (step === undefined) throw new HarnessFault("transport-error", VM_FAULT.read);
      return step.capture();
    },
  });
  return {
    simulated: false,
    transport(ctx: AttemptContext): PilotTransport {
      const step = new VmTrialStep(vm, ctx);
      steps.set(ctx.trialKey, step);
      const t = inner.transport(ctx);
      return {
        async runAgent(plan, gate) {
          try {
            await step.prepare();
            await t.runAgent(plan, gate);
          } catch (error) {
            await step.close();
            steps.delete(ctx.trialKey);
            throw error;
          }
        },
        async captureAfterStop() {
          try {
            return await t.captureAfterStop();
          } finally {
            steps.delete(ctx.trialKey);
          }
        },
        report(): AgentReport {
          const r = t.report();
          const boot = step.resetBootClass;
          return boot === null ? r : { ...r, resetBootClass: boot };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The real backend: the trial reset script and the SSH tunnel. Never built by a test.
// ---------------------------------------------------------------------------------------------

/** The M1 sweep's verified deploy, relative to the repository root (`scripts/m1-sweep.sh`). */
export const DEPLOY_SCRIPT = ["agent", "bootstrap", "deploy-to-vm.sh"] as const;
/** The line `deploy-to-vm.sh` prints only after the ping check and the host token write. */
export const DEPLOY_OK_LINE = "DEPLOY OK";
/** The deploy's bound: the M1 sweep's `alarm 400` around the same script. */
export const DEFAULT_DEPLOY_TIMEOUT_MS = 400_000;

/**
 * The ONE host token file path a trial uses: the deploy writes the fresh token there
 * (`MYCO_TOKEN_OUT`) and `open()` reads it from there (`--token-file`). A path only; the token
 * is never read here. The operator's `--token-file`, else their `MYCO_TOKEN_OUT`, else the
 * deploy's default `~/.myco-token`. Pinning `open()` to that file keeps a stale exported
 * `MYCO_AGENT_TOKEN` from winning over the token the deploy just rotated.
 */
export function agentTokenFile(
  tokenFile: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (tokenFile !== undefined) return tokenFile;
  const out = env.MYCO_TOKEN_OUT;
  return out !== undefined && out !== "" ? out : join(home, ".myco-token");
}

export interface DeployRunOptions {
  readonly repoRoot: string;
  readonly spawn: SpawnFn;
  /** Where the deploy writes the fresh token (`agentTokenFile`); passed as a path. */
  readonly tokenOut: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  /** Where the deploy's own output goes (default: the host's stderr, as the reset's). */
  readonly echo?: (chunk: Buffer) => void;
}

/**
 * Run `agent/bootstrap/deploy-to-vm.sh` once. Resolves only when it exited 0 AND printed
 * `DEPLOY OK`; a non-zero exit, a missing success line, a spawn error or the bound (killed)
 * rejects. The token never passes through here: the script writes it to `tokenOut` itself.
 */
export function runDeploy(o: DeployRunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const echo = o.echo ?? ((d: Buffer) => process.stderr.write(d));
    let child: ChildProcess;
    try {
      child = o.spawn("bash", [join(o.repoRoot, ...DEPLOY_SCRIPT)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...o.env, MYCO_TOKEN_OUT: o.tokenOut },
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timedOut = false;
    let stdout = "";
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      finish(new Error("deploy-to-vm.sh exceeded its bound and was killed"));
    }, o.timeoutMs ?? DEFAULT_DEPLOY_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      echo(d);
    });
    child.stderr?.on("data", (d: Buffer) => echo(d));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (timedOut) return;
      if (code !== 0) finish(new Error(`deploy-to-vm.sh exited ${String(code)}`));
      else if (!stdout.split(/\r?\n/).includes(DEPLOY_OK_LINE))
        finish(new Error(`deploy-to-vm.sh exited 0 without ${DEPLOY_OK_LINE}`));
      else finish(null);
    });
  });
}

export interface RealVmBackendOptions {
  readonly repoRoot: string;
  /** `--token-file PATH` for the in-guest agent's token (a path; read at point of use). */
  readonly tokenFile?: string;
  /** The per-trial deploy's bound. Default `DEFAULT_DEPLOY_TIMEOUT_MS`. */
  readonly deployTimeoutMs?: number;
  /** Inherit FD 9 (the `scripts/vm-session.sh` lock) into the reset, so it accepts the lock. */
  readonly inheritLockFd: boolean;
  readonly spawn?: SpawnFn;
  /** Guest agent ping attempts after a reset, `pingIntervalMs` apart. Default 24 x 5 s. */
  readonly pingAttempts?: number;
  readonly pingIntervalMs?: number;
}

/**
 * The real backend's pre-agent HCU check (#733 B1): the actuator's own SSH channel and command
 * (`ACTUATOR_SERVER_TEMPLATE` carries the same `HCU_GUEST_COMMAND`; pinned equal by test), so
 * the probe sees what the agent will see. Connect, initialise, the bounded screenshot warm-up,
 * all inside one bound. Exported so a test drives it through a fake `ssh`
 * (`test/pilot/hcu-ssh.test.ts`).
 */
export function realHcuProbe(
  spawn: HcuSpawn,
  home: string,
  log: (line: string) => void,
  timeoutMs: number = HCU_PROBE_TIMEOUT_MS,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  return probeHcuDesktop(() => openHcuSession(spawn, HCU_GUEST_COMMAND, home), timeoutMs, {
    log,
    ...(sleep === undefined ? {} : { sleep }),
  });
}

export function realVmBackend(opts: RealVmBackendOptions): VmBackend {
  // A test must never reach the VM (brief: fakes only). Refused, not skipped.
  if (process.env.VITEST !== undefined)
    throw new Error("realVmBackend is never built under a test runner: inject a fake VmBackend");
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const tokenOut = agentTokenFile(opts.tokenFile, process.env, homedir());
  return {
    deploy() {
      return runDeploy({
        repoRoot: opts.repoRoot,
        spawn,
        tokenOut,
        env: process.env,
        ...(opts.deployTimeoutMs === undefined ? {} : { timeoutMs: opts.deployTimeoutMs }),
      });
    },
    reset() {
      return new Promise((resolve, reject) => {
        // stdio[9] = 9 passes the session's lock descriptor through; nothing else is inherited.
        const stdio = opts.inheritLockFd
          ? ([
              "ignore",
              "inherit",
              "pipe",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              "ignore",
              9,
            ] as const)
          : (["ignore", "inherit", "pipe"] as const);
        let child: ChildProcess;
        try {
          child = spawn("bash", [join(opts.repoRoot, "scripts", "reset-trial-vm.sh")], {
            stdio: [...stdio],
            env: process.env,
          });
        } catch (error) {
          reject(error);
          return;
        }
        let stderr = "";
        child.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
          process.stderr.write(d);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`reset-trial-vm.sh exited ${String(code)}`));
          else resolve({ bootClass: parseBootClass(stderr) });
        });
      });
    },
    probeHcu: (log) => realHcuProbe(spawn, homedir(), log),
    async open() {
      // The file the deploy just wrote (`agentTokenFile`), read at the point of use.
      const token = resolveRunLiveToken(["--token-file", tokenOut], process.env, homedir());
      const tunnel = new SshTunnel();
      await tunnel.start();
      const client = AgentClient.overTunnel(tunnel, { token, timeoutMs: 60_000 });
      const attempts = opts.pingAttempts ?? 24;
      for (let i = 1; ; i++) {
        try {
          await client.ping();
          break;
        } catch (error) {
          if (i >= attempts) {
            await tunnel.stop();
            throw error;
          }
          await new Promise((r) => setTimeout(r, opts.pingIntervalMs ?? 5000));
        }
      }
      return {
        writeFile: (p, b) => client.writeFile(p, b),
        readFile: (p) => client.readFile(p),
        close: () => tunnel.stop(),
      };
    },
  };
}
