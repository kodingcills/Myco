/**
 * §5 desktop-proof gate (`session_info` over the SSH tunnel) — TIF-209 (F16).
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
 * Defense in depth: every string this module writes to stdout or stderr —
 * error messages from the transport or the agent, the result JSON, lock
 * refusals — goes through one sink (`emit`, below) that replaces any
 * occurrence of the token value with `[REDACTED]`, so a misbehaving agent
 * cannot echo the token back out. The ssh argv (`sshTunnelArgs`) never
 * contains the token, and no child is spawned with the token in its
 * environment.
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
 *   3   could not ask the agent: bad invocation, missing/empty/unreadable
 *       token file, tunnel or agent unreachable, auth failure, or a malformed
 *       session_info result
 *   10  REFUSED_VM_LOCKED: the VM lock is held (holder named on stderr), or
 *       the lock state could not be determined
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { AgentClient, SshTunnel } from "../win/agent-client.ts";
import { acquireVmLockUnlessOwnedByAncestor, VmLockedError, type VmLock } from "./vm-lock.ts";
import process from "node:process";

export const EXIT_OK = 0;
export const EXIT_GATE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_VM_LOCKED = 10;

/** Same default as `run-live.ts`'s fallback; produced by the §4/§5 token fetch. */
export const DEFAULT_TOKEN_FILE = `${homedir()}/.myco-token`;

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

/** The §5 gate classification, from the agent's session_info result. */
export function classifySessionInfo(result: unknown): {
  code: typeof EXIT_OK | typeof EXIT_GATE | typeof EXIT_BLOCKED;
  reason?: string;
} {
  if (typeof result !== "object" || result === null) {
    return { code: EXIT_BLOCKED, reason: `malformed session_info result: ${JSON.stringify(result)}` };
  }
  const { session_id: sessionId, window_station: windowStation } = result as Record<string, unknown>;
  const sessionOk =
    typeof sessionId === "number" && Number.isInteger(sessionId) && sessionId > 0;
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
  if (!stationReadable) problems.push(`window_station ${JSON.stringify(windowStation) ?? "undefined"}`);
  return { code: EXIT_BLOCKED, reason: `malformed session_info result: ${problems.join(", ")}` };
}

/**
 * The §5 step. Returns the exit code; prints everything through the
 * redaction sink. The lock (when taken) and the tunnel are always released.
 */
export async function runSessionInfo(
  argv: string[],
  deps: SessionInfoDeps,
): Promise<number> {
  let tokenFile: string;
  try {
    tokenFile = tokenFileFromArgv(argv) ?? DEFAULT_TOKEN_FILE;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
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
      deps.stderr(`REFUSED_VM_LOCKED: holder ${error.holder}`);
      return EXIT_VM_LOCKED;
    }
    deps.stderr(error instanceof Error ? error.message : String(error));
    return EXIT_VM_LOCKED;
  }

  // The one sink: every stdout/stderr byte this CLI produces passes through
  // here, so the token cannot leak even when the agent or the transport puts
  // it inside an error message or the result JSON.
  let secret = "";
  const emit = (text: string, channel: "stdout" | "stderr"): void => {
    if (secret !== "" && text.includes(secret)) {
      text = text.split(secret).join("[REDACTED]");
    }
    (channel === "stdout" ? deps.stdout : deps.stderr)(text);
  };

  try {
    try {
      const token = deps.readToken(tokenFile);
      secret = token;
    } catch (error) {
      // readToken's contract: the message names the path, never the contents.
      emit(error instanceof Error ? error.message : String(error), "stderr");
      return EXIT_BLOCKED;
    }

    let connection: SessionInfoConnection;
    try {
      connection = await deps.connect(secret);
    } catch (error) {
      emit(error instanceof Error ? error.message : String(error), "stderr");
      return EXIT_BLOCKED;
    }

    try {
      const result = await connection.client.sessionInfo();
      const verdict = classifySessionInfo(result);
      emit(JSON.stringify(result), "stdout");
      if (verdict.reason) emit(verdict.reason, "stderr");
      return verdict.code;
    } catch (error) {
      // AgentUnreachableError (transport) or AgentOpError (auth/op failure):
      // both mean the desktop proof could not be made.
      emit(error instanceof Error ? error.message : String(error), "stderr");
      return EXIT_BLOCKED;
    } finally {
      await connection.stop();
    }
  } finally {
    lock?.release();
  }
}

/** Production wiring: real lock, real token file, real tunnel + client. */
function productionDeps(): SessionInfoDeps {
  return {
    connect: async (token: string): Promise<SessionInfoConnection> => {
      const tunnel = new SshTunnel();
      try {
        await tunnel.start();
      } catch (error) {
        // start() may throw before establishing; a child could still exist.
        await tunnel.stop();
        throw error;
      }
      return { client: AgentClient.overTunnel(tunnel, { token }), stop: () => tunnel.stop() };
    },
    acquireLock: () => acquireVmLockUnlessOwnedByAncestor({ driver: "session-info.ts" }),
    readToken: readTokenFile,
    stdout: (text: string) => process.stdout.write(`${text}\n`),
    stderr: (text: string) => process.stderr.write(`${text}\n`),
  };
}

// Entry guard: run only when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSessionInfo(process.argv.slice(2), productionDeps()).then((code) => {
    process.exit(code);
  });
}
