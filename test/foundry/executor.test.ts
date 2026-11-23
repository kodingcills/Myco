import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  executeTrial,
  type LiveTransport,
  type ToolRequest,
} from "../../src/foundry/baseline/executor.ts";
import { ArmRecorder } from "../../src/foundry/baseline/recorder.ts";
import { scoreDiscoveryTrial } from "../../src/foundry/grader/discovery.ts";
import { fixtureHash, generateHiddenFixtures } from "../../src/foundry/hidden-split/index.ts";
import { findTask, taskFixture } from "../../src/foundry/tasks/bank.ts";
import type { ScreenView, TraceAct } from "../../src/foundry/types.ts";

/**
 * A fake guest. It holds the store in memory, renders the same listbox the model renders,
 * and can be told to fail at a given moment — which is how the offline tests cover the
 * transport-failure path without a VM.
 */
function fakeGuest(options: { failOnAct?: TraceAct["kind"]; status?: string } = {}) {
  const state = {
    rows: ["buy milk", "call mom"],
    status: options.status ?? "",
    up: true,
  };
  const actions: TraceAct[] = [];
  const transport: LiveTransport = {
    async screen(): Promise<ScreenView> {
      if (!state.up) return { visibleText: [], reachable: false };
      return {
        visibleText: [
          ...state.rows.map((r) => r.charAt(0).toUpperCase() + r.slice(1)),
          ...(state.status ? [state.status] : []),
        ],
        reachable: true,
      };
    },
    async readPersistence(paths) {
      const items = state.rows.map((text) => ({ text, added_at: "2026-11-22T00:00:00.000Z" }));
      const files: Record<string, Uint8Array> = {};
      for (const path of paths) {
        files[path] = new TextEncoder().encode(`${JSON.stringify({ items }, null, 2)}\n`);
      }
      return files;
    },
    async act(action) {
      actions.push(action);
      if (options.failOnAct === action.kind) throw new Error("transport dropped the input");
      // TraceAct carries its payload in `detail`; the fake guest renders it as status.
      if (action.kind === "typeText") state.status = `typed ${action.detail ?? ""}`;
      if (action.kind === "keyPress") state.status = `saved 2 item(s)`;
    },
    async tool(_via: "file-io" | "shell-exec", request: ToolRequest) {
      if (request.path === undefined) return [];
      return [{ operation: request.operation === "read" ? "read" : "write", path: request.path }];
    },
  };
  return { transport, actions, state };
}

const TASK = findTask("ef-t01-add-four-items")!;
const HIDDEN = generateHiddenFixtures(new Uint8Array(32).fill(42), 2);
const PROMPT_HASH = createHash("sha256").update(TASK.prompt).digest("hex");

function options(overrides: Partial<Parameters<typeof executeTrial>[3]> = {}) {
  return {
    armId: "screenshot-only" as const,
    taskId: TASK.taskId,
    promptHash: PROMPT_HASH,
    fixtureId: TASK.fixtureId,
    fixtureHash: fixtureHash(HIDDEN[0]!),
    budget: 20,
    persistencePaths: ["store.json"],
    ...overrides,
  };
}

describe("EF-005 arm recorder", () => {
  it("produces evidence where calls, count and audits agree", async () => {
    const guest = fakeGuest();
    const recorder = new ArmRecorder();
    const run = await executeTrial(
      recorder,
      guest.transport,
      async (surface) => {
        await surface.screen();
        await surface.act({ kind: "typeText", target: "entry", detail: "buy milk" });
        await surface.act({ kind: "keyPress", target: "save" });
        return { claimsSuccess: true, text: "saved" };
      },
      options(),
    );
    expect(run.evidence.recordedCallCount).toBe(run.evidence.recordedCalls.length);
    expect(run.evidence.toolCallAudits).toHaveLength(run.evidence.recordedCalls.length);
    expect(run.steps).toBe(2);
    expect(run.transportFailed).toBe(false);
  });

  it("refuses a duplicate call id rather than silently overwriting a record", () => {
    const recorder = new ArmRecorder();
    recorder.begin("gui", "c1");
    expect(() => recorder.begin("gui", "c1")).toThrow(/already recorded/);
  });

  it("refuses to attribute an action to a non-GUI call", () => {
    const recorder = new ArmRecorder();
    recorder.begin("file-io", "c1");
    expect(() => recorder.act("c1", { kind: "click", target: "save" }, 1)).toThrow(
      /only gui calls/,
    );
  });

  it("closes still-open calls as incomplete so the scorer excludes them", () => {
    const recorder = new ArmRecorder();
    recorder.begin("gui", "c1");
    const closed = recorder.close();
    expect(closed.audits[0]?.status).toBe("incomplete");
  });

  it("refuses to record after close (one recorder per trial)", () => {
    const recorder = new ArmRecorder();
    recorder.close();
    expect(() => recorder.begin("gui", "c2")).toThrow(/closed/);
  });
});

describe("EF-005 executor records what the grader audits", () => {
  it("a GUI-only arm produces a scoreable, audit-clean run", async () => {
    const guest = fakeGuest();
    const run = await executeTrial(
      new ArmRecorder(),
      guest.transport,
      async (surface) => {
        await surface.screen();
        await surface.act({ kind: "keyPress", target: "save" });
        return { claimsSuccess: true, text: "saved" };
      },
      options(),
    );
    const scored = scoreDiscoveryTrial(
      {
        ...run.evidence,
        planner: { model: "claude-sonnet-5-5", settings: { temperature: 0 } },
      } as never,
      {
        fixture: taskFixture(TASK),
        actual: { kind: "myco-todo", files: run.files },
        screen: run.screen,
        trace: run.trace,
        selfReport: run.selfReport,
        faultVersion: 0,
      } as never,
      { temperature: 0 },
    );
    expect(scored.status).toBe("scored");
  });

  it("a non-GUI write to the store is caught as a file-I/O shortcut", async () => {
    const guest = fakeGuest();
    const run = await executeTrial(
      new ArmRecorder(),
      guest.transport,
      async (surface) => {
        await surface.tool("file-io", { operation: "write", path: "store.json" });
        return { claimsSuccess: true, text: "wrote the store" };
      },
      options(),
    );
    // The shortcut is detected where it matters: the grader reconciles the audit into the
    // trace the state oracle sees, so a direct write reaches the guard as a file-write.
    const scored = scoreDiscoveryTrial(
      {
        ...run.evidence,
        planner: { model: "claude-sonnet-5-5", settings: { temperature: 0 } },
      } as never,
      {
        fixture: taskFixture(TASK),
        actual: { kind: "myco-todo", files: run.files },
        screen: run.screen,
        trace: run.trace,
        selfReport: run.selfReport,
        faultVersion: 0,
      } as never,
      { temperature: 0 },
    );
    expect(scored.status).toBe("scored");
    if (scored.status !== "scored") throw new Error("unreachable");
    expect(scored.result.traceGuard.status).toBe("file-io-shortcut");
  });

  it("a GUI action the transport never delivered does not appear in the trace", async () => {
    // A trace is a record of what happened. Recording an undelivered input would let the
    // oracle reason about an edit the guest never received.
    const guest = fakeGuest({ failOnAct: "typeText" });
    const run = await executeTrial(
      new ArmRecorder(),
      guest.transport,
      async (surface) => {
        try {
          await surface.act({ kind: "typeText", target: "entry", detail: "buy milk" });
        } catch {
          // the executor does not rethrow; the arm simply proceeds
        }
        return { claimsSuccess: true, text: "claimed" };
      },
      options(),
    );
    const actions = run.trace.filter((event) => event.type === "action");
    expect(actions).toHaveLength(0);
    expect(run.transportFailed).toBe(true);
  });

  it("stops at the tool-call ceiling instead of recording past it", async () => {
    const guest = fakeGuest();
    const recorder = new ArmRecorder({ maxCalls: 2 });
    const run = await executeTrial(
      recorder,
      guest.transport,
      async (surface) => {
        for (let i = 0; i < 5; i++) {
          try {
            await surface.tool("shell-exec", { operation: "exec", command: "cat store.json" });
          } catch {
            break;
          }
        }
        return { claimsSuccess: false, text: "limited" };
      },
      options(),
    );
    expect(recorder.callLimitExceeded).toBe(true);
    expect(run.evidence.recordedCalls.length).toBe(2);
    expect(run.evidence.status).toBe("quota-exhausted");
  });

  it("a transport failure mid-action yields an incomplete trial, never a finished one", async () => {
    const guest = fakeGuest({ failOnAct: "typeText" });
    const run = await executeTrial(
      new ArmRecorder(),
      guest.transport,
      async (surface) => {
        await surface.act({ kind: "typeText", target: "entry", detail: "buy milk" });
        return { claimsSuccess: true, text: "done" };
      },
      options(),
    );
    expect(run.transportFailed).toBe(true);
    expect(run.failure).toContain("transport dropped the input");
    expect(run.evidence.toolCallAudits.some((audit) => audit.status === "incomplete")).toBe(true);
  });

  it("an arm that cannot prove a tool call's effects is excluded by the scorer", async () => {
    const guest = fakeGuest();
    const recorder = new ArmRecorder();
    const run = await executeTrial(
      recorder,
      {
        ...guest.transport,
        async tool() {
          throw new Error("no audit available");
        },
      },
      async (surface) => {
        await surface.tool("shell-exec", { operation: "exec", command: "cat store.json" });
        return { claimsSuccess: true, text: "read it" };
      },
      options(),
    );
    expect(run.evidence.toolCallAudits[0]?.status).toBe("incomplete");
  });

  it("exhausting the step budget stops the arm instead of looping", async () => {
    const guest = fakeGuest();
    const run = await executeTrial(
      new ArmRecorder(),
      guest.transport,
      async (surface) => {
        for (let i = 0; i < 10; i++) {
          try {
            await surface.act({ kind: "click", target: "add" });
          } catch {
            break;
          }
        }
        return { claimsSuccess: false, text: "gave up" };
      },
      options({ budget: 3 }),
    );
    expect(run.budgetExhausted).toBe(true);
    expect(run.steps).toBe(3);
  });

  it("a dead window is reported as an unreadable screen, not an empty one", async () => {
    const guest = fakeGuest();
    guest.state.up = false;
    const run = await executeTrial(
      new ArmRecorder(),
      guest.transport,
      async (surface) => {
        const view = await surface.screen();
        return { claimsSuccess: view.reachable, text: "saw nothing" };
      },
      options(),
    );
    expect(run.screen.reachable).toBe(false);
    expect(run.selfReport.claimsSuccess).toBe(false);
  });
});
