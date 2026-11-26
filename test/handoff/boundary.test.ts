/**
 * Track N: the agent can never resolve a handoff, and nothing agent-facing carries a host path
 * or a secret.
 *
 *  - The agent's MCP server exposes request/await only; no input names an outcome; resolve-like
 *    tools and methods are unknown.
 *  - The operator channel is issued once; the agent channel object has no resolve verb.
 *  - The operator endpoint is loopback-only and token-gated (Host, Origin, content type, body cap).
 *  - The CLI refuses a connection file that is not loopback or not 0600, and never prints the token.
 *  - Leakage: every agent-facing byte (instructions, tool list, every result kind) is free of host
 *    paths, the token and the connection file path.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATE_REQUEST_SCHEMA } from "../../src/gate/api.ts";
import { GATE_SERVER_CLASS } from "../../src/gate/gated-trial.ts";
import { toolDefinitions } from "../../src/gate/mcp-server.ts";
import {
  HANDOFF_AWAIT_TOOL,
  HANDOFF_REQUEST_TOOL,
  HANDOFF_SERVER_CLASS,
  handleHandoffLine,
} from "../../src/handoff/agent-server.ts";
import { HandoffBroker } from "../../src/handoff/broker.ts";
import { main as cli } from "../../src/handoff/cli.ts";
import {
  connectionReachesAgent,
  newOperatorToken,
  OPERATOR_BASE,
  type OperatorServer,
  startOperatorServer,
  writeConnectionFile,
} from "../../src/handoff/operator-server.ts";
import { HOST_PATH, looksSecret } from "../../src/handoff/protocol.ts";
import { type AgentLaunchPlan, auditAgentLaunch } from "../../src/integrity/launch.ts";
import { rtSessionIdFor } from "../../src/integrity/surface.ts";
import { allStrings } from "./helpers.ts";

let base: string;
let server: OperatorServer | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-handoff-"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(base, { recursive: true, force: true });
});

function rpc(method: string, params: unknown = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function call(
  broker: HandoffBroker,
  name: string,
  args: unknown,
  waitMs = 10,
): Promise<Record<string, unknown>> {
  const out = await handleHandoffLine(
    broker.agentChannel(),
    rpc("tools/call", { name, arguments: args }),
    { waitMs },
  );
  return JSON.parse(out ?? "{}") as Record<string, unknown>;
}

function body(reply: Record<string, unknown>): Record<string, unknown> {
  return (reply.result as { structuredContent: Record<string, unknown> }).structuredContent;
}

function newBroker(): HandoffBroker {
  return new HandoffBroker({ runId: "run-b", taskId: "df-s01", timeoutMs: 60_000 });
}

describe("the agent cannot resolve a handoff", () => {
  it("the agent server lists request and await only, and no input names an outcome", async () => {
    const out = JSON.parse(
      (await handleHandoffLine(newBroker().agentChannel(), rpc("tools/list"))) ?? "{}",
    );
    const tools = out.result.tools as { name: string; inputSchema: { properties: object } }[];
    expect(tools.map((t) => t.name)).toEqual([HANDOFF_REQUEST_TOOL, HANDOFF_AWAIT_TOOL]);
    const fields = tools.flatMap((t) => Object.keys(t.inputSchema.properties));
    expect(fields).toEqual(["reason", "note", "handoffId"]);
    expect(JSON.stringify(tools)).not.toMatch(/approve|fixed-it|outcome|resolve/i);
  });

  it.each([
    ["myco_handoff_resolve", { handoffId: "ho-1", outcome: "approve" }],
    ["resolve", {}],
    ["myco_gate_check", { taskId: "df-s01", runId: "run-b" }],
  ])("tool %s is unknown on the agent server", async (name, args) => {
    const broker = newBroker();
    const op = broker.operatorChannel();
    await call(broker, HANDOFF_REQUEST_TOOL, { reason: "uncertain", note: "?" });
    const reply = await call(broker, name, args);
    expect(reply.error).toEqual({ code: -32602, message: "unknown tool" });
    expect(op.pending()).toHaveLength(1);
    expect(broker.log().entries).toEqual([]);
  });

  it("resolve-shaped JSON-RPC methods are not found", async () => {
    const channel = newBroker().agentChannel();
    for (const m of ["resolve", "handoff/resolve", "operator/resolve", "tools/resolve"]) {
      const out = JSON.parse(
        (await handleHandoffLine(channel, rpc(m, { handoffId: "ho-1" }))) ?? "{}",
      );
      expect(out.error.code).toBe(-32601);
    }
  });

  it("smuggling an outcome into a request is refused and opens nothing", async () => {
    const broker = newBroker();
    const op = broker.operatorChannel();
    for (const args of [
      { reason: "uncertain", note: "?", outcome: "approve" },
      { reason: "uncertain", note: "?", resolution: "fixed-it" },
      { handoffId: "ho-1", outcome: "approve" },
    ]) {
      const name = "handoffId" in args ? HANDOFF_AWAIT_TOOL : HANDOFF_REQUEST_TOOL;
      expect(body(await call(broker, name, args))).toMatchObject({
        status: "refused",
        code: "UNKNOWN_FIELD",
      });
    }
    expect(op.pending()).toEqual([]);
  });

  it("the agent channel has no resolve verb, and the operator channel is issued once", () => {
    const broker = newBroker();
    const agent = broker.agentChannel() as unknown as Record<string, unknown>;
    expect(Object.keys(agent).sort()).toEqual(["await", "request"]);
    expect(agent.resolve).toBeUndefined();
    const policy = broker.policyTrigger() as unknown as Record<string, unknown>;
    expect(Object.keys(policy).sort()).toEqual(["awaitClear", "forcePause"]);
    broker.operatorChannel();
    expect(() => broker.operatorChannel()).toThrow(/already issued/);
  });

  it("the gate's agent input stays taskId/runId/claim; handoff is a separate classified server", () => {
    expect(Object.keys(GATE_REQUEST_SCHEMA.properties).sort()).toEqual([
      "apiVersion",
      "claim",
      "runId",
      "taskId",
    ]);
    expect(JSON.stringify(toolDefinitions())).not.toMatch(/handoff/);
    const plan = (servers: AgentLaunchPlan["mcpServers"]): AgentLaunchPlan => ({
      argv: [
        "-p",
        "do the task",
        "--strict-mcp-config",
        "--tools",
        "",
        "--mcp-config",
        join(base, "mcp.json"),
        "--allowedTools",
        [
          "mcp__myco-rt__observe",
          "mcp__myco-gate__myco_gate_check",
          `mcp__myco-handoff__${HANDOFF_REQUEST_TOOL}`,
          `mcp__myco-handoff__${HANDOFF_AWAIT_TOOL}`,
        ].join(","),
      ],
      mcpServers: servers,
      mcpConfigPath: join(base, "mcp.json"),
    });
    const servers = {
      "myco-rt": {
        command: "myco-rt-mcp",
        args: [],
        env: { MYCO_RT_SESSION_ID: rtSessionIdFor("run-b") },
      },
      "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} },
      "myco-handoff": { command: "myco-handoff-mcp", args: [], env: {} },
    };
    const ok = auditAgentLaunch(plan(servers), {
      runId: "run-b",
      extraServers: { ...GATE_SERVER_CLASS, ...HANDOFF_SERVER_CLASS },
    });
    expect(ok.violations).toEqual([]);
    expect(ok.ok).toBe(true);
    // Unclassified, the handoff server fails the audit closed.
    expect(
      auditAgentLaunch(plan(servers), { runId: "run-b", extraServers: GATE_SERVER_CLASS }).ok,
    ).toBe(false);
  });

  it("a launch plan that carries the operator connection or token is detected", () => {
    const token = newOperatorToken();
    const conn = join(base, "op", "run-b.json");
    const clean = {
      argv: ["-p", "x"],
      mcpServers: { "myco-handoff": { command: "myco-handoff-mcp", args: [], env: {} } },
    };
    expect(connectionReachesAgent(clean, conn, token)).toBe(false);
    expect(
      connectionReachesAgent(
        { ...clean, mcpServers: { h: { command: "x", args: ["--connection", conn], env: {} } } },
        conn,
        token,
      ),
    ).toBe(true);
    expect(
      connectionReachesAgent(
        { ...clean, mcpServers: { h: { command: "x", args: [], env: { T: token } } } },
        conn,
        token,
      ),
    ).toBe(true);
  });
});

function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? `${OPERATOR_BASE}/pending`,
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("operator endpoint: loopback, token, browser-safe", () => {
  async function start() {
    const broker = newBroker();
    const token = newOperatorToken();
    server = await startOperatorServer({ channel: broker.operatorChannel(), token });
    void broker
      .agentChannel()
      .request({ reason: "needs-approval", note: "ok?" }, Number.POSITIVE_INFINITY);
    return { broker, token, port: server.port };
  }

  it("binds 127.0.0.1 only", async () => {
    const { port } = await start();
    expect(server?.url).toBe(`http://127.0.0.1:${port}`);
  });

  it("refuses missing or wrong tokens, foreign Host and Origin, form posts and big bodies", async () => {
    const { token, port, broker } = await start();
    const host = `127.0.0.1:${port}`;
    const auth = `Bearer ${token}`;
    const resolveBody = JSON.stringify({ handoffId: "ho-1", outcome: "approve" });
    const cases: [Parameters<typeof raw>[1], number, string][] = [
      [{ headers: { host } }, 401, "UNAUTHORIZED"],
      [{ headers: { host, authorization: "Bearer nope" } }, 401, "UNAUTHORIZED"],
      [{ headers: { host, authorization: token } }, 401, "UNAUTHORIZED"],
      [{ headers: { host: `evil.example:${port}`, authorization: auth } }, 403, "BAD_HOST"],
      [{ headers: { host: "127.0.0.1:1", authorization: auth } }, 403, "BAD_HOST"],
      [
        { headers: { host, authorization: auth, origin: "https://evil.example" } },
        403,
        "BAD_ORIGIN",
      ],
      [
        {
          method: "POST",
          path: `${OPERATOR_BASE}/resolve`,
          headers: {
            host,
            authorization: auth,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "handoffId=ho-1&outcome=approve",
        },
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      ],
      [
        {
          method: "POST",
          path: `${OPERATOR_BASE}/resolve`,
          headers: { host, authorization: auth, "content-type": "application/json" },
          body: JSON.stringify({ handoffId: "ho-1", outcome: "approve", note: "x".repeat(5000) }),
        },
        413,
        "BODY_TOO_LARGE",
      ],
      [
        {
          method: "POST",
          path: `${OPERATOR_BASE}/resolve`,
          headers: { host, authorization: auth, "content-type": "application/json" },
          body: JSON.stringify({
            handoffId: "ho-1",
            outcome: "approve",
            resolvedBy: "host:timeout",
          }),
        },
        400,
        "UNKNOWN_FIELD",
      ],
      [{ path: "/etc/passwd", headers: { host, authorization: auth } }, 404, "NOT_FOUND"],
    ];
    for (const [opts, status, code] of cases) {
      const r = await raw(port, opts);
      expect([r.status, JSON.parse(r.body).code]).toEqual([status, code]);
      expect(r.body).not.toContain(token);
    }
    expect(broker.log().entries).toEqual([]);
    const ok = await raw(port, {
      method: "POST",
      path: `${OPERATOR_BASE}/resolve`,
      headers: { host, authorization: auth, "content-type": "application/json" },
      body: resolveBody,
    });
    expect(ok.status).toBe(200);
    expect(broker.log().entries[0]?.resolvedBy).toBe("operator:api");
  });

  it("an allow-listed origin (the watch view, lands with #513) may call", async () => {
    const broker = newBroker();
    const token = newOperatorToken();
    server = await startOperatorServer({
      channel: broker.operatorChannel(),
      token,
      allowedOrigins: ["http://127.0.0.1:4173"],
    });
    const r = await raw(server.port, {
      headers: {
        host: `127.0.0.1:${server.port}`,
        authorization: `Bearer ${token}`,
        origin: "http://127.0.0.1:4173",
      },
    });
    expect(r.status).toBe(200);
  });
});

describe("operator CLI", () => {
  function io() {
    const out = new PassThrough();
    const err = new PassThrough();
    const read = (s: PassThrough) => (s.read() as Buffer | null)?.toString() ?? "";
    return { io: { stdout: out, stderr: err }, out: () => read(out), err: () => read(err) };
  }

  it("lists and resolves over the connection file, never printing the token", async () => {
    const broker = newBroker();
    const token = newOperatorToken();
    server = await startOperatorServer({ channel: broker.operatorChannel(), token });
    const conn = join(base, "op", "run-b.json");
    writeConnectionFile(conn, server.url, token);
    const call = broker
      .agentChannel()
      .request({ reason: "blocked", note: "modal dialog" }, Number.POSITIVE_INFINITY);
    const a = io();
    expect(await cli(["list", "--connection", conn], a.io)).toBe(0);
    const listed = a.out();
    expect(JSON.parse(listed).pending[0]).toMatchObject({ handoffId: "ho-1", reason: "blocked" });
    const b = io();
    expect(
      await cli(
        [
          "resolve",
          "ho-1",
          "fixed-it",
          "--note",
          "closed the dialog",
          "--operator",
          "tiff",
          "--connection",
          conn,
        ],
        b.io,
      ),
    ).toBe(0);
    expect(await call).toMatchObject({
      status: "resumed",
      outcome: "fixed-it",
      humanNote: "closed the dialog",
    });
    expect(broker.log().entries[0]).toMatchObject({
      resolvedBy: "operator:cli",
      operatorLabel: "tiff",
    });
    const c = io();
    expect(await cli(["resolve", "ho-1", "approve", "--connection", conn], c.io)).toBe(1);
    expect(c.err()).toBe("myco-handoff: ALREADY_RESOLVED\n");
    for (const text of [listed, b.out(), a.err(), b.err()]) expect(text).not.toContain(token);
  });

  it("refuses a connection file that is too open or points off loopback", async () => {
    const token = newOperatorToken();
    const open = join(base, "open.json");
    writeFileSync(
      open,
      JSON.stringify({ schema: "myco.handoff.connection/1", url: "http://127.0.0.1:9", token }),
    );
    chmodSync(open, 0o644);
    const a = io();
    expect(await cli(["list", "--connection", open], a.io)).toBe(2);
    expect(a.err()).toMatch(/CONNECTION_FILE_TOO_OPEN/);
    const far = join(base, "far.json");
    writeConnectionFile(far, "http://evil.example:80", token);
    let fetched = false;
    const b = io();
    const code = await cli(["list", "--connection", far], {
      ...b.io,
      fetch: (async () => {
        fetched = true;
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(code).toBe(2);
    expect(fetched).toBe(false);
    expect(b.err()).toBe("myco-handoff: CONNECTION_NOT_LOOPBACK\n");
    const c = io();
    expect(await cli(["list", "--connection", join(base, "missing.json")], c.io)).toBe(2);
    expect(c.err()).toBe("myco-handoff: CONNECTION_FILE_UNREADABLE\n");
    expect(c.err()).not.toContain(base);
  });

  it("writes the connection file 0600 and never overwrites one", () => {
    const conn = join(base, "op", "c.json");
    writeConnectionFile(conn, "http://127.0.0.1:1", newOperatorToken());
    expect(() => writeConnectionFile(conn, "http://127.0.0.1:1", newOperatorToken())).toThrow();
  });
});

describe("leakage: no host paths or secrets in agent-facing output", () => {
  it("instructions, tool list and every result kind are path- and secret-free", async () => {
    const broker = new HandoffBroker({ runId: "run-b", taskId: "df-s01", timeoutMs: 1_000 });
    const token = newOperatorToken();
    const op = broker.operatorChannel();
    const channel = broker.agentChannel();
    const replies: unknown[] = [];
    const send = async (line: string) => {
      replies.push(JSON.parse((await handleHandoffLine(channel, line, { waitMs: 5 })) ?? "null"));
    };
    await send(rpc("initialize", { protocolVersion: "2025-06-18" }));
    await send(rpc("tools/list"));
    // refused (path in note), refused (secret), paused, resumed, paused, rejected, ended.
    await send(
      rpc("tools/call", {
        name: HANDOFF_REQUEST_TOOL,
        arguments: { reason: "uncertain", note: `see ${base}/x` },
      }),
    );
    await send(
      rpc("tools/call", {
        name: HANDOFF_REQUEST_TOOL,
        arguments: { reason: "uncertain", note: `token=${token}` },
      }),
    );
    await send(
      rpc("tools/call", {
        name: HANDOFF_REQUEST_TOOL,
        arguments: { reason: "uncertain", note: "q1" },
      }),
    );
    op.resolve({ handoffId: "ho-1", outcome: "approve", via: "cli", note: "go ahead" });
    await send(rpc("tools/call", { name: HANDOFF_AWAIT_TOOL, arguments: { handoffId: "ho-1" } }));
    await send(
      rpc("tools/call", {
        name: HANDOFF_REQUEST_TOOL,
        arguments: { reason: "needs-approval", note: "q2" },
      }),
    );
    // A human note that would leak is refused at the operator side, so it never reaches the agent.
    expect(
      op.resolve({ handoffId: "ho-2", outcome: "reject", via: "cli", note: `see ${base}` }),
    ).toEqual({
      ok: false,
      code: "NOTE_HOST_PATH",
    });
    expect(
      op.resolve({
        handoffId: "ho-2",
        outcome: "reject",
        via: "cli",
        note: "Bearer abcdefghijklmnopqrstuv",
      }),
    ).toEqual({
      ok: false,
      code: "NOTE_SECRET_SHAPED",
    });
    op.resolve({ handoffId: "ho-2", outcome: "reject", via: "cli" });
    await send(rpc("tools/call", { name: HANDOFF_AWAIT_TOOL, arguments: { handoffId: "ho-2" } }));
    await new Promise<void>((r) => {
      void channel
        .request({ reason: "blocked", note: "q3" }, Number.POSITIVE_INFINITY)
        .then(() => r());
    });
    await send(rpc("tools/call", { name: HANDOFF_AWAIT_TOOL, arguments: { handoffId: "ho-3" } }));
    await send(rpc("bogus"));
    await send("not json");

    const statuses = replies
      .map(
        (r) =>
          (r as { result?: { structuredContent?: { status?: string } } }).result?.structuredContent
            ?.status,
      )
      .filter(Boolean);
    expect(statuses).toEqual([
      "refused",
      "refused",
      "paused",
      "resumed",
      "paused",
      "rejected",
      "ended",
    ]);
    const strings = allStrings(replies);
    for (const s of strings) {
      expect(HOST_PATH.test(s), s).toBe(false);
      expect(s).not.toContain(base);
      expect(s).not.toContain(token);
      expect(s).not.toContain(process.cwd());
    }
    // The refused replies are codes, not echoes of the offending note.
    expect(JSON.stringify(replies)).not.toContain("see ");
    expect(strings.some((s) => looksSecret(s))).toBe(false);
  });
});
