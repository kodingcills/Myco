/**
 * Out-of-process plugin runner (capability track T). One child process per request, started
 * synchronously so the R5 self-test runner (synchronous by contract) can call a plugin
 * oracle directly.
 *
 * Isolation, each enforced here or in the child's flags, and each proven by
 * `test/plugins/sandbox.test.ts` / `test/plugins/sandbox-os.test.ts`:
 *  - no network, in three layers:
 *     1. an OS layer around the child (`networkIsolation()`): on Linux a fresh, empty network
 *        namespace AND a fresh PID namespace (`unshare --user --map-root-user --net --pid
 *        --fork --kill-child`, with `/bin/sh` as the namespace's init so node is not PID 1);
 *        on macOS a Seatbelt profile that denies all network and every signal except to itself
 *        (`sandbox-exec`). No OS layer, no plugin run: the call fails closed with
 *        `PLUGIN_NO_NET_ISOLATION`;
 *     2. no socket in the child at all: stdin and stdout are regular files (never pipes, which
 *        Node wraps in `net.Socket`), stderr is /dev/null, and the child hides
 *        `process.stdin/stdout/stderr` from plugin code before it loads;
 *     3. `guard.ts` denies every network-capable builtin and global;
 *  - no signals to host processes (verifier round 2, D2): the PID namespace hides every host
 *    PID (macOS: Seatbelt denies signals to any process but itself), and `guard.ts` pins `kill`, `_kill`,
 *    `_debugProcess` and the rest of the signal/binding surface of `process`;
 *  - empty environment (no secrets, no proxy settings reach a plugin);
 *  - Node permission model: reads only the SDK directory and the plugin directory; no
 *    writes, child processes, workers, addons, WASI;
 *  - bounded input (the manifest's `maxInputBytes`, under the host ceiling), wall-clock
 *    timeout (SIGKILL), V8 heap cap (`--max-old-space-size`) and a resident-memory watchdog in
 *    the child;
 *  - bounded output WHILE the child runs (verifier round 3 on #537, D3), not only after it
 *    exits: every child runs under `RLIMIT_FSIZE` (`ulimit -f`, set by `/bin/sh` in
 *    `LIMIT_WRAPPER` before the OS layer and node start), so the kernel refuses any write that
 *    would take a file past the cap plus at most one 512-byte block. The child can write only
 *    the answer file (the permission model denies every path write; `fs` is denied), so the
 *    host disk holds at most `maxOutputBytes + 1024` bytes of plugin output per call, whatever
 *    route the plugin finds to that file. Node ignores SIGXFSZ, so a write past the limit fails
 *    with EFBIG instead; the child is then stopped by its own error or the wall-clock kill, and
 *    the host reports `PLUGIN_OUTPUT_TOO_LARGE` whenever the file is over the cap. Core dumps
 *    are off (`ulimit -c 0`), so a crash writes nothing to the plugin directory either;
 *  - the plugin gets the captured bytes and a basename over stdin, never a host path of the
 *    trial.
 * Every failure is a `SandboxFault` with a `PLUGIN_*` code; callers turn it into `uncertain`.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  byteLength,
  type PluginCaps,
  type PluginRequest,
  type PluginResponse,
  parseResponse,
} from "../sdk/protocol.ts";

export const SDK_DIR = resolve(import.meta.dirname, "..", "sdk");
const GUARD = join(SDK_DIR, "guard.ts");
const CHILD = join(SDK_DIR, "child.ts");

/** Resident memory the Node runtime itself needs before the plugin allocates anything. */
export const RUNTIME_RSS_ALLOWANCE_BYTES = 128 * 1024 * 1024;

export const SANDBOX_FAULT_CODES = [
  "PLUGIN_NO_NET_ISOLATION",
  "PLUGIN_INPUT_TOO_LARGE",
  "PLUGIN_SPAWN_FAILED",
  "PLUGIN_TIMEOUT",
  "PLUGIN_OUTPUT_TOO_LARGE",
  "PLUGIN_MEMORY_EXCEEDED",
  "PLUGIN_NO_HOOK",
  "PLUGIN_THREW",
  "PLUGIN_CRASH",
  "PLUGIN_MALFORMED_OUTPUT",
] as const;
export type SandboxFaultCode = (typeof SANDBOX_FAULT_CODES)[number];

export interface SandboxFault {
  readonly ok: false;
  readonly code: SandboxFaultCode;
}
export type SandboxResult = { readonly ok: true; readonly response: PluginResponse } | SandboxFault;

const fault = (code: SandboxFaultCode): SandboxFault => ({ ok: false, code });

/** Seatbelt (macOS) profile for plugin children: everything the permission model allows, minus
 * every network operation (IP and Unix-domain sockets, inbound and outbound) and every signal
 * to any process but itself (D2: `kill`, and SIGUSR1 to open a host process's inspector).
 * `(deny signal (target others))` is not enough: macOS CI showed a same-process-group victim
 * (the host itself is in the plugin child's process group) still being killed under it. */
export const SEATBELT_PROFILE =
  "(version 1)(allow default)(deny network*)(deny signal)(allow signal (target self))";

/**
 * Linux: node must not be PID 1 of its PID namespace (the kernel drops signals PID 1 sends
 * itself, so V8's out-of-memory `abort()` would turn into a SIGSEGV and lose the memory code).
 * `/bin/sh` is the namespace's init: it runs node as PID 2 and exits with node's status
 * (128 + signal when node is killed). `--kill-child` takes the whole namespace down when the
 * host SIGKILLs `unshare` on timeout. The shell exports `PWD`; it is unset so the plugin still
 * sees an empty environment (the `env` probe in sandbox.test.ts).
 */
const LINUX_INIT = ["/bin/sh", "-c", 'unset PWD; "$@"; exit $?', "sh"] as const;

/**
 * The outermost layer of every plugin child, on both platforms (D3): `/bin/sh` sets the file
 * size limit (`ulimit -f`, in 512-byte blocks, given as `$1`) and turns core dumps off, then
 * `exec`s the OS layer with an empty environment (`env -i`: the shell may export `PWD`,
 * `SHLVL` or `_`). rlimits are inherited across `exec`, `unshare` and `sandbox-exec`, so node
 * and anything it could start run under them. If either limit cannot be set the call exits 90
 * and fails closed (`PLUGIN_SPAWN_FAILED`); detection runs the same wrapper, so a host where it
 * cannot work never runs a plugin (`PLUGIN_NO_NET_ISOLATION`).
 */
export const LIMIT_WRAPPER = [
  "/bin/sh",
  "-c",
  'ulimit -c 0 && ulimit -f "$1" || exit 90; shift; exec /usr/bin/env -i "$@"',
  "sh",
] as const;

const EXIT_LIMIT_FAILED = 90;
const FSIZE_BLOCK = 512;

/** The `ulimit -f` value for an output cap: the smallest whole number of 512-byte blocks
 * strictly larger than the cap, so an answer of exactly `maxOutput` bytes still fits and any
 * file the kernel lets reach the limit is over the cap. */
export function fsizeBlocks(maxOutput: number): number {
  return Math.floor(maxOutput / FSIZE_BLOCK) + 1;
}

/** The full command prefix for one call: the limit wrapper, then the OS layer. */
function limitedPrefix(prefix: readonly string[], maxOutput: number): string[] {
  return [...LIMIT_WRAPPER, String(fsizeBlocks(maxOutput)), ...prefix];
}

/** A child under the Linux prefix proves the PID namespace: its parent is the init, PID 1. */
const LINUX_PROBE = "process.exit(process.ppid === 1 ? 0 : 3)";

/**
 * The OS layer a plugin child runs under. `prefix` is the command line that wraps `node`: on
 * macOS it `exec`s node; on Linux the namespace init runs node and exits with its status, and
 * the host's SIGKILL on timeout takes the whole PID namespace down (`--kill-child`).
 */
export type NetworkIsolation =
  | { readonly kind: "netns" | "seatbelt"; readonly prefix: readonly string[] }
  | { readonly kind: "none" };

/** Output cap the detection probe runs under, and the limit it must then see. */
const PROBE_OUTPUT_CAP = 4096;
/**
 * Every detection probe also proves the D3 limits reach node through the whole prefix: the
 * soft and hard file-size limit is the expected byte count, and core dumps are off. Node's
 * diagnostic report gives the raw rlimit values (bytes, despite the `_blocks` name).
 */
const LIMIT_PROBE = `{const u=process.report.getReport().userLimits;const f=${fsizeBlocks(PROBE_OUTPUT_CAP) * FSIZE_BLOCK};if(u.file_size_blocks.soft!==f||u.file_size_blocks.hard!==f||u.core_file_size_blocks.soft!==0)process.exit(4)}`;

/** Whether a plugin child can run under `osPrefix` with the D3 limits in force (exported for
 * `sandbox-os.test.ts`). */
export function works(osPrefix: readonly string[], probe = "0"): boolean {
  if (!existsSync(LIMIT_WRAPPER[0]) || !existsSync("/usr/bin/env")) return false;
  if (!existsSync(osPrefix[0] ?? "")) return false;
  const [cmd, ...args] = limitedPrefix(osPrefix, PROBE_OUTPUT_CAP);
  if (cmd === undefined) return false;
  const r = spawnSync(cmd, [...args, process.execPath, "-e", `${LIMIT_PROBE};${probe}`], {
    env: {},
    stdio: "ignore",
    timeout: 10_000,
  });
  return r.error === undefined && r.status === 0 && r.signal === null;
}

/** Finds the OS network layer for this host by trying each one once. */
export function detectNetworkIsolation(
  platform: NodeJS.Platform = process.platform,
): NetworkIsolation {
  if (platform === "linux") {
    for (const cmd of ["/usr/bin/unshare", "/bin/unshare"]) {
      const prefix = [
        cmd,
        "--user",
        "--map-root-user",
        "--net",
        "--pid",
        "--fork",
        "--kill-child",
        ...LINUX_INIT,
      ];
      if (existsSync(LINUX_INIT[0]) && works(prefix, LINUX_PROBE))
        return Object.freeze({ kind: "netns", prefix: Object.freeze(prefix) });
    }
  }
  if (platform === "darwin") {
    const prefix = ["/usr/bin/sandbox-exec", "-p", SEATBELT_PROFILE];
    if (works(prefix)) return Object.freeze({ kind: "seatbelt", prefix: Object.freeze(prefix) });
  }
  return Object.freeze({ kind: "none" });
}

let detected: NetworkIsolation | undefined;
/** The OS network layer every plugin child runs under (detected once per process). */
export function networkIsolation(): NetworkIsolation {
  detected ??= detectNetworkIsolation();
  return detected;
}

export interface SandboxTarget {
  /** Absolute plugin directory (the only plugin-side path the child may read). */
  readonly dir: string;
  /** Absolute entry module inside `dir`. */
  readonly entry: string;
  readonly caps: PluginCaps;
}

export interface RunOptions {
  /** Output ceiling for this request; defaults to the manifest's `maxOutputBytes`. */
  readonly maxOutputBytes?: number;
}

export function runInSandbox(
  target: SandboxTarget,
  request: PluginRequest,
  opts: RunOptions = {},
): SandboxResult {
  let input: string;
  try {
    input = JSON.stringify(request);
  } catch {
    return fault("PLUGIN_INPUT_TOO_LARGE");
  }
  // The JSON envelope adds a little over the raw bytes (base64 is 4/3); bound the envelope.
  const inputCeiling = Math.ceil((target.caps.maxInputBytes * 4) / 3) + 64 * 1024 + 4096;
  if (byteLength(input) > inputCeiling) return fault("PLUGIN_INPUT_TOO_LARGE");

  const isolation = networkIsolation();
  if (isolation.kind === "none") return fault("PLUGIN_NO_NET_ISOLATION");

  const memoryMb = target.caps.memoryMb;
  const rssCap = memoryMb * 1024 * 1024 + RUNTIME_RSS_ALLOWANCE_BYTES;
  const maxOutput = opts.maxOutputBytes ?? target.caps.maxOutputBytes;
  // stdin and stdout are regular files in a private directory, never pipes: Node wraps a pipe
  // in `net.Socket`, whose class can open TCP and Unix-domain connections without any import.
  const io = mkdtempSync(join(tmpdir(), "myco-plugin-io-"));
  let inFd: number | undefined;
  let outFd: number | undefined;
  try {
    writeFileSync(join(io, "in.json"), input, { mode: 0o600 });
    inFd = openSync(join(io, "in.json"), "r");
    outFd = openSync(join(io, "out.json"), "w", 0o600);
    const [cmd, ...prefixArgs] = limitedPrefix(isolation.prefix, maxOutput);
    const r = spawnSync(
      cmd as string,
      [
        ...prefixArgs,
        process.execPath,
        "--permission",
        `--allow-fs-read=${SDK_DIR}`,
        `--allow-fs-read=${target.dir}`,
        `--max-old-space-size=${memoryMb}`,
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--import",
        GUARD,
        CHILD,
        target.entry,
        String(rssCap),
      ],
      {
        cwd: target.dir,
        env: {},
        stdio: [inFd, outFd, "ignore"],
        timeout: target.caps.timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
    );
    const errCode = (r.error as (Error & { code?: string }) | undefined)?.code;
    if (r.error !== undefined && errCode !== "ETIMEDOUT") return fault("PLUGIN_SPAWN_FAILED");
    // Checked before the exit status: a plugin that overflowed and then hung, crashed or ran
    // out of memory is reported as what it did to the disk.
    if (fstatSync(outFd).size > maxOutput) return fault("PLUGIN_OUTPUT_TOO_LARGE");
    if (errCode === "ETIMEDOUT") return fault("PLUGIN_TIMEOUT");
    if (r.status === EXIT_LIMIT_FAILED) return fault("PLUGIN_SPAWN_FAILED");
    // Under the Linux init, node's own signal death arrives as 128 + signal (134 SIGABRT,
    // 133 SIGTRAP); on macOS node is the direct child and the signal is reported as such.
    if (
      r.signal === "SIGABRT" ||
      r.signal === "SIGTRAP" ||
      r.status === 87 ||
      r.status === 133 ||
      r.status === 134
    )
      return fault("PLUGIN_MEMORY_EXCEEDED");
    if (r.status === 65) return fault("PLUGIN_NO_HOOK");
    if (r.status === 70) return fault("PLUGIN_THREW");
    if (r.status === 71) return fault("PLUGIN_MALFORMED_OUTPUT");
    if (r.status !== 0 || r.signal !== null) return fault("PLUGIN_CRASH");
    return parseAnswer(readFileSync(join(io, "out.json"), "utf8"), request);
  } catch {
    return fault("PLUGIN_SPAWN_FAILED");
  } finally {
    if (inFd !== undefined) closeSync(inFd);
    if (outFd !== undefined) closeSync(outFd);
    rmSync(io, { recursive: true, force: true });
  }
}

/** Plugin code has no stdout (`child.ts` hides it), so the file holds only the child's answer;
 * it is still re-parsed with the closed parser and trusted for nothing else. */
function parseAnswer(text: string, request: PluginRequest): SandboxResult {
  try {
    return { ok: true, response: parseResponse(JSON.parse(text), request.op) };
  } catch {
    return fault("PLUGIN_MALFORMED_OUTPUT");
  }
}
