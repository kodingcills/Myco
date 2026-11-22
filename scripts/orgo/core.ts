import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const origin = "https://www.orgo.ai";
export const prefix = "myco-discovery-";
export const small = { cpu: 0.5, ram: 4, os: "linux" } as const;
export const uuid = /\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi;
export const medium = { cpu: 2, ram: 8, os: "linux" } as const;
export const smallLimits = { stopCents: 120, budgetCents: 150, reserveCents: 30, maxComputers: 2 };
export const probeLimits = { stopCents: 15, budgetCents: 25, reserveCents: 5, maxComputers: 1 };
const trustedHosts = new Set(["www.orgo.ai", "docs.orgo.ai"]);

export type Computer = { id: string; name: string; status: string };
export type JsonObject = Record<string, unknown>;
export type Reply = { status: number; ms: number; data: JsonObject; body: string; code?: string };
export type Api = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  payload?: JsonObject,
  signal?: AbortSignal,
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

const apiRoutes = {
  GET: [
    /^\/api\/credits(?:\/transactions)?$/,
    /^\/api\/workspaces(?:\/[\w-]+)?$/,
    /^\/api\/billing\/compute\?workspace_id=[\w-]+$/,
    /^\/api\/computers\/[\w-]+$/,
  ],
  POST: [
    /^\/api\/computers$/,
    /^\/api\/computers\/[\w-]+\/(?:bash|fork|clone|stop|start|suspend|resume)$/,
  ],
  DELETE: [/^\/api\/computers\/[\w-]+$/],
};

export function createApi(key: string, request: typeof fetch = fetch): Api {
  return async (method, path, payload, deadline) => {
    if (!path.startsWith("/api/") || !apiRoutes[method].some((route) => route.test(path)))
      throw new Error("Unexpected API path");
    const started = performance.now();
    const timeout = AbortSignal.timeout(75_000);
    const signal = deadline ? AbortSignal.any([deadline, timeout]) : timeout;
    // Bound both the fetch and body read, even if an injected transport ignores cancellation.
    let abort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const response = await Promise.race([
        cancelled,
        request(origin + path, {
          method,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          redirect: "error",
          signal,
        }),
      ]);
      const raw = await Promise.race([cancelled, response.text()]);
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
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
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

/** Refuse a transition when credit, spend or inventory exceeds its limit. */
export function guard(
  start: number,
  balance: number,
  count: number,
  additional: number,
  limits = smallLimits,
  gateObservation = false,
) {
  if (
    ![start, balance, count, additional].every(Number.isFinite) ||
    balance < limits.reserveCents
  ) {
    throw new Error("Cannot establish available credit");
  }
  const spent = start - balance;
  if (spent >= limits.stopCents || spent + limits.reserveCents > limits.budgetCents) {
    throw new Error(`Observed spend reached the ${limits.stopCents}c stop rule`);
  }
  if (
    count > limits.maxComputers ||
    count + additional > limits.maxComputers + Number(gateObservation)
  ) {
    throw new Error(`Computer limit is ${limits.maxComputers}, including the new copy`);
  }
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

/**
 * Computers cleanup deletes: names starting `myco-discovery-`, every id this run created
 * (Orgo auto-names forks, e.g. `agent-1 (fork)`), and every computer absent at preflight
 * (inventory delta), regardless of name. Without a scope only the name prefix applies.
 */
export function cleanupSelection(
  computers: Computer[],
  scope: { created?: Iterable<string>; baseline?: Iterable<string> } = {},
) {
  const created = new Set(scope.created ?? []);
  const baseline = scope.baseline === undefined ? null : new Set(scope.baseline);
  return computers.filter(
    ({ id, name }) =>
      name.startsWith(prefix) || created.has(id) || (baseline !== null && !baseline.has(id)),
  );
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
  profile?: "probe" | "small";
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

/** Read-only eligibility for the Free Medium probe or the paid Small run. */
export function assessPreflight(input: {
  tier: string;
  mode: string;
  balanceCents: number | null;
  offers: Offer[];
  inventoryCount: number | null;
}): Preflight {
  const reasons: string[] = [];
  const free = input.tier.toLowerCase() === "free" || input.mode.toLowerCase() === "free";
  if (free) {
    const [offer] = input.offers;
    if (
      input.offers.length !== 1 ||
      offer?.name !== "Medium" ||
      offer.cpu !== medium.cpu ||
      offer.ramGb !== medium.ram ||
      offer.usdPerHour !== 0.055
    ) {
      reasons.push("Free probe requires exactly Medium (2 vCPU, 8 GB, $0.055/h)");
    }
  } else if (!input.offers.some((offer) => offer.cpu === small.cpu && offer.ramGb === small.ram)) {
    reasons.push("billing/compute offers no Small (0.5 vCPU, 4 GB)");
  }
  const needed = free ? probeLimits.budgetCents : smallLimits.reserveCents;
  if (
    input.balanceCents === null ||
    !Number.isFinite(input.balanceCents) ||
    input.balanceCents < needed
  ) {
    reasons.push(`Balance is missing or below the ${needed}c preflight minimum`);
  }
  if (input.inventoryCount !== 0) reasons.push("Workspace inventory is unknown or nonempty");
  return { ok: reasons.length === 0, reasons, profile: free ? "probe" : "small", ...input };
}

export function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n, min: null, median: null, p95: null, max: null };
  return {
    n,
    min: sorted[0] ?? null,
    median: ((sorted[Math.floor((n - 1) / 2)] ?? 0) + (sorted[Math.floor(n / 2)] ?? 0)) / 2,
    p95: n < 2 ? null : (sorted[Math.ceil(n * 0.95) - 1] ?? null),
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
