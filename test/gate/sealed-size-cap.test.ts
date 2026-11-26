/**
 * H-06 (docs/security/gate-api-review.md): the sealed reader enforces the mock reader's
 * `STATE_FILE_LIMIT`. A captured state file over the limit is `uncertain`
 * STATE_UNREADABLE and never reaches the oracle, so the two readers agree on the same
 * bytes. The over-limit store here is a *passing* store padded with whitespace: without the
 * limit, the oracle would verify it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTask } from "../../src/discovery/run-tasks.ts";
import {
  buildRegistry,
  createGate,
  fileEvidenceReader,
  STATE_FILE_LIMIT,
  type TaskRegistry,
} from "../../src/gate/gate.ts";
import { createSealedGate, gateGroundTruth } from "../../src/gate/sealed.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { todoStore, writeState } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const ORACLE_SOURCES = ["src/gate/families.ts", "src/discovery/s0-sequence.ts"].map((rel) =>
  join(ROOT, rel),
);
const TASK = "df-s01";

let base: string;
let vault: VerdictVault;
let tasks: TaskRegistry;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-sealed-size-"));
  const agentRoot = join(base, "agent");
  mkdirSync(agentRoot);
  vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [agentRoot],
  });
  tasks = buildRegistry(builtinTasks());
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A passing df-s01 store, padded with trailing whitespace to exactly `size` bytes. */
function passingStoreOfSize(size: number): Buffer {
  const store = Buffer.from(todoStore(runTask(TASK).items));
  if (store.length > size) throw new Error("size below the store itself");
  return Buffer.concat([store, Buffer.alloc(size - store.length, 0x20)]);
}

/** Seal, stop and capture `bytes` as the trial's persisted state; return its sealed gate. */
function sealedGateWith(runId: string, bytes: Buffer) {
  const task = tasks.get(TASK);
  if (!task) throw new Error("no task");
  const receipt = vault.seal(runId, {
    groundTruth: gateGroundTruth(task),
    fixtures: {},
    oracle: { id: "todo-items@1", sourceFiles: ORACLE_SOURCES },
  });
  vault.markAgentStopped(runId);
  vault.capture(runId, { [`persisted/${task.stateFile}`]: bytes });
  return createSealedGate({ tasks, vault, binding: { runId, receipt }, taskId: TASK });
}

describe("sealed reader: STATE_FILE_LIMIT (H-06)", () => {
  it("a passing store one byte over the limit is uncertain STATE_UNREADABLE, never verified", async () => {
    const gate = sealedGateWith("run-big", passingStoreOfSize(STATE_FILE_LIMIT + 1));
    const result = await gate.check({ taskId: TASK, runId: "run-big" });
    expect(result.verdict).toBe("uncertain");
    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toEqual(["STATE_UNREADABLE"]);
    expect(result.oracle).toBeUndefined();
    expect(result.evidenceRefs).toEqual([]);
    // Agent-facing: the limit, never a host path.
    expect(result.reasons.join("\n")).toContain(String(STATE_FILE_LIMIT));
    expect(result.reasons.join("\n")).not.toContain(base);
  });

  it("a passing store of exactly the limit is still verified (the limit is inclusive)", async () => {
    const gate = sealedGateWith("run-edge", passingStoreOfSize(STATE_FILE_LIMIT));
    const result = await gate.check({ taskId: TASK, runId: "run-edge" });
    expect(result.verdict).toBe("verified");
    expect(result.accepted).toBe(true);
    expect(result.evidenceRefs[0]?.bytes).toBe(STATE_FILE_LIMIT);
  });

  it("parity: the mock reader gives the same answer for the same bytes at and over the limit", async () => {
    const root = join(base, "evidence");
    for (const [runId, size] of [
      ["run-big", STATE_FILE_LIMIT + 1],
      ["run-edge", STATE_FILE_LIMIT],
    ] as const) {
      const bytes = passingStoreOfSize(size);
      writeState(root, runId, ".myco-todo.json", bytes);
      const mock = createGate({
        tasks,
        reader: fileEvidenceReader(root),
        assignment: { taskId: TASK, runId },
      });
      const sealed = sealedGateWith(runId, bytes);
      const [m, s] = await Promise.all([
        mock.check({ taskId: TASK, runId }),
        sealed.check({ taskId: TASK, runId }),
      ]);
      expect([s.verdict, s.reasonCodes]).toEqual([m.verdict, m.reasonCodes]);
    }
  });
});
