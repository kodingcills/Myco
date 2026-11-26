/**
 * Contract tests for the gate API (TIF-265): every verdict path, malformed input, and the
 * two guarantees the gate exists for:
 *  - it never returns `verified` (or `accepted`) without an oracle pass;
 *  - the agent cannot supply or alter the oracle's inputs through a request.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
  type Assignment,
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

function gateOver(
  root: string,
  assignment: Assignment,
  extra: Partial<GateConfig> = {},
  entries?: TaskEntry[],
) {
  return createGate({
    assignment,
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
    const result = await gateOver(root, { taskId: "df-s01", runId: "r1" }).check({
      taskId: "df-s01",
      runId: "r1",
    });
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
    const result = await gateOver(root, { taskId: "df-s02", runId: "r2" }).check({
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
    const result = await gateOver(tempRoot(), { taskId: "df-s01", runId: "never-ran" }).check({
      taskId: "df-s01",
      runId: "never-ran",
    });
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
    const result = await gateOver(root, { taskId: "df-s01", runId: "r" }).check({
      taskId: "df-s01",
      runId: "r",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_CORRUPT"] });
  });

  it("uncertain STATE_UNREADABLE: the state file is a symlink out of the evidence root", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, "forged.json"), todoStore(S02_ITEMS));
    mkdirSync(join(root, "r"), { recursive: true });
    symlinkSync(join(outside, "forged.json"), join(root, "r", STORE));
    const result = await gateOver(root, { taskId: "df-s02", runId: "r" }).check({
      taskId: "df-s02",
      runId: "r",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
  });

  it("uncertain STATE_UNREADABLE: the state path is a directory", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "r", STORE), { recursive: true });
    const result = await gateOver(root, { taskId: "df-s01", runId: "r" }).check({
      taskId: "df-s01",
      runId: "r",
    });
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
  });

  it("uncertain STATE_UNREADABLE: the reader throws", async () => {
    const reader: EvidenceReader = {
      describe: "throws",
      read: async () => {
        throw new Error("disk on fire");
      },
    };
    const result = await gateOver(tempRoot(), { taskId: "df-s01", runId: "r" }, { reader }).check({
      taskId: "df-s01",
      runId: "r",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
  });

  it("a task outside the registry is ASSIGNMENT_MISMATCH (the assignment must be registered)", async () => {
    const result = await gateOver(tempRoot(), { taskId: "df-s01", runId: "r" }).check({
      taskId: "nope",
      runId: "r",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["ASSIGNMENT_MISMATCH"] });
  });
});

describe("gate: verdict paths over the calc-record-edit family (M1's Calc oracle)", () => {
  it("verified when the target cell holds the new value", async () => {
    const root = tempRoot();
    writeState(root, "c", "out/sheet.csv", calcCsv(true));
    const result = await gateOver(root, { taskId: "calc-1", runId: "c" }).check({
      taskId: "calc-1",
      runId: "c",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "verified", reasonCodes: ["ORACLE_PASS"] });
  });

  it("refuted when the sheet was saved without the edit", async () => {
    const root = tempRoot();
    writeState(root, "c", "out/sheet.csv", calcCsv(false));
    const result = await gateOver(root, { taskId: "calc-1", runId: "c" }).check({
      taskId: "calc-1",
      runId: "c",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "refuted", reasonCodes: ["ORACLE_FAIL"] });
  });

  it("uncertain ORACLE_UNCERTAIN when the sheet is truncated before the target row", async () => {
    const root = tempRoot();
    writeState(root, "c", "out/sheet.csv", "id,name\n");
    const result = await gateOver(root, { taskId: "calc-1", runId: "c" }).check({
      taskId: "calc-1",
      runId: "c",
    });
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
      assignment: { taskId: "df-s01", runId: "r" },
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
    const result = await gateOver(root, { taskId: "df-s01", runId: "r" }).check({
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
        assignment: { taskId: "df-s02", runId: "r2" },
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
    const gate = gateOver(root, { taskId: "df-s02", runId: "r2" });
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
      assignment: { taskId: "df-s02", runId: "r2" },
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
      assignment: { taskId: "df-s02", runId: "r2" },
    });
    await gate.check({ taskId: "df-s02", runId: "r2" });
    await gate.check({ taskId: "df-s02", runId: "r2" });
    expect(seenLengths).toEqual([4, 4]);
  });

  it("the claim never changes the verdict", async () => {
    const root = tempRoot();
    writeState(root, "r2", STORE, todoStore(S02_PERSISTED));
    const gate = gateOver(root, { taskId: "df-s02", runId: "r2" });
    const verdicts = new Set<string>();
    for (const claim of [
      "",
      "done",
      "verified",
      "All 4 items added and saved.",
      "x".repeat(4000),
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
      assignment: { taskId: "df-s01", runId: "r" },
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
    // Every combination of assigned trial and request: substitutions included.
    for (const taskId of ["df-s01", "df-s02"]) {
      for (const runId of ["good", "bad", "corrupt", "missing"]) {
        const gate = createGate({
          tasks: buildRegistry(builtinTasks(), new Map([["todo-items", counting]])),
          reader: fileEvidenceReader(root),
          assignment: { taskId, runId },
        });
        for (const request of requests) {
          const result = await gate.check(request);
          assertInvariant(result);
          if (result.verdict === "verified") {
            verified += 1;
            expect(result.request).toMatchObject({ taskId, runId });
          }
        }
      }
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
    const ok = await gateOver(
      root,
      { taskId: "df-s01", runId: "r1" },
      {
        onDecision: (r) => {
          logged.push(r);
        },
      },
    ).check({
      taskId: "df-s01",
      runId: "r1",
    });
    expect(logged).toEqual([ok]);

    const failing = await gateOver(
      root,
      { taskId: "df-s01", runId: "r1" },
      {
        onDecision: () => {
          throw new Error("disk full");
        },
      },
    ).check({ taskId: "df-s01", runId: "r1" });
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

describe("gate: the assignment binds the gate to one trial (round 1 D1)", () => {
  function spyReader(root: string) {
    const reads: string[] = [];
    const inner = fileEvidenceReader(root);
    const reader: EvidenceReader = {
      describe: inner.describe,
      read(runId, stateFile) {
        reads.push(`${runId}/${stateFile}`);
        return inner.read(runId, stateFile);
      },
    };
    return { reader, reads };
  }

  function twoRuns() {
    const root = tempRoot();
    writeState(root, "run-s01", STORE, todoStore(S01_ITEMS)); // passes df-s01
    writeState(root, "run-s02", STORE, todoStore(S02_PERSISTED)); // refutes df-s02
    return root;
  }

  it("cross-run and cross-task: an agent assigned df-s02 cannot name df-s01's passing run", async () => {
    const root = twoRuns();
    const { reader, reads } = spyReader(root);
    const gate = gateOver(root, { taskId: "df-s02", runId: "run-s02" }, { reader });
    const result = await gate.check({ taskId: "df-s01", runId: "run-s01", claim: "df-s02 done" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", accepted: false });
    expect(result.reasonCodes[0]).toBe("ASSIGNMENT_MISMATCH");
    expect(reads).toEqual([]);
    // Its own run is still checked, and refuted.
    expect((await gate.check({ taskId: "df-s02", runId: "run-s02" })).verdict).toBe("refuted");
  });

  it("same task, other run: an agent cannot name another passing run of its own task", async () => {
    const root = twoRuns();
    const gate = gateOver(root, { taskId: "df-s01", runId: "mine" });
    const result = await gate.check({ taskId: "df-s01", runId: "run-s01" });
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["ASSIGNMENT_MISMATCH"] });
  });

  it("same run, other task: the run's state is not checked against a different task", async () => {
    const root = twoRuns();
    const gate = gateOver(root, { taskId: "df-s02", runId: "run-s01" });
    const result = await gate.check({ taskId: "df-s01", runId: "run-s01" });
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["ASSIGNMENT_MISMATCH"] });
  });

  it("a state file symlinked to another run inside the root is STATE_UNREADABLE", async () => {
    const root = twoRuns();
    mkdirSync(join(root, "symin"));
    symlinkSync(join(root, "run-s01", STORE), join(root, "symin", STORE));
    const result = await gateOver(root, { taskId: "df-s01", runId: "symin" }).check({
      taskId: "df-s01",
      runId: "symin",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
  });

  it("a run directory symlinked to another run is STATE_UNREADABLE", async () => {
    const root = twoRuns();
    symlinkSync(join(root, "run-s01"), join(root, "symdir"));
    const result = await gateOver(root, { taskId: "df-s01", runId: "symdir" }).check({
      taskId: "df-s01",
      runId: "symdir",
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
    expect(result.reasons.join(" ")).toContain("passes through a symlink at symdir");
  });

  it("an evidence root that is itself a symlink is allowed (the operator chose it)", async () => {
    const real = twoRuns();
    const linkParent = tempRoot();
    symlinkSync(real, join(linkParent, "root"));
    const result = await gateOver(join(linkParent, "root"), {
      taskId: "df-s01",
      runId: "run-s01",
    }).check({ taskId: "df-s01", runId: "run-s01" });
    expect(result.verdict).toBe("verified");
  });

  it.each([
    ["an unregistered task", { taskId: "nope", runId: "r" }],
    ["an unsafe run id", { taskId: "df-s01", runId: "../r" }],
    ["a missing assignment", undefined],
  ])("createGate refuses %s", (_name, assignment) => {
    expect(() =>
      createGate({
        tasks: buildRegistry(builtinTasks()),
        reader: fileEvidenceReader(tempRoot()),
        assignment: assignment as Assignment,
      }),
    ).toThrow(/invalid gate assignment/);
  });
});

describe("gate: an async decision log is awaited and fails closed (round 1 D2)", () => {
  it("a rejecting async logger gives uncertain AUDIT_FAILED, never verified", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const result = await gateOver(
      root,
      { taskId: "df-s01", runId: "r1" },
      {
        onDecision: async () => {
          await new Promise((done) => setTimeout(done, 5));
          throw new Error("ledger unavailable");
        },
      },
    ).check({ taskId: "df-s01", runId: "r1" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", accepted: false });
    expect(result.reasonCodes).toEqual(["ORACLE_PASS", "AUDIT_FAILED"]);
  });

  it("the result is returned only after an async logger has finished", async () => {
    const root = tempRoot();
    writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const logged: GateResult[] = [];
    const result = await gateOver(
      root,
      { taskId: "df-s01", runId: "r1" },
      {
        onDecision: async (r) => {
          await new Promise((done) => setTimeout(done, 5));
          logged.push(r);
        },
      },
    ).check({ taskId: "df-s01", runId: "r1" });
    expect(logged).toEqual([result]);
    expect(result.accepted).toBe(true);
  });
});

describe("gate: evidence refs and the rejection list are pinned (round 1 D3)", () => {
  it("the evidence ref's digest and size are those of the file actually read", async () => {
    const root = tempRoot();
    const path = writeState(root, "r1", STORE, todoStore(S01_ITEMS));
    const bytes = readFileSync(path);
    const result = await gateOver(root, { taskId: "df-s01", runId: "r1" }).check({
      taskId: "df-s01",
      runId: "r1",
    });
    expect(result.evidenceRefs).toEqual([
      {
        kind: "persisted-state",
        runId: "r1",
        path: STORE,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
    ]);
  });

  it("the oracle-input field list is exactly the documented one", () => {
    // A literal copy on purpose: removing a name from the source must fail here.
    expect([...ORACLE_INPUT_FIELDS].sort()).toEqual(
      [
        "accepted",
        "cells",
        "evidence",
        "evidenceDir",
        "evidenceRoot",
        "expected",
        "expectedValue",
        "family",
        "fixture",
        "groundTruth",
        "intent",
        "items",
        "oracle",
        "params",
        "path",
        "persisted",
        "spec",
        "state",
        "stateFile",
        "status",
        "store",
        "storePath",
        "verdict",
      ].sort(),
    );
    for (const field of ["verdict", "items", "evidenceRoot"]) {
      const parsed = parseGateRequest({ taskId: "df-s01", runId: "r", [field]: 1 });
      expect(parsed.ok ? "accepted" : parsed.code).toBe("ORACLE_INPUT_REJECTED");
    }
  });
});

describe("gate: round 1 nits", () => {
  it("a reader that never answers times out as STATE_UNREADABLE", async () => {
    const reader: EvidenceReader = { describe: "hangs", read: () => new Promise(() => {}) };
    const result = await gateOver(
      tempRoot(),
      { taskId: "df-s01", runId: "r" },
      { reader, readTimeoutMs: 20 },
    ).check({ taskId: "df-s01", runId: "r" });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
    expect(result.reasons.join(" ")).toContain("timed out");
  });

  it("an oracle output with a throwing getter keeps its request and evidence refs", async () => {
    const root = tempRoot();
    writeState(root, "r", STORE, todoStore(S01_ITEMS));
    const family: OracleFamily = {
      id: "todo-items",
      version: "test",
      checkSpec: () => undefined,
      decide: () =>
        ({
          get status(): string {
            throw new Error("trap");
          },
        }) as never,
    };
    const result = await createGate({
      tasks: buildRegistry(builtinTasks(), new Map([["todo-items", family]])),
      reader: fileEvidenceReader(root),
      assignment: { taskId: "df-s01", runId: "r" },
    }).check({ taskId: "df-s01", runId: "r" });
    assertInvariant(result);
    expect(result).toMatchObject({
      verdict: "uncertain",
      reasonCodes: ["ORACLE_ERROR"],
      request: { taskId: "df-s01", runId: "r" },
    });
    expect(result.evidenceRefs).toHaveLength(1);
  });

  it("a claim longer than 4000 characters is rejected, not truncated", async () => {
    const result = await gateOver(tempRoot(), { taskId: "df-s01", runId: "r" }).check({
      taskId: "df-s01",
      runId: "r",
      claim: "x".repeat(4001),
    });
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["INVALID_REQUEST"] });
  });
});

/**
 * Reasons reach the agent: none may name the evidence root, as given, resolved or real
 * (macOS's tmpdir is a symlink, so all three can differ). Call before the root is moved.
 */
function hostPathsOf(root: string): string[] {
  return [...new Set([root, resolve(root), realpathSync(root)])];
}
function expectNoHostPath(result: { reasons: readonly string[] }, paths: readonly string[]) {
  const reasons = result.reasons.join(" ");
  for (const path of paths) expect(reasons).not.toContain(path);
}

describe("reader: a run directory or final component swapped around the open, and FIFOs, fail closed on every platform (round 2 D-A, D-B; intermediate swaps during a walk are below)", () => {
  /** Run r refutes df-s01 on its own; run good passes. Every swap below borrows good. */
  function racedRoot() {
    const root = tempRoot();
    writeState(root, "r", STORE, todoStore(S02_PERSISTED));
    writeState(root, "good", STORE, todoStore(S01_ITEMS));
    return root;
  }

  async function checkWithHooks(root: string, hooks: Parameters<typeof fileEvidenceReader>[1]) {
    const paths = hostPathsOf(root);
    const result = await createGate({
      tasks: buildRegistry(builtinTasks()),
      reader: fileEvidenceReader(root, hooks),
      assignment: { taskId: "df-s01", runId: "r" },
    }).check({ taskId: "df-s01", runId: "r" });
    expectNoHostPath(result, paths);
    return result;
  }

  it("run directory moved away between the walk and the open → STATE_MISSING, reason carries the errno code, no host path", async () => {
    const root = racedRoot();
    const result = await checkWithHooks(root, {
      beforeOpen: () => renameSync(join(root, "r"), join(root, "r-gone")),
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_MISSING"] });
    expect(result.reasons.join(" ")).toContain(`r/${STORE}: open failed: ENOENT`);
  });

  it("a read failure after the open → STATE_UNREADABLE with the errno code only, never the error message", async () => {
    const root = racedRoot();
    const result = await checkWithHooks(root, {
      afterOpen: () => {
        throw Object.assign(new Error(`EIO: i/o error, read '${resolve(root)}/r/${STORE}'`), {
          code: "EIO",
        });
      },
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
    expect(result.reasons.join(" ")).toContain(`r/${STORE}: read failed: EIO`);
  });

  it("without a swap, run r is refuted (the baseline the races try to flip)", async () => {
    const result = await checkWithHooks(racedRoot(), {});
    expect(result.verdict).toBe("refuted");
  });

  it("run directory swapped to a symlink between the walk and the open → STATE_UNREADABLE", async () => {
    const root = racedRoot();
    const result = await checkWithHooks(root, {
      beforeOpen: () => {
        renameSync(join(root, "r"), join(root, "r-real"));
        symlinkSync(join(root, "good"), join(root, "r"));
      },
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
    expect(result.reasons.join(" ")).toContain("passes through a symlink at r (after open)");
  });

  it("state file swapped to a symlink for the open only → refused at open (O_NOFOLLOW)", async () => {
    const root = racedRoot();
    const file = join(root, "r", STORE);
    const result = await checkWithHooks(root, {
      beforeOpen: () => {
        renameSync(file, join(root, "r-store.json"));
        symlinkSync(join(root, "good", STORE), file);
      },
      afterOpen: () => {
        renameSync(join(root, "r-store.json"), file);
      },
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
    expect(result.reasons.join(" ")).toContain("is a symlink (refused at open)");
  });

  it("run directory swapped for another run (no symlink) around the open → dev/ino mismatch", async () => {
    const root = racedRoot();
    const result = await checkWithHooks(root, {
      beforeOpen: () => {
        renameSync(join(root, "r"), join(root, "r-own"));
        renameSync(join(root, "good"), join(root, "r"));
      },
      afterOpen: () => {
        renameSync(join(root, "r"), join(root, "good"));
        renameSync(join(root, "r-own"), join(root, "r"));
      },
    });
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
    expect(result.reasons.join(" ")).toContain("changed between the check and the open");
  });

  it.each(["static", "swap"])(
    "a FIFO as the state file (%s) returns STATE_UNREADABLE at once, never blocks",
    (mode) => {
      const started = Date.now();
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname, "fifo-child.ts"), mode],
        { cwd: join(import.meta.dirname, "..", ".."), encoding: "utf8", timeout: 8_000 },
      );
      expect(child.signal, "the reader blocked on the FIFO and was killed").toBeNull();
      const outcome = JSON.parse(child.stdout.trim());
      expect(outcome).toMatchObject({ ok: false, cause: "unreadable" });
      // static: refused by the walk before any open; swap: the walk saw a regular file,
      // so the O_NONBLOCK open returns and the descriptor check refuses the FIFO.
      expect(outcome.detail).toContain(
        mode === "static" ? "is not a regular file" : "opened a non-regular file",
      );
      expect(Date.now() - started).toBeLessThan(8_000);
    },
    15_000,
  );
});

describe("reader: an intermediate component swapped during a walk (TIF-265 follow-up, #471 round-3 D-A')", () => {
  const LINUX = process.platform === "linux";
  /** df-s01's spec with the state file one directory down, for the parent-directory case. */
  const nestedEntry = (): TaskEntry => {
    const s01 = builtinTasks().find((entry) => entry.id === "df-s01");
    if (!s01) throw new Error("df-s01 missing");
    return { ...s01, id: "df-nested", stateFile: `sub/${STORE}` };
  };

  /**
   * The verifier's determ.mts interleaving, through the reader's lstat hook: right before
   * each walk lstats the intermediate directory `swapped`, it is the run's real directory;
   * right before the walk lstats the state file under it, it is a symlink to `borrowed`
   * (a passing run; relative to the root, or absolute for a target outside it). The open (between the walks) therefore goes through the symlink, and
   * both walks' final lstat resolve it, so every dev/ino agrees on the borrowed file.
   */
  function interleaved(root: string, swapped: string, borrowed: string, stateFile: string) {
    const abs = resolve(root);
    const dir = join(abs, swapped);
    const aside = `${dir}-own`;
    let linked = false;
    let swaps = 0;
    const makeReal = () => {
      if (!linked) return;
      unlinkSync(dir);
      renameSync(aside, dir);
      linked = false;
    };
    const makeLink = () => {
      if (linked) return;
      renameSync(dir, aside);
      symlinkSync(resolve(abs, borrowed), dir);
      linked = true;
      swaps += 1;
    };
    const finalPath = join(abs, "r", stateFile);
    return {
      hooks: {
        beforeLstat: (path: string) => {
          if (path === dir) makeReal();
          else if (path === finalPath) makeLink();
        },
        beforeOpen: makeLink,
      },
      linkedAtOpen: () => linked,
      swaps: () => swaps,
      restore: makeReal,
    };
  }

  function raced() {
    const root = tempRoot();
    writeState(root, "r", STORE, todoStore(S02_PERSISTED));
    writeState(root, "good", STORE, todoStore(S01_ITEMS));
    writeState(root, "r", `sub/${STORE}`, todoStore(S02_PERSISTED));
    writeState(root, "good", `sub/${STORE}`, todoStore(S01_ITEMS));
    const paths = hostPathsOf(root);
    const check = async (taskId: string, hooks: Parameters<typeof fileEvidenceReader>[1]) => {
      const result = await createGate({
        tasks: buildRegistry([...builtinTasks(), nestedEntry()]),
        reader: fileEvidenceReader(root, hooks),
        assignment: { taskId, runId: "r" },
      }).check({ taskId, runId: "r" });
      expectNoHostPath(result, paths);
      return result;
    };
    return { root, check };
  }

  it.each(["df-s01", "df-nested"])(
    "%s: without a swap run r is refuted (the baseline the interleaving tries to flip)",
    async (taskId) => {
      const { check } = raced();
      expect((await check(taskId, {})).verdict).toBe("refuted");
    },
  );

  it.skipIf(!LINUX)(
    "Linux: run directory r swapped for a symlink to a passing run inside each walk → STATE_UNREADABLE (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root, check } = raced();
      const swap = interleaved(root, "r", "good", STORE);
      const result = await check("df-s01", swap.hooks);
      swap.restore();
      assertInvariant(result);
      expect(swap.swaps()).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
      expect(result.reasons.join(" ")).toContain(
        `the opened file is at good/${STORE}, not at r/${STORE} (descriptor path check)`,
      );
    },
  );

  it.skipIf(!LINUX)(
    "Linux: parent directory r/sub swapped for a symlink to good/sub inside each walk → STATE_UNREADABLE (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root, check } = raced();
      const swap = interleaved(root, "r/sub", "good/sub", `sub/${STORE}`);
      const result = await check("df-nested", swap.hooks);
      swap.restore();
      assertInvariant(result);
      expect(swap.swaps()).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
      expect(result.reasons.join(" ")).toContain("(descriptor path check)");
    },
  );

  // Pins the documented per-platform gap, and proves the interleaving above really reaches
  // the window (it is not refused by the walks or the dev/ino check): without the
  // descriptor-path binding, as on macOS, the same interleaving returns another run's bytes.
  it.each([
    ["df-s01", "r", "good", STORE],
    ["df-nested", "r/sub", "good/sub", `sub/${STORE}`],
  ])(
    "%s: without the binding (platform darwin, the macOS behaviour) the same interleaving gives verified: the documented gap",
    async (taskId, swapped, borrowed, stateFile) => {
      const { root, check } = raced();
      const swap = interleaved(root, swapped, borrowed, stateFile);
      const result = await check(taskId, { ...swap.hooks, platform: "darwin" });
      expect(swap.linkedAtOpen()).toBe(true);
      swap.restore();
      expect(result).toMatchObject({ verdict: "verified", reasonCodes: ["ORACLE_PASS"] });
      const goodBytes = readFileSync(join(root, "good", stateFile));
      expect(result.evidenceRefs[0]?.sha256).toBe(
        createHash("sha256").update(goodBytes).digest("hex"),
      );
    },
  );

  it.skipIf(!LINUX)(
    "Linux: run directory r swapped for a symlink to a passing run OUTSIDE the evidence root inside each walk → STATE_UNREADABLE, reason names no host path (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root, check } = raced();
      const elsewhere = tempRoot();
      writeState(elsewhere, "good", STORE, todoStore(S01_ITEMS));
      const swap = interleaved(root, "r", join(resolve(elsewhere), "good"), STORE);
      const result = await check("df-s01", swap.hooks);
      swap.restore();
      assertInvariant(result);
      expect(swap.swaps()).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
      const reasons = result.reasons.join(" ");
      expect(reasons).toContain(
        `the opened file is at a path outside the evidence root, not at r/${STORE} (descriptor path check)`,
      );
      expect(reasons).not.toContain(resolve(elsewhere));
    },
  );

  it("the same outside-root interleaving without the binding (platform darwin) gives verified: the test above reaches the binding", async () => {
    const { root, check } = raced();
    const elsewhere = tempRoot();
    writeState(elsewhere, "good", STORE, todoStore(S01_ITEMS));
    const swap = interleaved(root, "r", join(resolve(elsewhere), "good"), STORE);
    const result = await check("df-s01", { ...swap.hooks, platform: "darwin" });
    expect(swap.linkedAtOpen()).toBe(true);
    swap.restore();
    expect(result).toMatchObject({ verdict: "verified", reasonCodes: ["ORACLE_PASS"] });
  });

  // Runs on every platform: the binding is forced on (platform "linux"), and realpath runs
  // before /proc is read, so this branch is reached even where /proc does not exist.
  it("binding: the evidence root cannot be resolved after the open → fails closed, reason names no host path", async () => {
    const { root } = raced();
    writeState(root, "ok", STORE, todoStore(S01_ITEMS));
    const gone = `${resolve(root)}-gone`;
    const result = await createGate({
      tasks: buildRegistry(builtinTasks()),
      reader: fileEvidenceReader(root, {
        platform: "linux",
        beforeBind: () => renameSync(resolve(root), gone),
      }),
      assignment: { taskId: "df-s01", runId: "ok" },
    }).check({ taskId: "df-s01", runId: "ok" });
    renameSync(gone, resolve(root));
    assertInvariant(result);
    expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
    const reasons = result.reasons.join(" ");
    expect(reasons).toContain("cannot resolve the evidence root (realpath failed: ENOENT)");
    expect(reasons).not.toContain(resolve(root));
  });

  it.skipIf(!LINUX)(
    "Linux: a state file unlinked after the checks reads back as '(deleted)' → STATE_UNREADABLE (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root } = raced();
      writeState(root, "ok", STORE, todoStore(S01_ITEMS));
      const result = await createGate({
        tasks: buildRegistry(builtinTasks()),
        reader: fileEvidenceReader(root, {
          beforeBind: () => unlinkSync(join(root, "ok", STORE)),
        }),
        assignment: { taskId: "df-s01", runId: "ok" },
      }).check({ taskId: "df-s01", runId: "ok" });
      assertInvariant(result);
      expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
      expect(result.reasons.join(" ")).toContain(
        `the opened file is at ok/${STORE} (deleted), not at ok/${STORE} (descriptor path check)`,
      );
    },
  );

  it("without the binding (platform darwin) the same unlink still gives verified: the bytes are the ones opened", async () => {
    const { root } = raced();
    writeState(root, "ok", STORE, todoStore(S01_ITEMS));
    const result = await createGate({
      tasks: buildRegistry(builtinTasks()),
      reader: fileEvidenceReader(root, {
        platform: "darwin",
        beforeBind: () => unlinkSync(join(root, "ok", STORE)),
      }),
      assignment: { taskId: "df-s01", runId: "ok" },
    }).check({ taskId: "df-s01", runId: "ok" });
    expect(result).toMatchObject({ verdict: "verified", reasonCodes: ["ORACLE_PASS"] });
  });

  /** A passing run that is also named r: inside the root at x/r, or in a sibling <root>-evil. */
  function borrowedR(root: string, where: "inside" | "sibling"): string {
    const base = where === "inside" ? join(resolve(root), "x") : `${resolve(root)}-evil`;
    writeState(base, "r", STORE, todoStore(S01_ITEMS));
    return join(base, "r");
  }

  it.skipIf(!LINUX)(
    "Linux: r swapped for a symlink to another run ALSO named r inside the root (x/r) → STATE_UNREADABLE: the path must match exactly, not by suffix (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root, check } = raced();
      const swap = interleaved(root, "r", borrowedR(root, "inside"), STORE);
      const result = await check("df-s01", swap.hooks);
      swap.restore();
      assertInvariant(result);
      expect(swap.swaps()).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
      expect(result.reasons.join(" ")).toContain(
        `the opened file is at x/r/${STORE}, not at r/${STORE} (descriptor path check)`,
      );
    },
  );

  it.skipIf(!LINUX)(
    "Linux: r swapped for a symlink to a run ALSO named r in a sibling <root>-evil → STATE_UNREADABLE, reported as outside the root, no host path (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root, check } = raced();
      const borrowed = borrowedR(root, "sibling");
      const swap = interleaved(root, "r", borrowed, STORE);
      const result = await check("df-s01", swap.hooks);
      swap.restore();
      assertInvariant(result);
      expect(swap.swaps()).toBeGreaterThanOrEqual(2);
      expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
      const reasons = result.reasons.join(" ");
      expect(reasons).toContain(
        `the opened file is at a path outside the evidence root, not at r/${STORE} (descriptor path check)`,
      );
      expect(reasons).not.toContain("evil");
    },
  );

  it.each(["inside", "sibling"] as const)(
    "a borrowed run also named r (%s) without the binding (platform darwin) gives verified: the tests above reach the binding",
    async (where) => {
      const { root, check } = raced();
      const borrowed = borrowedR(root, where);
      const swap = interleaved(root, "r", borrowed, STORE);
      const result = await check("df-s01", { ...swap.hooks, platform: "darwin" });
      expect(swap.linkedAtOpen()).toBe(true);
      swap.restore();
      expect(result).toMatchObject({ verdict: "verified", reasonCodes: ["ORACLE_PASS"] });
      expect(result.evidenceRefs[0]?.sha256).toBe(
        createHash("sha256")
          .update(readFileSync(join(borrowed, STORE)))
          .digest("hex"),
      );
    },
  );

  it.skipIf(!LINUX)(
    "Linux: if /proc/self/fd cannot be read, the read fails closed (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root } = raced();
      writeState(root, "ok", STORE, todoStore(S01_ITEMS));
      const result = await createGate({
        tasks: buildRegistry(builtinTasks()),
        reader: fileEvidenceReader(root, { procFdDir: join(root, "no-such-proc") }),
        assignment: { taskId: "df-s01", runId: "ok" },
      }).check({ taskId: "df-s01", runId: "ok" });
      assertInvariant(result);
      expect(result).toMatchObject({ verdict: "uncertain", reasonCodes: ["STATE_UNREADABLE"] });
      expect(result.reasons.join(" ")).toContain("cannot bind the descriptor to its path");
    },
  );

  it.skipIf(!LINUX)(
    "Linux: the binding accepts an untouched passing run, including under a symlinked root (skipped off Linux: no /proc/self/fd)",
    async () => {
      const { root } = raced();
      writeState(root, "ok", STORE, todoStore(S01_ITEMS));
      const link = `${root}-link`;
      symlinkSync(root, link);
      for (const where of [root, link]) {
        const result = await createGate({
          tasks: buildRegistry(builtinTasks()),
          reader: fileEvidenceReader(where),
          assignment: { taskId: "df-s01", runId: "ok" },
        }).check({ taskId: "df-s01", runId: "ok" });
        expect(result).toMatchObject({ verdict: "verified", reasonCodes: ["ORACLE_PASS"] });
      }
    },
  );
});
