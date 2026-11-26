/**
 * Live watch view (TIF-265 follow-up, scope add A): a read-only local web view of one or
 * more runs: the agent's desktop as a frame series, and the gate's decisions as they land.
 *
 * Security model (docs/gate/watch.md):
 *  - Loopback only. `startWatchServer` refuses any bind address that is not loopback
 *    (127.0.0.0/8, ::1, `localhost`) unless `allowNonLoopback` is set, and checks the
 *    address the socket actually bound to. The `Host` header must name a loopback host (or
 *    the explicit bind host), which stops DNS-rebinding pages from reading the stream.
 *  - Read-only. Every method other than GET is refused with 405, on every path, before
 *    routing. No route reads a request body. The server holds no handle on the gate, the
 *    vault, an oracle or the agent: its only inputs are the decision-log path and a frame
 *    source, both opened read-only. It writes no file.
 *  - No CORS. No response carries `Access-Control-Allow-*`; a request with a foreign
 *    `Origin` is refused. Responses carry a strict CSP, `nosniff`, no-referrer, no-store.
 *  - Redaction by allowlist. The stream carries only `WatchEvent`s (`events.ts`), run ids
 *    the operator listed and frame counts; never a path, the claim, reasons, digests or any
 *    vault field. Frames are addressed by (listed run id, index), never by a name.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { DecisionLogTail } from "./decision-log.ts";
import { projectDecisions, type WatchEvent } from "./events.ts";
import type { FrameSource } from "./frames.ts";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "./page.ts";

export interface WatchServerOptions {
  /** Bind address. Default 127.0.0.1. */
  readonly host?: string;
  /** Port; 0 picks a free one. Default 0. */
  readonly port?: number;
  /** Allow a non-loopback bind. Off by default; the CLI needs an explicit flag. */
  readonly allowNonLoopback?: boolean;
  /** Runs the operator listed: only these are shown. */
  readonly runs: readonly string[];
  /** Tasks the operator listed: only these task ids are shown. */
  readonly tasks?: readonly string[];
  /** The gate's decision log (`--audit` JSONL). Read-only. */
  readonly decisionLog?: string;
  readonly frames?: FrameSource;
  /** How often the log and frames are re-read. Default 250 ms. */
  readonly pollMs?: number;
}

export interface WatchState {
  readonly runs: readonly { readonly runId: string; readonly frames: number }[];
  readonly events: readonly WatchEvent[];
  readonly skipped: number;
  readonly logPresent: boolean;
}

export interface WatchServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  /** The current state, exactly as `/api/state` serves it. */
  state(): WatchState;
  close(): Promise<void>;
}

export class WatchBindError extends Error {}

const MAX_SSE_CLIENTS = 16;

/** True for a loopback address or the name `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.toLowerCase() === "localhost") return true;
  const family = isIP(bare);
  if (family === 4) return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  if (family === 6) return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
  return false;
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const DATA_CSP = "default-src 'none'; frame-ancestors 'none'";

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Security-Policy": DATA_CSP,
    "Content-Type": type,
    "Content-Length": String(Buffer.byteLength(body)),
    ...extra,
  });
  res.end(body);
}

const TEXT = "text/plain; charset=utf-8";
const FRAME_ROUTE = /^\/frames\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(0|[1-9]\d{0,5})$/;

export async function startWatchServer(opts: WatchServerOptions): Promise<WatchServer> {
  const host = opts.host ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  if (!loopback && opts.allowNonLoopback !== true)
    throw new WatchBindError(
      `refusing to bind ${host}: the watch view binds loopback only (pass the explicit non-loopback flag to override)`,
    );
  const runs = new Set(opts.runs);
  const tasks = new Set(opts.tasks ?? []);
  const tail = opts.decisionLog === undefined ? null : new DecisionLogTail(opts.decisionLog);
  const frames = opts.frames;

  let current: WatchState = { runs: [], events: [], skipped: 0, logPresent: false };
  let currentJson = "";
  const refresh = (): boolean => {
    tail?.poll();
    const log = tail?.snapshot() ?? { present: false, records: [], malformed: 0 };
    const projected = projectDecisions(log.records, { runs, tasks });
    const next: WatchState = {
      runs: opts.runs.map((runId) => ({ runId, frames: frames?.count(runId) ?? 0 })),
      events: projected.events,
      skipped: projected.skipped + log.malformed,
      logPresent: log.present,
    };
    const json = JSON.stringify(next);
    if (json === currentJson) return false;
    current = next;
    currentJson = json;
    return true;
  };
  refresh();

  const clients = new Set<ServerResponse>();
  const broadcast = () => {
    for (const client of clients) client.write(`event: state\ndata: ${currentJson}\n\n`);
  };
  const timer = setInterval(() => {
    try {
      if (refresh()) broadcast();
    } catch {
      // A failed poll keeps the last good state; the view never crashes the operator.
    }
  }, opts.pollMs ?? 250);
  const keepAlive = setInterval(() => {
    for (const client of clients) client.write(": keep-alive\n\n");
  }, 15_000);
  timer.unref();
  keepAlive.unref();

  let boundPort = 0;
  const allowedHosts = (): Set<string> => {
    const names = ["127.0.0.1", "localhost", "[::1]"];
    if (!loopback) names.push(host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);
    return new Set(names.map((name) => `${name.toLowerCase()}:${boundPort}`));
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // 1. Read-only: GET and nothing else, on every path, before anything else is looked at.
    if (req.method !== "GET") {
      send(res, 405, TEXT, "method not allowed: the watch view is read-only\n", { Allow: "GET" });
      req.resume();
      return;
    }
    // 2. Host must be this loopback server (DNS-rebinding defence).
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts().has(hostHeader)) {
      send(res, 421, TEXT, "misdirected request\n");
      return;
    }
    // 3. No cross-origin reads, and never a CORS grant.
    const origin = req.headers.origin;
    if (origin !== undefined && origin.toLowerCase() !== `http://${hostHeader}`) {
      send(res, 403, TEXT, "cross-origin request refused\n");
      return;
    }
    // 4. Exact routes only. No query, no encoding, no dot segments, no backslash.
    const url = req.url ?? "";
    if (!url.startsWith("/") || /[?#%\\]|\/\.\.?(\/|$)/.test(url)) {
      send(res, 400, TEXT, "bad request\n");
      return;
    }
    switch (url) {
      case "/":
        send(res, 200, "text/html; charset=utf-8", PAGE_HTML, {
          "Content-Security-Policy": PAGE_CSP,
        });
        return;
      case "/watch.css":
        send(res, 200, "text/css; charset=utf-8", PAGE_CSS);
        return;
      case "/watch.js":
        send(res, 200, "text/javascript; charset=utf-8", PAGE_JS);
        return;
      case "/api/state":
        send(res, 200, "application/json; charset=utf-8", currentJson);
        return;
      case "/api/events": {
        if (clients.size >= MAX_SSE_CLIENTS) {
          send(res, 503, TEXT, "too many watchers\n");
          return;
        }
        res.writeHead(200, {
          ...BASE_HEADERS,
          "Content-Security-Policy": DATA_CSP,
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
        });
        res.write(`retry: 1000\nevent: state\ndata: ${currentJson}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
    }
    const match = FRAME_ROUTE.exec(url);
    if (match && frames !== undefined && runs.has(match[1] as string)) {
      const frame = frames.read(match[1] as string, Number(match[2]));
      if (frame !== null) {
        send(res, 200, frame.contentType, frame.bytes, { "Content-Security-Policy": FRAME_CSP });
        return;
      }
    }
    send(res, 404, TEXT, "not found\n");
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) send(res, 500, TEXT, "internal error\n");
      else res.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: opts.port ?? 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const close = async () => {
    clearInterval(timer);
    clearInterval(keepAlive);
    for (const client of clients) client.end();
    clients.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  if (address === null || typeof address === "string") {
    await close();
    throw new WatchBindError("watch server did not bind a TCP address");
  }
  if (!isLoopbackHost(address.address) && opts.allowNonLoopback !== true) {
    await close();
    throw new WatchBindError(`watch server bound non-loopback ${address.address}; closed`);
  }
  boundPort = address.port;
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${urlHost}:${boundPort}/`,
    port: boundPort,
    host: address.address,
    state: () => current,
    close,
  };
}
