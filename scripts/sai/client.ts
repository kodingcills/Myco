/**
 * Sai REST client. One attempt per call (no automatic retries), every call ledgered and passed to the
 * guard. The API key lives only in this closure; it is registered for redaction and never logged.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Approval } from "./approvals.ts";
import { type AccountView, type Guard, GuardStop, parseAccount, type SpendKind } from "./guard.ts";
import { excerpt, type Ledger } from "./ledger.ts";
import { registerSecret, scrub } from "./redact.ts";

export const DEFAULT_BASE_URL = "https://api.simular.ai";
export const SECRET_FILE = `${homedir()}/.myco/secrets/sai.env`;

/** Parse `SAI_API_KEY=...` from the one permitted file. Throws without echoing file contents. */
export function loadApiKey(file = SECRET_FILE): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error("could not read the Sai secret file");
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("SAI_API_KEY=")) {
      const value = line
        .slice("SAI_API_KEY=".length)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (value.length > 0) {
        registerSecret(value);
        return value;
      }
    }
  }
  throw new Error("SAI_API_KEY not found in the Sai secret file");
}

export interface HttpResult {
  status: number | null;
  ok: boolean;
  body: unknown;
  approval?: Approval;
  ms: number;
  error?: string;
}

export interface CallOptions {
  stage: string;
  label: string;
  method?: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** Billable class for the guard; omitted means read-only/no-model. */
  spend?: SpendKind;
  /** Exclude this path's query string from the ledger (cursors are opaque but long). */
  hideQuery?: boolean;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

const APPROVAL_SECRET = /(?:url|uri|link|token|code|secret|credential|password|key)$/i;

function approvalSafeBody(body: unknown): unknown {
  const secrets = new Set<string>();
  let longestFirst: string[] = [];
  const remember = (secret: string): void => {
    if (!secret) return;
    secrets.add(secret);
    if (!/^https?:/i.test(secret)) return;
    try {
      const url = new URL(secret);
      for (const [key, value] of url.searchParams) {
        if (value && key !== "from") secrets.add(value);
      }
    } catch {
      // An unparseable link is still sensitive in its entirety.
    }
  };
  function visit(value: unknown, collect: boolean, insideApproval = false): unknown {
    if (Array.isArray(value)) return value.map((item) => visit(item, collect, insideApproval));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => {
          if (/^approval$/i.test(name)) {
            if (collect) visit(item, true, true);
            return ["approval", { present: true }];
          }
          if (
            /^approval.*(?:url|uri|link|token|code|secret|credential|password|key)$/i.test(name)
          ) {
            if (collect && typeof item === "string") remember(item);
            return ["approvalSecretPresent", true];
          }
          if (collect && insideApproval && APPROVAL_SECRET.test(name) && typeof item === "string")
            remember(item);
          return [String(visit(name, false)), visit(item, collect, insideApproval)];
        }),
      );
    }
    if (collect && insideApproval && typeof value === "string") {
      for (const url of value.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) remember(url);
    }
    if (!collect && typeof value === "string") {
      let safe = value;
      for (const secret of longestFirst) safe = safe.replaceAll(secret, "[REDACTED]");
      return safe;
    }
    return value;
  }
  visit(body, true);
  longestFirst = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of longestFirst) registerSecret(secret);
  return visit(body, false);
}

export class SaiClient {
  constructor(
    private readonly apiKey: string,
    readonly ledger: Ledger,
    readonly guard: Guard,
    private readonly opts: { baseUrl?: string; fetchImpl?: FetchLike } = {},
  ) {
    registerSecret(apiKey);
  }

  private get baseUrl(): string {
    return this.opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  async call(o: CallOptions): Promise<HttpResult> {
    if (o.spend) this.guard.beforeSpend(o.spend);
    if (o.method === "POST" && o.path === "/v1/agents/message") this.guard.beforeMessage();
    const method = o.method ?? "GET";
    const fetchImpl: FetchLike = this.opts.fetchImpl ?? ((url, init) => fetch(url, init));
    const t0 = Date.now();
    let status: number | null = null;
    let text = "";
    let error: string | undefined;
    try {
      const res = await fetchImpl(`${this.baseUrl}${o.path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      error = scrub(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    const ms = Date.now() - t0;
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const approval =
      o.path.split("?")[0] === "/v1/agents/events"
        ? (body as { approval?: Approval } | null)?.approval
        : undefined;
    body = approvalSafeBody(body);
    const ok = status !== null && status >= 200 && status < 300;
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const displayPath = o.hideQuery ? o.path.split("?")[0] : o.path;
    this.ledger.append({
      stage: o.stage,
      label: o.label,
      kind: "http",
      method,
      ...(displayPath !== undefined ? { path: displayPath } : {}),
      status,
      ms,
      vendorStatus: typeof b.status === "string" ? b.status : null,
      reasonCode: typeof b.reason_code === "string" ? b.reason_code : null,
      vendorCode:
        typeof b.code === "string"
          ? b.code
          : typeof b.error === "string"
            ? scrub(b.error).slice(0, 80)
            : null,
      usage: b.usage ?? "not_reported",
      excerpt: excerpt(error ? { networkError: error } : body),
    });
    if (status !== null) this.guard.observeResponse(status, body, o.label);
    return { status, ok, body, ms, ...(approval ? { approval } : {}), ...(error ? { error } : {}) };
  }

  /** GET /account → guard observation. Also ledgers the balance. */
  async account(stage: string, label: string): Promise<AccountView> {
    const r = await this.call({ stage, label, path: "/v1/agents/account" });
    if (!r.ok) {
      throw new GuardStop({
        reason: "account_unreadable",
        detail: `GET /account returned ${String(r.status)}; cannot confirm free plan/credits`,
      });
    }
    const view = parseAccount(r.body);
    this.guard.observeAccount(view);
    return view;
  }

  async machineId(stage: string): Promise<string> {
    const r = await this.call({ stage, label: "machines", path: "/v1/agents/machines" });
    const machines = ((r.body as { machines?: unknown })?.machines ?? []) as Array<
      Record<string, unknown>
    >;
    const win = machines.find((m) => m.kind === "cloud");
    if (!win || typeof win.machineId !== "string") {
      throw new GuardStop({ reason: "no_cloud_machine", detail: "no hosted cloud machine listed" });
    }
    return win.machineId;
  }
}

/** UTF-16LE base64 for `powershell -EncodedCommand`. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** The command line `machine.exec` should run for a PowerShell script (kept short; see writeToFile for big files). */
export function powershellCommand(script: string): string {
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(script)}`;
}
