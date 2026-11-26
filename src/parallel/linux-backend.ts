/**
 * Track L (safe parallelism) — the Linux disposable-desktop backend (`linux-plain`).
 *
 * This is the only Linux backend in this PR. Strict namespace isolation (`linux-ns`:
 * per-trial user/mount/net/pid namespaces) is NOT here: its round-1 form let a trial
 * unmount the "hidden" run root and write another trial's saved file, and it needs
 * privileges cloud sessions lack. It is filed as its own follow-up (see
 * docs/product/safe-parallelism.md §2).
 *
 * What `linux-plain` gives each trial, and the report says exactly this:
 *   - a private root (workspace, HOME, TMPDIR, XDG dirs) no other trial is given;
 *   - one process group per exec, killed (with its Xvfb) at destroy;
 *   - Xvfb on a display Xvfb picks itself (`-displayfd`), so trials never share one;
 *   - an env built from an allowlist (PATH, LANG) plus its own dirs: no host env var (and
 *     so no host secret) reaches a trial;
 *   - a watchdog that samples the trial's processes from /proc every 200 ms and destroys
 *     the desktop when their RSS sum exceeds `memoryMbPerTrial` or their CPU time exceeds
 *     `cpuSecondsPerTrial`.
 *
 * What it does NOT give, and the report says so (`hostDirsHidden: false`, `tmp: "env"`,
 * `network: "shared"`): the host filesystem, /tmp and network are shared, so a trial can
 * write another trial's workspace, and a process that leaves its process group (`setsid`)
 * outlives the desktop. The pool therefore never counts a `linux-plain` trial as verified
 * (`shared-host-dirs`), and strict requirements refuse it outright.
 *
 * `destroy()` kills everything it knows of, waits until no process of the trial's groups
 * remains, removes the root, and reports both facts; it never throws.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  BackendProbe,
  CapBreach,
  DesktopBackend,
  DestroyReport,
  ExecOptions,
  ExecResult,
  IsolationReport,
  TrialDesktop,
  TrialDesktopSpec,
  TrialPaths,
} from "./backend.ts";

const OUTPUT_LIMIT = 1024 * 1024;
const PAGE_BYTES = 4096;
const CLOCK_TICKS = 100;

export interface LinuxBackendOptions {
  readonly xvfb?: string;
  /** Watchdog sampling period. */
  readonly sampleMs?: number;
}

/** Env vars a trial inherits from the host. Nothing else crosses. */
export const HOST_ENV_ALLOWLIST = ["PATH", "LANG"] as const;

function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of HOST_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------------------
// /proc sampling
// ---------------------------------------------------------------------------------------

interface ProcStat {
  readonly pid: number;
  /** One-letter state; "Z" (zombie) and "X" (dead) run no code and hold no memory. */
  readonly state: string;
  readonly ppid: number;
  readonly pgid: number;
  readonly cpuTicks: number;
  readonly rssBytes: number;
}

function readStat(pid: number): ProcStat | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    // rest[0] is field 3 (state); field n is rest[n - 3].
    const ppid = Number(rest[1]);
    const pgid = Number(rest[2]);
    const cpuTicks = Number(rest[11]) + Number(rest[12]) + Number(rest[13]) + Number(rest[14]);
    const rssPages = Number(rest[21]);
    return { pid, state: rest[0] ?? "", ppid, pgid, cpuTicks, rssBytes: rssPages * PAGE_BYTES };
  } catch {
    return undefined;
  }
}

function allPids(): number[] {
  try {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------------------

function binaryWorks(bin: string, args: readonly string[]): boolean {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
  return r.error === undefined;
}

/** The isolation every `linux-plain` desktop gets: stated, never hoped. */
export const PLAIN_ISOLATION = {
  backend: "linux-plain",
  kind: "process",
  privateRoot: true,
  hostDirsHidden: false,
  tmp: "env",
  network: "shared",
  processes: "process-group",
} as const satisfies Omit<IsolationReport, "display">;

// ---------------------------------------------------------------------------------------
// the desktop
// ---------------------------------------------------------------------------------------

function makePaths(root: string): TrialPaths & { runtime: string } {
  const paths = {
    root,
    workspace: join(root, "workspace"),
    tmp: join(root, "tmp"),
    home: join(root, "home"),
    runtime: join(root, "tmp", "xdg-runtime"),
  };
  mkdirSync(paths.workspace, { recursive: true, mode: 0o700 });
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  return paths;
}

interface RunningExec {
  readonly child: ChildProcess;
}

class LinuxDesktop implements TrialDesktop {
  readonly isolation: IsolationReport;
  private readonly pgids = new Set<number>();
  private readonly cpuSeen = new Map<number, number>();
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private breached: CapBreach | undefined;
  private destroyed: DestroyReport | undefined;
  private readonly running = new Set<RunningExec>();

  constructor(
    readonly runId: string,
    readonly paths: TrialPaths,
    private readonly env: Readonly<Record<string, string>>,
    private readonly spec: TrialDesktopSpec,
    opts: Required<LinuxBackendOptions>,
    xvfb: ChildProcess | undefined,
    isolation: IsolationReport,
  ) {
    this.isolation = Object.freeze({
      ...isolation,
      display: Object.freeze({ ...isolation.display }),
    });
    if (xvfb?.pid) this.pgids.add(xvfb.pid);
    this.watchdog = setInterval(() => this.sample(), opts.sampleMs);
    this.watchdog.unref();
  }

  /**
   * The trial's live processes: members of its process groups. Zombies
   * are excluded: they run nothing and hold no memory, and an orphaned init can stay a
   * zombie until the host's reaper gets to it.
   */
  private members(): ProcStat[] {
    const out: ProcStat[] = [];
    for (const pid of allPids()) {
      const stat = readStat(pid);
      if (!stat || stat.state === "Z" || stat.state === "X") continue;
      if (this.pgids.has(stat.pgid)) out.push(stat);
    }
    return out;
  }

  private sample(): void {
    if (this.destroyed || this.breached) return;
    const members = this.members();
    let rss = 0;
    for (const m of members) {
      rss += m.rssBytes;
      this.cpuSeen.set(m.pid, Math.max(this.cpuSeen.get(m.pid) ?? 0, m.cpuTicks));
    }
    let cpuTicks = 0;
    for (const ticks of this.cpuSeen.values()) cpuTicks += ticks;
    const rssMb = rss / (1024 * 1024);
    const cpuSeconds = cpuTicks / CLOCK_TICKS;
    if (rssMb > this.spec.memoryMbPerTrial)
      this.breached = {
        cap: "memory",
        observed: Math.round(rssMb),
        limit: this.spec.memoryMbPerTrial,
      };
    else if (cpuSeconds > this.spec.cpuSecondsPerTrial)
      this.breached = {
        cap: "cpu",
        observed: Math.round(cpuSeconds),
        limit: this.spec.cpuSecondsPerTrial,
      };
    if (this.breached) this.killAll();
  }

  breach(): CapBreach | undefined {
    return this.breached;
  }

  exec(command: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.destroyed || this.breached)
      return Promise.resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "desktop is gone",
        timedOut: false,
      });
    const env = { ...this.env, ...opts.env };
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        cwd: this.paths.workspace,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const entry = { child };
      this.running.add(entry);
      if (child.pid) this.pgids.add(child.pid);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < OUTPUT_LIMIT) stderr += d.toString("utf8");
      });
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killGroup(child.pid);
          }, opts.timeoutMs)
        : undefined;
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.running.delete(entry);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ code, signal, stdout, stderr, timedOut });
      };
      child.on("error", (e) => {
        stderr += String(e.message);
        finish(null, null);
      });
      child.on("close", finish);
      // A background child of the command can hold stdout open long after the command
      // exited; the exec is over when the command is, so give the pipes a moment to drain
      // and then resolve. The background child stays a member of the trial (its process
      // group) and dies with the desktop.
      child.on("exit", (code, signal) => {
        setTimeout(() => finish(code, signal), 100).unref();
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input ?? "");
    });
  }

  private killAll(): void {
    for (const pgid of this.pgids) killGroup(pgid);
    for (const { child } of this.running) killGroup(child.pid);
  }

  async destroy(): Promise<DestroyReport> {
    if (this.destroyed) return this.destroyed;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.killAll();
    let processesGone = false;
    for (let i = 0; i < 100; i++) {
      if (this.members().length === 0 && this.running.size === 0) {
        processesGone = true;
        break;
      }
      this.killAll();
      await sleep(30);
    }
    let rootRemoved = false;
    let detail: string | undefined;
    try {
      rmSync(this.paths.root, { recursive: true, force: true });
      rootRemoved = !existsSync(this.paths.root);
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    this.destroyed = {
      processesGone,
      rootRemoved,
      ...(detail ? { detail } : {}),
    };
    return this.destroyed;
  }
}

function killGroup(pgid: number | undefined): void {
  if (!pgid) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Read the first line a child prints on `stream`, or reject after `ms`. */
function firstLine(
  child: ChildProcess,
  stream: NodeJS.ReadableStream,
  ms: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for the desktop")), ms);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      stream.removeAllListeners("data");
      fn();
    };
    stream.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) done(() => resolve(buf.slice(0, nl).trim()));
    });
    child.once("exit", (code) =>
      done(() => reject(new Error(`desktop setup exited ${String(code)}: ${buf.trim()}`))),
    );
  });
}

export function linuxBackend(options: LinuxBackendOptions = {}): DesktopBackend {
  const opts: Required<LinuxBackendOptions> = {
    xvfb: options.xvfb ?? "Xvfb",
    sampleMs: options.sampleMs ?? 200,
  };
  let xvfbFound: boolean | undefined;
  const hasXvfb = () => {
    xvfbFound ??= binaryWorks(opts.xvfb, ["-help"]);
    return xvfbFound;
  };
  const backend: DesktopBackend = {
    id: "linux-plain",
    async probe(): Promise<BackendProbe> {
      if (process.platform !== "linux")
        return { available: false, detail: "the Linux backend needs Linux (/proc)" };
      return {
        available: true,
        expected: PLAIN_ISOLATION,
        detail: `process groups and a private root only (no namespaces: other trials' roots, /tmp and the network are shared); Xvfb ${hasXvfb() ? "found" : "not found"}`,
      };
    },
    async create(spec: TrialDesktopSpec): Promise<TrialDesktop> {
      if (process.platform !== "linux") throw new Error("the Linux backend needs Linux");
      if (spec.display === "xvfb" && !hasXvfb()) throw new Error("Xvfb required but not found");
      const paths = makePaths(spec.root);
      const base: Record<string, string> = {
        ...hostEnv(),
        HOME: paths.home,
        XDG_CONFIG_HOME: join(paths.home, ".config"),
        XDG_CACHE_HOME: join(paths.home, ".cache"),
        XDG_DATA_HOME: join(paths.home, ".local", "share"),
        XDG_RUNTIME_DIR: join(paths.root, "tmp", "xdg-runtime"),
        TMPDIR: paths.tmp,
        LC_ALL: "C.UTF-8",
        ...spec.env,
      };
      mkdirSync(paths.tmp, { recursive: true, mode: 0o700 });
      let xvfb: ChildProcess | undefined;
      let display: IsolationReport["display"] = { kind: "none" };
      if (spec.display === "xvfb") {
        xvfb = spawn(
          opts.xvfb,
          ["-displayfd", "3", "-nolisten", "tcp", "-screen", "0", "1280x800x24"],
          {
            env: hostEnv(),
            detached: true,
            stdio: ["ignore", "ignore", "ignore", "pipe"],
          },
        );
        const fd3 = xvfb.stdio[3] as NodeJS.ReadableStream | null;
        if (!fd3) throw new Error("could not start Xvfb");
        try {
          const n = await firstLine(xvfb, fd3, 20_000);
          if (!/^\d+$/.test(n)) throw new Error(`Xvfb reported display ${JSON.stringify(n)}`);
          base.DISPLAY = `:${n}`;
          display = { kind: "xvfb", id: `:${n}` };
        } catch (e) {
          killGroup(xvfb.pid);
          rmSync(paths.root, { recursive: true, force: true });
          throw e;
        }
      }
      return new LinuxDesktop(spec.runId, paths, Object.freeze(base), spec, opts, xvfb, {
        ...PLAIN_ISOLATION,
        display,
      });
    },
  };
  return backend;
}
