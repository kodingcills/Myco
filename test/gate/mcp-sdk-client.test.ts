/**
 * `myco-gate` driven by a non-Claude MCP client (TIF-265 follow-up): the official MCP
 * TypeScript client (`@modelcontextprotocol/sdk`, pinned) spawns the real server over stdio,
 * exactly as any MCP host would from a config entry (command, args, env, cwd).
 *
 * No model is involved, so every call is deterministic: list tools, an honest run is
 * `verified`, a wrong-value run is `refuted`, and naming another task is
 * `ASSIGNMENT_MISMATCH`. The evidence is a fixture under a private temp dir, the same shape
 * the mock demo (`src/gate/demo.ts`) writes.
 *
 * The second block replays `examples/mcp-clients/stdio-requests.jsonl`, the plain JSON-RPC
 * example in the docs, so the documented wire session cannot drift from the server.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { GATE_REQUEST_SCHEMA, type GateResult } from "../../src/gate/api.ts";
import { GATE_SCRIPT } from "../../src/gate/demo.ts";
import { GATE_TOOL, SERVER_NAME } from "../../src/gate/mcp-server.ts";
import {
  CALC_SPEC,
  calcCsv,
  S01_ITEMS,
  S02_PERSISTED,
  tempRoot,
  todoStore,
  writeState,
} from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const STORE = ".myco-todo.json";
const CALC_TASK = "calc-emp-0002-name";

interface Fixture {
  readonly root: string;
  readonly tasksFile: string;
}

function fixture(): Fixture {
  const root = tempRoot();
  writeState(root, "run-honest", STORE, todoStore(S01_ITEMS));
  writeState(root, "run-dropped", STORE, todoStore(S02_PERSISTED));
  // A calc-record-edit run where the agent left the target cell at its old value.
  writeState(root, "run-wrong-value", "sheet.csv", calcCsv(false));
  const tasksFile = join(root, "tasks.json");
  writeFileSync(
    tasksFile,
    JSON.stringify({
      tasks: [
        { id: CALC_TASK, family: "calc-record-edit", stateFile: "sheet.csv", spec: CALC_SPEC },
      ],
    }),
  );
  return { root, tasksFile };
}

/** The server's launch line, the same command/args any MCP client config names. */
function serverArgs(f: Fixture, taskId: string, runId: string): string[] {
  return [
    "--import",
    "tsx",
    GATE_SCRIPT,
    "mcp",
    "--evidence-root",
    f.root,
    "--tasks",
    f.tasksFile,
    "--task",
    taskId,
    "--run",
    runId,
  ];
}

/** Connect the official SDK client to a fresh gate process bound to one trial. */
async function sdkClient(f: Fixture, taskId: string, runId: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs(f, taskId, runId),
    cwd: ROOT,
    // The SDK passes only its default safe variables (HOME, PATH, ...) plus this: nothing else.
    env: {},
    stderr: "pipe",
  });
  const client = new Client({ name: "sdk-test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type CallResult = { structuredContent?: GateResult; isError?: boolean; content: unknown };

async function gateCall(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: GATE_TOOL, arguments: args })) as CallResult;
  const gate = result.structuredContent;
  if (gate === undefined) throw new Error("no structuredContent");
  return { gate, isError: result.isError, content: result.content };
}

describe("myco-gate with the official MCP TypeScript client (non-Claude)", () => {
  let f: Fixture;
  beforeAll(() => {
    f = fixture();
  });

  it("initializes and lists exactly one tool with the gate's request schema", async () => {
    const client = await sdkClient(f, "df-s01", "run-honest");
    try {
      expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME });
      expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
      expect(client.getInstructions()).toContain('verdict "verified"');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([GATE_TOOL]);
      expect(tools[0]?.inputSchema).toEqual(JSON.parse(JSON.stringify(GATE_REQUEST_SCHEMA)));
      expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("an honest run is verified and accepted", async () => {
    const client = await sdkClient(f, "df-s01", "run-honest");
    try {
      const { gate, isError, content } = await gateCall(client, {
        taskId: "df-s01",
        runId: "run-honest",
        claim: "All 4 items saved.",
      });
      expect(isError).toBe(false);
      expect(gate).toMatchObject({ verdict: "verified", accepted: true });
      expect(gate.reasonCodes).toContain("ORACLE_PASS");
      // The text content carries the same result for clients that ignore structuredContent.
      expect(JSON.parse((content as { text: string }[])[0]?.text ?? "")).toEqual(gate);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("a wrong-value run is refuted (todo store drops items; calc target holds the old value)", async () => {
    const todo = await sdkClient(f, "df-s02", "run-dropped");
    try {
      const { gate, isError } = await gateCall(todo, { taskId: "df-s02", runId: "run-dropped" });
      expect(isError).toBe(false); // refuted is an answer, not a protocol error
      expect(gate).toMatchObject({ verdict: "refuted", accepted: false });
      expect(gate.reasonCodes).toContain("ORACLE_FAIL");
    } finally {
      await todo.close();
    }
    const calc = await sdkClient(f, CALC_TASK, "run-wrong-value");
    try {
      const { gate } = await gateCall(calc, { taskId: CALC_TASK, runId: "run-wrong-value" });
      expect(gate).toMatchObject({ verdict: "refuted", accepted: false });
      expect(gate.reasonCodes).toEqual(expect.arrayContaining(["ORACLE_FAIL", "TARGET_MISMATCH"]));
      // Codes-only: a refuted reason names cells, never the requested value.
      expect(JSON.stringify(gate.reasons)).not.toContain(CALC_SPEC.newValue);
    } finally {
      await calc.close();
    }
  }, 30_000);

  it("naming another taskId gives ASSIGNMENT_MISMATCH and nothing is read", async () => {
    const client = await sdkClient(f, "df-s02", "run-dropped");
    try {
      const { gate, isError } = await gateCall(client, {
        taskId: "df-s01",
        runId: "run-dropped",
      });
      expect(isError).toBe(true);
      expect(gate).toMatchObject({ verdict: "uncertain", accepted: false });
      expect(gate.reasonCodes).toContain("ASSIGNMENT_MISMATCH");
      expect(gate.evidenceRefs).toEqual([]);
      // An oracle input is refused the same way through this client.
      const tamper = await gateCall(client, {
        taskId: "df-s02",
        runId: "run-dropped",
        items: S02_PERSISTED,
      });
      expect(tamper.gate.reasonCodes).toContain("ORACLE_INPUT_REJECTED");
      expect(tamper.gate.accepted).toBe(false);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("the plain JSON-RPC example in examples/mcp-clients", () => {
  let f: Fixture;
  beforeAll(() => {
    f = fixture();
  });

  it("stdio-requests.jsonl, piped to the server, gives the documented replies", async () => {
    const requests = readFileSync(join(ROOT, "examples/mcp-clients/stdio-requests.jsonl"), "utf8");
    // The example names df-s01 / run-42; bind a gate to exactly that trial.
    writeState(f.root, "run-42", STORE, todoStore(S01_ITEMS));
    const child = spawn(process.execPath, serverArgs(f, "df-s01", "run-42"), {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.stdin.end(requests);
    const code = await new Promise<number | null>((done) => child.once("exit", done));
    expect(code).toBe(0);
    const replies = out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    // initialize, tools/list, tools/call; the notification gets no reply.
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(replies[0]?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: SERVER_NAME },
    });
    const listed = (replies[1]?.result.tools ?? []) as { name: string }[];
    expect(listed.map((t) => t.name)).toEqual([GATE_TOOL]);
    expect(replies[2]?.result).toMatchObject({
      isError: false,
      structuredContent: { verdict: "verified", accepted: true, request: { taskId: "df-s01" } },
    });
  }, 30_000);
});

describe("the example client configs in examples/mcp-clients", () => {
  const files = [
    "claude-code.mcp.json",
    "oh-my-pi.mcp.json",
    "gemini-cli.settings.json",
    "generic.mcp.json",
  ];
  it.each(files)("%s launches one bound gate and carries no environment values", (file) => {
    const config = JSON.parse(readFileSync(join(ROOT, "examples/mcp-clients", file), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: object }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(["myco-gate"]);
    const server = config.mcpServers["myco-gate"];
    if (server === undefined) throw new Error("no myco-gate entry");
    expect(server.command).toMatch(/\/node_modules\/\.bin\/tsx$/);
    expect(server.args[0]).toMatch(/\/scripts\/myco-gate\.ts$/);
    expect(server.args[1]).toBe("mcp");
    for (const flag of ["--evidence-root", "--task", "--run"]) {
      expect(server.args).toContain(flag);
    }
    expect(Object.keys(server.env ?? {})).toEqual([]);
  });
});
