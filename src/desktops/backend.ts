/**
 * Disposable desktop backend interface (capability track U, "Linux scale track", merged with
 * the "Lightweight agent desktops" roadmap item; design in docs/product/linux-scale.md).
 *
 * One desktop is bound to one trial. A backend creates it from a spec, runs programs inside
 * it, captures the persisted bytes a trial left behind, and destroys it. The interface is
 * the seam a microVM backend (Firecracker / Cloud Hypervisor, TO FILE: local, single-owner)
 * plugs into later; `src/desktops/local-process.ts` is the implementation CI runs today.
 *
 * Guarantees every backend must keep (pinned by test/desktops/backend.test.ts, mutation-
 * proved by scripts/desktops-mutation-proof.sh):
 *  - networking is off by default: a spec asking for anything else is refused at create;
 *  - paths a caller hands in (seed files, capture paths) are relative, normalised and stay
 *    inside the desktop; a symlink is never followed on capture;
 *  - a program inside the desktop does not inherit the host environment (no host secret,
 *    token or path reaches it through env);
 *  - a handle answers only for its own trial: once destroyed, or from another backend, every
 *    call is refused;
 *  - errors carry codes only (`DesktopError.code`), never a host path or a value.
 *
 * This module holds types and the shared guards only; it imports nothing from the gate, the
 * grader or the task generators, so a desktop cannot reach oracle internals.
 */
import { createHash } from "node:crypto";

/** The isolation a backend actually provides, recorded in every exported run's provenance. */
export type IsolationLevel = "process" | "container" | "microvm";

export const DESKTOP_ERROR_CODES = [
  "NETWORK_NOT_OFF",
  "BAD_SPEC",
  "BAD_PATH",
  "PATH_ESCAPE",
  "SYMLINK_REFUSED",
  "NOT_REGULAR_FILE",
  "CAPTURE_TOO_LARGE",
  "UNKNOWN_DESKTOP",
  "DESKTOP_DESTROYED",
  "BACKEND_MISMATCH",
  "RUN_FAILED",
] as const;
export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number];

/** A code-only error: the message is the code, so no host path or value can leak through it. */
export class DesktopError extends Error {
  readonly code: DesktopErrorCode;
  constructor(code: DesktopErrorCode) {
    super(code);
    this.name = "DesktopError";
    this.code = code;
  }
}

export interface SeedFile {
  /** Relative path inside the desktop's home, e.g. `docs/fixture.csv`. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface DesktopSpec {
  /** The trial this desktop is bound to (`<taskId>/<runId>` or any safe id). */
  readonly trialKey: string;
  /** Image id, e.g. `myco-linux-desktop/1` (docs/product/linux-scale.md §2). */
  readonly image: string;
  /** Networking. Only `off` is accepted; the field exists so the refusal is explicit. */
  readonly network: "off";
  /** Files placed in the desktop's home before the agent starts (fixture, task file). */
  readonly seed: readonly SeedFile[];
}

export interface DesktopHandle {
  readonly id: string;
  readonly trialKey: string;
  readonly backend: string;
  readonly isolation: IsolationLevel;
}

export interface RunRequest {
  /** Program and arguments. argv[0] is resolved by the backend, not through a shell. */
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** stdout with the desktop's host root replaced by `<desktop>`. */
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CapturedBytes {
  /** The relative path that was captured. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size: number;
}

/** What a microVM, container or local-process backend implements. */
export interface DesktopBackend {
  readonly kind: string;
  readonly isolation: IsolationLevel;
  /** True only when the backend itself enforces "no network" (microVM with no NIC, netns). */
  readonly enforcesNetworkOff: boolean;
  create(spec: DesktopSpec): Promise<DesktopHandle>;
  run(handle: DesktopHandle, request: RunRequest): Promise<RunResult>;
  /** The persisted bytes at `path`, or null when nothing is there (never a partial read). */
  capture(handle: DesktopHandle, path: string): Promise<CapturedBytes | null>;
  /** Idempotent. Removes everything the desktop wrote. */
  destroy(handle: DesktopHandle): Promise<void>;
}

/** Captures larger than this are refused, never truncated. */
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Validates a caller-supplied relative path and returns its segments. Refuses absolute
 * paths, backslashes, empty, `.` and `..` segments, and anything outside a conservative
 * character set, so a seed or capture can never name a file outside the desktop.
 */
export function safeRelativePath(path: unknown): string[] {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) {
    throw new DesktopError("BAD_PATH");
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new DesktopError("PATH_ESCAPE");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === ".." || segment === ".") throw new DesktopError("PATH_ESCAPE");
    if (!SAFE_SEGMENT.test(segment)) throw new DesktopError("BAD_PATH");
  }
  return segments;
}

/** Validates a spec: network off, safe trial key and image id, safe seed paths. */
export function checkSpec(spec: DesktopSpec): void {
  if (spec === null || typeof spec !== "object") throw new DesktopError("BAD_SPEC");
  if (spec.network !== "off") throw new DesktopError("NETWORK_NOT_OFF");
  if (typeof spec.trialKey !== "string" || !SAFE_ID.test(spec.trialKey)) {
    throw new DesktopError("BAD_SPEC");
  }
  if (typeof spec.image !== "string" || !SAFE_ID.test(spec.image)) {
    throw new DesktopError("BAD_SPEC");
  }
  if (!Array.isArray(spec.seed)) throw new DesktopError("BAD_SPEC");
  const seen = new Set<string>();
  for (const file of spec.seed) {
    const key = safeRelativePath(file?.path).join("/");
    if (seen.has(key) || !(file.bytes instanceof Uint8Array)) throw new DesktopError("BAD_SPEC");
    seen.add(key);
  }
}

/**
 * The only host environment variables a desktop program sees. Everything else (tokens,
 * proxies, cloud credentials, the host HOME and USER) is dropped. PATH is kept so the
 * program can find an interpreter; HOME is the desktop's own home.
 */
export const ENV_ALLOWLIST = ["PATH", "LANG", "TZ"] as const;
