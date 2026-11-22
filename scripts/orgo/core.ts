import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const origin = "https://www.orgo.ai";
export const prefix = "myco-discovery-";
export const small = { cpu: 0.5, ram: 4, os: "linux" } as const;
export const uuid = /\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi;
/** Observed spend (cents) at which every allocation is refused and cleanup starts. */
export const stopCents = 120;
const budgetCents = 150;
const reserveCents = 30;
const trustedHosts = new Set(["www.orgo.ai", "docs.orgo.ai"]);

export type Computer = { id: string; name: string; status: string };
export type JsonObject = Record<string, unknown>;
export type Reply = { status: number; ms: number; data: JsonObject; body: string; code?: string };
export type Api = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: JsonObject,
) => Promise<Reply>;

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** A 20+ character run that mixes letters with digits (or cases) looks like a credential. */
function tokenLike(candidate: string): boolean {
  if (candidate.length < 20 || !/[A-Za-z]/.test(candidate)) return false;
  if (/^[A-Z]+(?:_[A-Z]+)+$/.test(candidate)) return false;
  return /\d/.test(candidate) || (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate));
}

function safeUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      trustedHosts.has(url.hostname) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      url.pathname.split("/").every((part) => !tokenLike(part.replace(uuid, "")))
    );
  } catch {
    return false;
  }
}

/** Remove the API key and every token-shaped string; shorten UUIDs to their first 8 characters. */
export function redact(value: string, key: string): string {
  return (key ? value.replaceAll(key, "[redacted]") : value)
    .replace(/(?:https?|wss?):\/\/[^\s"'<>\\]+/gi, (url) => (safeUrl(url) ? url : "[redacted-url]"))
    .replace(
      /(["']?(?:authorization|(?:set[-_])?cookie|(?:vnc[-_])?password|[a-z_-]*(?:token|secret|api[-_]?key))["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\r\n,}]+)/gi,
      '$1"[redacted]"',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk_[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(uuid, (id) => shortId(id))
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, (candidate) =>
      /\d/.test(candidate) && /[A-Za-z]/.test(candidate) ? "[redacted]" : candidate,
    )
    .replace(/[A-Za-z0-9_+=-]{20,}/g, (candidate) =>
      tokenLike(candidate) ? "[redacted]" : candidate,
    );
}

export function createApi(key: string, request: typeof fetch = fetch): Api {
  return async (method, path, payload) => {
    if (!path.startsWith("/api/")) throw new Error("Unexpected API path");
    const started = performance.now();
    try {
      const response = await request(origin + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(75_000),
      });
      const raw = await response.text();
      const ms = performance.now() - started;
      let data: JsonObject = {};
      try {
        data = object(JSON.parse(raw));
      } catch {
        // Keep the sanitized body for non-JSON errors.
      }
      return {
        status: response.status,
        ms,
        data,
        body: redact(raw, key),
        code: typeof data.code === "string" ? redact(data.code, key) : undefined,
      };
    } catch {
      throw new Error("Orgo request failed before a response was read");
    }
  };
}

export function requireOk(reply: Reply, operation: string): JsonObject {
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`${operation} returned HTTP ${reply.status} ${reply.body}`);
  }
  return reply.data;
}

export function balanceCents(reply: Reply): number {
  const cents = requireOk(reply, "Balance").balanceCents;
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) {
    throw new Error("Balance is missing or invalid");
  }
  return cents;
}

/**
 * Hard guard: refuses any create/fork/clone when observed spend has reached the $1.20 stop rule,
 * when credit cannot be established, or when the allocation would exceed two live computers.
 */
export function guard(start: number, balance: number, count: number, additional: number) {
  if (![start, balance, count, additional].every(Number.isFinite) || balance < reserveCents) {
    throw new Error("Cannot establish available credit");
  }
  const spent = start - balance;
  if (spent >= stopCents || spent + reserveCents > budgetCents) {
    throw new Error("Observed spend reached the $1.20 stop rule");
  }
  if (count + additional > 2) throw new Error("Computer limit is two, including the new copy");
}

export function inventory(workspace: JsonObject): Computer[] {
  const rows = Array.isArray(workspace.desktops) ? workspace.desktops : [];
  return rows
    .map(object)
    .filter((row) => typeof row.id === "string")
    .map((row) => ({
      id: String(row.id),
      name: typeof row.name === "string" ? row.name : "",
      status: typeof row.status === "string" ? row.status : "unknown",
    }))
    .filter(({ status }) => status !== "deleted");
}

/** Only computers this tool names `myco-discovery-*` are ever selected for deletion. */
export function cleanupSelection(computers: Computer[]) {
  return computers.filter(({ name }) => name.startsWith(prefix));
}

export type Offer = {
  name: string;
  cpu: number;
  ramGb: number;
  diskGb: number;
  usdPerHour: number;
};
export type Preflight = {
  ok: boolean;
  reasons: string[];
  tier: string;
  mode: string;
  balanceCents: number | null;
  inventoryCount: number | null;
  offers: Offer[];
};

export function parseOffers(compute: JsonObject): Offer[] {
  const entries = Array.isArray(compute.entries) ? compute.entries : [];
  return entries.flatMap((entry) => {
    const sku = object(object(entry).sku);
    const spec = object(sku.specification);
    const price = object(object(object(entry).offer).price);
    return typeof sku.name === "string" &&
      typeof spec.cpu === "number" &&
      typeof spec.ramGb === "number"
      ? [
          {
            name: sku.name,
            cpu: spec.cpu,
            ramGb: spec.ramGb,
            diskGb: typeof spec.diskGb === "number" ? spec.diskGb : 0,
            usdPerHour:
              typeof price.activeMicrosPerHour === "number"
                ? price.activeMicrosPerHour / 1_000_000
                : Number.NaN,
          },
        ]
      : [];
  });
}

/**
 * Read-only eligibility check from PROTOCOL.md: an explicit Small (0.5 vCPU, 4 GB) hourly create
 * must be offered, the account must not be Free (docs: Free always gets a Medium), the balance must
 * clear the reserve and the inventory must be empty. Anything else stops before the POST.
 */
export function assessPreflight(input: {
  tier: string;
  mode: string;
  balanceCents: number | null;
  offers: Offer[];
  inventoryCount: number | null;
}): Preflight {
  const reasons: string[] = [];
  const free = input.tier === "free" || input.mode === "free";
  if (free) {
    reasons.push(
      "Free account: Orgo runs hourly computers as Medium only and a create naming another size still gets a Medium (docs: create, account-limits, instance-types)",
    );
  }
  const hasSmall = input.offers.some(
    (offer) => offer.cpu === small.cpu && offer.ramGb === small.ram,
  );
  if (!hasSmall) {
    reasons.push(
      `billing/compute offers no Small (0.5 vCPU, 4 GB): ${input.offers.map((o) => `${o.name} ${o.cpu} vCPU ${o.ramGb} GB`).join("; ") || "no offers"}`,
    );
  }
  if (input.balanceCents === null || input.balanceCents < reserveCents) {
    reasons.push("Balance is missing or below the reserve");
  }
  if (input.inventoryCount !== 0) reasons.push("Workspace inventory is not empty");
  return { ok: reasons.length === 0, reasons, ...input };
}

export function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n, min: null, median: null, p95: null, max: null };
  return {
    n,
    min: sorted[0] ?? null,
    median: ((sorted[Math.floor((n - 1) / 2)] ?? 0) + (sorted[Math.floor(n / 2)] ?? 0)) / 2,
    p95: sorted[Math.ceil(n * 0.95) - 1] ?? null,
    max: sorted[n - 1] ?? null,
  };
}

export type LedgerRow = {
  operation: string;
  timestamp: string;
  computer: string | null;
  status: number | null;
  code: string | null;
  latencyMs: number | null;
  body?: string;
  beforeCents: number | null;
  immediateCents: number | null;
  delayedCents: number | null;
  spendCents: number | null;
};

export async function sampleBalances(
  read: () => Promise<number>,
  wait: () => Promise<void> = () => delay(2_000),
) {
  const immediateCents = await read().catch(() => null);
  await wait();
  const delayedCents = await read().catch(() => null);
  return { immediateCents, delayedCents };
}

export async function appendLedger(path: string, row: LedgerRow, key: string) {
  const fields = {
    ...row,
    operation: redact(row.operation, key),
    computer: row.computer ? redact(row.computer, key) : null,
    code: row.code ? redact(row.code, key) : null,
    ...(row.body === undefined ? {} : { body: redact(row.body, key).slice(0, 600) }),
  };
  await appendFile(path, `${JSON.stringify(fields)}\n`, { mode: 0o600 });
}
