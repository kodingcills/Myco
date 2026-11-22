/**
 * Minimal stdio MCP client used once in S0: confirm the server's tool list matches the docs and make
 * one read-only call (`sai_machines`). The key is passed through the child's environment, never argv.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { scrub } from "./redact.ts";

export const DOCUMENTED_TOOLS = [
  "sai_machines",
  "sai_models",
  "sai_task_start",
  "sai_task_wait",
  "sai_task_approve",
  "sai_task_abort",
  "sai_upload",
  "sai_control_open",
  "sai_control_exec",
  "sai_control_interrupt",
  "sai_control_close",
] as const;

/** Also documented in docs, but outside the brief's list; reported separately, not required. */
export const DOCUMENTED_EXTRA_TOOLS = ["sai_live_link"] as const;

export interface McpCheck {
  ok: boolean;
  serverName: string | null;
  serverVersion: string | null;
  tools: string[];
  missingDocumented: string[];
  undocumented: string[];
  machinesCall: { isError: boolean; excerpt: string } | null;
  error: string | null;
  ms: number;
}

export function diffTools(tools: readonly string[]): { missing: string[]; undocumented: string[] } {
  const documented = new Set<string>([...DOCUMENTED_TOOLS, ...DOCUMENTED_EXTRA_TOOLS]);
  const have = new Set(tools);
  return {
    missing: DOCUMENTED_TOOLS.filter((t) => !have.has(t)),
    undocumented: tools.filter((t) => !documented.has(t)),
  };
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export async function checkMcpServer(
  apiKey: string,
  opts: { command?: string; args?: string[]; timeoutMs?: number } = {},
): Promise<McpCheck> {
  const t0 = Date.now();
  const command = opts.command ?? "npx";
  // Match the exact MCP version recorded in the S0 results.
  const args = opts.args ?? ["-y", "@simular-ai/sai-mcp@0.6.0"];
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const result: McpCheck = {
    ok: false,
    serverName: null,
    serverVersion: null,
    tools: [],
    missingDocumented: [],
    undocumented: [],
    machinesCall: null,
    error: null,
    ms: 0,
  };
  let child: ChildProcessWithoutNullStreams | null = null;
  const pending = new Map<number, Pending>();
  let buffer = "";
  try {
    child = spawn(command, args, {
      env: { PATH: process.env.PATH, SAI_API_KEY: apiKey },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", () => undefined); // never surfaced: may echo configuration
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line.startsWith("{")) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id;
          if (typeof id === "number" && pending.has(id)) {
            pending.get(id)?.resolve(msg);
            pending.delete(id);
          }
        } catch {
          // ignore non-JSON noise
        }
      }
    });
    const proc = child;
    let nextId = 1;
    const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`mcp ${method} timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject,
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "myco-sai-arm", version: "0.0.1" },
    });
    const info = ((init.result as Record<string, unknown> | undefined)?.serverInfo ?? {}) as Record<
      string,
      unknown
    >;
    result.serverName = typeof info.name === "string" ? info.name : null;
    result.serverVersion = typeof info.version === "string" ? info.version : null;
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const list = await request("tools/list", {});
    const tools = (
      ((list.result as Record<string, unknown> | undefined)?.tools ?? []) as Array<{
        name?: string;
      }>
    )
      .map((t) => t.name)
      .filter((n): n is string => typeof n === "string");
    result.tools = tools;
    const diff = diffTools(tools);
    result.missingDocumented = diff.missing;
    result.undocumented = diff.undocumented;

    if (tools.includes("sai_machines")) {
      const call = await request("tools/call", { name: "sai_machines", arguments: {} });
      const r = (call.result ?? {}) as { isError?: boolean; content?: Array<{ text?: string }> };
      const text = (r.content ?? []).map((c) => c.text ?? "").join(" ");
      result.machinesCall = { isError: r.isError === true, excerpt: scrub(text).slice(0, 400) };
    }
    result.ok = true;
  } catch (e) {
    result.error = scrub(e instanceof Error ? e.message : String(e));
  } finally {
    child?.kill("SIGTERM");
    result.ms = Date.now() - t0;
  }
  return result;
}
