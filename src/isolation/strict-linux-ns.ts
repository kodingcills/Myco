/**
 * Track L2: strict per-trial isolation on Linux (`strict-linux-ns`).
 *
 * Every trial gets its own disposable root. Inside, the trial sees only:
 *   /workspace   its own workspace (read-write bind of <root>/workspace)
 *   /evidence    its own evidence dir (READ-ONLY bind of <root>/evidence)
 *   /tmp, /home, /dev/shm   private tmpfs
 *   /usr, /bin, /lib*, /sbin, /etc/alternatives   read-only binds of the host's
 *   /etc         a minimal generated /etc (never the host's)
 *   /dev         null, zero, full, random, urandom only
 *   /proc        the proc of the command's own pid namespace
 *
 * Why the run root and other trials' roots cannot be reached (#541 round-1 D1):
 *  1. The view is built with pivot_root and the old root is detached (`umount -l`).
 *     The run root is not hidden under a mount the trial could remove: it is not in
 *     the trial's mount tree at all. Unmounting anything reveals an empty dir.
 *  2. Agent commands never run in the namespace that built the view. Each exec enters
 *     the trial, then creates a NESTED user + mount + pid namespace and maps itself
 *     to uid 1000 there. The kernel locks every mount inherited across that boundary
 *     (MNT_LOCKED / MNT_LOCK_READONLY), so they cannot be unmounted, remounted rw or
 *     revealed, and the command holds no capability in the namespace that owns them.
 *  3. no_new_privs, an empty capability set (uid 1000, not root, in its namespace),
 *     an empty environment, a nested pid namespace with its own /proc, and a network
 *     namespace with no device except a down loopback.
 * The backend does not trust its own setup: after building a trial it runs a self-check
 * AS THE AGENT and refuses the trial (fail closed, with a code) unless every property
 * holds. If the host cannot do any of this, the backend refuses to start; there is no
 * weaker fallback (see docs/product/strict-isolation.md).
 *
 * Integration: the desktop shape follows the `DesktopBackend` interface proposed in
 * #541 (src/parallel/backend.ts). That code is not merged, so nothing is imported from
 * it; the pool adapter lands with L.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const STRICT_BACKEND_ID = "strict-linux-ns";

/** Every refusal carries one of these codes. Agent-facing text is the code only. */
export type StrictIsolationCode =
  | "STRICT_NS_UNSUPPORTED_PLATFORM"
  | "STRICT_NS_TOOL_MISSING"
  | "STRICT_NS_SETUP_FAILED"
  | "STRICT_NS_SELFCHECK_FAILED"
  | "STRICT_NS_BAD_ROOT"
  | "STRICT_NS_BAD_SPEC"
  | "STRICT_NS_HIDE_OVERLAP"
  | "STRICT_NS_DISPLAY_UNSUPPORTED"
  | "STRICT_NS_TRIAL_MISMATCH"
  | "STRICT_NS_DESTROYED"
  | "STRICT_NS_BAD_FILE";

export class StrictIsolationError extends Error {
  readonly code: StrictIsolationCode;
  /** Operator-only detail (host paths, tool stderr). Never shown to an agent. */
  readonly detail: string;
  constructor(code: StrictIsolationCode, detail = "") {
    super(code);
    this.name = "StrictIsolationError";
    this.code = code;
    this.detail = detail;
  }
}

/** The isolation a trial has, as VERIFIED by the in-trial self-check (not as hoped). */
export interface StrictIsolationReport {
  readonly backend: typeof STRICT_BACKEND_ID;
  readonly kind: "namespace";
  readonly privateRoot: true;
  readonly hostDirsHidden: true;
  readonly tmp: "mount-ns";
  readonly network: "netns";
  readonly processes: "pid-ns";
  readonly display: { readonly kind: "none" };
  readonly mountsLocked: true;
  readonly agentUid: number;
  readonly noNewPrivs: true;
  readonly capabilities: "none";
}

export interface StrictTrialSpec {
  readonly runId: string;
  /** Empty host dir made for this trial only. Must be a real dir, not a symlink. */
  readonly root: string;
  /** Host dirs the trial must not reach (run root, other trials, vaults). Checked inside. */
  readonly hide: readonly string[];
  readonly memoryMbPerTrial: number;
  readonly cpuSecondsPerTrial: number;
  /** Only "none" today; "xvfb" is refused with a code (in-namespace Xvfb lands later). */
  readonly display: "none" | "xvfb";
  /** Extra env every exec sees (for example the pool's per-trial marker). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface StrictExecOptions {
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface StrictExecResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface StrictTrialPaths {
  readonly root: string;
  readonly workspace: string;
  readonly evidence: string;
}

export interface StrictDestroyReport {
  readonly processesGone: boolean;
  readonly rootRemoved: boolean;
  readonly detail?: string;
}

/** Host-side handle on a trial. Only the harness holds it. */
export interface TrialTarget {
  readonly holderPid: number;
  readonly nonce: string;
}

export interface StrictTrialDesktop {
  readonly runId: string;
  readonly isolation: StrictIsolationReport;
  readonly paths: StrictTrialPaths;
  /** For the harness and tests only; never handed to an agent. */
  readonly target: TrialTarget;
  exec(
    command: string,
    args: readonly string[],
    opts?: StrictExecOptions,
  ): Promise<StrictExecResult>;
  /** Kill everything and remove the root. Idempotent. Never throws. */
  destroy(): Promise<StrictDestroyReport>;
}

export interface StrictProbe {
  readonly available: boolean;
  readonly code?: StrictIsolationCode;
  readonly detail: string;
}

export const REQUIRED_TOOLS = [
  "unshare",
  "nsenter",
  "setpriv",
  "pivot_root",
  "prlimit",
  "mount",
  "umount",
] as const;
export type ToolName = (typeof REQUIRED_TOOLS)[number];

export interface StrictBackendOptions {
  /** Test seam: replace a tool with another path (for example a failing stub). */
  readonly tools?: Partial<Record<ToolName, string>>;
  /** Test seam: pretend to be another platform. */
  readonly platform?: NodeJS.Platform;
  /** Max bytes kept from each of stdout/stderr per exec. */
  readonly maxOutputBytes?: number;
}

/** The uid the agent runs as inside its nested user namespace. */
export const AGENT_UID = 1000;
/** Host dirs bound read-only into the trial when present. Nothing else of the host is. */
export const SYSTEM_DIRS = ["usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32"] as const;
const ETC_BINDS = ["/etc/alternatives"] as const;
const DEV_NODES = ["null", "zero", "full", "random", "urandom"] as const;
const SAFE_PATH = /^\/[A-Za-z0-9._/@+-]*$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETUP_EXIT = 125;
const SAFE_SEARCH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/* ------------------------------------------------------------------ host-side checks */

function resolveTool(name: ToolName, override?: string): string {
  const candidates = override
    ? [override]
    : SAFE_SEARCH_PATH.split(":").map((d) => path.join(d, name));
  for (const c of candidates) {
    try {
      const st = lstatSync(realpathSync(c));
      if (st.isFile() && (st.mode & 0o111) !== 0) return c;
    } catch {
      /* try the next one */
    }
  }
  throw new StrictIsolationError("STRICT_NS_TOOL_MISSING", `${name} not found`);
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate a spec before touching the kernel. Throws a coded error. */
export function checkSpec(spec: StrictTrialSpec): void {
  if (typeof spec.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.runId))
    throw new StrictIsolationError("STRICT_NS_BAD_SPEC", "runId");
  if (spec.display !== "none")
    throw new StrictIsolationError("STRICT_NS_DISPLAY_UNSUPPORTED", String(spec.display));
  if (!Number.isFinite(spec.memoryMbPerTrial) || spec.memoryMbPerTrial < 64)
    throw new StrictIsolationError("STRICT_NS_BAD_SPEC", "memoryMbPerTrial");
  if (!Number.isFinite(spec.cpuSecondsPerTrial) || spec.cpuSecondsPerTrial < 1)
    throw new StrictIsolationError("STRICT_NS_BAD_SPEC", "cpuSecondsPerTrial");
  for (const [k, v] of Object.entries(spec.env ?? {}))
    if (!ENV_KEY.test(k) || /[\0\n]/.test(v))
      throw new StrictIsolationError("STRICT_NS_BAD_SPEC", `env ${k}`);

  const root = spec.root;
  if (typeof root !== "string" || !path.isAbsolute(root) || !SAFE_PATH.test(root))
    throw new StrictIsolationError("STRICT_NS_BAD_ROOT", "root must be an absolute plain path");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(root);
  } catch {
    throw new StrictIsolationError("STRICT_NS_BAD_ROOT", "root missing");
  }
  // A symlinked root (or a symlink anywhere above it) could point the binds at the run root.
  if (!st.isDirectory() || realpathSync(root) !== path.resolve(root))
    throw new StrictIsolationError("STRICT_NS_BAD_ROOT", "root is not a real directory");
  if (readdirSync(root).length !== 0)
    throw new StrictIsolationError("STRICT_NS_BAD_ROOT", "root is not empty");

  // Compare REAL paths (#551 round-1 D2): a hide entry that is, or sits under, a symlink
  // into a system bind is visible at its target inside the trial. Both the lexical and the
  // real form of each system source are checked (on merged-/usr hosts /lib -> /usr/lib).
  const systemSources = systemBindSources();
  const realRoot = realPathOf(root);
  for (const h of spec.hide) {
    if (typeof h !== "string" || !path.isAbsolute(h) || !SAFE_PATH.test(h))
      throw new StrictIsolationError(
        "STRICT_NS_BAD_SPEC",
        "hide entries must be absolute plain paths",
      );
    if (!SAFE_PATH.test(realPathOf(h)))
      throw new StrictIsolationError(
        "STRICT_NS_BAD_SPEC",
        "hide entry resolves to a non-plain path",
      );
    for (const form of new Set([path.resolve(h), realPathOf(h)])) {
      // A hide dir inside the trial root could be exposed through /workspace or /evidence.
      if (within(form, realRoot))
        throw new StrictIsolationError("STRICT_NS_HIDE_OVERLAP", "hide dir inside the trial root");
      // A hide dir under a system bind would be visible read-only.
      for (const s of systemSources)
        if (within(form, s))
          throw new StrictIsolationError("STRICT_NS_HIDE_OVERLAP", `hide dir under ${s}`);
    }
  }
  for (const s of systemSources)
    if (within(realRoot, s))
      throw new StrictIsolationError("STRICT_NS_BAD_ROOT", `root under ${s}`);
}

/** Every host dir the view binds read-only, lexical and resolved. */
function systemBindSources(): string[] {
  const out = new Set<string>();
  for (const s of [...SYSTEM_DIRS.map((d) => `/${d}`), ...ETC_BINDS]) {
    out.add(s);
    out.add(realPathOf(s));
  }
  return [...out];
}

/**
 * The real path of `p`, resolving every symlink in it. A missing tail is appended to the
 * real path of its deepest existing ancestor, so a hide entry that does not exist yet is
 * still compared where it would land.
 */
export function realPathOf(p: string, depth = 0): string {
  const abs = path.resolve(p);
  if (depth > 40) throw new StrictIsolationError("STRICT_NS_BAD_SPEC", "symlink loop");
  try {
    return realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    const realParent = realPathOf(parent, depth + 1);
    // A dangling symlink: follow it by hand to where it would land.
    let link: string | undefined;
    try {
      if (lstatSync(abs).isSymbolicLink()) link = readlinkSync(abs);
    } catch {
      /* missing: append below */
    }
    if (link !== undefined) return realPathOf(path.resolve(realParent, link), depth + 1);
    return path.join(realParent, path.basename(abs));
  }
}

/** What the self-check probes for each hide entry: the entry and its real path. */
export function hideProbes(hide: readonly string[]): string[] {
  const out = new Set<string>();
  for (const h of hide) {
    out.add(path.resolve(h));
    // checkSpec refused any entry whose real path is not plain, so this is script-safe.
    out.add(realPathOf(h));
  }
  return [...out];
}

/* ------------------------------------------------------------------ in-namespace scripts */

/**
 * Runs as root of the trial's OWN user namespace (U1), in a fresh mount + pid + net
 * namespace, before any agent code exists. It builds the view, pivots into it, detaches
 * the host root, then becomes the holder: pid 1 of the trial's pid namespace, alive until
 * its stdin (a pipe from the harness) closes. While it waits, sh reaps every child
 * re-parented to it, so killed execs do not linger as zombies. Harness death closes the pipe, pid 1 exits,
 * and the kernel kills every process in the trial.
 */
export const SETUP_SCRIPT = String.raw`
set -eu
ROOT=$1; NONCE=$2
NEW="$ROOT/.nsroot"
mount --make-rprivate /
mount -t tmpfs -o mode=755,size=8m,nosuid,nodev myco-root "$NEW"
for d in ${SYSTEM_DIRS.join(" ")}; do
  if [ -L "/$d" ]; then ln -s "$(readlink "/$d")" "$NEW/$d"
  elif [ -d "/$d" ]; then
    mkdir "$NEW/$d"
    mount --bind "/$d" "$NEW/$d"
    mount -o remount,bind,ro,nosuid,nodev "$NEW/$d"
  fi
done
mkdir -p "$NEW/etc" "$NEW/workspace" "$NEW/evidence" "$NEW/tmp" "$NEW/home" "$NEW/proc" "$NEW/dev" "$NEW/.old"
printf 'root:x:0:0::/root:/bin/sh\nagent:x:${AGENT_UID}:${AGENT_UID}::/home:/bin/sh\nnobody:x:65534:65534::/nonexistent:/bin/false\n' > "$NEW/etc/passwd"
printf 'root:x:0:\nagent:x:${AGENT_UID}:\nnogroup:x:65534:\n' > "$NEW/etc/group"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$NEW/etc/hosts"
printf 'passwd: files\ngroup: files\nhosts: files\n' > "$NEW/etc/nsswitch.conf"
if [ -f /etc/ld.so.cache ]; then cat /etc/ld.so.cache > "$NEW/etc/ld.so.cache"; fi
for e in ${ETC_BINDS.join(" ")}; do
  if [ -d "$e" ] && [ ! -L "$e" ]; then
    mkdir -p "$NEW$e"
    mount --bind "$e" "$NEW$e"
    mount -o remount,bind,ro,nosuid,nodev "$NEW$e"
  fi
done
mount --bind "$ROOT/workspace" "$NEW/workspace"
mount -o remount,bind,nosuid,nodev "$NEW/workspace"
mount --bind "$ROOT/evidence" "$NEW/evidence"
mount -o remount,bind,ro,nosuid,nodev "$NEW/evidence"
mount -t tmpfs -o mode=1777,size=256m,nosuid,nodev myco-tmp "$NEW/tmp"
mount -t tmpfs -o mode=1777,size=256m,nosuid,nodev myco-home "$NEW/home"
mount -t tmpfs -o mode=755,size=1m,nosuid myco-dev "$NEW/dev"
for n in ${DEV_NODES.join(" ")}; do
  : > "$NEW/dev/$n"
  mount --bind "/dev/$n" "$NEW/dev/$n"
done
mkdir "$NEW/dev/shm"
mount -t tmpfs -o mode=1777,size=64m,nosuid,nodev myco-shm "$NEW/dev/shm"
ln -s /proc/self/fd "$NEW/dev/fd"
ln -s /proc/self/fd/0 "$NEW/dev/stdin"
ln -s /proc/self/fd/1 "$NEW/dev/stdout"
ln -s /proc/self/fd/2 "$NEW/dev/stderr"
mount -o remount,bind,ro,nosuid "$NEW/dev"
mount -t proc -o nosuid,nodev,noexec proc "$NEW/proc"
printf '%s\n' "$NONCE" > "$NEW/.myco-trial"
mount -o remount,bind,ro,nosuid,nodev "$NEW"
cd "$NEW"
pivot_root . .old
cd /
umount -l /.old
echo MYCO-READY
exec 3<&0 0</dev/null
cat >/dev/null <&3 &
exec 3<&-
wait $!
`;

/**
 * Runs per exec: enters the trial's namespaces (as U1 root; nsenter forks into the trial's
 * pid ns), checks it reached the RIGHT trial, signals the harness
 * on fd 3, closes fd 3, then drops into a nested user + mount + pid namespace as uid
 * 1000 with no_new_privs and rlimits, and an empty environment.
 */
export const EXEC_SCRIPT = String.raw`
n=$(cat /.myco-trial 2>/dev/null) || exit ${SETUP_EXIT}
[ "$n" = "$1" ] || exit ${SETUP_EXIT}
AS=$2; CPU=$3; shift 3
cd /workspace || exit ${SETUP_EXIT}
printf 'MYCO-ENTERED\n' >&3 || exit ${SETUP_EXIT}
exec 3>&-
exec setpriv --no-new-privs -- unshare --user --mount --pid --fork --kill-child --mount-proc --map-user=${AGENT_UID} --map-group=${AGENT_UID} -- prlimit --as="$AS" --cpu="$CPU" -- env -i "$@"
`;

/** Printed by the self-check, run AS THE AGENT. One `key=value` per line. */
export function selfCheckScript(hide: readonly string[], hostRoot: string): string {
  const probes = [...hide, hostRoot]
    .map((p, i) => `if [ -e '${p}' ] || [ -L '${p}' ]; then echo "visible${i}=1"; fi`)
    .join("\n");
  return String.raw`
echo "uid=$(id -u)"
grep -E '^(CapInh|CapPrm|CapEff|CapAmb|NoNewPrivs):' /proc/self/status | tr -d '\t ' | tr ':' '='
echo "nsroot=$(cat /.myco-trial)"
while read -r _id _p _dev _r mp opts _rest; do echo "mount=$mp $opts"; done < /proc/self/mountinfo
tail -n +3 /proc/net/dev | while read -r ifc _rest; do echo "netdev=$ifc"; done
echo "pid=$$"
if touch /myco-selfcheck 2>/dev/null; then echo rootwritable=1; fi
${probes}
echo end=1
`;
}

export interface SelfCheckExpectation {
  readonly nonce: string;
  readonly hideCount: number;
}

const ALLOWED_MOUNTS = new Set([
  "/",
  ...SYSTEM_DIRS.map((d) => `/${d}`),
  ...ETC_BINDS,
  "/workspace",
  "/evidence",
  "/tmp",
  "/home",
  "/dev",
  ...DEV_NODES.map((n) => `/dev/${n}`),
  "/dev/shm",
  "/proc",
]);
const MUST_BE_RO = new Set(["/", ...SYSTEM_DIRS.map((d) => `/${d}`), ...ETC_BINDS, "/evidence"]);

/** Turn self-check output into failures; empty means every strict property holds. */
export function evaluateSelfCheck(output: string, want: SelfCheckExpectation): string[] {
  const lines = output.split("\n").filter((l) => l.includes("="));
  const kv = new Map<string, string>();
  const mounts: string[] = [];
  const netdevs: string[] = [];
  for (const l of lines) {
    const i = l.indexOf("=");
    const k = l.slice(0, i);
    const v = l.slice(i + 1);
    if (k === "mount") mounts.push(v);
    else if (k === "netdev") netdevs.push(v);
    else kv.set(k, v);
  }
  const out: string[] = [];
  if (kv.get("end") !== "1") out.push("self-check did not finish");
  if (kv.get("uid") !== String(AGENT_UID)) out.push(`agent uid ${kv.get("uid")}`);
  for (const c of ["CapInh", "CapPrm", "CapEff", "CapAmb"])
    if (!/^0+$/.test(kv.get(c) ?? "")) out.push(`${c} not empty`);
  if (kv.get("NoNewPrivs") !== "1") out.push("no_new_privs not set");
  if (kv.get("nsroot") !== want.nonce) out.push("wrong trial root");
  if (kv.get("rootwritable") === "1") out.push("root is writable");
  if (!/^[0-9]+$/.test(kv.get("pid") ?? "") || Number(kv.get("pid")) > 64)
    out.push("not in a fresh pid namespace");
  if (mounts.length === 0) out.push("no mounts listed");
  const seen = new Set<string>();
  for (const m of mounts) {
    const [mp = "", opts = ""] = m.split(" ");
    seen.add(mp);
    if (!ALLOWED_MOUNTS.has(mp)) out.push(`unexpected mount ${mp}`);
    if (MUST_BE_RO.has(mp) && !opts.split(",").includes("ro")) out.push(`${mp} is not read-only`);
  }
  for (const need of ["/", "/workspace", "/evidence", "/tmp", "/proc"])
    if (!seen.has(need)) out.push(`missing mount ${need}`);
  for (const d of netdevs) if (d.replace(/:$/, "") !== "lo") out.push(`network device ${d}`);
  for (let i = 0; i <= want.hideCount; i++)
    if (kv.get(`visible${i}`) === "1") out.push(`host path ${i} is visible`);
  return out;
}

/* ------------------------------------------------------------------ exec */

interface ResolvedTools {
  readonly [k: string]: string;
}

/** Run one command inside a trial. Exported so tests can aim it at the WRONG trial. */
export async function runInTrial(
  tools: ResolvedTools,
  target: TrialTarget,
  limits: { readonly memoryMb: number; readonly cpuSeconds: number },
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  opts: StrictExecOptions & { readonly maxOutputBytes?: number } = {},
): Promise<StrictExecResult> {
  if (typeof command !== "string" || command.length === 0 || command.includes("="))
    throw new StrictIsolationError("STRICT_NS_BAD_SPEC", "command");
  const assigns: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY.test(k) || /[\0\n]/.test(v))
      throw new StrictIsolationError("STRICT_NS_BAD_SPEC", `env ${k}`);
    assigns.push(`${k}=${v}`);
  }
  const argv = [
    "-t",
    String(target.holderPid),
    "--user",
    "--mount",
    "--net",
    "--pid",
    "--preserve-credentials",
    "--",
    "/bin/sh",
    "-c",
    EXEC_SCRIPT,
    "myco-exec",
    target.nonce,
    String(Math.floor(limits.memoryMb) * 1024 * 1024),
    String(Math.floor(limits.cpuSeconds)),
    ...assigns,
    command,
    ...args,
  ];
  const max = opts.maxOutputBytes ?? 8 * 1024 * 1024;
  return await new Promise<StrictExecResult>((resolve, reject) => {
    const child = spawn(tools.nsenter!, argv, {
      // The host environment never reaches the trial.
      env: { PATH: SAFE_SEARCH_PATH },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      cwd: "/",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outN = 0;
    let errN = 0;
    let entered = "";
    let timedOut = false;
    child.stdout!.on("data", (b: Buffer) => {
      if (outN < max) out.push(b.subarray(0, max - outN));
      outN += b.length;
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (errN < max) err.push(b.subarray(0, max - errN));
      errN += b.length;
    });
    const fd3 = child.stdio[3] as NodeJS.ReadableStream;
    fd3.on("data", (b: Buffer) => {
      entered += b.toString("utf8");
    });
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            // nsenter's forked child becomes (by exec) the nested namespace's `unshare`
            // parent; killing it makes --kill-child take the command's whole pid
            // namespace with it. nsenter then reaps it and exits; it is forced only if it
            // does not (a child orphaned into the trial would be left unreaped by pid 1).
            // Kill the nested namespace's init first so `unshare` reaps it and exits.
            const kids = childrenOf(child.pid!);
            const inits = kids.flatMap((k) => childrenOf(k));
            for (const c of inits.length > 0 ? inits : kids) killQuietly(c);
            if (kids.length === 0) child.kill("SIGKILL");
            else setTimeout(() => child.kill("SIGKILL"), 2000).unref();
          }, opts.timeoutMs)
        : undefined;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new StrictIsolationError("STRICT_NS_SETUP_FAILED", String(e)));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (!entered.startsWith("MYCO-ENTERED\n")) {
        reject(
          new StrictIsolationError(
            timedOut ? "STRICT_NS_SETUP_FAILED" : "STRICT_NS_TRIAL_MISMATCH",
            Buffer.concat(err).toString("utf8").slice(0, 2000),
          ),
        );
        return;
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    child.stdin!.on("error", () => {});
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

/* ------------------------------------------------------------------ host process helpers */

function nsInode(pid: number, ns: string): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/ns/${ns}`);
  } catch {
    return undefined;
  }
}

/** Pids on the host whose pid namespace is `pidNs` (the trial's). */
export function pidsInNamespace(pidNs: string): number[] {
  const out: number[] = [];
  for (const e of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(e)) continue;
    if (nsInode(Number(e), "pid") === pidNs) out.push(Number(e));
  }
  return out;
}

function childrenOf(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter((x) => /^[0-9]+$/.test(x))
      .map(Number);
  } catch {
    return [];
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

function parentOf(pid: number): number | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

/** Every host pid in the trial's pid ns or descended from one (nested exec namespaces). */
export function trialPids(pidNs: string): number[] {
  const all = readdirSync("/proc")
    .filter((e) => /^[0-9]+$/.test(e))
    .map(Number);
  const inNs = new Set(all.filter((p) => nsInode(p, "pid") === pidNs));
  const out = new Set(inNs);
  for (const p of all) {
    let q: number | undefined = p;
    for (let i = 0; i < 256 && q !== undefined && q > 1; i++) {
      if (inNs.has(q)) {
        out.add(p);
        break;
      }
      q = parentOf(q);
    }
  }
  return [...out];
}

/* ------------------------------------------------------------------ host-side file capture */

/**
 * Read `rel` beneath the harness-owned directory `base` (normally `paths.workspace`), from
 * the host, without following a symlink at ANY path component and without blocking on a
 * FIFO (#541 round-1 D2, #551 round-1 D1). The trial controls everything under its
 * workspace, so it can turn any sub-directory into a symlink to a sibling trial; `lstat` +
 * `O_NOFOLLOW` on the full path only guards the last component. Instead this walks one
 * component at a time from a directory fd, like `openat(dirfd, name, O_NOFOLLOW)`: each
 * step opens `/proc/self/fd/<dirfd>/<name>`, where the kernel resolves the magic link to
 * the pinned directory itself and `O_NOFOLLOW` applies to `<name>`. A symlink anywhere
 * gives ELOOP; a swap between steps cannot redirect an fd already held. `base` itself must
 * be a real directory (no symlink anywhere in it). Anything but a regular file is refused.
 */
export function readTrialFile(base: string, rel: string, maxBytes = 64 * 1024 * 1024): Buffer {
  // The walk needs Linux /proc/self/fd; the backend is Linux-only anyway.
  if (process.platform !== "linux")
    throw new StrictIsolationError("STRICT_NS_UNSUPPORTED_PLATFORM", process.platform);
  if (typeof base !== "string" || !path.isAbsolute(base))
    throw new StrictIsolationError("STRICT_NS_BAD_FILE", "base must be absolute");
  if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel) || rel.includes("\0"))
    throw new StrictIsolationError("STRICT_NS_BAD_FILE", "path must be relative");
  const parts = rel.split("/").filter((c) => c !== "" && c !== ".");
  if (parts.length === 0 || parts.includes(".."))
    throw new StrictIsolationError("STRICT_NS_BAD_FILE", "path must stay beneath the base");
  let real: string;
  try {
    real = realpathSync(base);
  } catch {
    throw new StrictIsolationError("STRICT_NS_BAD_FILE", "base missing");
  }
  if (real !== path.resolve(base))
    throw new StrictIsolationError("STRICT_NS_BAD_FILE", "base is not a real directory");

  const DIR = fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW;
  let dirFd: number;
  try {
    dirFd = openSync(real, DIR);
  } catch {
    throw new StrictIsolationError("STRICT_NS_BAD_FILE", "base open refused");
  }
  let fd: number;
  try {
    for (const name of parts.slice(0, -1)) {
      let next: number;
      try {
        next = openSync(`/proc/self/fd/${dirFd}/${name}`, DIR);
      } catch {
        throw new StrictIsolationError("STRICT_NS_BAD_FILE", "directory component refused");
      }
      closeSync(dirFd);
      dirFd = next;
    }
    try {
      fd = openSync(
        `/proc/self/fd/${dirFd}/${parts[parts.length - 1]}`,
        fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK,
      );
    } catch {
      throw new StrictIsolationError("STRICT_NS_BAD_FILE", "open refused");
    }
  } finally {
    closeSync(dirFd);
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) throw new StrictIsolationError("STRICT_NS_BAD_FILE", "not a regular file");
    if (fst.size > maxBytes) throw new StrictIsolationError("STRICT_NS_BAD_FILE", "too large");
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ backend */

export interface StrictBackend {
  readonly id: typeof STRICT_BACKEND_ID;
  probe(): Promise<StrictProbe>;
  create(spec: StrictTrialSpec): Promise<StrictTrialDesktop>;
}

export function strictLinuxNs(options: StrictBackendOptions = {}): StrictBackend {
  const platform = options.platform ?? process.platform;

  function tools(): ResolvedTools {
    if (platform !== "linux")
      throw new StrictIsolationError("STRICT_NS_UNSUPPORTED_PLATFORM", platform);
    const t: Record<string, string> = {};
    for (const n of REQUIRED_TOOLS) t[n] = resolveTool(n, options.tools?.[n]);
    return t;
  }

  async function create(spec: StrictTrialSpec): Promise<StrictTrialDesktop> {
    const t = tools();
    checkSpec(spec);
    const root = path.resolve(spec.root);
    const paths: StrictTrialPaths = {
      root,
      workspace: path.join(root, "workspace"),
      evidence: path.join(root, "evidence"),
    };
    mkdirSync(paths.workspace, { mode: 0o755 });
    mkdirSync(paths.evidence, { mode: 0o755 });
    mkdirSync(path.join(root, ".nsroot"), { mode: 0o755 });
    const nonce = randomBytes(16).toString("hex");

    const holder = spawn(
      t.unshare!,
      [
        "--user",
        "--map-root-user",
        "--mount",
        "--pid",
        "--net",
        "--fork",
        "--kill-child",
        "--",
        "/bin/sh",
        "-c",
        SETUP_SCRIPT,
        "myco-setup",
        root,
        nonce,
      ],
      {
        env: { PATH: SAFE_SEARCH_PATH },
        stdio: ["pipe", "pipe", "pipe"],
        cwd: "/",
      },
    );
    let setupOut = "";
    let setupErr = "";
    holder.stderr!.on("data", (b: Buffer) => {
      if (setupErr.length < 8000) setupErr += b.toString("utf8");
    });
    const holderExit = new Promise<void>((r) => holder.once("close", () => r()));
    holder.stdin!.on("error", () => {});
    let exited = false;
    holderExit.then(() => {
      exited = true;
    });

    let holderPid: number | undefined;
    // Close the holder's stdin so pid 1 of the trial exits and its parent (`unshare`)
    // reaps it; only then force. Killing the parent first would leave an unreaped holder.
    const stopHolder = async (): Promise<void> => {
      holder.stdin!.destroy();
      if (await settles(holderExit, 2000)) return;
      if (holderPid !== undefined) killQuietly(holderPid);
      if (await settles(holderExit, 2000)) return;
      holder.kill("SIGKILL");
      await settles(holderExit, 5000);
    };

    const fail = async (code: StrictIsolationCode, detail: string): Promise<never> => {
      await stopHolder();
      rmSync(root, { recursive: true, force: true });
      throw new StrictIsolationError(code, detail);
    };

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      holder.stdout!.on("data", (b: Buffer) => {
        setupOut += b.toString("utf8");
        if (setupOut.includes("MYCO-READY\n")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      holder.once("close", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!ready || exited) return await fail("STRICT_NS_SETUP_FAILED", setupErr.slice(0, 2000));

    // The holder's pid ns is the trial's. unshare --fork: the setup sh (now `cat`) is the
    // child of the spawned unshare.
    holderPid = await findChild(holder.pid!);
    if (holderPid === undefined) return await fail("STRICT_NS_SETUP_FAILED", "no holder pid");
    const pidNs = nsInode(holderPid, "pid");
    if (!pidNs || pidNs === nsInode(process.pid, "pid"))
      return await fail("STRICT_NS_SETUP_FAILED", "holder not in its own pid ns");

    const target: TrialTarget = { holderPid, nonce };
    const limits = { memoryMb: spec.memoryMbPerTrial, cpuSeconds: spec.cpuSecondsPerTrial };
    const baseEnv: Record<string, string> = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home",
      TMPDIR: "/tmp",
      USER: "agent",
      LANG: "C.UTF-8",
      ...(spec.env ?? {}),
    };

    // Do not trust the setup: check every property AS THE AGENT before handing it out.
    // Each hide entry is probed at its lexical AND its real path (#551 round-1 D2).
    const probes = hideProbes(spec.hide);
    let check: StrictExecResult;
    try {
      check = await runInTrial(
        t,
        target,
        limits,
        "/bin/sh",
        ["-c", selfCheckScript(probes, root)],
        baseEnv,
        { timeoutMs: 15_000 },
      );
    } catch (e) {
      return await fail("STRICT_NS_SELFCHECK_FAILED", String((e as Error).message));
    }
    const failures = evaluateSelfCheck(check.stdout, { nonce, hideCount: probes.length });
    if (check.code !== 0 || failures.length > 0)
      return await fail(
        "STRICT_NS_SELFCHECK_FAILED",
        `${failures.join("; ")} ${check.stderr.slice(0, 500)}`,
      );

    const isolation: StrictIsolationReport = {
      backend: STRICT_BACKEND_ID,
      kind: "namespace",
      privateRoot: true,
      hostDirsHidden: true,
      tmp: "mount-ns",
      network: "netns",
      processes: "pid-ns",
      display: { kind: "none" },
      mountsLocked: true,
      agentUid: AGENT_UID,
      noNewPrivs: true,
      capabilities: "none",
    };

    let destroyed: StrictDestroyReport | undefined;
    return {
      runId: spec.runId,
      isolation,
      paths,
      target,
      async exec(command, args, opts = {}) {
        if (destroyed || exited) throw new StrictIsolationError("STRICT_NS_DESTROYED");
        return await runInTrial(
          t,
          target,
          limits,
          command,
          args,
          { ...baseEnv, ...(opts.env ?? {}) },
          {
            ...opts,
            maxOutputBytes: options.maxOutputBytes,
          },
        );
      },
      async destroy() {
        if (destroyed) return destroyed;
        try {
          await stopHolder();
          let left: number[] = [];
          for (let i = 0; i < 50; i++) {
            left = trialPids(pidNs);
            if (left.length === 0) break;
            await sleep(50);
          }
          const processesGone = left.length === 0;
          // Never delete while a process of the trial (and so its mounts) may live.
          if (processesGone) rmSync(root, { recursive: true, force: true });
          let rootRemoved = false;
          try {
            lstatSync(root);
          } catch {
            rootRemoved = true;
          }
          destroyed = {
            processesGone,
            rootRemoved,
            ...(processesGone ? {} : { detail: `left: ${left.join(",")}` }),
          };
        } catch (e) {
          destroyed = { processesGone: false, rootRemoved: false, detail: String(e) };
        }
        return destroyed;
      },
    };
  }

  return {
    id: STRICT_BACKEND_ID,
    /**
     * Builds and destroys a throwaway trial: the probe proves the full strict setup works
     * here (an AppArmor-restricted or seccomp'd userns passes `unshare -U` but fails this).
     */
    async probe() {
      let scratch: string | undefined;
      try {
        tools();
        scratch = mkdtempSync(path.join(realpathSync(tmpdir()), "myco-strict-probe-"));
        const root = path.join(scratch, "trial");
        mkdirSync(root);
        const d = await create({
          runId: "probe",
          root,
          hide: [path.join(scratch, "hidden")],
          memoryMbPerTrial: 256,
          cpuSecondsPerTrial: 10,
          display: "none",
        });
        const r = await d.exec("/bin/true", []);
        const gone = await d.destroy();
        if (r.code !== 0 || !gone.processesGone || !gone.rootRemoved)
          return {
            available: false,
            code: "STRICT_NS_SETUP_FAILED",
            detail: "probe trial misbehaved",
          };
        return { available: true, detail: "strict-linux-ns works on this host" };
      } catch (e) {
        if (e instanceof StrictIsolationError)
          return { available: false, code: e.code, detail: `${e.code}: ${e.detail}` };
        return { available: false, code: "STRICT_NS_SETUP_FAILED", detail: String(e) };
      } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }
    },
    create,
  };
}

async function findChild(ppid: number): Promise<number | undefined> {
  for (let i = 0; i < 100; i++) {
    const first = childrenOf(ppid)[0];
    if (first !== undefined) return first;
    await sleep(20);
  }
  return undefined;
}

async function settles(p: Promise<void>, ms: number): Promise<boolean> {
  let t: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    p.then(() => true),
    new Promise<boolean>((res) => {
      t = setTimeout(() => res(false), ms);
    }),
  ]);
  if (t) clearTimeout(t);
  return r;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
