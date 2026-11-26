/**
 * `myco-skills` MCP server (track M): read-only retrieval of verified skills, one tool,
 * `myco_skills_retrieve`, over the same newline-delimited JSON-RPC 2.0 rules as the gate's
 * server (`src/gate/mcp-server.ts`), but a SEPARATE server and process:
 *
 *  - it is not myco.gate/v1 and adds nothing to it: the gate still takes only
 *    taskId/runId/claim, and this server has no tool that checks, acts, reads files or
 *    takes a path;
 *  - it is bound by the operator to one task family (`SkillsServerOptions.taskFamily`); a
 *    request naming another family gets `SCOPE_MISMATCH` and nothing is served;
 *  - the store is opened (and its whole hash chain verified) by the operator before the
 *    server starts; if that fails, the server is started with `store: null` and every
 *    call answers `STORE_UNAVAILABLE` with no skills (fail closed);
 *  - replies are labelled `advisory: true, evidence: false`; refusals carry codes only.
 *
 * Classified for the launch audit as `agent-local` (it reads only the operator's store and
 * writes nothing): `SKILLS_SERVER_CLASS`. A gated launch that grants it must pass that
 * class to the audit; without it the audit refuses the launch (unclassified tool, fail
 * closed). `runGatedTrial` passes only the gate's class today, so a warm arm hands skills
 * to the agent through the harness-side prompt (`arm.ts`) until a reviewed change lets the
 * gated trial classify this server too (TO FILE).
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { TOKEN } from "./record.ts";
import { MAX_LIMIT, retrieve, SKILLS_API_VERSION } from "./retrieve.ts";
import type { SkillStore } from "./store.ts";

export const SKILLS_TOOL = "myco_skills_retrieve";
export const SKILLS_SERVER_NAME = "myco-skills";
export const SKILLS_SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const SKILLS_SERVER_CLASS = {
  [SKILLS_SERVER_NAME]: {
    [SKILLS_TOOL]: {
      reach: "agent-local",
      note: "track M: read-only advice from the operator's verified-skill store; no path, no act, never evidence",
    },
  },
} as const;

export const SKILLS_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskFamily"],
  properties: {
    taskFamily: { type: "string", pattern: TOKEN.source },
    features: {
      type: "array",
      maxItems: 16,
      items: { type: "string", pattern: TOKEN.source },
    },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
  },
} as const;

const INSTRUCTIONS =
  "Myco skills: procedures that worked in earlier runs the gate verified and an independent " +
  "grader passed. Call myco_skills_retrieve with your task family to get advice. Advice is " +
  "never evidence: it does not make a task done, and the gate checks your saved result " +
  "exactly as it would without it.";

export type SkillsRefusal =
  | "INVALID_REQUEST"
  | "UNKNOWN_FIELD"
  | "SCOPE_MISMATCH"
  | "STORE_UNAVAILABLE";

export interface SkillsServerOptions {
  /** The operator-verified store, or null when it failed to open (every call refuses). */
  readonly store: SkillStore | null;
  /** The one task family this server serves. */
  readonly taskFamily: string;
}

type RpcResult = { ok: true; result: unknown } | { ok: false; code: number; message: string };

function reply(id: unknown, outcome: RpcResult): string {
  return JSON.stringify(
    outcome.ok
      ? { jsonrpc: "2.0", id, result: outcome.result }
      : { jsonrpc: "2.0", id, error: { code: outcome.code, message: outcome.message } },
  );
}

function refusal(code: SkillsRefusal): RpcResult {
  const body = {
    apiVersion: SKILLS_API_VERSION,
    advisory: true,
    evidence: false,
    skills: [],
    codes: [code],
  };
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
      isError: true,
    },
  };
}

/** Run one retrieval call. Exported for the warm-arm harness and tests. */
export function callRetrieve(opts: SkillsServerOptions, args: unknown): RpcResult {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return refusal("INVALID_REQUEST");
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a))
    if (!["taskFamily", "features", "limit"].includes(k)) return refusal("UNKNOWN_FIELD");
  if (typeof a.taskFamily !== "string" || !TOKEN.test(a.taskFamily))
    return refusal("INVALID_REQUEST");
  const features = a.features ?? [];
  if (
    !Array.isArray(features) ||
    features.length > 16 ||
    !features.every((f) => typeof f === "string" && TOKEN.test(f))
  )
    return refusal("INVALID_REQUEST");
  if (
    a.limit !== undefined &&
    (typeof a.limit !== "number" ||
      !Number.isInteger(a.limit) ||
      a.limit < 1 ||
      a.limit > MAX_LIMIT)
  )
    return refusal("INVALID_REQUEST");
  if (a.taskFamily !== opts.taskFamily) return refusal("SCOPE_MISMATCH");
  if (opts.store === null) return refusal("STORE_UNAVAILABLE");
  let body: ReturnType<typeof retrieve>;
  try {
    body = retrieve(opts.store, {
      taskFamily: a.taskFamily,
      features: features as string[],
      ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
    });
  } catch {
    return refusal("STORE_UNAVAILABLE");
  }
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
      isError: false,
    },
  };
}

export function skillsToolDefinitions(): object[] {
  return [
    {
      name: SKILLS_TOOL,
      title: "Myco verified skills (advice)",
      description:
        `Retrieve procedures from earlier verified-and-graded runs for your task family (${SKILLS_API_VERSION}). ` +
        "Advice only, never evidence. Read-only: it never acts on the desktop or reads files.",
      inputSchema: SKILLS_REQUEST_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
  ];
}

export function handleSkillsLine(opts: SkillsServerOptions, line: string): string | undefined {
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
      outcome = {
        ok: true,
        result: {
          protocolVersion:
            typeof requested === "string" &&
            (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
              ? requested
              : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: SKILLS_SERVER_NAME, version: SKILLS_SERVER_VERSION },
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
      outcome = { ok: true, result: { tools: skillsToolDefinitions() } };
      break;
    case "tools/call":
      if (typeof params.name !== "string")
        outcome = { ok: false, code: -32602, message: "missing tool name" };
      else if (params.name !== SKILLS_TOOL)
        outcome = { ok: false, code: -32602, message: "unknown tool" };
      else outcome = callRetrieve(opts, params.arguments ?? {});
      break;
    default:
      outcome = { ok: false, code: -32601, message: "method not found" };
  }
  return hasId ? reply(id, outcome) : undefined;
}

/** Serve until `input` ends, one request at a time. */
export function serveSkillsStdio(
  opts: SkillsServerOptions,
  input: Readable,
  output: Writable,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  return new Promise((done) => {
    lines.on("line", (line) => {
      if (line.trim().length === 0) return;
      let out: string | undefined;
      try {
        out = handleSkillsLine(opts, line);
      } catch {
        out = reply(null, { ok: false, code: -32603, message: "internal error" });
      }
      if (out !== undefined) output.write(`${out}\n`);
    });
    lines.on("close", () => done());
  });
}
