/**
 * The operator side of a handoff (capability track N): a loopback-only HTTP endpoint that lists
 * pending handoffs and resolves them. The CLI (`scripts/myco-handoff.ts`) talks to it, and it is
 * shaped to sit beside the live watch view (PR #513): `createOperatorHandler` is a plain
 * request handler #513's server can mount at `/handoff/v1` (lands with #513).
 *
 * Why the agent cannot reach it (docs/handoff/security.md §2):
 *  - It holds the broker's one `OperatorChannel`; the agent's MCP server holds only the agent
 *    channel, which has no resolve verb.
 *  - It binds 127.0.0.1 on the HOST. In a live run the agent's actuator acts inside the guest
 *    VM, which has no route to host loopback; the launch audit denies the agent any host shell,
 *    host fs or network tool (src/integrity/surface.ts) that could reach it from the host side.
 *  - Every request needs the operator token (`Authorization: Bearer`), generated at start from
 *    `crypto.randomBytes`, compared in constant time, never logged or put in argv or env. The
 *    CLI reads it from a 0600 connection file the operator names, outside the repo
 *    (`writeConnectionFile`).
 *  - The Host header must be loopback (DNS rebinding), a present Origin must be allow-listed,
 *    POST bodies must be `application/json` (no form-post CSRF from a browser page) and at most
 *    4 KiB.
 *
 * Responses carry codes, never the token or a host path.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import type { OperatorChannel } from "./broker.ts";

export const OPERATOR_BASE = "/handoff/v1";
export const MAX_OPERATOR_BODY = 4096;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface OperatorHandlerOptions {
  readonly channel: OperatorChannel;
  /** The operator token. Hold it in memory only; never log it. */
  readonly token: string;
  /** The port the handler is served on (the Host header must name it). */
  readonly port: () => number;
  /** Origins allowed to call (the watch view's own origin, lands with #513). Default none. */
  readonly allowedOrigins?: readonly string[];
}

/** A new operator token: 32 random bytes, base64url. */
export function newOperatorToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenMatches(presented: string, expected: string): boolean {
  // Hash both so the comparison is constant-time whatever the lengths.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function hostOk(host: string | undefined, port: number): boolean {
  if (typeof host !== "string") return false;
  const m = /^(\[::1\]|[^:]+):(\d+)$/.exec(host);
  if (!m) return false;
  return LOOPBACK_HOSTS.has(m[1] ?? "") && Number(m[2]) === port;
}

function readBody(req: IncomingMessage): Promise<string | "TOO_LARGE"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OPERATOR_BODY) over = true;
      else if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? "TOO_LARGE" : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The operator request handler. Mountable by another loopback server (the #513 watch view). */
export function createOperatorHandler(
  opts: OperatorHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const origins = new Set(opts.allowedOrigins ?? []);
  return async (req, res) => {
    try {
      if (!hostOk(req.headers.host, opts.port())) return send(res, 403, { code: "BAD_HOST" });
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin))
        return send(res, 403, { code: "BAD_ORIGIN" });
      const auth = req.headers.authorization;
      const presented = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!tokenMatches(presented, opts.token)) return send(res, 401, { code: "UNAUTHORIZED" });

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === `${OPERATOR_BASE}/pending`) {
        return send(res, 200, { pending: opts.channel.pending() });
      }
      if (req.method === "POST" && url.pathname === `${OPERATOR_BASE}/resolve`) {
        const type = req.headers["content-type"] ?? "";
        if (!/^application\/json(?:;|$)/i.test(type))
          return send(res, 415, { code: "UNSUPPORTED_MEDIA_TYPE" });
        const raw = await readBody(req);
        if (raw === "TOO_LARGE") return send(res, 413, { code: "BODY_TOO_LARGE" });
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { code: "INVALID_JSON" });
        }
        if (typeof body !== "object" || body === null || Array.isArray(body))
          return send(res, 400, { code: "INVALID_REQUEST" });
        const b = body as Record<string, unknown>;
        for (const key of Object.keys(b))
          if (!["handoffId", "outcome", "note", "via", "operatorLabel"].includes(key))
            return send(res, 400, { code: "UNKNOWN_FIELD" });
        const result = opts.channel.resolve({
          handoffId: b.handoffId,
          outcome: b.outcome,
          note: b.note,
          via: b.via ?? "api",
          operatorLabel: b.operatorLabel,
        });
        if (!result.ok)
          return send(res, result.code === "ALREADY_RESOLVED" ? 409 : 400, { code: result.code });
        return send(res, 200, { resolved: result.entry });
      }
      return send(res, 404, { code: "NOT_FOUND" });
    } catch {
      return send(res, 500, { code: "INTERNAL" });
    }
  };
}

export interface OperatorServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartOperatorServerOptions {
  readonly channel: OperatorChannel;
  readonly token: string;
  readonly allowedOrigins?: readonly string[];
  /** 0 (default) picks a free port. */
  readonly port?: number;
}

/** Start the endpoint on 127.0.0.1 only. There is no option to bind anything else. */
export async function startOperatorServer(
  opts: StartOperatorServerOptions,
): Promise<OperatorServer> {
  let port = 0;
  const handler = createOperatorHandler({
    channel: opts.channel,
    token: opts.token,
    port: () => port,
    ...(opts.allowedOrigins ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** What the CLI needs to reach the endpoint. Lives only in a 0600 file outside the repo. */
export interface OperatorConnection {
  readonly schema: "myco.handoff.connection/1";
  readonly url: string;
  readonly token: string;
}

/**
 * Write the connection file with mode 0600, refusing to overwrite (`wx`). The path is the
 * operator's choice (e.g. under `~/.myco/handoff/`); never inside the repo, never in the agent's
 * launch plan (`connectionReachesAgent` checks the plan).
 */
export function writeConnectionFile(path: string, url: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body: OperatorConnection = { schema: "myco.handoff.connection/1", url, token };
  writeFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" });
}

/**
 * True when anything in the agent's launch plan names the connection file or carries the token:
 * the harness refuses to launch in that case (`assertNoOperatorReach`).
 */
export function connectionReachesAgent(
  plan: {
    readonly argv: readonly string[];
    readonly mcpServers: Readonly<
      Record<
        string,
        {
          readonly command: string;
          readonly args: readonly string[];
          readonly env: Readonly<Record<string, string>>;
        }
      >
    >;
  },
  connectionPath: string,
  token: string,
): boolean {
  const strings = [
    ...plan.argv,
    ...Object.values(plan.mcpServers).flatMap((s) => [
      s.command,
      ...s.args,
      ...Object.keys(s.env),
      ...Object.values(s.env),
    ]),
  ];
  const base = connectionPath.split(/[\\/]/).pop() ?? connectionPath;
  return strings.some(
    (s) => s.includes(connectionPath) || (base.length > 0 && s.includes(base)) || s.includes(token),
  );
}
