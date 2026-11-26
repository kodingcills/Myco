/**
 * `myco-gate` MCP server (TIF-265): the gate as one MCP tool over stdio
 * (newline-delimited JSON-RPC 2.0), for Claude Code or any other MCP client
 * (docs/gate/clients.md).
 *
 * This is a separate server from the actuator (`runtime/crates/myco-rt-mcp`, server name
 * `myco-rt`). The actuator's tools act on the desktop; this server has exactly one tool,
 * `myco_gate_check`, and no tool that acts, reads files or takes a path. Running them as
 * two processes keeps the gate's inputs out of the actuator's reach (TIF-266 builds on it).
 *
 * The JSON-RPC rules mirror `myco-rt-mcp`'s `handle_line` so a client sees one behaviour:
 * parse error -32700 and keep serving; batch -32600; missing method -32600; unknown method
 * -32601; `id: null` is a request; a notification gets no reply.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { GATE_API_VERSION, GATE_REQUEST_SCHEMA } from "./api.ts";
import type { Gate } from "./gate.ts";

export const GATE_TOOL = "myco_gate_check";
export const SERVER_NAME = "myco-gate";
export const SERVER_VERSION = "0.1.0";

/** Newest first. The client's version is echoed when supported, otherwise the newest. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const INSTRUCTIONS =
  "Myco's completion gate. When you believe the task is done, call myco_gate_check with the " +
  "taskId and runId you were given. This gate serves only that task and run; naming any " +
  "other gives ASSIGNMENT_MISMATCH. The task counts as done only if the result has " +
  'verdict "verified" (accepted: true). On "refuted", the persisted state contradicts the ' +
  'task: fix it and call again. On "uncertain", the gate could not look: report the reason ' +
  "codes; do not claim done. You cannot supply evidence or expected values; the gate reads " +
  "persisted state itself. If the operator enabled corrections, a refuted or uncertain result " +
  "may carry `corrections`: typed notes about your saved document (a target cell's value, a " +
  "cell you changed, an unsaved document). Fix the document in the app and save; echoing a " +
  "correction back changes nothing, and corrections never add attempts.";

export function toolDefinitions(): object[] {
  return [
    {
      name: GATE_TOOL,
      title: "Myco completion gate",
      description:
        `Check whether a task is done according to the app's persisted state (${GATE_API_VERSION}). ` +
        'Returns verdict "verified", "refuted" or "uncertain" with reason codes and evidence refs. ' +
        "Only verified means done. Read-only: it never acts on the desktop.",
      inputSchema: GATE_REQUEST_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}

type RpcResult = { ok: true; result: unknown } | { ok: false; code: number; message: string };

function reply(id: unknown, outcome: RpcResult): string {
  return JSON.stringify(
    outcome.ok
      ? { jsonrpc: "2.0", id, result: outcome.result }
      : { jsonrpc: "2.0", id, error: { code: outcome.code, message: outcome.message } },
  );
}

async function callTool(gate: Gate, params: Record<string, unknown>): Promise<RpcResult> {
  if (typeof params.name !== "string")
    return { ok: false, code: -32602, message: "missing tool name" };
  if (params.name !== GATE_TOOL) {
    return { ok: false, code: -32602, message: `unknown tool: ${params.name}` };
  }
  // The arguments go to the gate as-is; the gate's own parser is the only judge of them.
  const result = await gate.check(params.arguments ?? {});
  const rejected = result.reasonCodes.some((code) =>
    [
      "INVALID_REQUEST",
      "UNKNOWN_FIELD",
      "ORACLE_INPUT_REJECTED",
      "UNSUPPORTED_API_VERSION",
      "ASSIGNMENT_MISMATCH",
    ].includes(code),
  );
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
      isError: rejected,
    },
  };
}

/** Handle one wire line. Returns the reply line, or undefined for notifications. */
export async function handleLine(gate: Gate, line: string): Promise<string | undefined> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return reply(null, { ok: false, code: -32700, message: "parse error" });
  }
  if (Array.isArray(message)) {
    return reply(null, { ok: false, code: -32600, message: "batch requests are not supported" });
  }
  if (typeof message !== "object" || message === null) {
    return reply(null, { ok: false, code: -32600, message: "invalid request" });
  }
  const request = message as Record<string, unknown>;
  const hasId = Object.hasOwn(request, "id");
  const id = hasId ? request.id : null;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return hasId ? reply(id, { ok: false, code: -32600, message: "invalid request" }) : undefined;
  }
  const params =
    typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};

  let outcome: RpcResult | undefined;
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
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
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
      outcome = { ok: true, result: { tools: toolDefinitions() } };
      break;
    case "tools/call":
      outcome = await callTool(gate, params);
      break;
    default:
      outcome = { ok: false, code: -32601, message: `method not found: ${request.method}` };
  }
  return hasId ? reply(id, outcome) : undefined;
}

/**
 * Serve until `input` ends. Requests are handled one at a time, in order, so replies
 * keep request order and each reply is one complete line.
 */
export function serveStdio(gate: Gate, input: Readable, output: Writable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let chain = Promise.resolve();
  return new Promise((resolveDone) => {
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      chain = chain.then(async () => {
        let out: string | undefined;
        try {
          out = await handleLine(gate, line);
        } catch {
          // Unreachable while the gate is total; a failure must not stall later requests.
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
