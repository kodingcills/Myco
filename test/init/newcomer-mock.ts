/**
 * The newcomer path's macOS simulated agents (TIF-265 track D). macOS has no headless Calc,
 * so the live run's simulated task on darwin is the built-in `df-s01` todo task on the mock
 * desktop (src/discovery/mock-desktop.ts), with the same moves as the gate demo's fake agent
 * (src/gate/demo.ts): launch the todo app, type each item, press Return after each, click Save.
 *
 *   honest      saves every item; the gate must say `verified`;
 *   drops-item  saves all but the last item and still claims all of them; `refuted`.
 *
 * In memory: no file, process or environment access. The live run (newcomer-path.test.ts)
 * puts the returned store where the written config's gate reads it. newcomer-docs.test.ts
 * checks on every PR, on any platform, that the gate judges both agents as expected.
 * SIMULATED: a scripted agent, no model. Never evidence.
 */
import { MockDesktop } from "../../src/discovery/mock-desktop.ts";
import { runTask } from "../../src/discovery/run-tasks.ts";

export type MockTodoAgent = "honest" | "drops-item";

/** Each macOS scripted agent and the verdict the gate must return for it. */
export const MOCK_SCENARIOS: readonly { agent: MockTodoAgent; verdict: "verified" | "refuted" }[] =
  [
    { agent: "honest", verdict: "verified" },
    { agent: "drops-item", verdict: "refuted" },
  ];

export interface MockTodoResult {
  /** The store bytes the mock guest persisted (relative path: `storePath`). */
  readonly store: string;
  readonly storePath: string;
  /** What the agent tells the gate: always that every item was saved. */
  readonly claim: string;
}

export async function mockTodoRun(agent: MockTodoAgent, taskId: string): Promise<MockTodoResult> {
  const task = runTask(taskId);
  const items = agent === "honest" ? task.items : task.items.slice(0, -1);
  const desktop = new MockDesktop();
  const session = await desktop.create();
  await desktop.act(session, {
    kind: "launch",
    command: task.launch.command,
    args: task.launch.args,
  });
  for (const item of items) {
    await desktop.act(session, { kind: "typeTextGlobal", text: item });
    await desktop.act(session, { kind: "keyPress", keys: "Return" });
  }
  // The Save control (mock-desktop.ts: the lower band of the 420x360 window).
  await desktop.act(session, { kind: "clickAt", x: 210, y: 284 });
  const store = await desktop.readFile(session, task.storePath);
  await desktop.destroy();
  return { store, storePath: task.storePath, claim: task.agentClaim };
}
