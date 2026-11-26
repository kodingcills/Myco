/**
 * Track L (safe parallelism) — the Linux disposable-desktop backend.
 *
 * Two modes, chosen by `probe()` and recorded honestly in every desktop's
 * `IsolationReport` (the pool, not this file, decides whether that is enough):
 *
 * `linux-ns` (unprivileged user namespaces available):
 *   One long-lived namespace "holder" per trial: `unshare -rmnpf --mount-proc --kill-child`.
 *   Inside it, before anything of the agent runs:
 *     - a private tmpfs on /tmp (so every trial can use DISPLAY=:99 and the same /tmp
 *       names without colliding, and nothing in the host /tmp is visible);
 *     - a tmpfs over every `hide` dir (the pool root holding the other trials' roots, the
 *       vault and evidence roots), then the trial's own root bound back at its own path;
 *     - a network namespace with loopback only (no route out, no other trial's sockets;
 *       abstract unix sockets are per network namespace too);
 *     - a pid namespace: SIGKILL to its init kills every process of the trial, Xvfb and
 *       soffice included, with no orphan;
 *     - optionally Xvfb `:99 -nolisten tcp`, private to the namespace.
 *   `exec` enters the namespace with `nsenter -U -m -n -p`.
 *
 * `linux-plain` (no user namespaces, e.g. a host with AppArmor's userns restriction):
 *   A private root, HOME/TMPDIR/XDG dirs inside it, one process group per exec, Xvfb on a
 *   display Xvfb picks itself (`-displayfd`). The network and /tmp are SHARED and other
 *   trials' roots are visible: the report says so, and the pool's strict requirements
 *   refuse it.
 *
 * Both modes:
 *   - The desktop's env is built from an allowlist (PATH, LANG) plus its own dirs: no host
 *     env var (and so no host secret) reaches a trial.
 *   - A watchdog samples the trial's processes from /proc every 200 ms and destroys the
 *     desktop when their RSS sum exceeds `memoryMbPerTrial` or their CPU time exceeds
 *     `cpuSecondsPerTrial`.
 *   - `destroy()` kills everything, waits until no process of the trial remains, removes
 *     the root, and reports both facts; it never throws.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
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
/** The display every namespaced trial uses: private per network + mount namespace. */
export const NS_DISPLAY = ":99";

export interface LinuxBackendOptions {
  readonly unshare?: string;
  readonly nsenter?: string;
  readonly xvfb?: string;
  /** "auto" (default) picks ns when available; "ns" / "plain" force a mode. */
  readonly mode?: "auto" | "ns" | "plain";
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

function pidNs(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return undefined;
  }
}

function childrenOf(pid: number): number[] {
  return allPids().filter((p) => readStat(p)?.ppid === pid);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------------------

function nsWorks(unshare: string): boolean {
  if (process.platform !== "linux") return false;
  const r = spawnSync(
    unshare,
    [
      "-rmnpf",
      "--mount-proc",
      "--kill-child",
      "sh",
      "-c",
      "mount -t tmpfs tmpfs /tmp && test ! -e /proc/1/ns/net || true",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  return r.status === 0;
}

function binaryWorks(bin: string, args: readonly string[]): boolean {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
  return r.error === undefined;
}

// ---------------------------------------------------------------------------------------
// the holder script (runs as pid 1's parent inside the trial's namespaces)
// ---------------------------------------------------------------------------------------

/**
 * `$1` root, `$2` display ("xvfb" | "none"), `$3` Xvfb binary, `$4…` dirs to hide.
 * Prints READY once the namespace is set up, then becomes a sleeping init.
 */
export const HOLDER_SCRIPT = [
  "set -e",
  'root="$1"; display="$2"; xvfb="$3"; shift 3',
  'cd "$root"',
  "mount -t tmpfs -o mode=1777,size=512m tmpfs /tmp",
  'for d in "$@"; do mkdir -p "$d"; mount -t tmpfs -o mode=700,size=1m tmpfs "$d"; done',
  'mkdir -p "$root"',
  'mount --no-canonicalize --bind . "$root"',
  'if [ "$display" = xvfb ]; then',
  `  "$xvfb" ${NS_DISPLAY} -nolisten tcp -screen 0 1280x800x24 >/dev/null 2>&1 &`,
  "  i=0",
  `  while [ ! -S /tmp/.X11-unix/X${NS_DISPLAY.slice(1)} ]; do`,
  '    i=$((i+1)); if [ "$i" -gt 200 ]; then echo "NO-DISPLAY"; exit 3; fi; sleep 0.05',
  "  done",
  "fi",
  "echo READY",
  "exec sleep 2147483647",
].join("\n");

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
    private readonly opts: Required<LinuxBackendOptions>,
    private readonly ns: { holder: ChildProcess; init: number; pidNs: string } | undefined,
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
   * The trial's live processes, by pid namespace (ns) or process group (plain). Zombies
   * are excluded: they run nothing and hold no memory, and an orphaned init can stay a
   * zombie until the host's reaper gets to it.
   */
  private members(): ProcStat[] {
    const out: ProcStat[] = [];
    for (const pid of allPids()) {
      if (this.ns && pidNs(pid) !== this.ns.pidNs) continue;
      const stat = readStat(pid);
      if (!stat || stat.state === "Z" || stat.state === "X") continue;
      if (this.ns || this.pgids.has(stat.pgid)) out.push(stat);
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
    const [bin, argv] = this.ns
      ? [
          this.opts.nsenter,
          [
            "-t",
            String(this.ns.init),
            "-U",
            "-m",
            "-n",
            "-p",
            "--preserve-credentials",
            `--wd=${this.paths.workspace}`,
            "--",
            command,
            ...args,
          ],
        ]
      : [command, [...args]];
    return new Promise((resolve) => {
      const child = spawn(bin, argv, {
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
      // and then resolve. The background child stays a member of the trial (pid ns or
      // process group) and dies with the desktop.
      child.on("exit", (code, signal) => {
        setTimeout(() => finish(code, signal), 100).unref();
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input ?? "");
    });
  }

  private killAll(): void {
    if (this.ns) {
      killPid(this.ns.init);
      killPid(this.ns.holder.pid);
    }
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

function killPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
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
    unshare: options.unshare ?? "unshare",
    nsenter: options.nsenter ?? "nsenter",
    xvfb: options.xvfb ?? "Xvfb",
    mode: options.mode ?? "auto",
    sampleMs: options.sampleMs ?? 200,
  };
  let probed: { ns: boolean; xvfb: boolean } | undefined;
  const detect = () => {
    probed ??= {
      ns:
        opts.mode !== "plain" && nsWorks(opts.unshare) && binaryWorks(opts.nsenter, ["--version"]),
      xvfb: binaryWorks(opts.xvfb, ["-help"]),
    };
    return probed;
  };
  const backend: DesktopBackend = {
    get id() {
      return detect().ns ? "linux-ns" : "linux-plain";
    },
    async probe(): Promise<BackendProbe> {
      if (process.platform !== "linux")
        return { available: false, detail: "the Linux backend needs Linux (/proc, namespaces)" };
      const d = detect();
      if (opts.mode === "ns" && !d.ns)
        return { available: false, detail: "unprivileged user namespaces are not available" };
      return {
        available: true,
        expected: d.ns
          ? {
              backend: "linux-ns",
              kind: "namespace",
              privateRoot: true,
              hostDirsHidden: true,
              tmp: "mount-ns",
              network: "netns",
              processes: "pid-ns",
            }
          : {
              backend: "linux-plain",
              kind: "process",
              privateRoot: true,
              hostDirsHidden: false,
              tmp: "env",
              network: "shared",
              processes: "process-group",
            },
        detail: `${d.ns ? "namespaces" : "process groups only"}; Xvfb ${d.xvfb ? "found" : "not found"}`,
      };
    },
    async create(spec: TrialDesktopSpec): Promise<TrialDesktop> {
      const d = detect();
      if (process.platform !== "linux") throw new Error("the Linux backend needs Linux");
      if (opts.mode === "ns" && !d.ns) throw new Error("namespaces required but unavailable");
      if (spec.display === "xvfb" && !d.xvfb) throw new Error("Xvfb required but not found");
      const paths = makePaths(spec.root);
      const base: Record<string, string> = {
        ...hostEnv(),
        HOME: paths.home,
        XDG_CONFIG_HOME: join(paths.home, ".config"),
        XDG_CACHE_HOME: join(paths.home, ".cache"),
        XDG_DATA_HOME: join(paths.home, ".local", "share"),
        XDG_RUNTIME_DIR: d.ns ? "/tmp" : join(paths.root, "tmp", "xdg-runtime"),
        TMPDIR: d.ns ? "/tmp" : paths.tmp,
        LC_ALL: "C.UTF-8",
        ...spec.env,
      };
      if (d.ns) {
        const holder = spawn(
          opts.unshare,
          [
            "-rmnpf",
            "--mount-proc",
            "--kill-child",
            "sh",
            "-c",
            HOLDER_SCRIPT,
            "sh",
            paths.root,
            spec.display,
            opts.xvfb,
            ...spec.hide,
          ],
          { env: hostEnv(), stdio: ["ignore", "pipe", "pipe"] },
        );
        const stdout = holder.stdout;
        if (!stdout || !holder.pid) throw new Error("could not start the namespace holder");
        try {
          const line = await firstLine(holder, stdout, 20_000);
          if (line !== "READY") throw new Error(`desktop setup failed: ${line}`);
        } catch (e) {
          killPid(holder.pid);
          rmSync(paths.root, { recursive: true, force: true });
          throw e;
        }
        let init: number | undefined;
        for (let i = 0; i < 50 && init === undefined; i++) {
          init = childrenOf(holder.pid)[0];
          if (init === undefined) await sleep(20);
        }
        const ns = init !== undefined ? pidNs(init) : undefined;
        if (init === undefined || ns === undefined || ns === pidNs(process.pid)) {
          killPid(holder.pid);
          rmSync(paths.root, { recursive: true, force: true });
          throw new Error("could not find the trial's pid namespace");
        }
        if (spec.display === "xvfb") base.DISPLAY = NS_DISPLAY;
        return new LinuxDesktop(
          spec.runId,
          paths,
          Object.freeze(base),
          spec,
          opts,
          { holder, init, pidNs: ns },
          undefined,
          {
            backend: "linux-ns",
            kind: "namespace",
            privateRoot: true,
            hostDirsHidden: true,
            tmp: "mount-ns",
            network: "netns",
            processes: "pid-ns",
            display: spec.display === "xvfb" ? { kind: "xvfb", id: NS_DISPLAY } : { kind: "none" },
          },
        );
      }
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
      return new LinuxDesktop(spec.runId, paths, Object.freeze(base), spec, opts, undefined, xvfb, {
        backend: "linux-plain",
        kind: "process",
        privateRoot: true,
        hostDirsHidden: false,
        tmp: "env",
        network: "shared",
        processes: "process-group",
        display,
      });
    },
  };
  return backend;
}
