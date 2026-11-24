import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedDiagnostic } from "../../scripts/c1-driver-preflight.ts";
import { connectC1, type Mcp } from "../../src/baseline/c1.ts";
import { type PreparedC1, runC1Trial } from "../../src/baseline/c1-trial.ts";
import { judge } from "../../src/baseline/index.ts";
import { mcpStdio } from "../../src/baseline/mcp-stdio.ts";
import {
  createPlanner,
  MAX_CALL_MICROS,
  type Planner,
  PlannerFailure,
} from "../../src/baseline/planner.ts";
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
  it("does not gate a trial on AC power", async () => {
    // Tiffany: never pause or gate VM work on charger state. Power is recorded
    // evidence, so a battery trial must RUN and report acPower: false rather
    // than throw. Load-bearing: reinstating the gate fails this test.
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      { ...prepared(), acPower: false },
      planner(),
    );
    expect(row.acPower).toBe(false);
  });

  it("runs teardown on an aborting precondition, so an abort cannot leak", async () => {
    // Regression: an aborting precondition must sit inside the cleanup scope.
    // The AC gate that used to live before the try is gone, so this now proves
    // the mechanism itself: a trial that aborts at entry still closes its
    // transport. Uses a driver so the guarded block is entered.
    const closed = vi.fn(async () => {});
    await expect(
      runC1Trial(
        { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
        {
          ...prepared(),
          closeTransport: closed,
          connect: async () => {
            throw new Error("abort at entry");
          },
        },
        planner(),
      ),
    ).rejects.toThrow(/abort at entry/);
    expect(closed).toHaveBeenCalledTimes(1);
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
      expect(await c1.execute(action)).toEqual({
        outcome: "delivered",
        deliveryMode: "background",
        escalated: false,
        verified: true,
      });
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
    // TIF-186: index 1's prepare throws BEFORE any planner call, so it books 0, not
    // its 30-call reservation. Two consequences, both intended:
    //   - the charge is 400 (index 0's real cost), not 30 * MAX_CALL_MICROS + 400
    //   - `completed` rises from 1 to 3, because booking 0 for a trial that spent
    //     nothing consumes the arm limit more slowly. The old behaviour let a
    //     phantom hold stop a run that was affordable - what happened to arm-003d
    //     r5, whose apparent cap read $6.30 against $4.48 of cash.
    expect(report).toMatchObject({
      completed: 3,
      partial: true,
      c1ChargedMicros: 1200,
    });
    expect(report.rows[0]).toMatchObject({ verdict: "refuted" });
    expect(report.rows[1]).toMatchObject({ omitted: "trial-interrupted" });
    // Row 3 now SCORES rather than being omitted spend-limit: without index 1's
    // phantom reservation consuming the arm limit, the budget stretches further.
    // The cap still binds eventually - that is asserted by the dedicated cap test.
    expect(report.rows[3]).toMatchObject({ mycoVerdict: "refuted" });
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
    // 4, not 2: without the phantom reservation the arm limit stretches further, so
    // more trials are prepared. The point of this assertion is that the RERUN does
    // not prepare again for already-scored or already-interrupted indices, which the
    // `toEqual(report)` above pins.
    expect(prepare).toHaveBeenCalledTimes(4);
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

    // TIF-164/TIF-90: prior spend counts against the ceiling.
    //
    // The ledger in a run directory holds only that run's trials, so a fresh
    // directory previously got a full allowance it had already spent part of.
    // arm-003d hit this: $3.19 was committed against a $9 ceiling and the new
    // ledger started at zero. Fail-closed means a prior-spend seed that is
    // present but ignored must BLOCK the run, not merely be absent from the math.
    // A fresh spy per case: the shared one is asserted against earlier in this
    // test, and reusing it would make an unrelated count failure look like a
    // seed failure.
    const fresh = {
      directory: directory(),
      coordinatorGo: true,
      prepare: vi.fn(async () => prepared()),
      planner,
    };
    // Plenty of room: prior spend is small, so the run proceeds. This is the
    // control that proves the assertion below is about the seed and not about a
    // universally-impossible cap.
    const roomy = await runC1Sweep({ ...fresh, priorSpendMicros: 100_000 });
    expect(roomy.completed).toBeGreaterThan(0);
    // Remaining budget of one trial's reservation: prior spend must consume it,
    // or the run would buy a second trial with money already gone.
    const tight = await runC1Sweep({
      directory: directory(),
      coordinatorGo: true,
      prepare: vi.fn(async () => prepared()),
      planner,
      priorSpendMicros: 9_000_000 - 376_800,
      // The seed consumes almost the whole ceiling, so the caller must state
      // what is LEFT rather than inherit the per-arm default - which is the
      // fail-closed behaviour this parameter adds.
      armLimitMicros: 376_800,
    });
    expect(tight.rows[0]).toMatchObject({ omitted: "spend-limit" });
    // And an invalid seed is refused outright rather than treated as zero.
    for (const bad of [-1, 1.5, Number.NaN, 9_000_001]) {
      await expect(runC1Sweep({ ...fresh, priorSpendMicros: bad })).rejects.toThrow(
        "invalid prior spend",
      );
    }
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
    // The point is that the paying call is the Count-Tokens body PLUS max_tokens,
    // not that the ceiling is one particular number - the ceiling is asserted in
    // planner-truncation.test.ts, where its value is the subject. Pinning 256 here
    // made a deliberate raise of that ceiling look like a vision regression.
    const paying = JSON.parse(String(messages?.body));
    const countBody = JSON.parse(String(count?.body));
    expect(typeof paying.max_tokens).toBe("number");
    expect({ ...paying, max_tokens: 0 }).toEqual({ ...countBody, max_tokens: 0 });
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

describe("C1 sweep abort-early", () => {
  // Defensive engineering rule 7: two consecutive identical exclusion causes
  // mean the sweep is measuring the harness, not the agent. The pre-existing
  // single-strike rule only watches `driver-unreachable` verdicts on scored
  // rows; this covers the general case, where a repeated *omission* cause
  // (here a failed prepare) burns the arm without ever scoring a row.
  // Reverting noteCause makes this fail: the sweep walks all 30 rows and
  // prepares 30 times instead of stopping at 2.
  it("stops after two consecutive identical exclusion causes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-early-"));
    directories.push(directory);
    let prepares = 0;
    const report = await runC1Sweep({
      coordinatorGo: true,
      directory,
      planner: planner(),
      prepare: async () => {
        prepares += 1;
        // The arm's real failure shape: the driver answers but its session
        // command fails, so prepare throws and the trial is omitted.
        throw new Error("session-command-failed");
      },
    });
    // It must stop early rather than walking all 30 rows.
    expect(prepares).toBeLessThan(5);
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const reasons = Object.values(ledger.c1 as Record<string, { reason?: string }>)
      .map((e) => e.reason)
      .filter(Boolean);
    expect(reasons).toContain("repeated-cause");
    expect(report.completed).toBe(0);
  });

  // The SCORED case, which the omission test above does not cover (TIF-164).
  //
  // arm-003d r2 trials 3 and 4 both SCORED `refuted/persisted-mismatch` with zero
  // steps and one truncated model call. The abort rule was wired only to
  // omissions and driver-unreachable, so a repeated scored failure incremented
  // nothing and the sweep kept buying trials that were measuring the output
  // ceiling rather than the agent. Reverting the scored branch makes this fail:
  // every row is prepared instead of stopping at two.
  //
  // This is the ZERO-ACTION case: the planner returns nothing, so the histogram
  // is empty and identical on both trials - which is why an empty shape still
  // aborts. (TIF-181 later changed the key from verdict+steps to that histogram;
  // this test's premise is unchanged by it, but the shape it relies on is worth
  // naming.)
  it("stops after two consecutive identical SCORED failures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-scored-"));
    directories.push(directory);
    let prepares = 0;
    await runC1Sweep({
      coordinatorGo: true,
      directory,
      // A judge that always finds the document unsaved: the r2 shape. The trial
      // completes and scores, it does not throw.
      planner: planner(),
      prepare: async () => {
        prepares += 1;
        return prepared();
      },
    });
    expect(prepares).toBeLessThan(5);
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const reasons = Object.values(ledger.c1 as Record<string, { reason?: string }>)
      .map((e) => e.reason)
      .filter(Boolean);
    expect(reasons).toContain("repeated-cause");
  });

  // TIF-181. The rule keys on the ACTION HISTOGRAM, not on verdict+steps.
  //
  // arm-003d r3 aborted on trials 0 and 1, which both scored refuted/step-budget
  // at 30 steps but did plainly different things: 28 press_keys + 2 type_texts
  // versus 20 press_keys + 5 clicks + 5 type_texts. That is a hard task, not a
  // repeated harness fault, and aborting it threw away real baseline data the
  // run had already paid for.
  it("does NOT abort when two step-budget failures took different actions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-varied-"));
    directories.push(directory);
    let prepares = 0;
    // A FACTORY, not a shared array: the first draft reused one array, so trial 1
    // consumed what trial 0 had left and both signatures collapsed to the same
    // shape. Building fresh per trial is the difference between testing the rule
    // and testing the fixture.
    //
    // Two shapes, both 30 actions, both exhausting the budget, different tools:
    // the r3 pattern (28 press_keys + 2 type_texts vs 20/5/5) in miniature.
    // Reproduces r3's ACTUAL pair, then keeps varying so no later trial collides.
    //
    // r3 trial 0 was press_keyx28 + type_textx2 and trial 1 was
    // clickx5 + press_keyx20 + type_textx5. Using a modulo schedule here was
    // wrong: `(trial % 5) + (trial % 4)` yields only 20 distinct shapes across 30
    // trials, so trials 0 and 20 were identical, and trial 0 collapsed to
    // press_keyx30 rather than r3's mixed shape.
    const shape = (trial: number) => {
      // trial 0 is r3 verbatim: press_keyx28 + type_textx2.
      //
      // Every later trial gets a DISTINCT (clicks, types) pair, using the fact that
      // (n % 5, n // 5) is injective over n in 0..29. Three earlier attempts failed
      // here and each failure is instructive: clamping saturated five trials into
      // one shape, two out-of-phase modulo cycles repeated at their LCM, and a
      // single-stride lattice collided 8 times. Injectivity has to be CONSTRUCTED,
      // not hoped for from coprime-looking constants.
      const lo = trial - 1;
      const types = trial === 0 ? 2 : 1 + Math.floor(lo / 5);
      const clicks = trial === 0 ? 0 : 2 + (lo % 5) * 3;
      return Array.from({ length: 30 }, (_, i) =>
        i < clicks
          ? { tool: "click", arguments: { x: 222 + i, y: 262 } }
          : i < clicks + types
            ? { tool: "type_text", arguments: { x: 222, y: 261, text: `v${trial}-${i}\n` } }
            : { tool: "press_key", arguments: { x: 300, y: 261, key: "Ctrl+s" } },
      );
    };
    let queued: { tool: string; arguments: unknown }[] = [];
    let trial = -1;
    const varied = {
      paid: true,
      calls: [],
      async act() {
        return { decision: queued.shift() ?? ("failure" as const), calls: [] };
      },
    } as unknown as Planner;
    await runC1Sweep({
      coordinatorGo: true,
      directory,
      planner: varied,
      prepare: async () => {
        prepares += 1;
        trial += 1;
        queued = shape(trial);
        return prepared();
      },
    });
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const reasons = Object.values(ledger.c1 as Record<string, { reason?: string }>)
      .map((e) => e.reason)
      .filter(Boolean);
    // The whole point: varied effort must NOT stop the arm.
    expect(reasons).not.toContain("repeated-cause");
    // And it kept going rather than stopping after the pair - the assertion that
    // makes `prepares` load-bearing instead of decorative.
    expect(prepares).toBeGreaterThan(2);
  });

  // The other side of the same rule, and the reason it still exists: an IDENTICAL
  // action sequence repeated is a harness fault and MUST abort.
  it("DOES abort when two scored failures repeat the identical action sequence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-identical-"));
    directories.push(directory);
    let prepares = 0;
    // Built fresh per trial from the same recipe, so every trial's action SHAPE is
    // identical - the harness-fault signature this rule must still catch. The
    // coordinates vary slightly per action, which is deliberate: the key counts
    // TOOLS, so a fault that reproduces its tool mix still aborts even when the
    // coordinates differ.
    const identical = () =>
      Array.from({ length: 30 }, (_, i) => ({
        tool: "press_key",
        arguments: { x: 320, y: 278, key: i % 2 ? "Escape" : "Ctrl+s" },
      }));
    let queued: { tool: string; arguments: unknown }[] = [];
    const same = {
      paid: true,
      calls: [],
      async act() {
        return { decision: queued.shift() ?? ("failure" as const), calls: [] };
      },
    } as unknown as Planner;
    await runC1Sweep({
      coordinatorGo: true,
      directory,
      planner: same,
      prepare: async () => {
        prepares += 1;
        queued = identical();
        return prepared();
      },
    });
    // Must stop early: the identical shape is the fault signature.
    expect(prepares).toBeLessThan(5);
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const reasons = Object.values(ledger.c1 as Record<string, { reason?: string }>)
      .map((e) => e.reason)
      .filter(Boolean);
    expect(reasons).toContain("repeated-cause");
  });

  // TIF-187. The same abort rule, exercised through the TRIAL catch rather than
  // prepare's. TIF-186 changed the key at BOTH noteCause call sites, but the
  // different-messages test below only reaches prepare's: its prepare throws, so
  // runC1Trial is never entered. Reverting the trial-catch key alone therefore
  // left the whole suite green - the fix was only half mutation-protected.
  //
  // What reaches the trial catch: a throw from `connect()`, which runs inside
  // runC1Trial's outer try. There is no retry loop - connect() is called once per
  // trial - so `connects++` advances by one for each of the 30 manifest entries and
  // the messages below are delivered in order, one per trial.
  it("stops after two consecutive TRIAL-catch omissions with DIFFERENT messages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-trialcatch-"));
    directories.push(directory);
    const messages = [
      "mcp request timed out mid-trial",
      "guest window closed while the trial was running",
      "screenshot decode failed during the trial",
    ];
    let connects = 0;
    await runC1Sweep({
      coordinatorGo: true,
      directory,
      planner: planner(),
      // prepare SUCCEEDS, so the throw below happens inside runC1Trial - that is
      // the whole point: this must exercise the trial catch, not prepare's.
      prepare: async () => ({
        ...prepared(),
        connect: async () => {
          throw new Error(messages[connects++ % messages.length]);
        },
      }),
    });
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const entries = Object.values(
      ledger.c1 as Record<string, { reason?: string; detail?: string }>,
    );
    const reasons = entries.map((e) => e.reason).filter(Boolean);
    // The class is the key, so two same-class omissions trip the rule even though
    // their messages differ - the arm-003d r5 failure.
    expect(reasons).toContain("repeated-cause");
    // The message is still preserved, so a stopped run is diagnosable.
    const details = entries.map((e) => e.detail).filter(Boolean) as string[];
    expect(details.some((d) => messages.some((m) => d.includes(m)))).toBe(true);
  });

  // TIF-186. The abort must fire on the FAULT CLASS, not on the message text.
  //
  // arm-003d r5 omitted trials 2 and 3 as `trial-interrupted` and kept going. The
  // cause key was `trial-interrupted:${error.message}`, so two omissions of the
  // same class but with different messages - an SSH banner timeout, then a throw
  // later in the trial - produced different keys and `consecutive` never reached
  // 2. Two identical interruptions burned $0.61 of cap each for no data.
  //
  // The pre-existing exclusion test above passes because it throws the SAME
  // message every time, so it could not see this. This is the case that failed in
  // production.
  it("stops after two consecutive omissions with DIFFERENT messages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-mixed-"));
    directories.push(directory);
    let prepares = 0;
    const messages = [
      "Connection timed out during banner exchange",
      "guest screenshot unavailable: window never read",
      "UNO socket timed out before becoming ready",
    ];
    await runC1Sweep({
      coordinatorGo: true,
      directory,
      planner: planner(),
      prepare: async () => {
        // A DIFFERENT message each time, same fault class: prepare failed.
        throw new Error(messages[prepares++ % messages.length]);
      },
    });
    expect(prepares).toBeLessThan(5);
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const reasons = Object.values(ledger.c1 as Record<string, { reason?: string }>)
      .map((e) => e.reason)
      .filter(Boolean);
    expect(reasons).toContain("repeated-cause");
  });

  // And the message must still be readable, because the abort no longer keys on it:
  // without persisting it, a run that stops cannot be diagnosed from its artifacts.
  it("persists the omission message as detail even though it no longer keys the abort", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-detail-"));
    directories.push(directory);
    await runC1Sweep({
      coordinatorGo: true,
      directory,
      planner: planner(),
      prepare: async () => {
        throw new Error("Connection timed out during banner exchange");
      },
    });
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const first = ledger.c1["0"] as { reason?: string; detail?: string };
    expect(first.reason).toBe("trial-interrupted");
    expect(first.detail).toContain("banner exchange");
  });

  // Mutation B in the earlier review: dropping the reset (`else consecutive += 1`)
  // left the suite green, because the only test used one cause. This pins the
  // reset — alternating causes must never accumulate into an abort.
  it("does not abort when the cause alternates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "myco-abort-reset-"));
    directories.push(directory);
    let prepares = 0;
    await runC1Sweep({
      coordinatorGo: true,
      directory,
      planner: planner(),
      prepare: async () => {
        prepares += 1;
        // TIF-186 changed what distinguishes a cause: the MESSAGE no longer does,
        // because keying on it meant two same-class faults with different messages
        // never aborted (arm-003d r5). The reset still has to work, so it is
        // exercised with a signal that genuinely alternates - the omission CLASS.
        // A prepare failure is `trial-interrupted`; the other arm of this throws
        // `PlannerFailure`, which is `planner-failed`. Different classes, so the
        // counter must reset between them.
        if (prepares % 2 === 0) throw new Error("session-command-failed");
        throw new PlannerFailure("Anthropic messages API call failed");
      },
    });
    const ledger = JSON.parse(readFileSync(join(directory, "accounting.json"), "utf8"));
    const reasons = Object.values(ledger.c1 as Record<string, { reason?: string }>)
      .map((e) => e.reason)
      .filter(Boolean);
    // Alternating causes must not trip abort-early: no repeated-cause stop.
    expect(reasons).not.toContain("repeated-cause");
    expect(prepares).toBeGreaterThan(2);
  });
});

describe("driver diagnostic propagation", () => {
  // Standing rule 4 (contract tests across boundaries) and the reason #156 had
  // to ship twice: the preflight computed a precise diagnostic, logged it, and
  // dropped it, so a too-tight timeout and a dead driver produced byte-identical
  // artifacts (`driver-unreachable`) and the arm could not name its own cause.
  it("carries the preflight diagnostic into the row for a driver-unreachable verdict", async () => {
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      {
        ...prepared(),
        driver: {
          hostVersion: "0.56.4",
          guestVersion: "0.56.4",
          pipeReachable: true,
          sessionIdentityMatches: false,
          diagnostic: "session-command-failed",
        },
        judge: async () => ({ kind: "unavailable" }),
      },
      planner(),
    );
    expect(row.verdict).toBe("uncertain");
    expect(row.verdictReason).toBe("driver-unreachable");
    // The cause must survive to the persisted artifact, not just the console.
    expect(row.driver.diagnostic).toBe("session-command-failed");
  });

  it("omits the diagnostic when the preflight did not supply one", async () => {
    // Absent must stay absent: an older call site that does not pass it must
    // not fabricate a cause.
    const row = await runC1Trial(
      { index: 0, params: targetParams, cellRef: "B2", expected: "x", previousValue: "y" },
      prepared(),
      planner(),
    );
    expect(row.driver.diagnostic).toBeUndefined();
  });
});

describe("judge names the driver cause", () => {
  // The row's driver field is set by prepare(); the *verdict* is what the
  // sweep diff reads. Reverting the reasons spread leaves this passing only if
  // the assertion targets the wrong field, so it targets the verdict.
  it("includes the diagnostic in the verdict reasons", () => {
    const verdict = judge(
      { actions: [], claims: [], deliveries: [] },
      {
        hostVersion: "0.56.4",
        guestVersion: "0.56.4",
        pipeReachable: true,
        sessionIdentityMatches: false,
        diagnostic: "session-command-failed",
      },
      { kind: "unavailable" },
    );
    expect(verdict.status).toBe("uncertain");
    expect(verdict.reasons).toContain("driver-unreachable");
    expect(verdict.reasons).toContain("session-command-failed");
  });
});

describe("judge leaves an unnamed cause unnamed", () => {
  // The judge() spread's own fallback was untested: `driver.diagnostic ??
  // "driver-cause-unknown"` passed every other test. A fabricated cause is
  // worse than none, so this pins the exact array.
  it("returns exactly ['driver-unreachable'] when the diagnostic is absent", () => {
    const verdict = judge(
      { actions: [], claims: [], deliveries: [] },
      {
        hostVersion: "0.56.4",
        guestVersion: "0.56.4",
        pipeReachable: true,
        sessionIdentityMatches: false,
      },
      { kind: "unavailable" },
    );
    expect(verdict.reasons).toEqual(["driver-unreachable"]);
  });
});

describe("the success sentinel is not a cause", () => {
  // classifySession returns `match` on success, and the sweep builds the driver
  // via persistedDiagnostic(). Carrying the sentinel into the row would put
  // `diagnostic: "match"` on every healthy row, contradicting the field's
  // contract ("the preflight's precise failure cause"). Reverting the helper to
  // always spread `diagnostic` fails this.
  it("records nothing for the success sentinel", () => {
    expect(persistedDiagnostic("match")).toEqual({});
  });

  it("records the cause for every real failure", () => {
    for (const cause of [
      "session-command-failed",
      "session-mismatch",
      "pipe-unreachable",
      "daemon-missing",
      "version-mismatch",
    ]) {
      expect(persistedDiagnostic(cause)).toEqual({ diagnostic: cause });
    }
  });
});
