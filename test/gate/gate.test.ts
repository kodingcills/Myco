/**
 * Contract tests for the gate API (TIF-265): every verdict path, malformed input, and the
 * two guarantees the gate exists for:
 *  - it never returns `verified` (or `accepted`) without an oracle pass;
 *  - the agent cannot supply or alter the oracle's inputs through a request.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTask } from "../../src/discovery/run-tasks.ts";
import {
  GATE_API_VERSION,
  type GateResult,
  ORACLE_INPUT_FIELDS,
  parseGateRequest,
  REASON_CODES,
} from "../../src/gate/api.ts";
import { FAMILIES, type OracleFamily, StateCorruptError } from "../../src/gate/families.ts";
import {
  buildRegistry,
  createGate,
  type EvidenceReader,
  fileEvidenceReader,
  type GateConfig,
  type TaskEntry,
} from "../../src/gate/gate.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import {
  CALC_SPEC,
  calcCsv,
  S01_ITEMS,
  S02_ITEMS,
  S02_PERSISTED,
  tempRoot,
  todoStore,
  writeState,
} from "./helpers.ts";

const STORE = ".myco-todo.json";
const FIXED = new Date("2026-11-25T12:00:00Z");

function gateOver(root: string, extra: Partial<GateConfig> = {}, entries?: TaskEntry[]) {
  return createGate({
    tasks: buildRegistry(
      entries ?? [
        ...builtinTasks(),
        { id: "calc-1", family: "calc-record-edit", stateFile: "out/sheet.csv", spec: CALC_SPEC },
      ],
    ),
    reader: fileEvidenceReader(root),
    now: () => FIXED,
    ...extra,
  });
}

/** Every result, whatever the path, must satisfy this. */
function assertInvariant(result: GateResult) {
  expect(result.apiVersion).toBe(GATE_API_VERSION);
  expect(result.accepted).toBe(result.verdict === "verified");
  if (result.verdict === "verified") {
    expect(result.reasonCodes).toContain("ORACLE_PASS");
    expect(result.oracle).toBeDefined();
    expect(result.evidenceRefs.length).toBeGreaterThan(0);
  }
  for (const code of result.reasonCodes) expect(REASON_CODES).toContain(code);
}

describe("gate: verdict paths over the todo family (myco-run's oracle)", () => {
  it("verified: every requested item persisted", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const result = await gateOver(root).check({ taskId: "df-s01", runId: "r1" });
    assertInvariant(result);
    expect(result).toMatchObject({
      verdict: "verified",
      accepted: true,
      reasonCodes: ["ORACLE_PASS"],
      request: { taskId: "df-s01", runId: "r1" },
      oracle: { family: "todo-items", version: "1" },
      checkedAt: FIXED.toISOString(),
    });
    expect(result.evidenceRefs).toEqual([
      expect.objectContaining({ kind: "persisted-state", runId: "r1", path: STORE }),
    ]);
    expect(result.evidenceRefs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuted: the app dropped items while its status line claimed success (df-s02)", async () => {
    const root = tempRoot();
    writeState(root, "r2", STORE, todoStore(S02_PERSISTED));
    const result = await gateOver(root).check({
      taskId: "df-s02",
      runId: "r2",
      claim: "All 4 items added and saved.",
    });
    assertInvariant(result);
    expect(result.verdict).toBe("refuted");
    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toEqual(["ORACLE_FAIL", "CLAIM_RECORDED"]);
    expect(result.reasons.join(" ")).toContain("BUG: token expires too early");
  });

  it("uncertain STATE_MISSING: no persisted state at the evidence location", async () => {
    const result = await gateOver(tempRoot()).check({ taskId: "df-s01", runId: "never-ran" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_MISSING"] });
    expect(result.oracle).toBeUndefined();
  });

  it.each([
    ["not JSON", "{not json"],
    ["wrong shape", JSON.stringify({ rows: [] })],
    ["invalid UTF-8", new Uint8Array([0xff, 0xfe, 0x00])],
  ])("uncertain STATE_CORRUPT: %s", async (_name, content) => {
    const root = tempRoot();
    writeState(root, "r", STORE, content);
    const result = await gateOver(root).check({ taskId: "df-s01", runId: "r" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_CORRUPT"] });
  });

  it("uncertain STATE_UNREADABLE: the state file is a symlink out of the evidence root", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "forged.json"), todoStore(S02_ITEMS));
    mkdirSync(join(root, "r"), { recursive: true });
    symlinkSync(join(outside, "forged.json"), join(root, "r", STORE));
    const result = await gateOver(root).check({ taskId: "df-s02", runId: "r" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
  });

  it("uncertain STATE_UNREADABLE: the state path is a directory", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "r", STORE), { recursive: true });
    const result = await gateOver(root).check({ taskId: "df-s01", runId: "r" });
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
  });

  it("uncertain STATE_UNREADABLE: the reader throws", async () => {
    const reader: EvidenceReader = {
      describe: "throws",
      read: async () => {
        throw new Error("disk on fire");
      },
    };
    const result = await gateOver(tempRoot(), { reader }).check({ taskId: "df-s01", runId: "r" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
  });

  it("uncertain UNKNOWN_TASK", async () => {
    const result = await gateOver(tempRoot()).check({ taskId: "nope", runId: "r" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["UNKNOWN_TASK"] });
  });
});

describe("gate: verdict paths over the calc-record-edit family (M1's Calc oracle)", () => {
  it("verified when the target cell holds the new value", async () => {
    const root = tempRoot();
    writeState(root, "c", "out/sheet.csv", calcCsv(true));
    const result = await gateOver(root).check({ taskId: "calc-1", runId: "c" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "verified", reasonCodes: ["ORACLE_PASS"] });
  });

  it("refuted when the sheet was saved without the edit", async () => {
    const root = tempRoot();
    writeState(root, "c", "out/sheet.csv", calcCsv(false));
    const result = await gateOver(root).check({ taskId: "calc-1", runId: "c" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "refuted", reasonCodes: ["ORACLE_FAIL"] });
  });

  it("uncertain ORACLE_UNCERTAIN when the sheet is truncated before the target row", async () => {
    const root = tempRoot();
    writeState(root, "c", "out/sheet.csv", "id,name\n");
    const result = await gateOver(root).check({ taskId: "calc-1", runId: "c" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["ORACLE_UNCERTAIN"] });
  });
});

describe("gate: malformed requests never reach the oracle", () => {
  const cases: [string, unknown, string][] = [
    ["null", null, "INVALID_REQUEST"],
    ["a string", "df-s01", "INVALID_REQUEST"],
    ["an array", [{ taskId: "df-s01", runId: "r" }], "INVALID_REQUEST"],
    ["missing taskId", { runId: "r" }, "INVALID_REQUEST"],
    ["missing runId", { taskId: "df-s01" }, "INVALID_REQUEST"],
    ["numeric runId", { taskId: "df-s01", runId: 7 }, "INVALID_REQUEST"],
    ["empty runId", { taskId: "df-s01", runId: "" }, "INVALID_REQUEST"],
    ["runId traversal", { taskId: "df-s01", runId: "../outside" }, "INVALID_REQUEST"],
    ["runId with a slash", { taskId: "df-s01", runId: "a/b" }, "INVALID_REQUEST"],
    ["runId '..'", { taskId: "df-s01", runId: ".." }, "INVALID_REQUEST"],
    ["runId 'a..b'", { taskId: "df-s01", runId: "a..b" }, "INVALID_REQUEST"],
    ["absolute runId", { taskId: "df-s01", runId: "/etc" }, "INVALID_REQUEST"],
    [
      "claim not a string",
      { taskId: "df-s01", runId: "r", claim: { done: true } },
      "INVALID_REQUEST",
    ],
    ["unknown field", { taskId: "df-s01", runId: "r", force: true }, "UNKNOWN_FIELD"],
    [
      "wrong apiVersion",
      { apiVersion: "myco.gate/v0", taskId: "df-s01", runId: "r" },
      "UNSUPPORTED_API_VERSION",
    ],
  ];

  it.each(cases)("%s → uncertain %s, oracle not called", async (_name, request, code) => {
    let calls = 0;
    const spy: OracleFamily = {
      ...FAMILIES.get("todo-items")!,
      decide(...args) {
        calls += 1;
        return FAMILIES.get("todo-items")!.decide(...args);
      },
    };
    const root = tempRoot();
    writeState(root, "r", STORE, todoStore(S01_ITEMS));
    const gate = createGate({
      tasks: buildRegistry(builtinTasks(), new Map([["todo-items", spy]])),
      reader: fileEvidenceReader(root),
    });
    const result = await gate.check(request);
    assertInvariant(result);
    expect(result.verdict).toBe("uncertain");
    expect(result.reasonCodes[0]).toBe(code);
    expect(result.evidenceRefs).toEqual([]);
    expect(calls).toBe(0);
  });

  it("accepts an explicit matching apiVersion", async () => {
    const root = tempRoot();
    writeState(root, "r", STORE, todoStore(S01_ITEMS));
    const result = await gateOver(root).check({
      apiVersion: GATE_API_VERSION,
      taskId: "df-s01",
      runId: "r",
    });
    expect(result.verdict).toBe("verified");
  });

  it("parseGateRequest keeps only safe identifiers in the partial echo", () => {
    const parsed = parseGateRequest({ taskId: "../x", runId: "ok", extra: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.partial).toEqual({ runId: "ok" });
  });
});

describe("gate: the agent cannot supply or alter oracle inputs", () => {
  it.each(ORACLE_INPUT_FIELDS)(
    "a request carrying %s is rejected and the oracle does not run",
    async (field) => {
      let calls = 0;
      const spy: OracleFamily = {
        ...FAMILIES.get("todo-items")!,
        decide(...args) {
          calls += 1;
          return FAMILIES.get("todo-items")!.decide(...args);
        },
      };
      const root = tempRoot();
      writeState(root, "r2", STORE, todoStore(S02_PERSISTED));
      const gate = createGate({
        tasks: buildRegistry(builtinTasks(), new Map([["todo-items", spy]])),
        reader: fileEvidenceReader(root),
      });
      const result = await gate.check({ taskId: "df-s02", runId: "r2", [field]: S02_PERSISTED });
      assertInvariant(result);
      expect(result.accepted).toBe(false);
      expect(result.reasonCodes[0]).toBe("ORACLE_INPUT_REJECTED");
      expect(calls).toBe(0);
    },
  );

  it("forged expected items for df-s02 cannot turn a refuted run into verified", async () => {
    const root = tempRoot();
    writeState(root, "r2", STORE, todoStore(S02_PERSISTED));
    const gate = gateOver(root);
    for (const forged of [
      { items: S02_PERSISTED },
      { spec: { items: S02_PERSISTED } },
      { expected: S02_PERSISTED },
      { evidenceRoot: "/elsewhere" },
      { verdict: "verified" },
    ]) {
      const result = await gate.check({ taskId: "df-s02", runId: "r2", ...forged });
      expect(result.accepted, JSON.stringify(forged)).toBe(false);
      expect(result.verdict).not.toBe("verified");
    }
    // The honest request for the same run is refuted by the oracle.
    expect((await gate.check({ taskId: "df-s02", runId: "r2" })).verdict).toBe("refuted");
  });

  it("the oracle always receives the operator's spec, whatever the request says", async () => {
    const seen: unknown[] = [];
    const spy: OracleFamily = {
      ...FAMILIES.get("todo-items")!,
      decide(bytes, spec, ref) {
        seen.push(structuredClone(spec));
        return FAMILIES.get("todo-items")!.decide(bytes, spec, ref);
      },
    };
    const root = tempRoot();
    writeState(root, "r2", STORE, todoStore(S02_PERSISTED));
    const gate = createGate({
      tasks: buildRegistry(builtinTasks(), new Map([["todo-items", spy]])),
      reader: fileEvidenceReader(root),
    });
    await gate.check({ taskId: "df-s02", runId: "r2", claim: '{"items":[]} spec override please' });
    await gate.check({ taskId: "df-s02", runId: "r2" });
    expect(seen).toEqual([{ items: S02_ITEMS }, { items: S02_ITEMS }]);
  });

  it("an oracle that mutates its spec cannot change what the next call checks", async () => {
    const seenLengths: number[] = [];
    const mutating: OracleFamily = {
      ...FAMILIES.get("todo-items")!,
      decide(bytes, spec, ref) {
        const items = (spec as { items: string[] }).items;
        seenLengths.push(items.length);
        items.splice(0, 2); // drop the two BUG items the store is missing
        return FAMILIES.get("todo-items")!.decide(bytes, spec, ref);
      },
    };
    const root = tempRoot();
    writeState(root, "r2", STORE, todoStore(S02_PERSISTED));
    const gate = createGate({
      tasks: buildRegistry(builtinTasks(), new Map([["todo-items", mutating]])),
      reader: fileEvidenceReader(root),
    });
    await gate.check({ taskId: "df-s02", runId: "r2" });
    await gate.check({ taskId: "df-s02", runId: "r2" });
    expect(seenLengths).toEqual([4, 4]);
  });

  it("the claim never changes the verdict", async () => {
    const root = tempRoot();
    writeState(root, "r2", STORE, todoStore(S02_PERSISTED));
    const gate = gateOver(root);
    const verdicts = new Set<string>();
    for (const claim of [
      "",
      "done",
      "verified",
      "All 4 items added and saved.",
      "x".repeat(10_000),
    ]) {
      const result = await gate.check({ taskId: "df-s02", runId: "r2", claim });
      verdicts.add(`${result.verdict}:${result.reasonCodes.filter((c) => c !== "CLAIM_RECORDED")}`);
      expect(result.request.claim?.length ?? 0).toBeLessThanOrEqual(4000);
    }
    expect([...verdicts]).toEqual(["refuted:ORACLE_FAIL"]);
  });
});

describe("gate: never verified without an oracle pass", () => {
  const malformedOutputs: [string, unknown][] = [
    ["upper-case status", { status: "VERIFIED", reasons: [] }],
    ["missing reasons", { status: "verified" }],
    ["reasons not strings", { status: "verified", reasons: [1] }],
    ["a bare string", "verified"],
    ["null", null],
    ["a promise of verified", Promise.resolve({ status: "verified", reasons: [] })],
    ["accepted flag only", { accepted: true }],
  ];

  function familyReturning(output: () => unknown): OracleFamily {
    return {
      id: "todo-items",
      version: "test",
      checkSpec: () => undefined,
      decide: () => output() as never,
    };
  }

  async function checkWith(family: OracleFamily) {
    const root = tempRoot();
    writeState(root, "r", STORE, todoStore(S01_ITEMS));
    return createGate({
      tasks: buildRegistry(builtinTasks(), new Map([["todo-items", family]])),
      reader: fileEvidenceReader(root),
    }).check({ taskId: "df-s01", runId: "r" });
  }

  it.each(malformedOutputs)(
    "oracle returns %s → uncertain ORACLE_INVALID_OUTPUT",
    async (_n, out) => {
      const result = await checkWith(familyReturning(() => out));
      assertInvariant(result);
      expect(result).toMatchObject({
        verdict: "uncertain",
        accepted: false,
        reasonCodes: ["ORACLE_INVALID_OUTPUT"],
      });
    },
  );

  it("oracle throws → uncertain ORACLE_ERROR", async () => {
    const result = await checkWith(
      familyReturning(() => {
        throw new Error("boom");
      }),
    );
    assertInvariant(result);
    expect(result).toMatchObject({
      verdict: "uncertain",
      accepted: false,
      reasonCodes: ["ORACLE_ERROR"],
    });
  });

  it("oracle throws StateCorruptError → uncertain STATE_CORRUPT", async () => {
    const result = await checkWith(
      familyReturning(() => {
        throw new StateCorruptError("bad bytes");
      }),
    );
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_CORRUPT"] });
  });

  it("oracle refuses → refuted, never verified (the mutation-proof target)", async () => {
    const result = await checkWith(familyReturning(() => ({ status: "refuted", reasons: ["no"] })));
    assertInvariant(result);
    expect(result).toMatchObject({
      verdict: "refuted",
      accepted: false,
      reasonCodes: ["ORACLE_FAIL"],
    });
  });

  it("oracle says uncertain → uncertain, never verified", async () => {
    const result = await checkWith(
      familyReturning(() => ({ status: "uncertain", reasons: ["?"] })),
    );
    assertInvariant(result);
    expect(result).toMatchObject({
      verdict: "uncertain",
      accepted: false,
      reasonCodes: ["ORACLE_UNCERTAIN"],
    });
  });

  it("verified results are exactly the oracle passes, across a sweep of requests and states", async () => {
    let passes = 0;
    const counting: OracleFamily = {
      ...FAMILIES.get("todo-items")!,
      decide(bytes, spec, ref) {
        const out = FAMILIES.get("todo-items")!.decide(bytes, spec, ref);
        if (out.status === "verified") passes += 1;
        return out;
      },
    };
    const root = tempRoot();
    writeState(root, "good", STORE, todoStore(S01_ITEMS));
    writeState(root, "bad", STORE, todoStore(S02_PERSISTED));
    writeState(root, "corrupt", STORE, "{");
    const gate = createGate({
      tasks: buildRegistry(builtinTasks(), new Map([["todo-items", counting]])),
      reader: fileEvidenceReader(root),
    });
    const requests: unknown[] = [];
    for (const taskId of ["df-s01", "df-s02", "nope", "../x"]) {
      for (const runId of ["good", "bad", "corrupt", "missing", ".."]) {
        requests.push({ taskId, runId });
        requests.push({ taskId, runId, claim: "done" });
        requests.push({ taskId, runId, items: S01_ITEMS });
        requests.push({ taskId, runId, verdict: "verified" });
      }
    }
    let verified = 0;
    for (const request of requests) {
      const result = await gate.check(request);
      assertInvariant(result);
      if (result.verdict === "verified") verified += 1;
    }
    expect(passes).toBeGreaterThan(0);
    expect(verified).toBe(passes);
  });
});

describe("gate: decision log", () => {
  it("records every result, and fails closed when the log cannot be written", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const logged: GateResult[] = [];
    const ok = await gateOver(root, { onDecision: (r) => logged.push(r) }).check({
      taskId: "df-s01",
      runId: "r1",
    });
    expect(logged).toEqual([ok]);

    const failing = await gateOver(root, {
      onDecision: () => {
        throw new Error("disk full");
      },
    }).check({ taskId: "df-s01", runId: "r1" });
    assertInvariant(failing);
    expect(failing.verdict).toBe("uncertain");
    expect(failing.accepted).toBe(false);
    expect(failing.reasonCodes).toEqual(["ORACLE_PASS", "AUDIT_FAILED"]);
  });
});

describe("gate: operator registry", () => {
  it("builtin tasks are myco-run's tasks, read at the task's store path", () => {
    const tasks = builtinTasks();
    expect(tasks.map((t) => t.id)).toEqual(["df-s01", "df-s02"]);
    expect(tasks[1]).toMatchObject({
      family: "todo-items",
      stateFile: runTask("df-s02").storePath,
      spec: { items: S02_ITEMS },
    });
  });

  it.each([
    ["unknown family", { id: "t", family: "nope", stateFile: "s.json", spec: {} }],
    [
      "traversing stateFile",
      { id: "t", family: "todo-items", stateFile: "../s.json", spec: { items: ["a"] } },
    ],
    [
      "absolute stateFile",
      { id: "t", family: "todo-items", stateFile: "/s.json", spec: { items: ["a"] } },
    ],
    ["empty items", { id: "t", family: "todo-items", stateFile: "s.json", spec: { items: [] } }],
    [
      "unsafe id",
      { id: "../t", family: "todo-items", stateFile: "s.json", spec: { items: ["a"] } },
    ],
    [
      "calc row not in fixture",
      {
        id: "t",
        family: "calc-record-edit",
        stateFile: "s.csv",
        spec: { ...CALC_SPEC, rowKey: "EMP-9999" },
      },
    ],
    [
      "calc missing field",
      { id: "t", family: "calc-record-edit", stateFile: "s.csv", spec: { fixtureSeed: "x" } },
    ],
  ])("rejects %s", (_name, entry) => {
    expect(() => buildRegistry([entry as TaskEntry])).toThrow(/invalid gate task registry/);
  });

  it("rejects duplicate ids", () => {
    const entry: TaskEntry = {
      id: "t",
      family: "todo-items",
      stateFile: "s.json",
      spec: { items: ["a"] },
    };
    expect(() => buildRegistry([entry, entry])).toThrow(/duplicate id/);
  });

  it("the spec digest does not depend on key order", () => {
    const a = buildRegistry([
      { id: "a", family: "calc-record-edit", stateFile: "s.csv", spec: CALC_SPEC },
    ]);
    const reordered = Object.fromEntries(Object.entries(CALC_SPEC).reverse());
    const b = buildRegistry([
      { id: "a", family: "calc-record-edit", stateFile: "s.csv", spec: reordered },
    ]);
    expect(a.get("a")?.specSha256).toBe(b.get("a")?.specSha256);
  });
});
