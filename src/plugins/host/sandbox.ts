/**
 * Out-of-process plugin runner (capability track T). One child process per request, started
 * synchronously so the R5 self-test runner (synchronous by contract) can call a plugin
 * oracle directly.
 *
 * Isolation, each enforced here or in the child's flags, and each proven by
 * `test/plugins/sandbox.test.ts`:
 *  - empty environment (no secrets, no proxy settings reach a plugin);
 *  - Node permission model: reads only the SDK directory and the plugin directory; no
 *    writes, child processes, workers, addons, WASI;
 *  - no network: `guard.ts` denies every network-capable builtin and global;
 *  - bounded input (the manifest's `maxInputBytes`, under the host ceiling), bounded output
 *    (`maxBuffer`; overflow kills the child), wall-clock timeout (SIGKILL), V8 heap cap
 *    (`--max-old-space-size`) and a resident-memory watchdog in the child;
 *  - the plugin gets the captured bytes and a basename over stdin, never a host path of the
 *    trial.
 * Every failure is a `SandboxFault` with a `PLUGIN_*` code; callers turn it into `uncertain`.
 */
import { spawnSync } from "node:child_process";
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

  const memoryMb = target.caps.memoryMb;
  const rssCap = memoryMb * 1024 * 1024 + RUNTIME_RSS_ALLOWANCE_BYTES;
  const maxOutput = opts.maxOutputBytes ?? target.caps.maxOutputBytes;
  const r = spawnSync(
    process.execPath,
    [
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
      input,
      cwd: target.dir,
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
      timeout: target.caps.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: maxOutput,
      windowsHide: true,
    },
  );
  const errCode = (r.error as (Error & { code?: string }) | undefined)?.code;
  if (errCode === "ETIMEDOUT") return fault("PLUGIN_TIMEOUT");
  if (errCode === "ENOBUFS") return fault("PLUGIN_OUTPUT_TOO_LARGE");
  if (r.error !== undefined) return fault("PLUGIN_SPAWN_FAILED");
  if (r.signal === "SIGABRT" || r.signal === "SIGTRAP" || r.status === 87 || r.status === 134)
    return fault("PLUGIN_MEMORY_EXCEEDED");
  if (r.status === 65) return fault("PLUGIN_NO_HOOK");
  if (r.status === 70) return fault("PLUGIN_THREW");
  if (r.status === 71) return fault("PLUGIN_MALFORMED_OUTPUT");
  if (r.status !== 0 || r.signal !== null) return fault("PLUGIN_CRASH");

  const text = r.stdout.toString("utf8");
  // Exactly one line of JSON: anything a plugin prints itself makes the output malformed.
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1)
    return fault("PLUGIN_MALFORMED_OUTPUT");
  try {
    return { ok: true, response: parseResponse(JSON.parse(text), request.op) };
  } catch {
    return fault("PLUGIN_MALFORMED_OUTPUT");
  }
}
