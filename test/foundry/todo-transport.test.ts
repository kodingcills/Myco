import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executeTrial } from "../../src/foundry/baseline/executor.ts";
import { fakeGuest, type GuestProtocol, LAYOUT } from "../../src/foundry/baseline/guest.ts";
import { ArmRecorder } from "../../src/foundry/baseline/recorder.ts";
import { mycoAgentGuest, todoTransport } from "../../src/foundry/baseline/todo-transport.ts";
import { scoreDiscoveryTrial } from "../../src/foundry/grader/discovery.ts";
import { findTask, taskFixture } from "../../src/foundry/tasks/bank.ts";
import { TODO_FIXTURE_SPECS } from "../../src/foundry/tasks/todo.ts";

const TASK = findTask("ef-t01b-add-four-items-noverify")!;
const SPEC = TODO_FIXTURE_SPECS.find((s) => s.fixtureId === TASK.fixtureId)!;
const PROMPT_HASH = createHash("sha256").update(TASK.prompt).digest("hex");

function options(overrides: Partial<Parameters<typeof executeTrial>[3]> = {}) {
  return {
    armId: "screenshot-only",
    taskId: TASK.taskId,
    promptHash: PROMPT_HASH,
    budget: 40,
    persistencePaths: ["store.json"],
    ...overrides,
  };
}

/** A pixel arm: click the entry, type, click Add, click Save. No text is read. */
const pixelPolicy =
  (items: readonly string[]) =>
  async (surface: {
    act: (a: {
      kind: "click" | "typeText" | "keyPress";
      target?: string;
      detail?: string;
    }) => Promise<void>;
  }) => {
    for (const item of items) {
      await surface.act({ kind: "click", target: `${LAYOUT.add.x},${LAYOUT.add.y}` });
      await surface.act({ kind: "typeText", detail: item });
      await surface.act({ kind: "click", target: `${LAYOUT.add.x},${LAYOUT.add.y}` });
    }
    await surface.act({ kind: "click", target: `${LAYOUT.save.x},${LAYOUT.save.y}` });
    return { claimsSuccess: true, text: "clicked save" };
  };

describe("EF-005 todo transport: contract", () => {
  it("drives a fake guest end to end and produces gradeable evidence", async () => {
    const guest = fakeGuest({ spec: SPEC });
    const run = await executeTrial(
      new ArmRecorder(),
      todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] }),
      pixelPolicy(["buy milk"]),
      options(),
    );
    expect(run.transportFailed).toBe(false);
    expect(run.evidence.recordedCallCount).toBe(run.evidence.recordedCalls.length);
    expect(run.evidence.toolCallAudits.every((a) => a.status === "complete")).toBe(true);
    // The guest really received the input, in order.
    expect(guest.received()).toContain("launch");
    expect(guest.received()).toContain("type");
    expect(guest.received()).toContain("click");
  });

  it("a pixel arm reads no text, and says so rather than inventing it", async () => {
    const guest = fakeGuest({ spec: SPEC });
    const run = await executeTrial(
      new ArmRecorder(),
      todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] }),
      pixelPolicy(["buy milk"]),
      options(),
    );
    // Tk exposes no AT-SPI node, so a pixel arm has nothing to read. An empty list is the
    // honest answer; a fabricated one would let the screen oracle "confirm" a claim.
    expect(run.screen.visibleText).toEqual([]);
    expect(run.screen.reachable).toBe(true);
  });

  it("a structural channel reads text when the guest can supply it", async () => {
    const guest = fakeGuest({ spec: SPEC });
    const run = await executeTrial(
      new ArmRecorder(),
      todoTransport({
        guest,
        channel: "structural",
        argv: ["python3", "myco_todo.py"],
        readText: async () => ["Buy milk", "saved 1 item(s)"],
      }),
      pixelPolicy(["buy milk"]),
      options(),
    );
    expect(run.screen.visibleText).toContain("saved 1 item(s)");
  });

  it("an unmappable action throws instead of silently doing nothing", async () => {
    const guest = fakeGuest({ spec: SPEC });
    const transport = todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] });
    await expect(transport.act({ kind: "click", target: "save-button" })).rejects.toThrow(
      /needs "x,y"/,
    );
  });

  it("a guest that dies mid-trial yields an unreadable screen, not an empty one", async () => {
    const guest = fakeGuest({ spec: SPEC, dieAfter: 2 });
    const run = await executeTrial(
      new ArmRecorder(),
      todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] }),
      pixelPolicy(["buy milk"]),
      options(),
    );
    expect(run.transportFailed).toBe(true);
    expect(run.screen.reachable).toBe(false);
  });

  it("a refused guest call marks the trial incomplete rather than finished", async () => {
    const guest = fakeGuest({ spec: SPEC, failOn: "type" });
    const run = await executeTrial(
      new ArmRecorder(),
      todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] }),
      pixelPolicy(["buy milk"]),
      options(),
    );
    expect(run.transportFailed).toBe(true);
    expect(run.evidence.toolCallAudits.some((a) => a.status === "incomplete")).toBe(true);
  });

  it("refuses a write through the tool channel instead of faking one", async () => {
    const guest = fakeGuest({ spec: SPEC });
    const transport = todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] });
    await expect(
      transport.tool("file-io", { operation: "write", path: "store.json" }),
    ).rejects.toThrow(/reads only/);
  });

  it("a read through the tool channel is audited as a read of that path", async () => {
    const guest = fakeGuest({ spec: SPEC });
    const transport = todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] });
    const accesses = await transport.tool("file-io", { operation: "read", path: "store.json" });
    expect(accesses).toEqual([{ operation: "read", path: "store.json" }]);
  });

  it("the whole path scores: recorder -> transport -> fake guest -> grader", async () => {
    const guest = fakeGuest({ spec: SPEC });
    const run = await executeTrial(
      new ArmRecorder(),
      todoTransport({ guest, channel: "pixel", argv: ["python3", "myco_todo.py"] }),
      pixelPolicy(["buy milk"]),
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
});

describe("EF-005 todo transport: the real guest adapter", () => {
  const baseOps = {
    launch: async () => {},
    screenshot: async () => new Uint8Array([1]),
    readFile: async () => new Uint8Array([2]),
    alive: async () => true,
  };

  it("names the missing channel when the guest has no coordinate input", async () => {
    // M1-023 recorded that the agent op union has no coordinate click. The adapter must say
    // so at the point of use, not fail later with an opaque error.
    const guest = mycoAgentGuest(baseOps);
    await expect(guest.click(1, 2)).rejects.toThrow(/no coordinate-click channel/);
  });

  it("names the missing channel when the guest has no keystroke input", async () => {
    const guest = mycoAgentGuest(baseOps);
    await expect(guest.key("Return")).rejects.toThrow(/no keystroke channel/);
  });

  it("passes through the channels the guest does have", async () => {
    const guest = mycoAgentGuest({ ...baseOps, click: async () => {}, key: async () => {} });
    await expect(guest.click(1, 2)).resolves.toBeUndefined();
    await expect(guest.key("Return")).resolves.toBeUndefined();
    expect(await guest.alive()).toBe(true);
  });

  it("a guest with every channel satisfies the protocol", async () => {
    const full: GuestProtocol = mycoAgentGuest({
      ...baseOps,
      click: async () => {},
      key: async () => {},
      type: async () => {},
    });
    expect(typeof full.launch).toBe("function");
    expect(typeof full.screenshot).toBe("function");
    expect(typeof full.readFile).toBe("function");
  });
});
