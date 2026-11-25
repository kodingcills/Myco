/**
 * MCP protocol tests for `myco-gate` (TIF-265): drive the server like a client
 * (initialize, list tools, call the gate) on mock evidence, in process over streams and
 * as a real subprocess started from the CLI, the way Claude Code starts it.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { mcpStdio } from "../../src/baseline/mcp-stdio.ts";
import type { GateResult } from "../../src/gate/api.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import {
  GATE_TOOL,
  handleLine,
  PROTOCOL_VERSIONS,
  SERVER_NAME,
  serveStdio,
  toolDefinitions,
} from "../../src/gate/mcp-server.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { S01_ITEMS, S02_PERSISTED, tempRoot, todoStore, writeState } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const STORE = ".myco-todo.json";

function fixtureRoot(): string {
  const root = tempRoot();
  writeState(root, "run-ok", STORE, todoStore(S01_ITEMS));
  writeState(root, "run-dropped", STORE, todoStore(S02_PERSISTED));
  return root;
}

type Assigned = { taskId: string; runId: string };
const S01_TRIAL: Assigned = { taskId: "df-s01", runId: "run-ok" };
const S02_TRIAL: Assigned = { taskId: "df-s02", runId: "run-dropped" };

function gate(root = fixtureRoot(), assignment: Assigned = S01_TRIAL) {
  return createGate({
    tasks: buildRegistry(builtinTasks()),
    reader: fileEvidenceReader(root),
    assignment,
  });
}

async function rpc(line: string, g = gate()): Promise<Record<string, unknown> | undefined> {
  const out = await handleLine(g, line);
  return out === undefined ? undefined : JSON.parse(out);
}

/** In-process client over a pair of streams: the same client code the demo uses. */
function connect(root: string, assignment: Assigned) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const served = serveStdio(gate(root, assignment), toServer, fromServer);
  const client = mcpStdio(toServer, fromServer);
  return {
    client,
    async close() {
      client.close();
      toServer.end();
      await served;
    },
  };
}

type CallResult = { structuredContent: GateResult; content: { text: string }[]; isError: boolean };

describe("myco-gate MCP server, driven like a client", () => {
  it("a df-s01 trial's own passing run is verified and accepted", async () => {
    const { client, close } = connect(fixtureRoot(), S01_TRIAL);
    try {
      await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      await client.notify("notifications/initialized");
      const ok = (await client.request("tools/call", {
        name: GATE_TOOL,
        arguments: { taskId: "df-s01", runId: "run-ok", claim: "done" },
      })) as CallResult;
      expect(ok.isError).toBe(false);
      expect(ok.structuredContent).toMatchObject({ verdict: "verified", accepted: true });
      expect(JSON.parse(ok.content[0]?.text ?? "")).toEqual(ok.structuredContent);
    } finally {
      await close();
    }
  });

  it("initialize → tools/list → tools/call: refuted, tamper, and run substitution (df-s02 trial)", async () => {
    const { client, close } = connect(fixtureRoot(), S02_TRIAL);
    try {
      const init = (await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      })) as Record<string, unknown>;
      expect(init).toMatchObject({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME },
      });
      expect(String(init.instructions)).toContain('verdict "verified"');
      await client.notify("notifications/initialized");

      const listed = (await client.request("tools/list", {})) as {
        tools: Record<string, unknown>[];
      };
      expect(listed.tools.map((t) => t.name)).toEqual([GATE_TOOL]);
      expect(listed.tools[0]).toMatchObject({
        inputSchema: { required: ["taskId", "runId"], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false },
      });

      // The df-s02 agent names df-s01's passing run: the bound gate refuses to look.
      const substituted = (await client.request("tools/call", {
        name: GATE_TOOL,
        arguments: { taskId: "df-s01", runId: "run-ok", claim: "done" },
      })) as CallResult;
      expect(substituted.isError).toBe(true);
      expect(substituted.structuredContent).toMatchObject({
        verdict: "uncertain",
        accepted: false,
        reasonCodes: ["ASSIGNMENT_MISMATCH", "CLAIM_RECORDED"],
      });

      const refuted = (await client.request("tools/call", {
        name: GATE_TOOL,
        arguments: { taskId: "df-s02", runId: "run-dropped" },
      })) as CallResult;
      expect(refuted.isError).toBe(false);
      expect(refuted.structuredContent).toMatchObject({
        verdict: "refuted",
        accepted: false,
        reasonCodes: ["ORACLE_FAIL"],
      });

      const tamper = (await client.request("tools/call", {
        name: GATE_TOOL,
        arguments: { taskId: "df-s02", runId: "run-dropped", items: S02_PERSISTED },
      })) as CallResult;
      expect(tamper.isError).toBe(true);
      expect(tamper.structuredContent).toMatchObject({
        verdict: "uncertain",
        accepted: false,
        reasonCodes: ["ORACLE_INPUT_REJECTED"],
      });

      expect(await client.request("ping", {})).toEqual({});
    } finally {
      await close();
    }
  });

  it("negotiates the protocol version: echoes a supported one, else offers the newest", async () => {
    for (const version of PROTOCOL_VERSIONS) {
      const reply = await rpc(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: version },
        }),
      );
      expect(reply?.result).toMatchObject({ protocolVersion: version });
    }
    const reply = await rpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      }),
    );
    expect(reply?.result).toMatchObject({ protocolVersion: PROTOCOL_VERSIONS[0] });
  });
});

describe("myco-gate MCP server: JSON-RPC edge cases (mirrors myco-rt-mcp)", () => {
  it("malformed JSON is -32700 and the server keeps serving", async () => {
    const { client, close } = connect(fixtureRoot(), S01_TRIAL);
    const g = gate();
    expect(await rpc("{nope", g)).toMatchObject({ id: null, error: { code: -32700 } });
    try {
      expect(await client.request("ping", {})).toEqual({});
    } finally {
      await close();
    }
  });

  it.each([
    ["batch", "[]", -32600],
    ["missing method", JSON.stringify({ jsonrpc: "2.0", id: 2 }), -32600],
    ["wrong jsonrpc", JSON.stringify({ jsonrpc: "1.0", id: 2, method: "ping" }), -32600],
    ["unknown method", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" }), -32601],
    [
      "unknown tool",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "act", arguments: {} },
      }),
      -32602,
    ],
    [
      "missing tool name",
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }),
      -32602,
    ],
  ])("%s → error (line %s, code %s)", async (_name, line, code) => {
    expect(await rpc(line)).toMatchObject({ error: { code } });
  });

  it("a notification gets no reply; id null is a request and does", async () => {
    expect(
      await rpc(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })),
    ).toBeUndefined();
    expect(await rpc(JSON.stringify({ jsonrpc: "2.0", method: "ping" }))).toBeUndefined();
    expect(await rpc(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }))).toEqual({
      jsonrpc: "2.0",
      id: null,
      result: {},
    });
  });

  it("tools/call with no arguments is a gate verdict (uncertain), not a protocol error", async () => {
    const reply = await rpc(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: GATE_TOOL } }),
    );
    const result = reply?.result as CallResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      verdict: "uncertain",
      reasonCodes: ["INVALID_REQUEST"],
    });
  });
});

describe("myco-gate is separate from the actuator", () => {
  it("shares no tool name with myco-rt-mcp and exposes no acting or file tool", () => {
    const rust = readFileSync(join(ROOT, "runtime/crates/myco-rt-mcp/src/main.rs"), "utf8");
    const defs = rust.slice(rust.indexOf("fn tool_defs()"), rust.indexOf("fn call_tool("));
    const actuatorTools = [...defs.matchAll(/"name":\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(actuatorTools).toEqual(
      expect.arrayContaining(["create", "act", "read_file", "write_file"]),
    );
    const gateTools = toolDefinitions().map((t) => (t as { name: string }).name);
    expect(gateTools).toEqual([GATE_TOOL]);
    expect(gateTools.filter((name) => actuatorTools.includes(name))).toEqual([]);
  });
});

describe("myco-gate as a subprocess (how Claude Code starts it)", () => {
  it("serves initialize, tools/list and a verdict over real stdio", async () => {
    const root = fixtureRoot();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(ROOT, "scripts/myco-gate.ts"),
        "mcp",
        "--evidence-root",
        root,
        "--task",
        "df-s02",
        "--run",
        "run-dropped",
      ],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    const client = mcpStdio(child.stdin, child.stdout);
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
      await client.notify("notifications/initialized");
      const listed = (await client.request("tools/list", {})) as { tools: { name: string }[] };
      expect(listed.tools.map((t) => t.name)).toEqual([GATE_TOOL]);
      const called = (await client.request("tools/call", {
        name: GATE_TOOL,
        arguments: { taskId: "df-s02", runId: "run-dropped" },
      })) as CallResult;
      expect(called.structuredContent.verdict).toBe("refuted");
    } finally {
      client.close();
      child.stdin.end();
    }
    const code = await new Promise<number | null>((done) => {
      if (child.exitCode !== null) done(child.exitCode);
      else child.once("exit", (c) => done(c));
    });
    expect(code).toBe(0);
  }, 30_000);
});
