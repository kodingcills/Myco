/**
 * §5 desktop-proof gate (`session_info` over the SSH tunnel) — TIF-209 (F16).
 *
 * The logic and the production wiring. The executable entry point is
 * `src/integration/session-info.ts`, which imports this module and always runs
 * it: there is no "am I the main module?" check, so no invocation path (a
 * symlinked checkout, a different loader) can import the CLI, skip the proof,
 * and exit 0.
 *
 * Usage:
 *   pnpm exec tsx src/integration/session-info.ts [--token-file PATH]
 *
 * `docs/eval-runbook.md` §5 needs an agent-side `session_info` call, but the
 * old inline recipe (`printf '…token…' | nc 127.0.0.1 8765`) prints the token
 * into the command line, and the host's enforced secret guard (AGENTS.md,
 * TIF-206) refuses any such command — so no agent could run §5. This CLI is
 * the replacement.
 *
 * Token handling: the token is read from a file (`--token-file PATH`, default
 * `~/.myco-token`, the same fallback `run-live.ts` uses), trimmed, and held
 * only in memory. `MYCO_AGENT_TOKEN` is deliberately NOT read: the token must
 * never pass through environment, argv, or a shell command line. A missing or
 * empty file is refused with a message that names the PATH, never the
 * contents.
 *
 * Output redaction: every string this module writes to stdout or stderr —
 * error messages from the transport or the agent, the result JSON, lock
 * refusals — goes through one sink (`redactToken`, applied in `emit`). It
 * replaces with `[REDACTED]`:
 *   - the raw token;
 *   - the token as it appears inside a JSON string literal (with `"` and `\`
 *     escaped), so a JSON-encoded echo is caught;
 *   - any run of 12 or more consecutive characters that also occurs in the raw
 *     token, so a truncated echo (e.g. the transport's 120-character
 *     malformed-NDJSON excerpt) is caught.
 * It does not catch fragments shorter than 12 characters, a token encoded some
 * other way (base64, hex, URL-encoding), or a token shorter than 12 characters
 * appearing only in part. It is a backstop against an agent or transport
 * echoing the token, not a general secret scanner.
 *
 * Child environment: the ssh argv (`sshTunnelArgs`) never contains the token,
 * and the ssh child gets an environment scrubbed of it (`tunnelOptionsFor`:
 * `MYCO_AGENT_TOKEN` and any variable whose value contains the token are
 * dropped), so an operator shell that still exports the token does not hand it
 * to ssh either.
 *
 * VM lock: taken the way `run-live.ts` takes it
 * (`acquireVmLockUnlessOwnedByAncestor`), recorded under driver
 * `session-info.ts`, and always released on exit. This is the M1 procedure:
 * each runbook step owns its own lock acquisition and release. The tunnel is
 * likewise always stopped, including on error.
 *
 * Exit codes:
 *   0   desktop proof passed: `session_id` is a non-zero integer and the
 *       window station is `WinSta0`; the session_info result JSON is on stdout
 *   2   the §5 gate: the agent is in session 0 and/or the window station is
 *       not `WinSta0` — stop, do not run trials. One-line reason on stderr,
 *       result JSON on stdout
 *   3   could not ask the agent, or could not evaluate its answer. Every cause:
 *       bad invocation (usage); token file missing, unreadable, or empty;
 *       tunnel did not come up or agent unreachable; auth failure or any other
 *       `ok:false` from the agent; a malformed session_info result (including
 *       an `ok:true` response with no result); the tunnel teardown failing.
 *       Reason on stderr
 *   10  REFUSED_VM_LOCKED: the VM lock is held (holder named on stderr), or
 *       the lock state could not be determined
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import {
  AgentClient,
  type AgentTransport,
  SshTunnel,
  type SshTunnelOptions,
} from "../win/agent-client.ts";
import { acquireVmLockUnlessOwnedByAncestor, type VmLock, VmLockedError } from "./vm-lock.ts";

export const EXIT_OK = 0;
export const EXIT_GATE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_VM_LOCKED = 10;

/** Same default as `run-live.ts`'s fallback; produced by the §4/§5 token fetch. */
export const DEFAULT_TOKEN_FILE = `${homedir()}/.myco-token`;

/** Shortest token fragment the sink redacts on its own (see the header). */
export const MIN_REDACTED_FRAGMENT = 12;

/** The surface `runSessionInfo` needs; `AgentClient` satisfies it. */
export interface SessionInfoClient {
  sessionInfo(): Promise<unknown>;
}

/** A connected client plus how to tear down its tunnel. */
export interface SessionInfoConnection {
  client: SessionInfoClient;
  stop(): Promise<void>;
}

export interface SessionInfoDeps {
  /** Creates the connected client for a token; must also return its teardown. */
  connect(token: string): Promise<SessionInfoConnection>;
  /** Takes the VM lock; throws `VmLockedError` on contention. May return
   * `undefined` when an allowed ancestor already holds it. */
  acquireLock(): VmLock | undefined;
  /** Reads and trims the token; throws an Error naming the path (never the
   * contents) when the file is missing or empty. */
  readToken(path: string): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Parses `[--token-file PATH]`; undefined when the flag is absent. Throws on
 * `--token-file` without a value. */
export function tokenFileFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf("--token-file");
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("usage: --token-file needs a PATH argument");
  }
  return value;
}

/** Production token read: file only, never the environment. */
export function readTokenFile(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read token file ${path}: ${reason}`);
  }
  const token = text.trim();
  if (!token) throw new Error(`token file ${path} is empty`);
  return token;
}

/**
 * The tunnel options for a token: production defaults, plus a copy of `env`
 * with every token-bearing variable removed, so the ssh child never sees the
 * token. Existing `SshTunnel` callers pass no `env` and keep inheriting.
 */
export function tunnelOptionsFor(token: string, env: NodeJS.ProcessEnv): SshTunnelOptions {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === "MYCO_AGENT_TOKEN") continue;
    if (value !== undefined && token !== "" && value.includes(token)) continue;
    scrubbed[name] = value;
  }
  return { env: scrubbed };
}

/**
 * The redaction sink's transform (contract in the header): the raw token, its
 * JSON-string-escaped form, and any fragment of at least
 * `MIN_REDACTED_FRAGMENT` characters of the raw token become `[REDACTED]`.
 */
export function redactToken(text: string, token: string): string {
  if (token === "") return text;
  let out = text.split(token).join("[REDACTED]");
  const escaped = JSON.stringify(token).slice(1, -1);
  if (escaped !== token) out = out.split(escaped).join("[REDACTED]");
  if (token.length < MIN_REDACTED_FRAGMENT) return out;
  // Fragments: at each position, take the longest run that occurs in the
  // token; redact it when it is long enough. O(text × token), both short.
  let result = "";
  let i = 0;
  while (i < out.length) {
    let length = 0;
    while (i + length < out.length && token.includes(out.slice(i, i + length + 1))) length++;
    if (length >= MIN_REDACTED_FRAGMENT) {
      result += "[REDACTED]";
      i += length;
    } else {
      result += out[i];
      i++;
    }
  }
  return result;
}

/** The §5 gate classification, from the agent's session_info result. */
export function classifySessionInfo(result: unknown): {
  code: typeof EXIT_OK | typeof EXIT_GATE | typeof EXIT_BLOCKED;
  reason?: string;
} {
  if (typeof result !== "object" || result === null) {
    return {
      code: EXIT_BLOCKED,
      reason: `malformed session_info result: ${JSON.stringify(result) ?? "no result"}`,
    };
  }
  const { session_id: sessionId, window_station: windowStation } = result as Record<
    string,
    unknown
  >;
  const sessionOk = typeof sessionId === "number" && Number.isInteger(sessionId) && sessionId > 0;
  const stationOk = windowStation === "WinSta0";
  if (sessionOk && stationOk) return { code: EXIT_OK };
  // Definitive gate: both fields are readable and at least one proves the
  // agent is not on the interactive desktop. Everything else is a malformed
  // result — the agent answered, but the proof cannot be evaluated either way.
  const sessionReadable = typeof sessionId === "number" && Number.isInteger(sessionId);
  const stationReadable = typeof windowStation === "string";
  if (sessionReadable && stationReadable) {
    return {
      code: EXIT_GATE,
      reason: `session_id ${sessionId}, window_station ${windowStation}: the agent is not on the interactive desktop — stop, do not run trials`,
    };
  }
  const problems: string[] = [];
  if (!sessionReadable) problems.push(`session_id ${JSON.stringify(sessionId) ?? "undefined"}`);
  if (!stationReadable)
    problems.push(`window_station ${JSON.stringify(windowStation) ?? "undefined"}`);
  return { code: EXIT_BLOCKED, reason: `malformed session_info result: ${problems.join(", ")}` };
}

/**
 * The §5 step. Returns the exit code; prints everything through the
 * redaction sink. The lock (when taken) and the tunnel are always released.
 */
export async function runSessionInfo(argv: string[], deps: SessionInfoDeps): Promise<number> {
  // The one sink: every stdout/stderr string this CLI produces passes through
  // here, so the token cannot leak even when the agent or the transport puts
  // it inside an error message or the result JSON. `secret` is empty until the
  // token is read; nothing printed before then can contain it.
  let secret = "";
  const emit = (text: string, channel: "stdout" | "stderr"): void => {
    (channel === "stdout" ? deps.stdout : deps.stderr)(redactToken(text, secret));
  };
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  let tokenFile: string;
  try {
    tokenFile = tokenFileFromArgv(argv) ?? DEFAULT_TOKEN_FILE;
  } catch (error) {
    emit(message(error), "stderr");
    return EXIT_BLOCKED;
  }

  // The VM lock, before anything touches the guest (TIF-191). A held lock is a
  // refusal, not a wait: a driver that holds it is running trials or resetting
  // the snapshot, and this step must not race it.
  let lock: VmLock | undefined;
  try {
    lock = deps.acquireLock();
  } catch (error) {
    if (error instanceof VmLockedError) {
      emit(`REFUSED_VM_LOCKED: holder ${error.holder}`, "stderr");
      return EXIT_VM_LOCKED;
    }
    emit(`REFUSED_VM_LOCKED: lock state undeterminable: ${message(error)}`, "stderr");
    return EXIT_VM_LOCKED;
  }

  try {
    try {
      const token = deps.readToken(tokenFile);
      secret = token;
    } catch (error) {
      // readToken's contract: the message names the path, never the contents.
      emit(message(error), "stderr");
      return EXIT_BLOCKED;
    }

    let connection: SessionInfoConnection;
    try {
      connection = await deps.connect(secret);
    } catch (error) {
      emit(message(error), "stderr");
      return EXIT_BLOCKED;
    }

    try {
      const result = await connection.client.sessionInfo();
      const verdict = classifySessionInfo(result);
      // An absent result (`ok:true` with no `result`) has no JSON to print;
      // the malformed-result reason on stderr says so.
      const json = JSON.stringify(result);
      if (json !== undefined) emit(json, "stdout");
      if (verdict.reason) emit(verdict.reason, "stderr");
      return verdict.code;
    } catch (error) {
      // AgentUnreachableError (transport) or AgentOpError (auth/op failure):
      // both mean the desktop proof could not be made.
      emit(message(error), "stderr");
      return EXIT_BLOCKED;
    } finally {
      await connection.stop();
    }
  } catch (error) {
    // Anything unexpected (e.g. a teardown that throws): still through the
    // sink, still a "could not ask the agent" exit, lock still released.
    emit(message(error), "stderr");
    return EXIT_BLOCKED;
  } finally {
    lock?.release();
  }
}

/** What `productionDeps` needs from a tunnel; `SshTunnel` satisfies it. */
export interface SessionInfoTunnel extends AgentTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Test seams for `productionDeps`; production passes none. */
export interface ProductionSeams {
  /** The environment the ssh child's scrubbed copy is made from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Builds the tunnel from its options (default `new SshTunnel(options)`). */
  makeTunnel?: (options: SshTunnelOptions) => SessionInfoTunnel;
}

/** Production wiring: real lock, real token file, real tunnel + client. */
export function productionDeps(seams: ProductionSeams = {}): SessionInfoDeps {
  const makeTunnel = seams.makeTunnel ?? ((options) => new SshTunnel(options));
  return {
    connect: async (token: string): Promise<SessionInfoConnection> => {
      const tunnel = makeTunnel(tunnelOptionsFor(token, seams.env ?? process.env));
      try {
        await tunnel.start();
      } catch (error) {
        // start() may throw before establishing; a child could still exist.
        await tunnel.stop();
        throw error;
      }
      return { client: new AgentClient(tunnel, { token }), stop: () => tunnel.stop() };
    },
    acquireLock: () => acquireVmLockUnlessOwnedByAncestor({ driver: "session-info.ts" }),
    readToken: readTokenFile,
    stdout: (text: string) => process.stdout.write(`${text}\n`),
    stderr: (text: string) => process.stderr.write(`${text}\n`),
  };
}

/** The CLI body: run with the real wiring and exit with its code. */
export function main(): void {
  runSessionInfo(process.argv.slice(2), productionDeps()).then(
    (code) => process.exit(code),
    // runSessionInfo catches and redacts everything itself; this only guards
    // against a bug there, and prints no error text that could carry the token.
    () => {
      process.stderr.write("session-info: internal error\n");
      process.exit(EXIT_BLOCKED);
    },
  );
}
