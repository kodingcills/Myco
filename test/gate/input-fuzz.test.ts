/**
 * H-07 (docs/security/gate-api-review.md): input fuzzing of the gate API and the
 * `myco-gate` MCP wire. Every bad input gets a reason code (or a JSON-RPC error) and is
 * never `verified`; nothing malformed reaches the evidence reader.
 *
 * The gate under test is bound to a run whose persisted state PASSES, so any input that
 * slipped through to the oracle would show up as `verified`. A reader spy counts reads.
 * Tests only: this pins behaviour that is already correct on main.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CLAIM_LIMIT,
  GATE_API_VERSION,
  type GateResult,
  parseGateRequest,
  REASON_CODES,
} from "../../src/gate/api.ts";
import {
  buildRegistry,
  createGate,
  type EvidenceReader,
  fileEvidenceReader,
} from "../../src/gate/gate.ts";
import { GATE_TOOL, handleLine, serveStdio } from "../../src/gate/mcp-server.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { S01_ITEMS, S02_PERSISTED, tempRoot, todoStore, writeState } from "./helpers.ts";

const STORE = ".myco-todo.json";
const TASK = "df-s01";
const RUN = "run-ok";
const VALID = { taskId: TASK, runId: RUN } as const;

/** A gate bound to a passing run (or a refuting one), with a count of reads. */
function spiedGate(state: "passing" | "refuting" = "passing") {
  const root = tempRoot();
  writeState(root, RUN, STORE, todoStore(state === "passing" ? S01_ITEMS : S02_PERSISTED));
  const inner = fileEvidenceReader(root);
  const spy = { reads: 0 };
  const reader: EvidenceReader = {
    describe: inner.describe,
    read(runId, file) {
      spy.reads += 1;
      return inner.read(runId, file);
    },
  };
  const gate = createGate({
    tasks: buildRegistry(builtinTasks()),
    reader,
    assignment: { taskId: TASK, runId: RUN },
  });
  return { gate, spy };
}

function expectRefused(result: GateResult, code: string) {
  expect(result.verdict).toBe("uncertain");
  expect(result.accepted).toBe(false);
  expect(result.reasonCodes[0]).toBe(code);
  expect(result.oracle).toBeUndefined();
  for (const c of result.reasonCodes) expect(REASON_CODES).toContain(c);
}

describe("positive control: the gate under test does verify its own valid request", () => {
  it("the bound, passing run is verified (so a slipped-through input would show)", async () => {
    const { gate, spy } = spiedGate();
    const result = await gate.check(VALID);
    expect(result.verdict).toBe("verified");
    expect(result.accepted).toBe(true);
    expect(spy.reads).toBe(1);
  });
});

describe("wrong shapes and types are INVALID_REQUEST, with nothing read", () => {
  const cases: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["number", 0],
    ["string", JSON.stringify(VALID)],
    ["boolean", true],
    ["empty array", []],
    ["array holding a valid request", [VALID]],
    ["empty object", {}],
    ["taskId number", { taskId: 1, runId: RUN }],
    ["taskId null", { taskId: null, runId: RUN }],
    ["taskId array", { taskId: [TASK], runId: RUN }],
    ["taskId object", { taskId: { toString: () => TASK }, runId: RUN }],
    ["taskId boolean", { taskId: true, runId: RUN }],
    ["taskId empty", { taskId: "", runId: RUN }],
    ["runId missing", { taskId: TASK }],
    ["runId String object", { taskId: TASK, runId: new String(RUN) }],
    ["claim number", { ...VALID, claim: 1 }],
    ["claim null", { ...VALID, claim: null }],
    ["claim array", { ...VALID, claim: ["done"] }],
    ["claim object", { ...VALID, claim: { text: "done" } }],
    ["claim over the limit", { ...VALID, claim: "c".repeat(CLAIM_LIMIT + 1) }],
  ];
  for (const [name, raw] of cases) {
    it(name, async () => {
      const { gate, spy } = spiedGate();
      expectRefused(await gate.check(raw), "INVALID_REQUEST");
      expect(spy.reads).toBe(0);
    });
  }
});

describe("unicode, NUL and path tricks in taskId and runId are INVALID_REQUEST", () => {
  const tricks = [
    "../run-ok",
    "run-ok/..",
    "..",
    ".",
    ".run-ok",
    "-run-ok",
    "_run-ok",
    "run..ok",
    "run-ok/",
    "run/ok",
    "run\\ok",
    "/run-ok",
    "C:\\run-ok",
    "C:run-ok",
    "run-ok\0",
    "run\0ok",
    "run-ok\n",
    "run-ok\r\n",
    "\nrun-ok",
    " run-ok",
    "run-ok ",
    "run-ok\t",
    "run%2Fok",
    "run-ok%00",
    "ｒｕｎ-ok", // fullwidth
    "run-оk", // Cyrillic o
    "run‐ok", // U+2010 hyphen
    "run-ok\u200b", // zero-width space
    "run-ok\u202e", // bidi override
    "run-ok\ufeff",
    "run-ok\ud800", // lone surrogate
    "ﬁle", // NFKC folds to "file"
    "r".repeat(129),
    "~",
    "$HOME",
    "run-ok;rm",
    "run-ok*",
  ];
  for (const trick of tricks) {
    for (const field of ["taskId", "runId"] as const) {
      it(`${field} = ${JSON.stringify(trick)}`, async () => {
        const { gate, spy } = spiedGate();
        const result = await gate.check({ ...VALID, [field]: trick });
        expectRefused(result, "INVALID_REQUEST");
        expect(spy.reads).toBe(0);
        // The unsafe id is not echoed back in the request summary.
        expect(result.request[field]).toBeUndefined();
      });
    }
  }

  it("an id of exactly 128 safe characters is well formed (then ASSIGNMENT_MISMATCH)", async () => {
    const { gate, spy } = spiedGate();
    expectRefused(await gate.check({ ...VALID, runId: "r".repeat(128) }), "ASSIGNMENT_MISMATCH");
    expect(spy.reads).toBe(0);
  });
});

describe("apiVersion other than v1 is UNSUPPORTED_API_VERSION", () => {
  for (const version of ["myco.gate/v2", "myco.gate/v1 ", "MYCO.GATE/V1", "", 1, null, true, {}]) {
    it(JSON.stringify(version), async () => {
      const { gate, spy } = spiedGate();
      expectRefused(await gate.check({ ...VALID, apiVersion: version }), "UNSUPPORTED_API_VERSION");
      expect(spy.reads).toBe(0);
    });
  }
  it(`"${GATE_API_VERSION}" itself is accepted`, async () => {
    const { gate } = spiedGate();
    expect((await gate.check({ ...VALID, apiVersion: GATE_API_VERSION })).accepted).toBe(true);
  });
});

describe("prototype-pollution keys and inherited properties", () => {
  for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
    it(`a wire key "${key}" is UNKNOWN_FIELD and pollutes nothing`, async () => {
      const { gate, spy } = spiedGate();
      const raw = JSON.parse(
        `{"taskId":"${TASK}","runId":"${RUN}","${key}":{"accepted":true,"verdict":"verified"}}`,
      );
      expectRefused(await gate.check(raw), "UNKNOWN_FIELD");
      expect(spy.reads).toBe(0);
      expect(({} as Record<string, unknown>).accepted).toBeUndefined();
      expect(({} as Record<string, unknown>).verdict).toBeUndefined();
    });
  }

  it("inherited oracle inputs are ignored: a refuted run stays refuted", async () => {
    // Only own keys are request fields. An object whose prototype carries `verdict`,
    // `expected` and `items` is just { taskId, runId } to the gate.
    const { gate } = spiedGate("refuting");
    const raw = Object.assign(
      Object.create({ verdict: "verified", accepted: true, items: S01_ITEMS, expected: S01_ITEMS }),
      VALID,
    );
    const result = await gate.check(raw);
    expect(result.verdict).toBe("refuted");
    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toEqual(["ORACLE_FAIL"]);
  });

  it("a null-prototype object with the valid fields is an ordinary request", async () => {
    const { gate } = spiedGate();
    const raw = Object.assign(Object.create(null), VALID);
    expect((await gate.check(raw)).accepted).toBe(true);
  });

  it("lookalike and case variants of field names are UNKNOWN_FIELD, never a field", async () => {
    for (const key of ["TaskId", "taskid", "task_id", "tаskId", "taskId ", "runID"]) {
      const { gate, spy } = spiedGate();
      const raw = { [key]: TASK, runId: RUN, taskId: TASK };
      expectRefused(await gate.check(raw), "UNKNOWN_FIELD");
      expect(spy.reads).toBe(0);
    }
  });

  it("case variants of oracle-input names are still refused (UNKNOWN_FIELD)", async () => {
    for (const key of ["Expected", "VERDICT", "Accepted", "Items"]) {
      const { gate } = spiedGate();
      expectRefused(await gate.check({ ...VALID, [key]: true }), "UNKNOWN_FIELD");
    }
  });
});

/** Send one wire line; return the parsed reply. */
async function wire(line: string, state: "passing" | "refuting" = "passing") {
  const { gate, spy } = spiedGate(state);
  const out = await handleLine(gate, line);
  return { reply: out === undefined ? undefined : JSON.parse(out), spy };
}

function call(args: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: GATE_TOOL, arguments: args },
  });
}

describe("duplicate keys on the wire: one parser, last key wins", () => {
  it("a later duplicate overrides an earlier one (and so decides the assignment check)", async () => {
    const lastValid = await wire(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${GATE_TOOL}","arguments":{"taskId":"df-s02","taskId":"${TASK}","runId":"${RUN}"}}}`,
    );
    expect(lastValid.reply.result.structuredContent.accepted).toBe(true);
    const lastOther = await wire(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${GATE_TOOL}","arguments":{"taskId":"${TASK}","taskId":"df-s02","runId":"${RUN}"}}}`,
    );
    const result = lastOther.reply.result.structuredContent as GateResult;
    expectRefused(result, "ASSIGNMENT_MISMATCH");
    expect(lastOther.spy.reads).toBe(0);
  });

  it("a duplicated tool name resolves last-wins too: the other tool is -32602", async () => {
    const { reply, spy } = await wire(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${GATE_TOOL}","name":"other","arguments":{"taskId":"${TASK}","runId":"${RUN}"}}}`,
    );
    expect(reply.error.code).toBe(-32602);
    expect(spy.reads).toBe(0);
  });
});

describe("malformed JSON-RPC never reaches the reader", () => {
  const lines: [string, string, number][] = [
    ["truncated JSON", '{"jsonrpc":"2.0","id":1,"method":"tools/call"', -32700],
    ["not JSON", "verify me", -32700],
    ["NUL byte", "\0", -32700],
    ["trailing garbage", `${call(VALID)}x`, -32700],
    ["two messages on one line", `${call(VALID)}${call(VALID)}`, -32700],
    ["batch", `[${call(VALID)}]`, -32600],
    ["null", "null", -32600],
    ["number", "1", -32600],
    ["string", '"tools/call"', -32600],
    ["jsonrpc 1.0", '{"jsonrpc":"1.0","id":1,"method":"ping"}', -32600],
    ["jsonrpc number", '{"jsonrpc":2,"id":1,"method":"ping"}', -32600],
    ["no method", '{"jsonrpc":"2.0","id":1}', -32600],
    ["method number", '{"jsonrpc":"2.0","id":1,"method":5}', -32600],
    ["unknown method", '{"jsonrpc":"2.0","id":1,"method":"tools/run"}', -32601],
    ["__proto__ method", '{"jsonrpc":"2.0","id":1,"method":"__proto__"}', -32601],
    ["no tool name", '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}', -32602],
    [
      "tool name not a string",
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":["myco_gate_check"]}}',
      -32602,
    ],
    [
      "another tool",
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"myco_gate_check "}}',
      -32602,
    ],
    [
      "params array",
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":["${GATE_TOOL}"]}`,
      -32602,
    ],
    ["params string", '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":"x"}', -32602],
  ];
  for (const [name, line, code] of lines) {
    it(`${name} → ${code}`, async () => {
      const { reply, spy } = await wire(line);
      expect(reply.error.code).toBe(code);
      expect(reply.result).toBeUndefined();
      expect(spy.reads).toBe(0);
    });
  }

  const badArguments: [string, unknown, string][] = [
    ["arguments array", [VALID], "INVALID_REQUEST"],
    ["arguments string", JSON.stringify(VALID), "INVALID_REQUEST"],
    ["arguments number", 1, "INVALID_REQUEST"],
    ["arguments null (defaults to {})", null, "INVALID_REQUEST"],
    ["arguments with an oracle input", { ...VALID, verdict: "verified" }, "ORACLE_INPUT_REJECTED"],
    ["arguments with an unknown key", { ...VALID, tenant: "acme" }, "UNKNOWN_FIELD"],
  ];
  for (const [name, args, code] of badArguments) {
    it(`${name} → uncertain ${code}, isError, never verified`, async () => {
      const { reply, spy } = await wire(call(args));
      const result = reply.result.structuredContent as GateResult;
      expectRefused(result, code);
      expect(reply.result.isError).toBe(true);
      expect(JSON.parse(reply.result.content[0].text)).toEqual(result);
      expect(spy.reads).toBe(0);
    });
  }
});

describe("deep nesting", () => {
  it("a deeply nested unknown field is UNKNOWN_FIELD; a deeply nested arguments value is INVALID_REQUEST", async () => {
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    const nestedField = await wire(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${GATE_TOOL}","arguments":{"taskId":"${TASK}","runId":"${RUN}","x":${deep}}}}`,
    );
    expectRefused(nestedField.reply.result.structuredContent, "UNKNOWN_FIELD");
    const nestedArgs = await wire(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${GATE_TOOL}","arguments":${deep}}}`,
    );
    expectRefused(nestedArgs.reply.result.structuredContent, "INVALID_REQUEST");
    expect(nestedField.spy.reads + nestedArgs.spy.reads).toBe(0);
  });

  it("H-09: a deeply nested JSON-RPC id is -32603 from serveStdio, and the next request is served", async () => {
    // JSON.parse takes the deep id; echoing it back with JSON.stringify overflows the stack,
    // so handleLine throws and serveStdio's catch answers -32603 (id null). Not agent
    // reachable through the tool's arguments (the MCP client picks ids), but it is the one
    // input found that reaches that catch. The fix (reject non-scalar ids with -32600) is
    // TO FILE: mcp-server.ts is owned by #514.
    const { gate, spy } = spiedGate();
    const input = new PassThrough();
    const output = new PassThrough();
    const served = serveStdio(gate, input, output);
    const replies: string[] = [];
    output.on("data", (chunk) => replies.push(String(chunk)));
    const deepId = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    input.write(
      `{"jsonrpc":"2.0","id":${deepId},"method":"tools/call","params":{"name":"${GATE_TOOL}","arguments":{"taskId":"${TASK}","runId":"${RUN}"}}}\n`,
    );
    input.end(`${call(VALID)}\n`);
    await served;
    const lines = replies
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "internal error" },
    });
    expect(lines[1].id).toBe(7);
    expect(lines[1].result.structuredContent.accepted).toBe(true);
    // The deep-id call did reach the gate (the throw is in the reply's serialisation), so
    // the reader ran twice; the verdict it would have carried was never sent.
    expect(spy.reads).toBe(2);
  });

  it("a shallow structured id is echoed as-is (JSON-RPC allows only string, number or null)", async () => {
    const { reply } = await wire('{"jsonrpc":"2.0","id":{"a":[1]},"method":"ping"}');
    expect(reply).toEqual({ jsonrpc: "2.0", id: { a: [1] }, result: {} });
  });
});

/** mulberry32: a small seeded PRNG, so the sweep is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = [
  "taskId",
  "runId",
  "claim",
  "apiVersion",
  "verdict",
  "expected",
  "items",
  "__proto__",
  "x",
];
const STRINGS = [
  TASK,
  RUN,
  "df-s02",
  "run-other",
  GATE_API_VERSION,
  "",
  "..",
  "run-ok\0",
  "verified",
  "c".repeat(CLAIM_LIMIT + 1),
];

function randomValue(rand: () => number, depth: number): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const r = rand();
  if (depth <= 0 || r < 0.45) return pick(STRINGS);
  if (r < 0.55) return pick([0, -1, 1.5, true, false, null]);
  if (r < 0.65)
    return Array.from({ length: Math.floor(rand() * 3) }, () => randomValue(rand, depth - 1));
  const out: Record<string, unknown> = {};
  const n = Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) out[pick(KEYS)] = randomValue(rand, depth - 1);
  return out;
}

describe("seeded sweep: verified only for the one valid, assigned request", () => {
  it("2000 random requests: every accepted one is exactly { taskId, runId } of the assignment (+ claim/apiVersion)", async () => {
    const rand = prng(0x48_07);
    const { gate, spy } = spiedGate();
    let accepted = 0;
    let readsExpected = 0;
    for (let i = 0; i < 2000; i++) {
      // Bias towards the allowed keys so a share of requests is well formed.
      const raw =
        rand() < 0.5
          ? { taskId: rand() < 0.7 ? TASK : "df-s02", runId: rand() < 0.7 ? RUN : "run-other" }
          : randomValue(rand, 3);
      if (rand() < 0.3 && typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        (raw as Record<string, unknown>).claim = randomValue(rand, 0);
      }
      // Round-trip through JSON, as the wire would deliver it.
      const wired = JSON.parse(JSON.stringify(raw ?? null));
      const parsed = parseGateRequest(wired);
      const assigned = parsed.ok && parsed.request.taskId === TASK && parsed.request.runId === RUN;
      if (assigned) readsExpected += 1;
      const result = await gate.check(wired);
      for (const c of result.reasonCodes) expect(REASON_CODES).toContain(c);
      expect(result.accepted).toBe(result.verdict === "verified");
      if (result.accepted) {
        accepted += 1;
        expect(assigned).toBe(true);
      } else {
        expect(assigned).toBe(false);
      }
    }
    expect(spy.reads).toBe(readsExpected);
    // The sweep exercised both sides.
    expect(accepted).toBeGreaterThan(100);
    expect(2000 - accepted).toBeGreaterThan(500);
  });
});
