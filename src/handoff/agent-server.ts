/**
 * `myco-handoff` MCP server (capability track N): the agent's side of a handoff.
 *
 * A separate server from `myco-gate` (whose one tool still takes only taskId/runId/claim) and
 * from the actuator. Two tools, both built on `HandoffBroker.agentChannel()`, which has no
 * resolve verb:
 *
 *  - `myco_handoff_request {reason, note}`  open a handoff; the call waits (long-poll, up to
 *                                           `waitMs`) and returns its status.
 *  - `myco_handoff_await {handoffId}`       keep waiting on an open handoff.
 *
 * A result is `paused` (still open: call `myco_handoff_await` again), `resumed` (outcome
 * `approve` or `fixed-it`, and the human's note if any), `rejected`, `ended` (the attempt is
 * over: stop) or `refused` (a code saying why). Results carry codes and the human's validated
 * note only: no host path, no operator token, no deadline clock (docs/handoff/security.md §3).
 *
 * There is no resolve tool and no input that names an outcome: an agent calling anything else
 * gets `unknown tool`. The JSON-RPC rules mirror `src/gate/mcp-server.ts`.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentHandoffChannel, HandoffStatus } from "./broker.ts";
import { AGENT_NOTE_LIMIT, HANDOFF_API_VERSION, HANDOFF_ID, HANDOFF_REASONS } from "./protocol.ts";

export const HANDOFF_REQUEST_TOOL = "myco_handoff_request";
export const HANDOFF_AWAIT_TOOL = "myco_handoff_await";
export const HANDOFF_SERVER_NAME = "myco-handoff";
export const HANDOFF_SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Default long-poll per call: below common MCP client tool timeouts. */
export const DEFAULT_AGENT_WAIT_MS = 20_000;

export const HANDOFF_INSTRUCTIONS =
  "Myco's human handoff. When you are uncertain, need a human's approval, or are blocked, call " +
  'myco_handoff_request with reason "uncertain", "needs-approval" or "blocked" and a short note ' +
  "(one line, at most 280 characters, no file paths or secrets). You are paused until a human " +
  'answers. "paused": call myco_handoff_await with the handoffId. "resumed": continue; if the ' +
  'outcome is "fixed-it" the human changed the desktop, so look again before acting. "rejected": ' +
  'do not do what you asked about. "ended": stop, the attempt is over. A handoff never verifies ' +
  "a task: only myco_gate_check does.";

export const HANDOFF_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      enum: [...HANDOFF_REASONS],
      description: "Why you need a human: uncertain, needs-approval or blocked.",
    },
    note: {
      type: "string",
      maxLength: AGENT_NOTE_LIMIT,
      description: "One short line for the human: what you need. No paths, no secrets.",
    },
  },
  required: ["reason", "note"],
  additionalProperties: false,
} as const;

export const HANDOFF_AWAIT_SCHEMA = {
  type: "object",
  properties: {
    handoffId: {
      type: "string",
      pattern: HANDOFF_ID.source,
      description: "The handoffId a paused result gave you.",
    },
  },
  required: ["handoffId"],
  additionalProperties: false,
} as const;

export function handoffToolDefinitions(): object[] {
  return [
    {
      name: HANDOFF_REQUEST_TOOL,
      title: "Ask a human (Myco handoff)",
      description:
        `Pause and ask the human operator (${HANDOFF_API_VERSION}). Returns paused, resumed, ` +
        "rejected, ended or refused. It never acts on the desktop and never verifies a task.",
      inputSchema: HANDOFF_REQUEST_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: HANDOFF_AWAIT_TOOL,
      title: "Wait for the human (Myco handoff)",
      description: "Keep waiting on a paused handoff. Same results as myco_handoff_request.",
      inputSchema: HANDOFF_AWAIT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}

export interface HandoffServeOptions {
  /** Long-poll per call, ms. Default `DEFAULT_AGENT_WAIT_MS`. */
  readonly waitMs?: number;
}

/** The agent-facing result body. */
export type AgentHandoffResult = { readonly apiVersion: typeof HANDOFF_API_VERSION } & (
  | HandoffStatus
  | { readonly status: "refused"; readonly code: "INVALID_REQUEST" | "UNKNOWN_FIELD" }
);

type RpcResult = { ok: true; result: unknown } | { ok: false; code: number; message: string };

function reply(id: unknown, outcome: RpcResult): string {
  return JSON.stringify(
    outcome.ok
      ? { jsonrpc: "2.0", id, result: outcome.result }
      : { jsonrpc: "2.0", id, error: { code: outcome.code, message: outcome.message } },
  );
}

function toolResult(body: AgentHandoffResult): RpcResult {
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
      isError: body.status === "refused",
    },
  };
}

function closedArgs(
  args: unknown,
  allowed: readonly string[],
): Record<string, unknown> | "INVALID_REQUEST" | "UNKNOWN_FIELD" {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "INVALID_REQUEST";
  for (const key of Object.keys(args)) if (!allowed.includes(key)) return "UNKNOWN_FIELD";
  return args as Record<string, unknown>;
}

async function callTool(
  channel: AgentHandoffChannel,
  params: Record<string, unknown>,
  waitMs: number,
): Promise<RpcResult> {
  if (typeof params.name !== "string")
    return { ok: false, code: -32602, message: "missing tool name" };
  const v = HANDOFF_API_VERSION;
  if (params.name === HANDOFF_REQUEST_TOOL) {
    const args = closedArgs(params.arguments ?? {}, ["reason", "note"]);
    if (typeof args === "string")
      return toolResult({ apiVersion: v, status: "refused", code: args });
    return toolResult({
      apiVersion: v,
      ...(await channel.request({ reason: args.reason, note: args.note }, waitMs)),
    });
  }
  if (params.name === HANDOFF_AWAIT_TOOL) {
    const args = closedArgs(params.arguments ?? {}, ["handoffId"]);
    if (typeof args === "string")
      return toolResult({ apiVersion: v, status: "refused", code: args });
    return toolResult({ apiVersion: v, ...(await channel.await(args.handoffId, waitMs)) });
  }
  // Deliberately does not echo the name: the agent learns nothing about other surfaces.
  return { ok: false, code: -32602, message: "unknown tool" };
}

/** Handle one wire line. Returns the reply line, or undefined for notifications. */
export async function handleHandoffLine(
  channel: AgentHandoffChannel,
  line: string,
  options: HandoffServeOptions = {},
): Promise<string | undefined> {
  const waitMs = options.waitMs ?? DEFAULT_AGENT_WAIT_MS;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return reply(null, { ok: false, code: -32700, message: "parse error" });
  }
  if (Array.isArray(message))
    return reply(null, { ok: false, code: -32600, message: "batch requests are not supported" });
  if (typeof message !== "object" || message === null)
    return reply(null, { ok: false, code: -32600, message: "invalid request" });
  const request = message as Record<string, unknown>;
  const hasId = Object.hasOwn(request, "id");
  const id = hasId ? request.id : null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
    return hasId ? reply(id, { ok: false, code: -32600, message: "invalid request" }) : undefined;
  const params =
    typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};
  let outcome: RpcResult;
  switch (request.method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" &&
        (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : PROTOCOL_VERSIONS[0];
      outcome = {
        ok: true,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: HANDOFF_SERVER_NAME, version: HANDOFF_SERVER_VERSION },
          instructions: HANDOFF_INSTRUCTIONS,
        },
      };
      break;
    }
    case "notifications/initialized":
      return undefined;
    case "ping":
      outcome = { ok: true, result: {} };
      break;
    case "tools/list":
      outcome = { ok: true, result: { tools: handoffToolDefinitions() } };
      break;
    case "tools/call":
      outcome = await callTool(channel, params, waitMs);
      break;
    default:
      outcome = { ok: false, code: -32601, message: "method not found" };
  }
  return hasId ? reply(id, outcome) : undefined;
}

/** Serve until `input` ends, one request at a time, replies in order. */
export function serveHandoffStdio(
  channel: AgentHandoffChannel,
  input: Readable,
  output: Writable,
  options: HandoffServeOptions = {},
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let chain = Promise.resolve();
  return new Promise((resolveDone) => {
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      chain = chain.then(async () => {
        let out: string | undefined;
        try {
          out = await handleHandoffLine(channel, line, options);
        } catch {
          out = reply(null, { ok: false, code: -32603, message: "internal error" });
        }
        if (out !== undefined) output.write(`${out}\n`);
      });
    });
    lines.on("close", () => {
      void chain.then(() => resolveDone());
    });
  });
}

/** The handoff server's tools, classified for the launch audit (`auditAgentLaunch`). */
export const HANDOFF_SERVER_CLASS = {
  [HANDOFF_SERVER_NAME]: {
    [HANDOFF_REQUEST_TOOL]: {
      reach: "agent-local",
      note: "track N: pauses the agent for a human; takes a closed reason and a bounded note, reads and writes nothing on the host",
    },
    [HANDOFF_AWAIT_TOOL]: {
      reach: "agent-local",
      note: "track N: waits on an open handoff by id",
    },
  },
} as const;
