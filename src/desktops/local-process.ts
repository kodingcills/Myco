/**
 * Local-process desktop backend (track U). Runs in CI today with no VM, no container
 * runtime and no network: each desktop is a fresh private directory, and a program "inside"
 * it is a child process whose working directory and HOME are that directory and whose
 * environment is the allowlist in `backend.ts`, never the host's.
 *
 * What it does NOT give, and says so (`isolation: "process"`, `enforcesNetworkOff: false`):
 * kernel isolation, a network namespace, or resource limits. A program can still read the
 * host file system and open sockets. It is the reference for the interface and for $0
 * tests, not a security boundary; the microVM backend (docs/product/linux-scale.md §4,
 * TO FILE) is. Exported runs record the isolation level, so a dataset consumer can tell.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapturedBytes,
  checkSpec,
  type DesktopBackend,
  DesktopError,
  type DesktopHandle,
  type DesktopSpec,
  ENV_ALLOWLIST,
  MAX_CAPTURE_BYTES,
  type RunRequest,
  type RunResult,
  safeRelativePath,
  sha256Hex,
} from "./backend.ts";

export const LOCAL_PROCESS_BACKEND = "local-process/1";

interface Desktop {
  readonly root: string;
  readonly realRoot: string;
  readonly home: string;
  destroyed: boolean;
}

export interface LocalProcessOptions {
  /** Directory the desktops are created under. Default: a fresh directory in os.tmpdir(). */
  readonly baseDir?: string;
  /** Capture size cap (tests lower it). */
  readonly maxCaptureBytes?: number;
}

export class LocalProcessBackend implements DesktopBackend {
  readonly kind = LOCAL_PROCESS_BACKEND;
  readonly isolation = "process" as const;
  readonly enforcesNetworkOff = false;
  readonly #baseDir: string;
  readonly #maxCapture: number;
  readonly #desktops = new Map<string, Desktop>();

  constructor(options: LocalProcessOptions = {}) {
    this.#baseDir = options.baseDir ?? mkdtempSync(join(tmpdir(), "myco-desktops-"));
    mkdirSync(this.#baseDir, { recursive: true });
    this.#maxCapture = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
  }

  async create(spec: DesktopSpec): Promise<DesktopHandle> {
    checkSpec(spec);
    const root = mkdtempSync(join(this.#baseDir, "d-"));
    const home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    for (const file of spec.seed) {
      const segments = safeRelativePath(file.path);
      if (segments.length > 1) {
        mkdirSync(join(home, ...segments.slice(0, -1)), { recursive: true });
      }
      writeFileSync(join(home, ...segments), file.bytes, { flag: "wx" });
    }
    const id = randomUUID();
    this.#desktops.set(id, { root, realRoot: realpathSync(root), home, destroyed: false });
    return { id, trialKey: spec.trialKey, backend: this.kind, isolation: this.isolation };
  }

  #desktop(handle: DesktopHandle): Desktop {
    if (handle?.backend !== this.kind) throw new DesktopError("BACKEND_MISMATCH");
    const desktop = this.#desktops.get(handle.id);
    if (desktop === undefined) throw new DesktopError("UNKNOWN_DESKTOP");
    if (desktop.destroyed) throw new DesktopError("DESKTOP_DESTROYED");
    return desktop;
  }

  async run(handle: DesktopHandle, request: RunRequest): Promise<RunResult> {
    const desktop = this.#desktop(handle);
    const [program, ...args] = request.argv;
    if (typeof program !== "string" || program.length === 0) throw new DesktopError("BAD_SPEC");
    const env: Record<string, string> = {};
    for (const name of ENV_ALLOWLIST) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    env.HOME = desktop.home;
    env.TMPDIR = join(desktop.root, "tmp");
    const started = Date.now();
    return await new Promise<RunResult>((resolveRun, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(program, args, {
          cwd: desktop.home,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
      } catch {
        reject(new DesktopError("RUN_FAILED"));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on("data", (b: Buffer) => out.push(b));
      child.stderr?.on("data", (b: Buffer) => err.push(b));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, request.timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new DesktopError("RUN_FAILED"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveRun({
          exitCode: code,
          timedOut,
          stdout: this.#scrub(desktop, Buffer.concat(out).toString("utf8")),
          stderr: this.#scrub(desktop, Buffer.concat(err).toString("utf8")),
          durationMs: Date.now() - started,
        });
      });
    });
  }

  /**
   * Replaces the desktop's host home and root (both spellings) with placeholders, so output
   * never carries a host path. The exporter's leak scan still refuses any path that slips by.
   */
  #scrub(desktop: Desktop, text: string): string {
    const realHome = join(desktop.realRoot, "home");
    let out = text;
    for (const [from, to] of [
      [realHome, "<home>"],
      [desktop.home, "<home>"],
      [desktop.realRoot, "<desktop>"],
      [desktop.root, "<desktop>"],
    ] as const) {
      out = out.split(from).join(to);
    }
    return out;
  }

  async capture(handle: DesktopHandle, path: string): Promise<CapturedBytes | null> {
    const desktop = this.#desktop(handle);
    const segments = safeRelativePath(path);
    // Walk every component with lstat: a symlink anywhere on the path is refused, not followed.
    let current = desktop.home;
    for (const segment of segments) {
      current = join(current, segment);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(current);
      } catch {
        return null;
      }
      if (stat.isSymbolicLink()) throw new DesktopError("SYMLINK_REFUSED");
    }
    let fd: number;
    try {
      fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      throw new DesktopError("SYMLINK_REFUSED");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new DesktopError("NOT_REGULAR_FILE");
      if (stat.size > this.#maxCapture) throw new DesktopError("CAPTURE_TOO_LARGE");
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const n = readSync(fd, bytes, read, stat.size - read, read);
        if (n === 0) break;
        read += n;
      }
      // A file that shrank mid-read is refused rather than captured partially.
      if (read !== stat.size) throw new DesktopError("RUN_FAILED");
      return { path: segments.join("/"), bytes, sha256: sha256Hex(bytes), size: read };
    } finally {
      closeSync(fd);
    }
  }

  async destroy(handle: DesktopHandle): Promise<void> {
    if (handle?.backend !== this.kind) throw new DesktopError("BACKEND_MISMATCH");
    const desktop = this.#desktops.get(handle.id);
    if (desktop === undefined) throw new DesktopError("UNKNOWN_DESKTOP");
    if (desktop.destroyed) return;
    desktop.destroyed = true;
    rmSync(desktop.root, { recursive: true, force: true });
  }

  /** Test hook: the host root of a live desktop (never exported). */
  rootOf(handle: DesktopHandle): string {
    return this.#desktop(handle).home;
  }
}
