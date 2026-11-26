/**
 * Out-of-process plugin runner (capability track T). One child process per request, started
 * synchronously so the R5 self-test runner (synchronous by contract) can call a plugin
 * oracle directly.
 *
 * Isolation, each enforced here or in the child's flags, and each proven by
 * `test/plugins/sandbox.test.ts` / `test/plugins/sandbox-os.test.ts`:
 *  - no network, in three layers:
 *     1. an OS network layer around the child (`networkIsolation()`): a fresh, empty network
 *        namespace on Linux (`unshare --user --map-root-user --net`), a Seatbelt profile that
 *        denies all network on macOS (`sandbox-exec`). No OS layer, no plugin run: the call
 *        fails closed with `PLUGIN_NO_NET_ISOLATION`;
 *     2. no socket in the child at all: stdin and stdout are regular files (never pipes, which
 *        Node wraps in `net.Socket`), stderr is /dev/null, and the child hides
 *        `process.stdin/stdout/stderr` from plugin code before it loads;
 *     3. `guard.ts` denies every network-capable builtin and global;
 *  - empty environment (no secrets, no proxy settings reach a plugin);
 *  - Node permission model: reads only the SDK directory and the plugin directory; no
 *    writes, child processes, workers, addons, WASI;
 *  - bounded input (the manifest's `maxInputBytes`, under the host ceiling), bounded output
 *    (the answer file is refused over the cap), wall-clock timeout (SIGKILL), V8 heap cap
 *    (`--max-old-space-size`) and a resident-memory watchdog in the child;
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
 * every network operation (IP and Unix-domain sockets, inbound and outbound). */
export const SEATBELT_PROFILE = "(version 1)(allow default)(deny network*)";

/**
 * The OS network layer a plugin child runs under. `prefix` is the command line that wraps
 * `node`; it `exec`s, so the time cap and exit status apply to the plugin's own process.
 */
export type NetworkIsolation =
  | { readonly kind: "netns" | "seatbelt"; readonly prefix: readonly string[] }
  | { readonly kind: "none" };

function works(prefix: readonly string[]): boolean {
  const [cmd, ...args] = prefix;
  if (cmd === undefined || !existsSync(cmd)) return false;
  const r = spawnSync(cmd, [...args, process.execPath, "-e", "0"], {
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
      const prefix = [cmd, "--user", "--map-root-user", "--net"];
      if (works(prefix)) return Object.freeze({ kind: "netns", prefix: Object.freeze(prefix) });
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
    const r = spawnSync(
      isolation.prefix[0] as string,
      [
        ...isolation.prefix.slice(1),
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
    if (errCode === "ETIMEDOUT") return fault("PLUGIN_TIMEOUT");
    if (r.error !== undefined) return fault("PLUGIN_SPAWN_FAILED");
    if (r.signal === "SIGABRT" || r.signal === "SIGTRAP" || r.status === 87 || r.status === 134)
      return fault("PLUGIN_MEMORY_EXCEEDED");
    if (r.status === 65) return fault("PLUGIN_NO_HOOK");
    if (r.status === 70) return fault("PLUGIN_THREW");
    if (r.status === 71) return fault("PLUGIN_MALFORMED_OUTPUT");
    if (r.status !== 0 || r.signal !== null) return fault("PLUGIN_CRASH");
    if (fstatSync(outFd).size > maxOutput) return fault("PLUGIN_OUTPUT_TOO_LARGE");
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
