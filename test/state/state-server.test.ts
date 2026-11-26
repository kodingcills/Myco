/**
 * Capability track I: the `myco-state` contract, hermetic (no LibreOffice).
 *
 * The request parser, the caps (fail closed, with codes), the server's re-checks of whatever
 * the backend returns, and the JSON-RPC surface: read-only tools only, refusals as codes,
 * never a raw error, an echoed input or a host path.
 */
import { describe, expect, it } from "vitest";
import {
  LIVE_STATE_NOTICE,
  parseA1Range,
  parseStateRequest,
  STATE_CAPS,
  STATE_CODES,
  STATE_TOOL_NAMES,
} from "../../src/state/api.ts";
import type { UiNode } from "../../src/state/backend.ts";
import {
  createStateService,
  handleStateLine,
  type StateReply,
  scrubPaths,
  stateToolDefinitions,
} from "../../src/state/server.ts";
import { type FakeDoc, fakeBackend, rawBackend, throwingBackend } from "./fake-backend.ts";

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies are read loosely in tests
type Json = any;

const doc = (): FakeDoc => ({
  sheets: [
    {
      name: "employees",
      rows: [
        ["id", "name", "qty"],
        ["EMP-0001", "Ann", "3"],
        ["EMP-0002", "Bob", "=C2*2"],
      ],
    },
    { name: "notes", rows: [] },
  ],
  modified: false,
});

async function rpc(service: ReturnType<typeof createStateService>, message: unknown) {
  const line = await handleStateLine(service, JSON.stringify(message));
  return line === undefined ? undefined : (JSON.parse(line) as Record<string, Json>);
}

async function call(service: ReturnType<typeof createStateService>, name: unknown, args?: unknown) {
  const reply = await rpc(service, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return reply as Record<string, Json>;
}

describe("A1 ranges and caps", () => {
  it("parses cells and ranges, either corner order, with $ anchors", () => {
    expect(parseA1Range("B8")).toEqual({ ok: true, value: [1, 7, 1, 7] });
    expect(parseA1Range("$A$1:C3")).toEqual({ ok: true, value: [0, 0, 2, 2] });
    expect(parseA1Range("C3:A1")).toEqual({ ok: true, value: [0, 0, 2, 2] });
    expect(parseA1Range("aa10")).toEqual({ ok: true, value: [26, 9, 26, 9] });
  });

  it("refuses malformed ranges with INVALID_RANGE", () => {
    for (const bad of [
      "",
      "A0",
      "1A",
      "A1:",
      "A1:B",
      "../etc/passwd",
      "/tmp/x",
      "A1;B2",
      "ZZZZ1",
      "A1 ",
    ])
      expect(parseA1Range(bad), bad).toEqual({ ok: false, code: "INVALID_RANGE" });
  });

  it(`refuses more than ${STATE_CAPS.maxCells} cells or ${STATE_CAPS.maxRangeSide} rows/cols with RANGE_TOO_LARGE`, () => {
    expect(parseA1Range("A1:T20").ok).toBe(true); // 400 cells
    expect(parseA1Range("A1:U20")).toEqual({ ok: false, code: "RANGE_TOO_LARGE" }); // 420
    expect(parseA1Range("A1:A201")).toEqual({ ok: false, code: "RANGE_TOO_LARGE" });
    expect(parseA1Range("A1:XFD1048576")).toEqual({ ok: false, code: "RANGE_TOO_LARGE" });
  });
});

describe("request parser", () => {
  it("accepts exactly the declared fields", () => {
    expect(parseStateRequest("state_list_sheets", {}).ok).toBe(true);
    expect(parseStateRequest("state_list_sheets", undefined).ok).toBe(true);
    expect(parseStateRequest("state_read_range", { range: "A1", sheet: 1 }).ok).toBe(true);
    expect(parseStateRequest("state_ui_tree", {})).toEqual({
      ok: true,
      value: {
        tool: "state_ui_tree",
        maxDepth: STATE_CAPS.defaultTreeDepth,
        maxNodes: STATE_CAPS.defaultTreeNodes,
      },
    });
  });

  it("refuses every field that could name a file, trial, run or path (UNKNOWN_FIELD)", () => {
    for (const field of [
      "path",
      "file",
      "url",
      "runId",
      "taskId",
      "trial",
      "docPath",
      "pipe",
      "vault",
    ]) {
      for (const tool of STATE_TOOL_NAMES) {
        const args: Record<string, unknown> = tool === "state_read_range" ? { range: "A1" } : {};
        args[field] = "/tmp/other-trial/saved.xlsx";
        expect(parseStateRequest(tool, args), `${tool}.${field}`).toEqual({
          ok: false,
          code: "UNKNOWN_FIELD",
        });
      }
    }
  });

  it("refuses bad shapes and limits with codes", () => {
    expect(parseStateRequest("state_write_cell", {})).toEqual({ ok: false, code: "UNKNOWN_TOOL" });
    expect(parseStateRequest(42, {})).toEqual({ ok: false, code: "UNKNOWN_TOOL" });
    expect(parseStateRequest("state_list_sheets", [])).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(parseStateRequest("state_list_sheets", "x")).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(parseStateRequest("state_read_range", {})).toEqual({ ok: false, code: "INVALID_RANGE" });
    expect(parseStateRequest("state_read_range", { range: 5 })).toEqual({
      ok: false,
      code: "INVALID_RANGE",
    });
    expect(parseStateRequest("state_read_range", { range: "A1", sheet: -1 })).toEqual({
      ok: false,
      code: "UNKNOWN_SHEET",
    });
    expect(parseStateRequest("state_read_range", { range: "A1", sheet: 1.5 })).toEqual({
      ok: false,
      code: "UNKNOWN_SHEET",
    });
    expect(parseStateRequest("state_read_range", { range: "A1", sheet: {} })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(parseStateRequest("state_read_range", { range: "A1", sheet: "x".repeat(200) })).toEqual({
      ok: false,
      code: "UNKNOWN_SHEET",
    });
    expect(parseStateRequest("state_ui_tree", { maxDepth: 99 })).toEqual({
      ok: false,
      code: "LIMIT_OUT_OF_RANGE",
    });
    expect(parseStateRequest("state_ui_tree", { maxNodes: 0 })).toEqual({
      ok: false,
      code: "LIMIT_OUT_OF_RANGE",
    });
    expect(parseStateRequest("state_ui_tree", { maxNodes: "5" })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });

  it("a prototype-polluting object is not a plain object", () => {
    const evil = JSON.parse('{"__proto__": {"range": "A1"}}');
    expect(parseStateRequest("state_read_range", evil).ok).toBe(false);
    expect(parseStateRequest("state_read_range", Object.create({ range: "A1" })).ok).toBe(false);
  });
});

describe("tool surface", () => {
  it("lists exactly four read-only tools, each with a closed input schema", () => {
    const tools = stateToolDefinitions() as Array<Record<string, Json>>;
    expect(tools.map((t) => t.name)).toEqual([...STATE_TOOL_NAMES]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/path|file|url|runId|taskId/i);
    }
  });

  it("no tool name or description offers a write", () => {
    const text = JSON.stringify(stateToolDefinitions());
    expect(text).not.toMatch(/\b(write|set|save|type|edit|click|store)_/i);
  });
});

describe("server replies", () => {
  const service = () => createStateService({ backend: fakeBackend(doc()) });

  it("reads values and formulas, and every success carries the not-proof notice", async () => {
    const r = await call(service(), "state_read_range", { range: "B2:C3" });
    const reply = r.result.structuredContent as StateReply;
    expect(r.result.isError).toBe(false);
    expect(reply).toMatchObject({ ok: true, api: "myco.state/v1", notice: LIVE_STATE_NOTICE });
    const rows = (reply as { data: { rows: Json[][] } }).data.rows;
    expect(rows[0]?.[0]).toMatchObject({ ref: "B2", kind: "text", value: "Ann" });
    expect(rows[1]?.[1]).toMatchObject({ ref: "C3", kind: "formula", formula: "=C2*2" });
    expect(LIVE_STATE_NOTICE).toMatch(/not proof of completion/i);
  });

  it("an unknown sheet, a backend refusal and a bad request are coded, isError true", async () => {
    for (const [args, code] of [
      [{ range: "A1", sheet: "missing" }, "UNKNOWN_SHEET"],
      [{ range: "A1", path: "/etc/passwd" }, "UNKNOWN_FIELD"],
      [{ range: "A1:Z999" }, "RANGE_TOO_LARGE"],
    ] as const) {
      const r = await call(service(), "state_read_range", args);
      expect(r.result.isError).toBe(true);
      expect(r.result.structuredContent).toEqual({
        api: "myco.state/v1",
        ok: false,
        tool: "state_read_range",
        code,
      });
    }
    const tree = await call(service(), "state_ui_tree", {});
    expect(tree.result.structuredContent.code).toBe("UI_TREE_UNAVAILABLE");
  });

  it("every refusal code is one of STATE_CODES and nothing else", async () => {
    const s = service();
    const replies = await Promise.all([
      call(s, "state_read_range", { range: "../../x" }),
      call(s, "state_ui_tree", { maxDepth: 0 }),
      call(s, "state_list_sheets", { x: 1 }),
      call(s, "state_document_status", "nope"),
    ]);
    for (const r of replies) expect(STATE_CODES).toContain(r.result.structuredContent.code);
  });

  it("an unknown tool is a JSON-RPC error that does not echo the name", async () => {
    const r = await call(service(), "/home/someone/secret_tool");
    expect(r.error).toEqual({ code: -32602, message: "unknown tool" });
    expect(JSON.stringify(r)).not.toContain("/home/someone");
  });

  it("a backend that throws gives BACKEND_ERROR; its message goes only to the operator", async () => {
    const seen: string[] = [];
    const s = createStateService({
      backend: throwingBackend("ENOENT: /srv/vault/run-1/ground-truth.json PLANTED_FAKE_MARKER"),
      onDiagnostic: (e) => seen.push(e.detail),
    });
    for (const tool of STATE_TOOL_NAMES) {
      const r = await call(s, tool, tool === "state_read_range" ? { range: "A1" } : {});
      expect(r.result.structuredContent.code).toBe("BACKEND_ERROR");
      expect(JSON.stringify(r)).not.toMatch(/PLANTED_FAKE_MARKER|\/srv\/vault|ENOENT/);
    }
    expect(seen.join("\n")).toContain("PLANTED_FAKE_MARKER");
  });
});

describe("server re-checks the backend against the caps (fail closed)", () => {
  const read = (data: unknown) =>
    createStateService({ backend: rawBackend(data) }).call("state_read_range", { range: "A1:B2" });

  it("refuses a range reply with the wrong shape", async () => {
    expect(await read({ rows: [[{}, {}]] })).toMatchObject({ code: "BACKEND_ERROR" });
    expect(await read({ rows: [[{}], [{}]] })).toMatchObject({ code: "BACKEND_ERROR" });
    expect(await read(null)).toMatchObject({ code: "BACKEND_ERROR" });
    expect(
      await read({
        rows: [
          [{}, {}],
          [{}, {}],
        ],
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses an over-long string anywhere in the reply", async () => {
    const long = "x".repeat(STATE_CAPS.maxCellTextChars + 1);
    expect(
      await read({
        rows: [
          [{ display: long }, {}],
          [{}, {}],
        ],
      }),
    ).toMatchObject({ code: "BACKEND_ERROR" });
  });

  it("refuses a UI tree over the depth, node or width cap", async () => {
    const chain = (depth: number): UiNode =>
      depth === 0
        ? { role: "x", name: "", childCount: 0 }
        : { role: "x", name: "", childCount: 1, children: [chain(depth - 1)] };
    const tree = (t: UiNode, args: object) =>
      createStateService({ backend: rawBackend({ tree: t, nodes: 0, truncated: false }) }).call(
        "state_ui_tree",
        args,
      );
    expect(await tree(chain(3), { maxDepth: 3 })).toMatchObject({ ok: true });
    expect(await tree(chain(4), { maxDepth: 3 })).toMatchObject({ code: "BACKEND_ERROR" });
    expect(await tree(chain(5), { maxDepth: 8, maxNodes: 5 })).toMatchObject({
      code: "BACKEND_ERROR",
    });
    const wide: UiNode = {
      role: "x",
      name: "",
      childCount: 30,
      children: Array.from({ length: STATE_CAPS.maxChildrenPerNode + 1 }, () => ({
        role: "y",
        name: "",
        childCount: 0,
      })),
    };
    expect(await tree(wide, { maxNodes: 200 })).toMatchObject({ code: "BACKEND_ERROR" });
  });

  it("scrubs path-like text from UI names (window titles carry file names)", async () => {
    const t: UiNode = {
      role: "root_pane",
      name: "/home/u/runs/trial-1/saved.xlsx — LibreOffice Calc",
      childCount: 2,
      children: [
        { role: "label", name: "C:\\Users\\u\\vault\\gt.json", childCount: 0 },
        { role: "label", name: "file:///tmp/x/y.csv and ~/secrets/k", childCount: 0 },
      ],
    };
    const reply = await createStateService({
      backend: rawBackend({ tree: t, nodes: 3, truncated: false }),
    }).call("state_ui_tree", {});
    const text = JSON.stringify(reply);
    expect(text).not.toMatch(/\/home\/u|Users|vault|tmp\/x|secrets/);
    expect(text).toContain("[path] — LibreOffice Calc");
    expect(scrubPaths("2024/06/21 and a/b")).toBe("2024/06/21 and a/b");
  });

  it("refuses a reply over maxReplyBytes with OUTPUT_TOO_LARGE", async () => {
    const cellText = "y".repeat(STATE_CAPS.maxCellTextChars);
    const rows = Array.from({ length: 20 }, () =>
      Array.from({ length: 20 }, () => ({ display: cellText })),
    );
    const s = createStateService({ backend: rawBackend({ rows }) });
    expect(await s.call("state_read_range", { range: "A1:T20" })).toMatchObject({
      code: "OUTPUT_TOO_LARGE",
    });
  });

  it("withholds any reply containing a harness-withheld string (raw or JSON-escaped)", async () => {
    const root = "C:\\trials\\run-2";
    const s = createStateService({
      backend: rawBackend({ rows: [[{ display: `see ${root}` }]] }),
      withheld: [root, "/srv/vault"],
    });
    expect(await s.call("state_read_range", { range: "A1" })).toMatchObject({
      code: "OUTPUT_WITHHELD",
    });
  });
});

describe("JSON-RPC framing", () => {
  const s = createStateService({ backend: fakeBackend(doc()) });

  it("initialize names the server and says the state is not proof", async () => {
    const r = await rpc(s, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(r?.result.serverInfo.name).toBe("myco-state");
    expect(r?.result.protocolVersion).toBe("2025-03-26");
    expect(r?.result.instructions).toMatch(/not proof/);
    expect(r?.result.instructions).toMatch(/cannot change anything/);
  });

  it("parse error, batch, bad request, unknown method, notification", async () => {
    expect(JSON.parse((await handleStateLine(s, "{nope")) ?? "")).toMatchObject({
      error: { code: -32700 },
    });
    expect(await rpc(s, [])).toMatchObject({ error: { code: -32600 } });
    expect(await rpc(s, { id: 1, method: "ping" })).toMatchObject({ error: { code: -32600 } });
    const unknown = await rpc(s, { jsonrpc: "2.0", id: 2, method: "/etc/shadow" });
    expect(unknown).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "method not found" },
    });
    expect(await rpc(s, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });
});

describe("stdin frame cap (the gate's boundFrames, as scripts/myco-state.ts wires it)", () => {
  it("answers an oversized frame -32600 and keeps serving", async () => {
    const { PassThrough } = await import("node:stream");
    const { boundFrames } = await import("../../src/gate/stdio-frame.ts");
    const { serveStateStdio } = await import("../../src/state/server.ts");
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (c: Buffer) => lines.push(...c.toString("utf8").split("\n").filter(Boolean)));
    const served = serveStateStdio(
      createStateService({ backend: fakeBackend(doc()) }),
      boundFrames(input, { maxBytes: 4096 }),
      output,
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "state_read_range", arguments: { range: "x".repeat(10_000) } } })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
    input.end();
    await served;
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });
});
