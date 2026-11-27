/**
 * The newcomer path's macOS simulated agents (newcomer-mock.ts), checked on every PR on any
 * platform: the macOS live run (`newcomer path (macos-latest)`) expects `verified` for
 * `honest` and `refuted` for `drops-item` from the gate its written config starts. Here the
 * same gate (createGate over the built-in tasks and a file evidence reader, bound to one
 * trial) judges the store each agent saves. SIMULATED: a scripted agent, no model, $0.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTask } from "../../src/discovery/run-tasks.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import { DEFAULT_RUN, DEFAULT_TASK } from "../../src/setup/init.ts";
import { MOCK_SCENARIOS, mockTodoRun } from "./newcomer-mock.ts";

/** Save what the agent persisted where the gate reads it, and ask the gate. */
async function judge(store: string, storePath: string, claim: string) {
  const root = mkdtempSync(join(tmpdir(), "myco-newcomer-mock-"));
  const file = join(root, DEFAULT_RUN, storePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, store);
  const gate = createGate({
    assignment: { taskId: DEFAULT_TASK, runId: DEFAULT_RUN },
    tasks: buildRegistry(builtinTasks()),
    reader: fileEvidenceReader(root),
  });
  return gate.check({ taskId: DEFAULT_TASK, runId: DEFAULT_RUN, claim });
}

describe("newcomer path, macOS simulated agents (mock desktop, df-s01)", () => {
  it("the quickstart's default task is df-s01 and its store is the todo app's", () => {
    expect(DEFAULT_TASK).toBe("df-s01");
    const entry = builtinTasks().find((t) => t.id === DEFAULT_TASK);
    expect(entry?.stateFile).toBe(runTask(DEFAULT_TASK).storePath);
  });

  it("is exactly honest → verified and drops-item → refuted", () => {
    expect(MOCK_SCENARIOS).toEqual([
      { agent: "honest", verdict: "verified" },
      { agent: "drops-item", verdict: "refuted" },
    ]);
  });

  it("honest saves every item; drops-item saves all but the last; both claim all", async () => {
    const items = runTask(DEFAULT_TASK).items;
    expect(items.length).toBeGreaterThan(1);
    const honest = await mockTodoRun("honest", DEFAULT_TASK);
    const drops = await mockTodoRun("drops-item", DEFAULT_TASK);
    const saved = (store: string) =>
      (JSON.parse(store) as { items: { text: string }[] }).items.map((i) => i.text);
    expect(saved(honest.store)).toEqual(items);
    expect(saved(drops.store)).toEqual(items.slice(0, -1));
    expect(drops.claim).toBe(honest.claim);
    expect(honest.claim).toBe(`All ${items.length} items added and saved.`);
  });

  for (const s of MOCK_SCENARIOS) {
    it(`the gate the quickstart config starts says ${s.verdict} for ${s.agent}`, async () => {
      const run = await mockTodoRun(s.agent, DEFAULT_TASK);
      const result = await judge(run.store, run.storePath, run.claim);
      expect(result.verdict).toBe(s.verdict);
      expect(result.accepted).toBe(s.verdict === "verified");
      expect(result.reasonCodes).toContain(
        s.verdict === "verified" ? "ORACLE_PASS" : "ORACLE_FAIL",
      );
    });
  }
});
