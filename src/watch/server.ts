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
 *  - Frames are rebuilt, never copied (`sanitize-frame.ts`): a PNG is re-encoded from its
 *    pixels alone, SVG is served only when this process rendered it, anything else is
 *    refused, and a backstop scan refuses bytes carrying host paths, the username or text.
 *  - Bounded memory. At most 16 SSE watchers. A watcher that has not drained its last
 *    message is not written to again (it gets the latest state once it drains, so updates
 *    coalesce), and one stalled longer than `sseStallMs`, or holding more than
 *    `sseMaxBufferedBytes` unsent, is disconnected. The state carries at most `maxEvents`
 *    events (the latest), so one message is bounded too.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { DecisionLogTail } from "./decision-log.ts";
import { projectDecisions, type WatchEvent } from "./events.ts";
import { type FrameSource, readRegular } from "./frames.ts";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "./page.ts";
import { runTrust } from "./run-trust.ts";
import { hostNeedles, servableFrame } from "./sanitize-frame.ts";
import {
  type JoinedDecision,
  type JoinedFrame,
  joinTimeline,
  readManifest,
  type TimelineCode,
} from "./timeline.ts";

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
  /**
   * Each listed run's own decision log: the audit log of the one gate bound to that trial
   * (replay B2, spec #589 §1.2). The replay join of a run uses its own log, or `decisionLog`
   * when exactly one run is listed. With these, the live events of a run come from its own
   * log only. Read-only.
   */
  readonly decisionLogs?: ReadonlyMap<string, string>;
  readonly frames?: FrameSource;
  /** How often the log and frames are re-read. Default 250 ms. */
  readonly pollMs?: number;
  /** Most events the state carries (the latest ones). Default 2000. */
  readonly maxEvents?: number;
  /** A watcher that has not drained for this long is disconnected. Default 30 s. */
  readonly sseStallMs?: number;
  /** A watcher holding more unsent bytes than this is disconnected. Default 8 MiB. */
  readonly sseMaxBufferedBytes?: number;
  /** Most open TCP connections; the next is closed at once. Default 64. */
  readonly maxConnections?: number;
  /**
   * A connection with no read or write activity for this long is destroyed (a client that
   * stops reading a response). Default 60 s; keep it above the 15 s SSE keep-alive.
   */
  readonly idleSocketMs?: number;
}

export interface WatchState {
  readonly runs: readonly { readonly runId: string; readonly frames: number }[];
  /**
   * Machine mark (spec #589 §2.6): the listed runs that are verified real runs (run-trust.ts).
   * Every other run is mock and the page watermarks every frame of it. Fail closed: a run is
   * real only by being named here, so a missing or unreadable field leaves every run mock.
   */
  readonly realRuns: readonly string[];
  readonly events: readonly WatchEvent[];
  /** Earlier events left out because the state carries at most `maxEvents`. */
  readonly omitted: number;
  readonly skipped: number;
  readonly logPresent: boolean;
}

/**
 * `GET /timeline/<run>` (replay B2): the joined timeline of one listed run. Closed fields only:
 * frame ordinals, straddle ordinals, decision ordinals and call numbers, verdicts, `REASON_CODES`
 * members, the "named another trial" flag and `TIMELINE_CODES` members. No digest, no path, no
 * claim, no reason text. When the join is invalid, `decisions` is empty: nothing is pinned.
 */
export interface TimelineView {
  readonly runId: string;
  /** Machine mark: true unless the run is a verified real run. */
  readonly mock: boolean;
  /** The watermark the page draws on every frame (`MOCK · NOT EVIDENCE`), or null. */
  readonly watermark: string | null;
  readonly joined: boolean;
  readonly code: TimelineCode | null;
  readonly frameCount: number;
  readonly frames: readonly JoinedFrame[];
  readonly decisions: readonly JoinedDecision[];
}

/** SSE bookkeeping, for tests and diagnostics. */
export interface SseStats {
  readonly clients: number;
  /** The largest unsent byte count any watcher has held since the server started. */
  readonly maxBufferedBytes: number;
  /** Watchers disconnected for stalling or holding too much. */
  readonly dropped: number;
  /** Times a watcher stopped draining (it may recover; see `sseStallMs`). */
  readonly stalls: number;
}

export interface WatchServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  /** The current state, exactly as `/api/state` serves it. */
  state(): WatchState;
  sse(): SseStats;
  /** Open TCP connections right now, for tests and diagnostics. */
  connections(): Promise<number>;
  close(): Promise<void>;
}

export class WatchBindError extends Error {}

export const MAX_SSE_CLIENTS = 16;
export const DEFAULT_MAX_CONNECTIONS = 64;
export const DEFAULT_IDLE_SOCKET_MS = 60_000;
export const DEFAULT_MAX_EVENTS = 2000;

/**
 * The `Host` header values this server answers (DNS-rebinding defence): the loopback names
 * and the bind host itself (e.g. 127.0.0.2), each with the bound port, lowercased.
 * `listenHost` is the bare address passed to listen() (no brackets).
 */
export function allowedHostHeaders(listenHost: string, port: number): Set<string> {
  const names = ["127.0.0.1", "localhost", "[::1]"];
  names.push(listenHost.includes(":") ? `[${listenHost}]` : listenHost);
  return new Set(names.map((name) => `${name.toLowerCase()}:${port}`));
}

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
const TIMELINE_ROUTE = /^\/timeline\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
const FRAME_ROUTE = /^\/frames\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(0|[1-9]\d{0,5})$/;

export async function startWatchServer(opts: WatchServerOptions): Promise<WatchServer> {
  const host = opts.host ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  if (!loopback && opts.allowNonLoopback !== true)
    throw new WatchBindError(
      `refusing to bind ${host}: the watch view binds loopback only (pass the explicit non-loopback flag to override)`,
    );
  // `[::1]` is a URL form; listen() wants the bare address.
  const listenHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  const stallMs = opts.sseStallMs ?? 30_000;
  const maxBuffered = opts.sseMaxBufferedBytes ?? 8 * 1024 * 1024;
  const needles = hostNeedles();
  const runs = new Set(opts.runs);
  const tasks = new Set(opts.tasks ?? []);
  const frames = opts.frames;
  const ownLogs = opts.decisionLogs ?? new Map<string, string>();
  for (const runId of ownLogs.keys())
    if (!runs.has(runId)) throw new Error("a per-run decision log names a run that is not listed");
  const tail =
    opts.decisionLog === undefined || ownLogs.size > 0
      ? null
      : new DecisionLogTail(opts.decisionLog);
  // With per-run logs, each run's live events come from its own log only.
  const ownTails = [...ownLogs].map(([runId, path]) => ({
    runId,
    tail: new DecisionLogTail(path),
  }));
  /** The run's own decision log for the replay join, or null (§1.2: never a shared log). */
  const ownLogOf = (runId: string): string | null =>
    ownLogs.get(runId) ??
    (ownLogs.size === 0 && opts.runs.length === 1 ? (opts.decisionLog ?? null) : null);
  const trustOf = (runId: string) =>
    runTrust({ runId, frames: frames?.provenance ?? "rendered", verified: null });

  /** The joined timeline of one listed run, as `/timeline/<run>` serves it. */
  const timelineView = (runId: string): TimelineView => {
    const trust = trustOf(runId);
    const frameCount = frames?.count(runId) ?? 0;
    const unjoined = (code: TimelineCode): TimelineView => ({
      runId,
      mock: trust.mock,
      watermark: trust.watermark,
      joined: false,
      code,
      frameCount,
      frames: [],
      decisions: [],
    });
    const logPath = ownLogOf(runId);
    const manifestPath = frames?.timelineFile?.(runId) ?? null;
    if (logPath === null || manifestPath === null || frames === undefined)
      return unjoined("TL_NO_TIMELINE");
    // The task the run's gate is bound to comes from the operator, never from the log. With
    // no single listed task the binding cannot be checked, so the join is refused.
    const taskId = opts.tasks?.length === 1 ? opts.tasks[0] : undefined;
    if (taskId === undefined) return unjoined("TL_LOG_BINDING");
    const join = joinTimeline({
      binding: { taskId, runId },
      listedRuns: runs,
      manifest: readManifest(manifestPath),
      frameCount,
      frameBytes: (index) => frames.read(runId, index)?.bytes ?? null,
      log: readRegular(logPath) ?? Buffer.alloc(0),
    });
    if (!join.ok) return unjoined(join.code);
    return {
      runId,
      mock: trust.mock,
      watermark: trust.watermark,
      joined: true,
      code: null,
      frameCount,
      // Allowlist: every field rebuilt from the join's closed values, none copied through.
      frames: join.frames.map((f) => ({ frame: f.frame, straddles: [...f.straddles] })),
      decisions: join.decisions.slice(-maxEvents).map((d) => ({
        ordinal: d.ordinal,
        call: d.call,
        verdict: d.verdict,
        accepted: d.accepted,
        reasonCodes: [...d.reasonCodes],
        namedAnotherTrial: d.namedAnotherTrial,
        frame: d.frame,
      })),
    };
  };

  let current: WatchState = {
    runs: [],
    realRuns: [],
    events: [],
    omitted: 0,
    skipped: 0,
    logPresent: false,
  };
  let currentJson = "";
  const readLogs = () => {
    if (tail !== null) {
      tail.poll();
      const log = tail.snapshot();
      const projected = projectDecisions(log.records, { runs, tasks });
      return { ...projected, malformed: log.malformed, present: log.present };
    }
    const events: WatchEvent[] = [];
    let skipped = 0;
    let malformed = 0;
    let present = false;
    for (const own of ownTails) {
      own.tail.poll();
      const log = own.tail.snapshot();
      const projected = projectDecisions(log.records, { runs: new Set([own.runId]), tasks });
      for (const event of projected.events) events.push({ ...event, seq: events.length + 1 });
      skipped += projected.skipped;
      malformed += log.malformed;
      present ||= log.present;
    }
    return { events, skipped, malformed, present };
  };
  const refresh = (): boolean => {
    const log = readLogs();
    const projected = log;
    const omitted = Math.max(0, projected.events.length - maxEvents);
    const next: WatchState = {
      runs: opts.runs.map((runId) => ({ runId, frames: frames?.count(runId) ?? 0 })),
      realRuns: opts.runs.filter((runId) => !trustOf(runId).mock),
      events: omitted === 0 ? projected.events : projected.events.slice(omitted),
      omitted,
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

  interface Client {
    readonly res: ServerResponse;
    /** A newer state arrived while the watcher was still draining. */
    dirty: boolean;
    /** When the watcher last stopped draining (null while it keeps up). */
    stalledSince: number | null;
  }
  const clients = new Set<Client>();
  let maxBufferedSeen = 0;
  let dropped = 0;
  let stalls = 0;
  const drop = (client: Client) => {
    if (!clients.delete(client)) return;
    dropped += 1;
    client.res.destroy();
  };
  const stateMessage = () => `event: state\ndata: ${currentJson}\n\n`;
  /** Write only to a watcher that has drained; otherwise remember it owes the latest state. */
  const push = (client: Client, message: string, coalesce: boolean) => {
    if (client.res.writableNeedDrain) {
      if (coalesce) client.dirty = true;
      if (client.stalledSince === null) {
        client.stalledSince = Date.now();
        stalls += 1;
      }
      return;
    }
    client.res.write(message);
    maxBufferedSeen = Math.max(maxBufferedSeen, client.res.writableLength);
    if (client.res.writableLength > maxBuffered) drop(client);
  };
  const sweep = () => {
    const now = Date.now();
    for (const client of clients)
      if (client.stalledSince !== null && now - client.stalledSince > stallMs) drop(client);
  };
  const broadcast = () => {
    const message = stateMessage();
    for (const client of clients) push(client, message, true);
  };
  const timer = setInterval(() => {
    try {
      if (refresh()) broadcast();
      sweep();
    } catch {
      // A failed poll keeps the last good state; the view never crashes the operator.
    }
  }, opts.pollMs ?? 250);
  const keepAlive = setInterval(() => {
    for (const client of clients) push(client, ": keep-alive\n\n", false);
  }, 15_000);
  timer.unref();
  keepAlive.unref();

  let boundPort = 0;
  const allowedHosts = (): Set<string> => allowedHostHeaders(listenHost, boundPort);

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
        const client: Client = { res, dirty: false, stalledSince: null };
        clients.add(client);
        res.on("drain", () => {
          client.stalledSince = null;
          if (client.dirty && clients.has(client)) {
            client.dirty = false;
            push(client, stateMessage(), true);
          }
        });
        req.on("close", () => clients.delete(client));
        push(client, `retry: 1000\n${stateMessage()}`, true);
        return;
      }
    }
    const timeline = TIMELINE_ROUTE.exec(url);
    if (timeline && runs.has(timeline[1] as string)) {
      send(
        res,
        200,
        "application/json; charset=utf-8",
        JSON.stringify(timelineView(timeline[1] as string)),
      );
      return;
    }
    const match = FRAME_ROUTE.exec(url);
    if (match && frames !== undefined && runs.has(match[1] as string)) {
      const read = frames.read(match[1] as string, Number(match[2]));
      const frame = read === null ? null : servableFrame(read, needles);
      if (frame !== null) {
        send(res, 200, frame.contentType, frame.bytes, {
          "Content-Security-Policy": FRAME_CSP,
          // Machine mark on every frame of a mock run; the page draws the watermark over it.
          ...(trustOf(match[1] as string).mock ? { "X-Myco-Mock": "1" } : {}),
        });
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
  // Bound what clients that stop reading can hold (verifier N1): a cap on connections, and an
  // idle timeout that destroys a socket whose response stopped moving. With no 'timeout'
  // listener, Node destroys the socket.
  server.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  server.setTimeout(opts.idleSocketMs ?? DEFAULT_IDLE_SOCKET_MS);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: listenHost, port: opts.port ?? 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const close = async () => {
    clearInterval(timer);
    clearInterval(keepAlive);
    // destroy, not end: a stalled watcher would otherwise hold close() open.
    for (const client of clients) client.res.destroy();
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
    sse: () => ({ clients: clients.size, maxBufferedBytes: maxBufferedSeen, dropped, stalls }),
    connections: () =>
      new Promise<number>((resolve) =>
        server.getConnections((error, n) => resolve(error ? -1 : n)),
      ),
    close,
  };
}
