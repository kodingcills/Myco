/**
 * The live driver's VM step (TIF-274): per trial attempt, a cold reset of the trial VM, the
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
 *  - every failure of the VM step (reset, channel, seed, read-back) is a `HarnessFault` with a
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
import type { BenchmarkTask } from "../benchmark/taskset.ts";
import { GATE_STATE_FILE } from "../benchmark/gated-rows.ts";
import { resolveRunLiveToken } from "../integration/run-live-token.ts";
import type { CaptureInput } from "../integrity/vault.ts";
import { AgentClient, SshTunnel } from "../win/agent-client.ts";
import { type ClaudeDriverOptions, claudeDriver, type SpawnFn } from "./claude-transport.ts";
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
  /** Open the guest channel (after a reset the old one is gone with the guest). */
  open(): Promise<GuestChannel>;
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
  if (!/^[A-Za-z]:\\(?:[A-Za-z0-9_.-]+\\)*[A-Za-z0-9_-]+$/.test(guestRoot) || guestRoot.includes(".."))
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
}

/** Fixed, code-only fault messages: the same failure always reads the same (repeat rule). */
export const VM_FAULT = {
  reset: "the trial VM reset failed",
  timeout: "the trial deadline passed during the VM reset",
  open: "the guest channel did not open after the reset",
  seed: "the task document could not be seeded in the guest",
  seedReadBack: "the seeded task document did not read back intact",
  read: "the persisted document could not be read back from the guest",
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
 * around it. Per attempt: reset, seed, run the agent, then capture from the guest. The report
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

export interface RealVmBackendOptions {
  readonly repoRoot: string;
  /** `--token-file PATH` for the in-guest agent's token (a path; read at point of use). */
  readonly tokenFile?: string;
  /** Inherit FD 9 (the `scripts/vm-session.sh` lock) into the reset, so it accepts the lock. */
  readonly inheritLockFd: boolean;
  readonly spawn?: SpawnFn;
  /** Guest agent ping attempts after a reset, `pingIntervalMs` apart. Default 24 x 5 s. */
  readonly pingAttempts?: number;
  readonly pingIntervalMs?: number;
}

export function realVmBackend(opts: RealVmBackendOptions): VmBackend {
  // A test must never reach the VM (brief: fakes only). Refused, not skipped.
  if (process.env.VITEST !== undefined)
    throw new Error("realVmBackend is never built under a test runner: inject a fake VmBackend");
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  return {
    reset() {
      return new Promise((resolve, reject) => {
        // stdio[9] = 9 passes the session's lock descriptor through; nothing else is inherited.
        const stdio = opts.inheritLockFd
          ? (["ignore", "inherit", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9] as const)
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
    async open() {
      const argv = opts.tokenFile === undefined ? [] : ["--token-file", opts.tokenFile];
      const token = resolveRunLiveToken(argv, process.env, homedir());
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
