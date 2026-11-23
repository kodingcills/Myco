/**
 * Live desktop transport over the runtime's MCP stdio server (TIF-89).
 *
 * The runner is transport-agnostic; this is the adapter that makes it live. It
 * speaks JSON-RPC to `myco-rt-mcp`, which owns the QEMU guest, and it reads the
 * app's own published state through `read_file` (RT-015) rather than relying on
 * the runtime's optional introspection config — the app writes that file itself,
 * so the claim and the store are both read from the guest, not from the runtime.
 *
 * Nothing here decides a verdict. It returns observations and outcomes; the
 * runner and the injected oracle do the rest.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord } from "./guards.ts";
import type {
  ActionOutcome,
  DesktopAction,
  DesktopObservation,
  DesktopSession,
  DesktopTransport,
} from "./live-runner.ts";
import type { ProbeEvidence } from "./preflight.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface RuntimeTransportOptions {
  /** Path to the `myco-rt-mcp` binary. */
  readonly binary: string;
  /** Extra argv (used by the fake server in tests). */
  readonly args?: readonly string[];
  /** Repo root; the server discovers the workspace from it. */
  readonly cwd: string;
  /** Guest directory the session may read (RT-015 grant). */
  readonly readRoot: string;
  /** Guest path of the app's published state file (ADR-0016). */
  readonly introspectionPath: string;
  /** Guest path of the app under test (the `appPresent` check). */
  readonly appPath: string;
  /** Session id; defaults to a timestamped one. */
  readonly sessionId?: string;
  /** Per-request timeout. */
  readonly timeoutMs?: number;
}

export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly timeoutMs: number;

  constructor(binary: string, cwd: string, args: readonly string[] = [], timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(binary, [...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const record = message as { id?: unknown; result?: unknown; error?: unknown };
      if (typeof record.id !== "number") return;
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id);
      if (record.error) pending.reject(new Error(JSON.stringify(record.error)));
      else pending.resolve(record.result);
    });
    this.child.stderr.on("data", () => {
      // The server logs to stderr; the caller's log file captures it.
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`mcp ${method} timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    this.child.stdin.write(`${payload}\n`);
    return promise;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "myco-discovery-s0", version: "0.1.0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (!text) throw new Error(`mcp ${name}: empty result`);
    const parsed: unknown = JSON.parse(text);
    if (result.isError) throw new Error(`mcp ${name}: ${text}`);
    return parsed;
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}

function outcomeOf(value: unknown): ActionOutcome {
  if (value === "delivered_verified" || value === "delivered_unverified" || value === "failed")
    return value;
  if (isRecord(value) && "failed" in value) return "failed";
  return "delivered_unverified";
}

export class RuntimeTransport implements DesktopTransport {
  private readonly client: McpClient;
  private readonly options: RuntimeTransportOptions;
  private sessionId: string;
  private created = false;

  constructor(options: RuntimeTransportOptions) {
    this.options = options;
    this.sessionId = options.sessionId ?? `s0-${Date.now()}`;
    this.client = new McpClient(options.binary, options.cwd, options.args ?? [], options.timeoutMs);
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  async create(): Promise<DesktopSession> {
    if (this.created) return { id: this.sessionId };
    await this.client.callTool("create", {
      session_id: this.sessionId,
      read_root: this.options.readRoot,
    });
    this.created = true;
    return { id: this.sessionId };
  }

  async observe(): Promise<DesktopObservation> {
    const observation = (await this.client.callTool("observe", {
      session_id: this.sessionId,
    })) as { state_version?: unknown };
    const stateVersion =
      typeof observation.state_version === "number" ? observation.state_version : 0;
    // The app publishes its own widget state; read it from the guest rather than
    // depending on the runtime's optional introspection config.
    let entryText = "";
    let listRows: string[] = [];
    let statusText = "";
    try {
      const file = (await this.client.callTool("read_file", {
        session_id: this.sessionId,
        path: this.options.introspectionPath,
      })) as { content_base64?: unknown };
      if (typeof file.content_base64 === "string") {
        const parsed: unknown = JSON.parse(
          Buffer.from(file.content_base64, "base64").toString("utf8"),
        );
        if (isRecord(parsed)) {
          if (typeof parsed.entry_text === "string") entryText = parsed.entry_text;
          if (Array.isArray(parsed.listbox_rows))
            listRows = parsed.listbox_rows.filter((row): row is string => typeof row === "string");
          if (typeof parsed.status_text === "string") statusText = parsed.status_text;
        }
      }
    } catch {
      // No published state yet (app not launched, or the file is mid-write). The
      // observation is still valid; the runner sees empty widget state.
    }
    return { stateVersion, entryText, listRows, statusText };
  }

  async act(_session: DesktopSession, action: DesktopAction): Promise<ActionOutcome> {
    const wire =
      action.kind === "launch"
        ? { kind: "launch", command: action.command, args: [...action.args] }
        : action.kind === "typeTextGlobal"
          ? { kind: "typeTextGlobal", text: action.text }
          : action.kind === "clickAt"
            ? { kind: "clickAt", x: action.x, y: action.y }
            : { kind: "keyPress", keys: action.keys };
    const result = (await this.client.callTool("act", {
      session_id: this.sessionId,
      action: wire,
    })) as { outcome?: unknown };
    return outcomeOf(result.outcome);
  }

  /**
   * Host-side evidence for the preflight; it never assumes a check passed.
   *
   * `guestClean` uses the ratified advisory definition (outer loop on Tiffany's
   * behalf, 2026-11-23; TIF-89): the app's store and published state files are
   * absent before launch. It says the run started from a known-empty app state,
   * not that the guest was otherwise pristine, and every evidence record must
   * state that this definition was in force. This object is built after the
   * session exists, when the app may already have run, so it reports the check
   * unproven rather than inferring the answer from files it can no longer trust.
   *
   * `oraclePresent` is Foundry's verifier validating this run, not something a
   * file read proves, and it is unproven until Foundry wires it: an S0 PASS must
   * not claim Foundry-oracle validation.
   */
  async evidence(_session: DesktopSession): Promise<ProbeEvidence> {
    let runtimeReachable = false;
    let guestReady = false;
    try {
      const observation = (await this.client.callTool("observe", {
        session_id: this.sessionId,
      })) as { a11y_tree?: unknown; windows?: unknown };
      runtimeReachable = true;
      guestReady = Array.isArray(observation.windows) && observation.windows.length > 0;
    } catch {
      return {
        runtimeReachable: false,
        guestReady: false,
        appPresent: false,
        storeReadable: false,
        // The oracle is supplied by its owner, not by this transport; claiming
        // it here would be the transport deciding what counts as verification.
        oraclePresent: false,
        guestClean: false,
      };
    }
    // Any failure counts as "not established". The agent does distinguish a
    // missing file from a refused path, but both arrive as one error string, and
    // reading that text would make presence depend on a message format.
    const canRead = async (path: string): Promise<boolean> => {
      try {
        await this.client.callTool("read_file", { session_id: this.sessionId, path });
        return true;
      } catch {
        return false;
      }
    };
    return {
      runtimeReachable,
      guestReady,
      appPresent: await canRead(this.options.appPath),
      storeReadable: await canRead(this.options.introspectionPath),
      // The oracle is supplied by its owner; the transport claiming it present
      // would be the transport deciding what counts as verification.
      oraclePresent: false,
      // Not established by this transport: it has no process probe, and a failed
      // read cannot tell "no stray process" from "no read grant". It stays false
      // until its owner supplies a real probe, so the live path stays closed.
      guestClean: false,
    };
  }

  async readFile(_session: DesktopSession, path: string): Promise<string> {
    const file = (await this.client.callTool("read_file", {
      session_id: this.sessionId,
      path,
    })) as { content_base64?: unknown };
    if (typeof file.content_base64 !== "string") throw new Error("read_file: no content");
    return Buffer.from(file.content_base64, "base64").toString("utf8");
  }

  async reset(): Promise<void> {
    await this.client.callTool("reset", { session_id: this.sessionId });
  }

  async destroy(): Promise<void> {
    try {
      await this.client.callTool("destroy", { session_id: this.sessionId });
    } finally {
      this.client.close();
    }
  }
}
