/**
 * H-08 (docs/security/gate-api-review.md): per-caller isolation. Two callers (two trials)
 * share one evidence root. Caller A's run is refuted, caller B's passes. Whatever A sends -
 * B's run id, B's task, lookalike ids, interleaved concurrent calls - A is never verified,
 * and A's gate never reads any run but A's own. The assignment check is exact string
 * equality, so no id normalisation (case folding, as a case-insensitive filesystem would
 * do, or prefix matching) can turn A's request into another run's directory.
 *
 * Every suite runs under three filesystem models: the host's own, a case-folding one (macOS
 * APFS, Windows NTFS defaults) and a Windows one (case folding plus trailing dots and spaces
 * dropped). The emulated models make the aliasing that broke the macOS leg in round 1
 * reproducible on any host: a bait directory that aliases A's run is never written, so A's
 * own refuted bytes survive. Request-level lookalikes stay in every model, since a
 * mismatched request reads nothing and needs no directory.
 *
 * Tests only: this pins behaviour that is already correct on main (the assignment check,
 * `gate.ts`), alongside `gate.test.ts` "the assignment binds the gate to one trial" and
 * `sealed-gate.test.ts` "the agent's run id never selects another trial's sealed bytes".
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GateRequest, GateResult } from "../../src/gate/api.ts";
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

/** Run ids that differ from A's: case, trailing dot, prefix and suffix. */
const LOOKALIKE_RUNS = ["RUN-A", "Run-a", "run-a.", "run-a-", "run-aa", "run-", "run-a0"];
/** Unicode lookalikes of A's run id: Cyrillic a, fullwidth r, a trailing zero-width joiner. */
const UNICODE_RUNS = ["run-\u0430", "\uff52un-a", "run-a\u200d"];

/**
 * How a filesystem maps a run id to the directory it lands in. `native` is the host's own
 * filesystem, unemulated: on macOS it folds case by itself, which is what round 1 hit.
 */
interface FsModel {
  readonly name: string;
  readonly dir: (runId: string) => string;
}
const MODELS: readonly FsModel[] = [
  { name: "native", dir: (id) => id },
  { name: "case-folding (APFS, NTFS)", dir: (id) => id.toLowerCase() },
  {
    name: "windows (case folding, trailing dots dropped)",
    dir: (id) => id.toLowerCase().replace(/[. ]+$/, ""),
  },
];

/** Probe the host filesystem once: does `alias` land in the directory `name` already made? */
function hostAliases(name: string, alias: string): boolean {
  const probe = tempRoot();
  mkdirSync(join(probe, name));
  return existsSync(join(probe, alias));
}

/** The lookalikes whose bait would land in A's own directory under `model`. */
function expectedSkips(model: FsModel): string[] {
  return [...LOOKALIKE_RUNS, ...UNICODE_RUNS].filter((id) =>
    model.name === "native" ? hostAliases(A.runId, id) : model.dir(id) === model.dir(A.runId),
  );
}

/**
 * A shared evidence root: A's refuted state, B's passing state, and passing bait under every
 * lookalike id whose directory is distinct. A bait id that lands in a directory already
 * written (A's, on a case-folding filesystem) is skipped, never written over it.
 */
function sharedRoot(model: FsModel): { root: string; skipped: string[] } {
  const root = tempRoot();
  writeState(root, model.dir(A.runId), STORE, todoStore(S02_PERSISTED));
  writeState(root, model.dir(B.runId), STORE, todoStore(S01_ITEMS));
  const skipped: string[] = [];
  for (const lookalike of [...LOOKALIKE_RUNS, ...UNICODE_RUNS]) {
    if (existsSync(join(root, model.dir(lookalike)))) {
      skipped.push(lookalike);
      continue;
    }
    writeState(root, model.dir(lookalike), STORE, todoStore(S01_ITEMS));
  }
  return { root, skipped };
}

/** A caller's gate over the shared root, recording every run id its reader receives. */
function callerGate(root: string, assignment: Assignment, model: FsModel) {
  const inner = fileEvidenceReader(root);
  const reads: string[] = [];
  const reader: EvidenceReader = {
    describe: inner.describe,
    read(runId, file) {
      reads.push(runId);
      return inner.read(model.dir(runId), file);
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

for (const model of MODELS) {
  describe(`filesystem model: ${model.name}`, () => {
    describe("the shared root never overwrites A's own state", () => {
      it("A's directory still holds A's refuted bytes, and only aliasing bait was skipped", () => {
        const { root, skipped } = sharedRoot(model);
        expect(readFileSync(join(root, model.dir(A.runId), STORE), "utf8")).toBe(
          todoStore(S02_PERSISTED),
        );
        expect(skipped).toEqual(expectedSkips(model));
      });
    });

    describe("baseline: each caller's own request decides on its own run", () => {
      it("A (dropped items) is refuted; B (all items) is verified", async () => {
        const { root } = sharedRoot(model);
        const a = callerGate(root, A, model);
        const b = callerGate(root, B, model);
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
        [
          "B's run id with apiVersion",
          { apiVersion: "myco.gate/v1", taskId: TASK, runId: B.runId },
        ],
        ["another registered task on A's run", { taskId: "df-s02", runId: A.runId }],
        ["another registered task on B's run", { taskId: "df-s02", runId: B.runId }],
      ];
      for (const lookalike of LOOKALIKE_RUNS) {
        borrow.push([`lookalike run id ${lookalike}`, { taskId: TASK, runId: lookalike }]);
      }
      for (const lookalike of ["DF-S01", "df-s01.", "df-s1", "df-s010"]) {
        borrow.push([`lookalike task id ${lookalike}`, { taskId: lookalike, runId: A.runId }]);
      }
      for (const [name, request] of borrow) {
        it(`${name} → ASSIGNMENT_MISMATCH, nothing read`, async () => {
          const a = callerGate(sharedRoot(model).root, A, model);
          expectMismatch(await a.gate.check(request));
          expect(a.reads).toEqual([]);
        });
      }
    });

    describe("unicode lookalikes are rejected before the assignment check", () => {
      const requests: [string, GateRequest][] = UNICODE_RUNS.map((runId) => [
        `run id ${JSON.stringify(runId)}`,
        { taskId: TASK, runId },
      ]);
      requests.push([
        "task id with a Cyrillic e",
        { taskId: "df-s01".replace("s", "\u0455"), runId: A.runId },
      ]);
      for (const [name, request] of requests) {
        it(`${name} → INVALID_REQUEST, nothing read`, async () => {
          const a = callerGate(sharedRoot(model).root, A, model);
          const result = await a.gate.check(request);
          expect(result.verdict).toBe("uncertain");
          expect(result.accepted).toBe(false);
          expect(result.reasonCodes).toEqual(["INVALID_REQUEST"]);
          expect(result.evidenceRefs).toEqual([]);
          expect(a.reads).toEqual([]);
        });
      }
    });

    describe("interleaved concurrent calls from two callers stay isolated", () => {
      it("400 interleaved checks: A is only refuted on its own run, B only verified on its own, and each reads only its own run", async () => {
        const { root } = sharedRoot(model);
        const a = callerGate(root, A, model);
        const b = callerGate(root, B, model);
        const requests = [
          A,
          B,
          { taskId: TASK, runId: "RUN-A" },
          { taskId: "df-s02", runId: "run-b" },
        ];
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
          else expect(result.verdict).toBe(caller === "A" ? "refuted" : "verified");
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
        const { root } = sharedRoot(model);
        const assignment = { taskId: TASK, runId: A.runId };
        const a = callerGate(root, assignment, model);
        assignment.runId = B.runId; // e.g. an operator object reused for the next trial
        expectMismatch(await a.gate.check(B));
        expect((await a.gate.check(A)).verdict).toBe("refuted");
        expect(a.reads).toEqual([A.runId]);
      });
    });
  });
}
