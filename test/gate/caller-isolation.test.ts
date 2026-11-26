/**
 * H-08 (docs/security/gate-api-review.md): per-caller isolation. Two callers (two trials)
 * share one evidence root. Caller A's run is refuted, caller B's passes. Whatever A sends -
 * B's run id, B's task, lookalike ids, interleaved concurrent calls - A is never verified,
 * and A's gate never reads any run but A's own. The assignment check is exact string
 * equality, so no id normalisation (case folding, as a case-insensitive filesystem would
 * do, or prefix matching) can turn A's request into another run's directory.
 *
 * Tests only: this pins behaviour that is already correct on main (the assignment check,
 * `gate.ts`), alongside `gate.test.ts` "the assignment binds the gate to one trial" and
 * `sealed-gate.test.ts` "the agent's run id never selects another trial's sealed bytes".
 */
import { describe, expect, it } from "vitest";
import type { GateResult } from "../../src/gate/api.ts";
import {
  type Assignment,
  buildRegistry,
  createGate,
  type EvidenceReader,
  fileEvidenceReader,
} from "../../src/gate/gate.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { S01_ITEMS, S02_PERSISTED, tempRoot, todoStore, writeState } from "./helpers.ts";

const STORE = ".myco-todo.json";
const TASK = "df-s01";
const A: Assignment = { taskId: TASK, runId: "run-a" }; // refuted state
const B: Assignment = { taskId: TASK, runId: "run-b" }; // passing state

function sharedRoot(): string {
  const root = tempRoot();
  writeState(root, A.runId, STORE, todoStore(S02_PERSISTED));
  writeState(root, B.runId, STORE, todoStore(S01_ITEMS));
  // Lookalike directories that hold passing state too: none may ever be read for A.
  for (const lookalike of ["RUN-A", "Run-a", "run-a.", "run-a-", "run-aa", "run-", "run-a0"]) {
    writeState(root, lookalike, STORE, todoStore(S01_ITEMS));
  }
  return root;
}

/** A caller's gate over the shared root, recording every run id its reader receives. */
function callerGate(root: string, assignment: Assignment) {
  const inner = fileEvidenceReader(root);
  const reads: string[] = [];
  const reader: EvidenceReader = {
    describe: inner.describe,
    read(runId, file) {
      reads.push(runId);
      return inner.read(runId, file);
    },
  };
  const gate = createGate({ tasks: buildRegistry(builtinTasks()), reader, assignment });
  return { gate, reads };
}

function expectMismatch(result: GateResult) {
  expect(result.verdict).toBe("uncertain");
  expect(result.accepted).toBe(false);
  // CLAIM_RECORDED may accompany it; nothing else may.
  expect(result.reasonCodes.filter((c) => c !== "CLAIM_RECORDED")).toEqual(["ASSIGNMENT_MISMATCH"]);
  expect(result.evidenceRefs).toEqual([]);
  expect(result.oracle).toBeUndefined();
}

describe("baseline: each caller's own request decides on its own run", () => {
  it("A (dropped items) is refuted; B (all items) is verified", async () => {
    const root = sharedRoot();
    const a = callerGate(root, A);
    const b = callerGate(root, B);
    expect((await a.gate.check(A)).verdict).toBe("refuted");
    expect((await b.gate.check(B)).verdict).toBe("verified");
    expect(a.reads).toEqual([A.runId]);
    expect(b.reads).toEqual([B.runId]);
  });
});

describe("caller A cannot borrow caller B's passing run", () => {
  const borrow: [string, Record<string, unknown>][] = [
    ["B's run id", { taskId: TASK, runId: B.runId }],
    ["B's run id with a claim", { taskId: TASK, runId: B.runId, claim: "done" }],
    ["B's run id with apiVersion", { apiVersion: "myco.gate/v1", taskId: TASK, runId: B.runId }],
    ["another registered task on A's run", { taskId: "df-s02", runId: A.runId }],
    ["another registered task on B's run", { taskId: "df-s02", runId: B.runId }],
  ];
  for (const lookalike of ["RUN-A", "Run-a", "run-a.", "run-a-", "run-aa", "run-", "run-a0"]) {
    borrow.push([`lookalike run id ${lookalike}`, { taskId: TASK, runId: lookalike }]);
  }
  for (const lookalike of ["DF-S01", "df-s01.", "df-s1", "df-s010"]) {
    borrow.push([`lookalike task id ${lookalike}`, { taskId: lookalike, runId: A.runId }]);
  }
  for (const [name, request] of borrow) {
    it(`${name} → ASSIGNMENT_MISMATCH, nothing read`, async () => {
      const a = callerGate(sharedRoot(), A);
      expectMismatch(await a.gate.check(request));
      expect(a.reads).toEqual([]);
    });
  }
});

describe("interleaved concurrent calls from two callers stay isolated", () => {
  it("400 interleaved checks: A is never verified, B only on its own run, and each reads only its own run", async () => {
    const root = sharedRoot();
    const a = callerGate(root, A);
    const b = callerGate(root, B);
    const requests = [A, B, { taskId: TASK, runId: "RUN-A" }, { taskId: "df-s02", runId: "run-b" }];
    const calls: Promise<[string, Assignment, GateResult]>[] = [];
    for (let i = 0; i < 200; i++) {
      const request = requests[i % requests.length] as Assignment;
      calls.push(a.gate.check(request).then((r) => ["A", request, r]));
      calls.push(b.gate.check(request).then((r) => ["B", request, r]));
    }
    for (const [caller, request, result] of await Promise.all(calls)) {
      const own = caller === "A" ? A : B;
      const isOwn = request.taskId === own.taskId && request.runId === own.runId;
      if (!isOwn) expectMismatch(result);
      expect(result.accepted).toBe(caller === "B" && isOwn);
    }
    expect(new Set(a.reads)).toEqual(new Set([A.runId]));
    expect(new Set(b.reads)).toEqual(new Set([B.runId]));
    expect(a.reads.length).toBe(50);
    expect(b.reads.length).toBe(50);
  });
});

describe("the binding is fixed at construction", () => {
  it("mutating the operator's assignment object after createGate does not rebind the gate", async () => {
    const root = sharedRoot();
    const assignment = { taskId: TASK, runId: A.runId };
    const a = callerGate(root, assignment);
    assignment.runId = B.runId; // e.g. an operator object reused for the next trial
    expectMismatch(await a.gate.check(B));
    expect((await a.gate.check(A)).verdict).toBe("refuted");
    expect(a.reads).toEqual([A.runId]);
  });
});
