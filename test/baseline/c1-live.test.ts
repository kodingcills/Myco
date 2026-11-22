import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectC1, type Mcp } from "../../src/baseline/c1.ts";
import { type PreparedC1, runC1Trial } from "../../src/baseline/c1-trial.ts";
import { mcpStdio } from "../../src/baseline/mcp-stdio.ts";
import { createPlanner, MAX_CALL_MICROS, type Planner } from "../../src/baseline/planner.ts";
import { runC1Sweep } from "../../src/baseline/sweep.ts";

const shot = { type: "image", mimeType: "image/png", data: "eA==" } as const;
const targetParams = {
  fixtureSeed: "s",
  rowKey: "EMP-0001",
  column: "name",
  newValue: "REVISED-1",
};
/** A planner that never gets consulted when a precondition aborts first. */
function planner(): Planner {
  return {
    paid: true,
    act: async () => ({
      calls: [{ model: "claude-sonnet-5-5", usage: { prompt: 1, completion: 1, cost: 0 } }],
      decision: "failure",
    }),
  };
}
const action = { tool: "click", arguments: { x: 1, y: 2 } };
const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "myco-c1-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeMcp() {
  return {
    request: vi.fn(async (method: string, params: { name?: string }) => {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (params.name === "get_window_state")
        return {
          content: [{ type: "text", text: "secret tree" }, shot],
          structuredContent: { element_token: "tree" },
        };
      return { structuredContent: { path: "pixel", verified: true } };
    }),
    notify: vi.fn(async () => {}),
  } satisfies Mcp;
}
function prepared(): PreparedC1 {
  return {
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      pipeReachable: true,
      sessionIdentityMatches: true,
    },
    resetMs: 1,
    acPower: true,
    caffeinate: true,
    loadAvg1: 0,
    window: { pid: 1, window_id: 2 },
    connect: async () => fakeMcp(),
    closeTransport: async () => {},
    judge: async () => ({ kind: "persisted", actual: "wrong", expected: "right" }),
    audit: async () => true,
  };
}

describe("C1 host harness", () => {
  it("does not gate a trial on AC power, and still tears down on battery", async () => {
    // Tiffany, 2026-11-22: never pause or gate C1 runs on charger power.
    // Power source is recorded evidence, not a precondition - so a battery trial
    // must run to completion AND still close its transport. Both halves matter:
    // the 2026-11-22 leak happened because an abort skipped teardown, so simply
    // deleting the gate would hide that regression class rather than prevent it.
    // Fails if the gate returns (verified by reinstating it: "AC power required").
    const closed = vi.fn(async () => {});
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      { ...prepared(), acPower: false, closeTransport: closed },
      planner(),
    );
    expect(closed).toHaveBeenCalledTimes(1);
    expect(row.acPower).toBe(false);
  });

  it("still runs teardown when the trial itself throws", async () => {
    const closed = vi.fn(async () => {});
    await expect(
      runC1Trial(
        { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
        {
          ...prepared(),
          closeTransport: closed,
          connect: async () => {
            throw new Error("guest went away");
          },
        },
        planner(),
      ),
    ).rejects.toThrow(/guest went away/);
    expect(closed).toHaveBeenCalledTimes(1);
=======
  it("does not gate a trial on AC power", async () => {
    // Tiffany, 2026-11-22: never pause or gate C1 runs on charger power.
    // Power source is recorded evidence, not a precondition - so a battery trial
    // must run rather than throw, and the row must still report acPower: false.
    // Verified load-bearing by reinstating the gate: this fails "AC power required".
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      { ...prepared(), acPower: false },
      planner(),
    );
    expect(row.acPower).toBe(false);
  });

  it("negotiates JSON-RPC over stdio and exposes pixels only", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const fake = fakeMcp();
    input.on("data", async (data) => {
      const { id, method, params } = JSON.parse(String(data));
      if (id === undefined) await fake.notify();
      else
        output.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, result: await fake.request(method, params) })}\n`,
        );
    });
    const mcp = mcpStdio(input, output);
    try {
      const c1 = await connectC1(mcp, { pid: 1, window_id: 2 });
      expect(await c1.screenshot()).toEqual({ mimeType: shot.mimeType, data: shot.data });
      await expect(
        c1.execute({ ...action, arguments: { ...action.arguments, element_token: "x" } }),
      ).rejects.toThrow();
      await expect(
        c1.execute({ ...action, arguments: { ...action.arguments, pid: 99 } }),
      ).rejects.toThrow();
      expect(await c1.execute(action)).toEqual({ refused: false, verified: true });
      expect(fake.request).toHaveBeenCalledTimes(3);
      expect(fake.request).toHaveBeenLastCalledWith("tools/call", {
        name: "click",
        arguments: { x: 1, y: 2, pid: 1, window_id: 2 },
      });
    } finally {
      mcp.close();
    }
  });

  it("persists attempt charges, omits capped rows and never retries a scored or interrupted index", async () => {
    const root = directory();
    const prepare = vi.fn(async ({ index }: { index: number }, snapshot: string) => {
      expect(snapshot).toBe("cua-c1-base");
      if (index === 1) throw new Error("sensitive preparation error");
      return prepared();
    });
    const planner: Planner = {
      paid: true,
      act: async () => ({
        calls: [
          { model: "claude-sonnet-5-5", usage: { prompt: 100, completion: 20, cost: 0.0004 } },
        ],
        decision: "done",
      }),
    };
    const options = {
      directory: root,
      coordinatorGo: true,
      prepare,
      planner,
      armLimitMicros: 30 * MAX_CALL_MICROS * 2,
    };
    const report = await runC1Sweep(options);
    expect(report).toMatchObject({
      completed: 1,
      partial: true,
      c1ChargedMicros: 30 * MAX_CALL_MICROS + 400,
    });
    expect(report.rows[0]).toMatchObject({ verdict: "refuted" });
    expect(report.rows[1]).toMatchObject({ omitted: "trial-interrupted" });
    expect(report.rows[3]).toMatchObject({ mycoVerdict: "refuted", omitted: "spend-limit" });
    const rowPath = join(root, "trials", "c1", "0.json");
    const row = JSON.parse(readFileSync(rowPath, "utf8"));
    expect(row).toMatchObject({
      tokens: { in: 100, out: 20 },
      cost: 0.0004,
      transcript: { claims: ["done"] },
    });
    rmSync(rowPath);
    expect(await runC1Sweep(options)).toEqual(report);
    expect(JSON.parse(readFileSync(rowPath, "utf8"))).toEqual(row);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("enforces GO and both default and combined caps before preparation", async () => {
    const prepare = vi.fn(async () => prepared());
    const planner: Planner = { paid: true, act: async () => ({ calls: [], decision: "done" }) };
    const options = { directory: directory(), coordinatorGo: true, prepare, planner };
    await expect(runC1Sweep({ ...options, coordinatorGo: false })).rejects.toThrow(
      "Coordinator GO",
    );
    await runC1Sweep({ ...options, armLimitMicros: 0 });
    const path = join(options.directory, "accounting.json");
    const ledger = JSON.parse(readFileSync(path, "utf8"));
    ledger.c1 = { 0: { status: "reserved", micros: 4_200_000 } };
    writeFileSync(path, JSON.stringify(ledger));
    expect((await runC1Sweep(options)).rows[1]).toMatchObject({ omitted: "spend-limit" });
    ledger.c1 = {};
    ledger.c2 = { 0: { status: "reserved", micros: 8_700_000 } };
    writeFileSync(path, JSON.stringify(ledger));
    const report = await runC1Sweep(options);
    expect(report).toMatchObject({ combinedChargedMicros: 8_700_000, completed: 0 });
    expect(report.rows[0]).toMatchObject({ omitted: "spend-limit" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("stops before connecting when the driver preflight fails", async () => {
    const ops = prepared();
    ops.driver.guestVersion = "different";
    const connect = vi.spyOn(ops, "connect");
    const act = vi.fn(async () => ({ calls: [] }));
    const prepare = vi.fn(async () => ops);
    const report = await runC1Sweep({
      directory: directory(),
      coordinatorGo: true,
      planner: { paid: false, act },
      prepare,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
    expect(report.rows[0]).toMatchObject({ verdict: "uncertain" });
    expect(report.rows[1]).toMatchObject({ omitted: "driver-unreachable" });
  });

  it("isolates grading from player claims and attributes exhaustion", async () => {
    const target = {
      index: 0,
      params: { fixtureSeed: "a", rowKey: "EMP-0001", column: "name", newValue: "NEW" },
      expected: "NEW",
      previousValue: "OLD",
      cellRef: "B2",
    };
    const ops = prepared();
    const judge = vi.fn(
      async () => ({ kind: "persisted", actual: "NEW", expected: "NEW" }) as const,
    );
    ops.judge = judge;
    ops.audit = async () => {
      throw new Error("audit unavailable");
    };
    const pass = await runC1Trial(target, ops, {
      paid: false,
      act: async () => ({
        calls: [],
        decision: "failure",
      }),
    });
    expect(judge).toHaveBeenCalledWith();
    expect(pass).toMatchObject({ verdict: "verified", audited: false, falseSuccess: null });
    const exhausted = await runC1Trial(target, ops, {
      paid: false,
      act: async () => ({
        calls: [],
        decision: action,
      }),
    });
    expect(exhausted).toMatchObject({
      steps: 30,
      budgetExhausted: true,
      verdict: "refuted",
      verdictReason: "step-budget",
    });
  });

  it("keeps a synthetic key out of actions, artifact files and fallback requests", async () => {
    const key = "fake-test-key";
    const request = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/count_tokens")) {
        expect(new Headers(init?.headers).get("x-api-key")).toBe(key);
        return Response.json({ input_tokens: 100 });
      }
      if (String(url).startsWith("https:")) throw new Error(`refused: ${key}`);
      expect(JSON.stringify(init)).not.toContain(key);
      return Response.json({
        message: {
          content: JSON.stringify({ tool: "type_text", arguments: { x: 1, y: 2, text: key } }),
        },
      });
    });
    const root = directory();
    const prepare = vi.fn(async () => prepared());
    await runC1Sweep({
      directory: root,
      coordinatorGo: true,
      prepare,
      planner: createPlanner(request, { ANTHROPIC_API_KEY: key, ALLOW_FALLBACK: "true" }),
    });
    const row = readFileSync(join(root, "trials/c1/0.json"), "utf8");
    expect(row).toContain("planner:claude-sonnet-5-5+qwen3.8-uncensored");
    expect(JSON.parse(row).transcript.actions).toEqual([]);
    for (const filename of ["accounting.json", "report.json", "trials/c1/0.json"])
      expect(readFileSync(join(root, filename), "utf8")).not.toContain(key);
  });

  it.each([
    [
      "transport failure",
      () => {
        throw new Error("synthetic-secret");
      },
    ],
    ["HTTP 429 (unknown error type)", () => new Response("synthetic-secret", { status: 429 })],
    [
      "HTTP 402 (billing_error)",
      () =>
        Response.json(
          { error: { type: "billing_error", message: "synthetic-secret" } },
          { status: 402 },
        ),
    ],
    ["invalid JSON", () => new Response("synthetic-secret")],
    ["missing, invalid, or out-of-bounds token usage", () => Response.json({})],
    [
      "missing, invalid, or out-of-bounds token usage",
      () => Response.json({ usage: { input_tokens: 5001, output_tokens: 1 } }),
    ],
    [
      "unexpected cache usage",
      () =>
        Response.json({
          usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 1 },
        }),
    ],
  ] as const)("fails closed with a redacted Messages diagnostic for %s", async (reason, reply) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ input_tokens: 100 }))
      .mockImplementationOnce(async () => reply());
    const planner = createPlanner(request, { ANTHROPIC_API_KEY: "synthetic-secret" });
    await expect(planner.act("test", { mimeType: "image/png", data: "AA==" })).rejects.toThrow(
      `Anthropic Messages usage could not be verified: ${reason}`,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("sends Sonnet vision Messages without unsupported sampling parameters", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ input_tokens: 100 }))
      .mockResolvedValueOnce(
        Response.json({
          usage: { input_tokens: 100, output_tokens: 12 },
          content: [{ type: "text", text: '{"claim":"done"}' }],
        }),
      );
    const planner = createPlanner(request, { ANTHROPIC_API_KEY: "synthetic-key" });
    const result = await planner.act("test", { mimeType: "image/png", data: "AA==" });
    const count = request.mock.calls[0]?.[1];
    const messages = request.mock.calls[1]?.[1];
    expect(JSON.parse(String(messages?.body))).toEqual({
      ...JSON.parse(String(count?.body)),
      max_tokens: 256,
    });
    expect(JSON.parse(String(messages?.body)).model).toBe("claude-sonnet-5-5");
    expect(new Headers(messages?.headers).has("anthropic-beta")).toBe(false);
    expect(result.calls[0]?.usage).toEqual({ prompt: 100, completion: 12, cost: 0.00032 });
  });

  it("keeps only bounded scrubbed provider text on an Anthropic 400", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ input_tokens: 100 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              type: "invalid_request_error",
              message:
                "A billing credit detail.\nAuthorization: private-value\r\n\tfolded-private-value\r\n  second-folded-value\n" +
                '"X-Api-Key": "obscure-value"\n' +
                "synthetic-key " +
                ["sk", "ant", "other", "key"].join("-") +
                " " +
                "detail ".repeat(60),
            },
          },
          { status: 400 },
        ),
      );
    const planner = createPlanner(request, { ANTHROPIC_API_KEY: "synthetic-key" });
    const error = await planner
      .act("test", { mimeType: "image/png", data: "AA==" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const prefix =
      "Anthropic Messages usage could not be verified: HTTP 400 (invalid_request_error): ";
    expect(message.startsWith(`${prefix}A billing credit detail.`)).toBe(true);
    expect(message.slice(prefix.length)).toHaveLength(300);
    expect(message).not.toMatch(
      /private-value|second-folded-value|obscure-value|synthetic-key|sk-ant|[\r\n]/,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed without Ollama fallback when Anthropic call fails", async () => {
    const key = "fake-test-key";
    const request = vi.fn<typeof fetch>(async () => {
      return Response.json(
        { error: { type: "authentication_error", message: key } },
        { status: 401 },
      );
    });
    const root = directory();
    const prepare = vi.fn(async () => prepared());
    const report = await runC1Sweep({
      directory: root,
      coordinatorGo: true,
      prepare,
      planner: createPlanner(request, { ANTHROPIC_API_KEY: key }),
    });
    expect(report.completed).toBe(0);
    expect(report.rows[0]).toMatchObject({
      omitted: "planner-failed",
      detail: "Anthropic token count rejected: HTTP 401 (authentication_error)",
    });
    expect(JSON.stringify(report)).not.toContain(key);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
