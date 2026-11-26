/**
 * Track S: the webhook trigger — an HTTP endpoint on loopback only, with an HMAC check.
 *
 *   POST /v1/trigger/<scheduleId>
 *   x-myco-delivery:  <id, 1-128 of [A-Za-z0-9._-]>   (the idempotency key)
 *   x-myco-signature: sha256=<hex HMAC-SHA256(secret, "myco.schedule.webhook/v1\n" +
 *                                              scheduleId + "\n" + delivery + "\n" + body)>
 *
 * Security model (docs/schedule/security.md):
 *  - The server binds 127.0.0.1 or ::1 only; any other host is refused at start.
 *  - The secret is read from the operator's secrets file at the point of use, per request
 *    (`readSecretFromFile`), held in a local only, and never logged or echoed. A missing
 *    or unreadable secret refuses every request (503), it never disables the check.
 *  - The signature covers the schedule id and the delivery id, so a captured request
 *    cannot be re-aimed at another schedule or replayed under a fresh delivery id; a
 *    replay under the same delivery id is a DUPLICATE (the scheduler's idempotency).
 *  - The comparison is constant-time. Header problems and a wrong signature return the
 *    same 401 code, so the endpoint does not say which part was wrong.
 *  - The body is capped (`maxBodyBytes`) and otherwise ignored: a webhook fires its
 *    schedule; it cannot choose a task, a run id, a claim or any oracle input.
 *  - Responses are JSON with a code (and the run id when admitted). Never a reason text.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readSecretFromFile } from "../baseline/secret-file.ts";
import { errorCode } from "../gate/reasons.ts";
import type { SecretRef } from "./config.ts";
import type { Scheduler, Submission } from "./scheduler.ts";

export const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
const DELIVERY = /^[A-Za-z0-9._-]{1,128}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const PATH = /^\/v1\/trigger\/([a-z0-9][a-z0-9-]{0,47})$/;

export function webhookSignature(
  secret: string,
  scheduleId: string,
  delivery: string,
  body: Buffer | string,
): string {
  const mac = createHmac("sha256", secret)
    .update(`myco.schedule.webhook/v1\n${scheduleId}\n${delivery}\n`)
    .update(body)
    .digest("hex");
  return `sha256=${mac}`;
}

export interface WebhookOptions {
  readonly scheduler: Pick<Scheduler, "submit">;
  readonly secret: SecretRef;
  readonly port: number;
  readonly host?: (typeof LOOPBACK_HOSTS)[number];
  readonly maxBodyBytes?: number;
  /** Called with each admitted submission (so the service can await its row). */
  readonly onSubmission?: (s: Submission) => void;
  readonly onDiagnostic?: (code: string) => void;
}

const STATUS: Record<string, number> = {
  UNKNOWN_SCHEDULE: 404,
  SOURCE_NOT_ENABLED: 403,
  PAUSED: 423,
  DUPLICATE: 409,
  BUDGET_RUNS_PER_DAY: 429,
  BUDGET_CONCURRENCY: 429,
  STATE_WRITE_FAILED: 500,
};

function reply(res: ServerResponse, status: number, body: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

export interface WebhookServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export async function startWebhookServer(opts: WebhookOptions): Promise<WebhookServer> {
  const host = opts.host ?? "127.0.0.1";
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host))
    throw new Error("the schedule webhook binds loopback only (127.0.0.1 or ::1)");
  const max = opts.maxBodyBytes ?? 64 * 1024;
  const diag = (code: string) => {
    try {
      opts.onDiagnostic?.(code);
    } catch {
      // never changes a response
    }
  };

  const handle = (req: IncomingMessage, res: ServerResponse, body: Buffer) => {
    const m = PATH.exec(req.url ?? "");
    if (!m) return reply(res, 404, { code: "NOT_FOUND" });
    const scheduleId = m[1] as string;
    const delivery = req.headers["x-myco-delivery"];
    const sigHeader = req.headers["x-myco-signature"];
    const sig = typeof sigHeader === "string" ? SIGNATURE.exec(sigHeader) : null;
    if (typeof delivery !== "string" || !DELIVERY.test(delivery) || !sig) {
      diag("WEBHOOK_BAD_SIGNATURE");
      return reply(res, 401, { code: "BAD_SIGNATURE" });
    }
    let expected: string;
    try {
      const secret = readSecretFromFile(opts.secret.file, opts.secret.name);
      expected = webhookSignature(secret, scheduleId, delivery, body).slice("sha256=".length);
    } catch (e) {
      diag(`WEBHOOK_SECRET_UNAVAILABLE:${errorCode(e)}`);
      return reply(res, 503, { code: "SECRET_UNAVAILABLE" });
    }
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig[1] as string, "hex");
    if (a.length !== 32 || b.length !== 32 || !timingSafeEqual(a, b)) {
      diag("WEBHOOK_BAD_SIGNATURE");
      return reply(res, 401, { code: "BAD_SIGNATURE" });
    }
    const sub = opts.scheduler.submit({ scheduleId, source: "webhook", key: delivery });
    opts.onSubmission?.(sub);
    if (sub.admission.admitted)
      return reply(res, 202, { code: "ACCEPTED", runId: sub.admission.runId });
    return reply(res, STATUS[sub.admission.code] ?? 400, { code: sub.admission.code });
  };

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      req.resume();
      return reply(res, 405, { code: "METHOD_NOT_ALLOWED" });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        reply(res, 413, { code: "BODY_TOO_LARGE" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      try {
        handle(req, res, Buffer.concat(chunks));
      } catch (e) {
        diag(`WEBHOOK_INTERNAL:${errorCode(e)}`);
        if (!res.headersSent) reply(res, 500, { code: "INTERNAL" });
      }
    });
    req.on("error", () => diag("WEBHOOK_REQUEST_ERROR"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
