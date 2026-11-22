/**
 * Host-side client for the myco-agent NDJSON protocol (M1-007 / TIF-11).
 *
 * Contract: agent/README.md — TCP on 127.0.0.1:8765 (guest loopback, reached
 * via SSH tunnel), one JSON request per line, one JSON response per line,
 * token auth. The client holds no policy and no retries (ADR-0001): every
 * decision lives in the caller.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Protocol shapes (agent/README.md)
// ---------------------------------------------------------------------------

export type AgentOp =
  | "ping"
  | "session_info"
  | "launch"
  | "uia_tree"
  | "uia_invoke"
  | "screenshot"
  | "read_file"
  | "write_file"
  | "kill"
  | "uno_eval";

export interface AgentRequest {
  id: number;
  token: string;
  op: AgentOp;
  params: Record<string, unknown>;
}

export interface AgentError {
  code: "AUTH_FAILED" | "BAD_REQUEST" | "UNKNOWN_OP" | "OP_FAILED" | "INTERNAL" | string;
  message: string;
}

export type AgentResponse =
  | { ok: true; id: number; result: unknown }
  | { ok: false; id: number; error: AgentError };

/** Result shape of the read-only `uno_eval` op. */
export interface UnoEvalResult {
  get_value?: number;
  get_string?: string;
  get_error?: number | string;
  is_modified?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Transport-level failure: agent unreachable, connection reset, timeout. */
export class AgentUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnreachableError";
  }
}

/** The agent answered `{ok: false}` — an in-protocol op failure. */
export class AgentOpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`agent op failed (${code}): ${message}`);
    this.code = code;
    this.name = "AgentOpError";
  }
}

// ---------------------------------------------------------------------------
// Transport interface (tests substitute a fake; production uses socket or tunnel)
// ---------------------------------------------------------------------------

export interface AgentTransport {
  call(request: AgentRequest): Promise<AgentResponse>;
}

// ---------------------------------------------------------------------------
// Socket transport
// ---------------------------------------------------------------------------

export interface SocketTransportOptions {
  host?: string;
  port?: number;
  /** Per-call timeout in ms (default 15_000). */
  timeoutMs?: number;
}

/**
 * Speaks the NDJSON protocol over a TCP connection, matching responses by id.
 * One short-lived connection per request keeps the client simple; blocking
 * desktop ops gain nothing from a persistent pipeline.
 */
export class SocketTransport implements AgentTransport {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(options: SocketTransportOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8765;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  call(request: Omit<AgentRequest, "id">): Promise<AgentResponse> {
    const id = this.nextId++;
    return this.exchange({ ...request, id });
  }

  private exchange(request: AgentRequest): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let socket: Socket | undefined;
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new AgentUnreachableError(
            `agent at ${this.host}:${this.port} timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket?.destroy();
      };

      socket = createConnection({ host: this.host, port: this.port }, () => {
        socket?.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).trim();
        cleanup();
        if (line === "") {
          reject(new AgentUnreachableError("agent closed the connection without a response"));
          return;
        }
        try {
          const response = JSON.parse(line) as AgentResponse;
          if (response.id !== request.id) {
            reject(
              new AgentUnreachableError(
                `agent response id mismatch: expected ${request.id}, got ${response.id}`,
              ),
            );
            return;
          }
          resolve(response);
        } catch {
          reject(new AgentUnreachableError(`agent sent malformed NDJSON: ${line.slice(0, 120)}`));
        }
      });
      socket.on("error", (err: Error) => {
        cleanup();
        reject(
          new AgentUnreachableError(
            `agent at ${this.host}:${this.port} unreachable: ${err.message}`,
          ),
        );
      });
      socket.on("close", () => {
        clearTimeout(timer);
        reject(new AgentUnreachableError("agent closed the connection before responding"));
      });
    });
  }
}

// ---------------------------------------------------------------------------
// SSH tunnel transport
// ---------------------------------------------------------------------------

export interface SshTunnelOptions {
  /** Host alias from the SSH config (default `myco-win11`). */
  host?: string;
  /** SSH config file (default `~/VMs/myco-win11/ssh_config`). */
  configFile?: string;
  /** Local port to forward (default 8765). */
  localPort?: number;
  /** Remote endpoint forwarded to (default guest loopback 8765). */
  remoteHost?: string;
  remotePort?: number;
  /** Executable used for the tunnel (default `ssh`); tests substitute a stub. */
  sshPath?: string;
  /** Per-call timeout for agent requests through the tunnel (default 15_000ms). */
  timeoutMs?: number;
}

/** The argv `SshTunnel` spawns, exported for tests and runbooks. */
export function sshTunnelArgs(options: SshTunnelOptions = {}): string[] {
  const localPort = options.localPort ?? 8765;
  const remoteHost = options.remoteHost ?? "127.0.0.1";
  const remotePort = options.remotePort ?? 8765;
  const configFile = options.configFile ?? join(homedir(), "VMs", "myco-win11", "ssh_config");
  const host = options.host ?? "myco-win11";
  return ["-L", `${localPort}:${remoteHost}:${remotePort}`, "-F", configFile, "-N", host];
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `ssh -L 8765:127.0.0.1:8765 -F ~/VMs/myco-win11/ssh_config myco-win11 -N`
 * with lifecycle management (start + health check + kill), behind the same
 * {@link AgentTransport} interface: requests are delegated to a
 * {@link SocketTransport} on the local forwarded port.
 */
export class SshTunnel implements AgentTransport {
  private readonly localPort: number;
  private readonly options: SshTunnelOptions;
  private child: ChildProcess | undefined;
  private readonly inner: SocketTransport;

  constructor(options: SshTunnelOptions = {}) {
    this.options = options;
    this.localPort = options.localPort ?? 8765;
    this.inner = new SocketTransport({
      host: "127.0.0.1",
      port: this.localPort,
      timeoutMs: options.timeoutMs ?? 15_000,
    });
  }

  /** Spawn the tunnel and wait until the local port accepts connections. */
  async start(startTimeoutMs = 10_000): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    const sshPath = this.options.sshPath ?? "ssh";
    const args = sshTunnelArgs(this.options);
    this.child = spawn(sshPath, args, { stdio: "ignore", detached: false });
    this.child.on("error", () => {
      // surfaced via health check / transport failures
    });
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new AgentUnreachableError(
          `ssh tunnel exited with code ${this.child.exitCode} before becoming healthy`,
        );
      }
      if (await canConnect("127.0.0.1", this.options.localPort ?? 8765, 500)) return;
      await sleep(200);
    }
    await this.stop();
    throw new AgentUnreachableError(`ssh tunnel did not become healthy within ${startTimeoutMs}ms`);
  }

  /** True while the tunnel child is alive and the local port accepts connections. */
  async healthy(): Promise<boolean> {
    if (!this.child || this.child.exitCode !== null) return false;
    return canConnect("127.0.0.1", this.options.localPort ?? 8765, 500);
  }

  /** Kill the tunnel process. Safe to call repeatedly. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      sleep(2000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) child.kill("SIGKILL");
  }

  async disconnect(): Promise<void> {
    await this.stop();
  }

  call(request: AgentRequest): Promise<AgentResponse> {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(
        new AgentUnreachableError("ssh tunnel is not running (call start() first)"),
      );
    }
    return this.inner.call(request);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AgentClientConfig {
  /** Shared auth token (agent/README.md protocol). */
  token: string;
  /** Per-request timeout in ms (default 15_000). */
  timeoutMs?: number;
}

export interface AgentClientEnv {
  MYCO_AGENT_TOKEN?: string;
  MYCO_AGENT_HOST?: string;
  MYCO_AGENT_PORT?: string;
  MYCO_AGENT_TIMEOUT_MS?: string;
}

/** Connection config from env vars; throws if the token is missing. */
export function agentConfigFromEnv(env: AgentClientEnv = process.env): AgentClientConfig & {
  host: string;
  port: number;
} {
  const token = env.MYCO_AGENT_TOKEN;
  if (!token) {
    throw new Error("MYCO_AGENT_TOKEN is required (agent protocol token auth)");
  }
  return {
    token,
    host: env.MYCO_AGENT_HOST ?? "127.0.0.1",
    port: Number(env.MYCO_AGENT_PORT ?? 8765),
    timeoutMs: env.MYCO_AGENT_TIMEOUT_MS ? Number(env.MYCO_AGENT_TIMEOUT_MS) : undefined,
  };
}

/**
 * Typed facade over the transport. Converts `ok:false` responses to
 * {@link AgentOpError} and transport failures to {@link AgentUnreachableError}
 * so callers (the verifier) can distinguish "provably absent" from "could not
 * look" (ADR-0002).
 */
export class AgentClient {
  private readonly transport: AgentTransport;
  private nextId = 1;
  private readonly token: string;

  constructor(transport: AgentTransport, config: AgentClientConfig) {
    this.transport = transport;
    this.token = config.token;
  }

  /** From env config over a direct socket (agent on loopback of this host). */
  static fromEnv(env: AgentClientEnv = process.env): AgentClient {
    const cfg = agentConfigFromEnv(env);
    return new AgentClient(
      new SocketTransport({ host: cfg.host, port: cfg.port, timeoutMs: cfg.timeoutMs }),
      cfg,
    );
  }

  /** Over an SSH tunnel to the VM's loopback agent. */
  static overTunnel(tunnel: SshTunnel, config: AgentClientConfig): AgentClient {
    return new AgentClient(tunnel, config);
  }

  private async request(op: AgentOp, params: Record<string, unknown> = {}): Promise<unknown> {
    let response: AgentResponse;
    try {
      response = await this.transport.call({ id: this.nextId++, token: this.token, op, params });
    } catch (error) {
      if (error instanceof AgentUnreachableError) throw error;
      throw new AgentUnreachableError(error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      throw new AgentOpError(response.error.code, response.error.message);
    }
    return response.result;
  }

  ping(): Promise<{ agent_version: string; session_id: string; backend?: string }> {
    // `backend` is present in the agent's wire response (observed: "windows")
    // but was missing from this type, so callers logging it appeared to read a
    // non-existent field. Optional because older agents may omit it.
    return this.request("ping") as Promise<{
      agent_version: string;
      session_id: string;
      backend?: string;
    }>;
  }

  /** Read-only UNO readback (getValue/getString/getError/isModified). */
  unoEval(params: {
    call: string;
    sheet?: string;
    cell?: string;
    socket?: string;
  }): Promise<UnoEvalResult> {
    return this.request("uno_eval", params) as Promise<UnoEvalResult>;
  }

  /** Read a guest file; returns the decoded bytes. */
  async readFile(path: string): Promise<Buffer> {
    const result = (await this.request("read_file", { path })) as { data_b64: string };
    return Buffer.from(result.data_b64, "base64");
  }

  /** Launch a process in the interactive session; resolves its pid. */
  launch(argv: readonly string[], cwd?: string): Promise<number> {
    const params: Record<string, unknown> = { argv };
    if (cwd !== undefined) params.cwd = cwd;
    return this.request("launch", params).then((r) => (r as { pid: number }).pid);
  }

  /** Write bytes to a guest file (parent directories are created). */
  async writeFile(path: string, data: Buffer): Promise<number> {
    const result = (await this.request("write_file", {
      path,
      data_b64: data.toString("base64"),
    })) as { bytes: number };
    return result.bytes;
  }

  /** Terminate a guest pid or image name; resolves the killed targets. */
  kill(params: { pid?: number; image_name?: string }): Promise<Array<number | string>> {
    return this.request("kill", params).then(
      (r) => (r as { killed: Array<number | string> }).killed,
    );
  }

  /** Depth-limited UIA subtree of the guest's top-level windows. */
  uiaTree(params: { pid?: number; title?: string; depth?: number }): Promise<unknown> {
    return this.request("uia_tree", params);
  }
}
