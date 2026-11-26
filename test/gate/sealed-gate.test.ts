/**
 * TIF-274 prerequisite: the gate on the sealed vault, end to end on the mock transport.
 *
 * seal → a scripted agent drives the mock desktop (and calls the gate mid-run) → the agent
 * stops → the harness copies the guest's saved file to the host and captures it → the gate's
 * verdict comes from the sealed copy only. Then every route by which an agent could swap
 * the bytes or point the gate elsewhere ends non-verified. No VM, no model, no network.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDesktop } from "../../src/discovery/mock-desktop.ts";
import { runTask } from "../../src/discovery/run-tasks.ts";
import type { GateResult } from "../../src/gate/api.ts";
import { buildRegistry, type Gate, type TaskRegistry } from "../../src/gate/gate.ts";
import {
  GATE_SERVER_CLASS,
  type GatedTrialTransport,
  runGatedTrial,
} from "../../src/gate/gated-trial.ts";
import { GATE_TOOL, handleLine } from "../../src/gate/mcp-server.ts";
import { createSealedGate, gateGroundTruth, sealedEvidenceReader } from "../../src/gate/sealed.ts";
import { builtinTasks } from "../../src/gate/tasks.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import { rtSessionIdFor } from "../../src/integrity/surface.ts";
import {
  AUDIT_WITHOUT_RECEIPT,
  type IntegrityViolation,
  newVaultKey,
  type SealReceipt,
  VerdictVault,
} from "../../src/integrity/vault.ts";
import { todoStore } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..", "..");
/** The family oracle's sources, hashed at seal. */
const ORACLE_SOURCES = ["src/gate/families.ts", "src/discovery/s0-sequence.ts"].map((rel) =>
  join(ROOT, rel),
);

let base: string;
let vaultRoot: string;
let agentRoot: string;
let vault: VerdictVault;
let tasks: TaskRegistry;
let integrity: IntegrityViolation[][];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-sealed-gate-"));
  vaultRoot = join(base, "vault");
  agentRoot = join(base, "agent");
  mkdirSync(agentRoot);
  vault = new VerdictVault({ root: vaultRoot, key: newVaultKey(), agentRoots: [agentRoot] });
  tasks = buildRegistry(builtinTasks());
  integrity = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function gatedPlan(runId: string, extraTools: readonly string[] = []): AgentLaunchPlan {
  return {
    argv: [
      "-p",
      "add the items, save, then call the gate",
      "--strict-mcp-config",
      "--mcp-config",
      join(base, "mcp.json"),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      [
        "mcp__myco-rt__observe",
        "mcp__myco-rt__act",
        `mcp__myco-gate__${GATE_TOOL}`,
        ...extraTools,
      ].join(","),
    ],
    mcpServers: {
      "myco-rt": {
        command: "myco-rt-mcp",
        args: [],
        env: { MYCO_RT_SESSION_ID: rtSessionIdFor(runId) },
      },
      "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} },
    },
  };
}

/** Call the gate the way Claude Code does: one JSON-RPC `tools/call` line. */
async function callGateTool(gate: Gate, args: Record<string, unknown>): Promise<GateResult> {
  const line = await handleLine(
    gate,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: GATE_TOOL, arguments: args },
    }),
  );
  return (JSON.parse(line ?? "{}") as { result: { structuredContent: GateResult } }).result
    .structuredContent;
}

interface MockRecord {
  launchedWith?: AgentLaunchPlan;
  midRun?: GateResult;
  extraCalls: GateResult[];
  captured: boolean;
}

/**
 * The mock transport: a scripted fake agent drives the mock desktop through a todo task and
 * calls the gate before stopping; after stop the harness copies the guest's saved store.
 */
function mockTransport(
  taskId: string,
  runId: string,
  record: MockRecord,
  agentAlso?: (gate: Gate) => Promise<void>,
): GatedTrialTransport {
  const task = runTask(taskId);
  const desktop = new MockDesktop();
  let session: Awaited<ReturnType<MockDesktop["create"]>> | undefined;
  return {
    async runAgent(plan, gate) {
      record.launchedWith = plan;
      session = await desktop.create();
      await desktop.act(session, {
        kind: "launch",
        command: task.launch.command,
        args: task.launch.args,
      });
      for (const item of task.items) {
        await desktop.act(session, { kind: "typeTextGlobal", text: item });
        await desktop.act(session, { kind: "keyPress", keys: "Return" });
      }
      await desktop.act(session, { kind: "clickAt", x: 210, y: 284 });
      // The agent believes it is done and asks the gate, mid-run.
      record.midRun = await callGateTool(gate, { taskId, runId, claim: task.agentClaim });
      await agentAlso?.(gate);
      // The agent process exits here.
    },
    async captureAfterStop() {
      if (!session) throw new Error("no session");
      const bytes = Buffer.from(await desktop.readFile(session, task.storePath));
      await desktop.destroy();
      record.captured = true;
      return {
        [`persisted/${task.storePath}`]: bytes,
        "result.json": Buffer.from(JSON.stringify({ claim: task.agentClaim })),
      };
    },
  };
}

async function trial(
  taskId: string,
  runId: string,
  agentAlso?: (gate: Gate) => Promise<void>,
  oracleSources: readonly string[] = ORACLE_SOURCES,
) {
  const record: MockRecord = { extraCalls: [], captured: false };
  const outcome = await runGatedTrial({
    vault,
    runId,
    taskId,
    tasks,
    plan: gatedPlan(runId),
    transport: mockTransport(taskId, runId, record, agentAlso),
    oracleSources,
    onIntegrity: (violations) => integrity.push([...violations]),
  });
  if (outcome.status !== "decided") throw new Error("audit refused the gated plan");
  return { ...outcome, record };
}

/** A gate for an already-decided trial, as the harness rebuilds it to re-check. */
function gateFor(taskId: string, runId: string, receipt: SealReceipt): Gate {
  return createSealedGate({
    tasks,
    vault,
    binding: { runId, receipt },
    taskId,
    onIntegrity: (violations) => integrity.push([...violations]),
  });
}

function overwrite(path: string, content: string | Uint8Array): void {
  chmodSync(path, 0o600);
  writeFileSync(path, content);
  chmodSync(path, 0o400);
}

function expectNotVerified(result: GateResult, code: string, detail?: RegExp): void {
  expect(result.verdict).toBe("uncertain");
  expect(result.accepted).toBe(false);
  expect(result.reasonCodes).toContain(code);
  if (detail) expect(result.reasons.join("\n")).toMatch(detail);
  // Agent-facing reasons carry codes, never a host path (#478/#480).
  expect(result.reasons.join("\n")).not.toContain(base);
}

describe("gated trial on the mock transport: verdict from sealed copies", () => {
  it("a clean save is verified, from the sealed capture, after stop", async () => {
    const { result, record, audit } = await trial("df-s01", "run-s01");
    expect(audit.ok).toBe(true);
    expect(audit.mycoRtSessionPinned).toBe(true);
    expect(record.captured).toBe(true);
    expect(result.verdict).toBe("verified");
    expect(result.accepted).toBe(true);
    expect(result.reasonCodes).toEqual(["ORACLE_PASS"]);
    expect(result.evidenceRefs[0]?.path).toBe(runTask("df-s01").storePath);
  });

  it("a silent drop is refuted from the sealed capture", async () => {
    const { result } = await trial("df-s02", "run-s02");
    expect(result.verdict).toBe("refuted");
    expect(result.reasonCodes).toEqual(["ORACLE_FAIL"]);
  });

  it("a gate call before stop and capture is uncertain, never verified", async () => {
    const { record, result } = await trial("df-s01", "run-s01");
    const mid = record.midRun as GateResult;
    expectNotVerified(mid, "STATE_UNREADABLE", /no sealed capture yet/);
    expect(mid.reasons.join("\n")).toMatch(/integrity:agent-not-stopped/);
    // The same gate, after capture, verifies: the difference is the sealed capture.
    expect(result.verdict).toBe("verified");
  });

  it("the transport is started with the very plan that was audited", async () => {
    const { record } = await trial("df-s01", "run-s01");
    const plan = record.launchedWith as AgentLaunchPlan;
    expect(plan).toEqual(gatedPlan("run-s01"));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.argv)).toBe(true);
    expect(Object.isFrozen(plan.mcpServers["myco-rt"]?.env)).toBe(true);
  });

  it("the oracle reads the vault, not the guest: a guest edit after capture changes nothing", async () => {
    // df-s02's app dropped two items. After capture the agent (or a process it left
    // behind) "fixes" the guest file; the verdict is still the sealed capture's.
    const { receipt } = await trial("df-s02", "run-s02");
    writeFileSync(join(agentRoot, ".myco-todo.json"), todoStore(runTask("df-s02").items));
    const again = await gateFor("df-s02", "run-s02", receipt).check({
      taskId: "df-s02",
      runId: "run-s02",
    });
    expect(again.verdict).toBe("refuted");
  });
});

describe("tampering after capture is never verified", () => {
  it("overwriting the captured persisted state with a passing store is caught by its hash", async () => {
    const { receipt, result } = await trial("df-s02", "run-s02");
    expect(result.verdict).toBe("refuted");
    const captured = join(vaultRoot, "run-s02", "captured", "persisted", ".myco-todo.json");
    overwrite(captured, todoStore(runTask("df-s02").items));
    const again = await gateFor("df-s02", "run-s02", receipt).check({
      taskId: "df-s02",
      runId: "run-s02",
    });
    expectNotVerified(again, "STATE_UNREADABLE", /integrity:captured-file-hash/);
    // The operator gets the full violation; the agent got the code only.
    expect(integrity.flat().some((v) => v.code === "captured-file-hash")).toBe(true);
  });

  it("re-signing the sealed spec to match a dropped store is caught", async () => {
    // The attacker rewrites ground truth so the oracle would expect only what was saved.
    const { receipt } = await trial("df-s02", "run-s02");
    const gt = join(vaultRoot, "run-s02", "sealed", "ground-truth.json");
    overwrite(
      gt,
      JSON.stringify({ ...gateGroundTruth(tasks.get("df-s02")!), spec: { items: ["x"] } }),
    );
    const again = await gateFor("df-s02", "run-s02", receipt).check({
      taskId: "df-s02",
      runId: "run-s02",
    });
    expectNotVerified(again, "STATE_UNREADABLE", /integrity:sealed-file-hash/);
  });

  it("dropping an extra file into the run's vault dir is caught", async () => {
    const { receipt } = await trial("df-s01", "run-s01");
    const dir = join(vaultRoot, "run-s01", "captured", "persisted");
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "extra.json"), "{}");
    const again = await gateFor("df-s01", "run-s01", receipt).check({
      taskId: "df-s01",
      runId: "run-s01",
    });
    expectNotVerified(again, "STATE_UNREADABLE", /integrity:unexpected-file/);
  });

  it("an edited oracle source is caught, and its host path never reaches the agent", async () => {
    const copy = join(base, "oracle-src", "families.ts");
    mkdirSync(join(base, "oracle-src"));
    writeFileSync(copy, readFileSync(ORACLE_SOURCES[0]!));
    const { receipt } = await trial("df-s01", "run-s01", undefined, [copy]);
    writeFileSync(copy, "// edited after seal\n", { flag: "a" });
    const again = await gateFor("df-s01", "run-s01", receipt).check({
      taskId: "df-s01",
      runId: "run-s01",
    });
    // expectNotVerified also asserts no reason contains the temp base dir.
    expectNotVerified(again, "STATE_UNREADABLE", /integrity:oracle-source-hash/);
    expect(integrity.flat().some((v) => v.path === copy)).toBe(true);
  });

  it("deleting the capture manifest is caught", async () => {
    const { receipt } = await trial("df-s01", "run-s01");
    rmSync(join(vaultRoot, "run-s01", "capture.json"), { force: true });
    const again = await gateFor("df-s01", "run-s01", receipt).check({
      taskId: "df-s01",
      runId: "run-s01",
    });
    expectNotVerified(again, "STATE_UNREADABLE", /integrity:capture-missing/);
  });
});

describe("the agent's run id never selects another trial's sealed bytes", () => {
  it("naming an earlier honest trial is ASSIGNMENT_MISMATCH, and nothing is read", async () => {
    await trial("df-s01", "run-0");
    const extra: GateResult[] = [];
    const { result } = await trial("df-s02", "run-1", async (gate) => {
      extra.push(await callGateTool(gate, { taskId: "df-s01", runId: "run-0" }));
      extra.push(await callGateTool(gate, { taskId: "df-s02", runId: "run-0" }));
    });
    for (const r of extra) expectNotVerified(r, "ASSIGNMENT_MISMATCH");
    expect(result.verdict).toBe("refuted");
  });

  it("the sealed reader refuses any run id but the binding's, on its own", async () => {
    // Defence in depth below the gate's assignment check: call the reader directly.
    await trial("df-s01", "run-0");
    const { receipt } = await trial("df-s01", "run-1");
    const reader = sealedEvidenceReader({
      vault,
      binding: { runId: "run-1", receipt },
      task: tasks.get("df-s01")!,
    });
    const other = await reader.read("run-0", ".myco-todo.json");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.detail).toMatch(/integrity:run-not-bound/);
    expect((await reader.read("run-1", ".myco-todo.json")).ok).toBe(true);
  });

  it("the sealed reader returns only the bound task's state file, not another persisted one", async () => {
    // A capture holding a second persisted file (a passing decoy) must not be readable
    // under any name but the task's state file.
    const task = tasks.get("df-s01")!;
    const receipt = vault.seal("run-d", {
      groundTruth: gateGroundTruth(task),
      fixtures: {},
      oracle: { id: "todo-items@1", sourceFiles: ORACLE_SOURCES },
    });
    vault.markAgentStopped("run-d");
    vault.capture("run-d", {
      "persisted/.myco-todo.json": Buffer.from(todoStore(["only one"])),
      "persisted/decoy.json": Buffer.from(todoStore(runTask("df-s01").items)),
    });
    const reader = sealedEvidenceReader({ vault, binding: { runId: "run-d", receipt }, task });
    const decoy = await reader.read("run-d", "decoy.json");
    expect(decoy.ok).toBe(false);
    if (!decoy.ok) expect(decoy.detail).toBe("not the bound task's state file");
    expect((await reader.read("run-d", task.stateFile)).ok).toBe(true);
  });

  it("another trial's receipt does not open this trial", async () => {
    const zero = await trial("df-s01", "run-0");
    await trial("df-s01", "run-1");
    const gate = gateFor("df-s01", "run-1", zero.receipt);
    const r = await gate.check({ taskId: "df-s01", runId: "run-1" });
    expectNotVerified(r, "STATE_UNREADABLE", /integrity:receipt-mismatch/);
  });

  it("a binding holding the audit opt-out is refused at runtime", async () => {
    await trial("df-s01", "run-0");
    const gate = gateFor("df-s01", "run-0", AUDIT_WITHOUT_RECEIPT as unknown as SealReceipt);
    const r = await gate.check({ taskId: "df-s01", runId: "run-0" });
    expectNotVerified(r, "STATE_UNREADABLE", /integrity:receipt-missing/);
  });

  it("a registry spec that differs from the sealed one is refused", async () => {
    // The trial sealed df-s01's spec; a gate built over a registry whose df-s01 now
    // expects fewer items (the store would pass it) must not decide from it.
    const { receipt } = await trial("df-s01", "run-0");
    const weaker = buildRegistry(
      builtinTasks().map((t) =>
        t.id === "df-s01" ? { ...t, spec: { items: [runTask("df-s01").items[0]] } } : t,
      ),
    );
    const gate = createSealedGate({
      tasks: weaker,
      vault,
      binding: { runId: "run-0", receipt },
      taskId: "df-s01",
    });
    const r = await gate.check({ taskId: "df-s01", runId: "run-0" });
    expectNotVerified(r, "STATE_UNREADABLE", /sealed spec differs/);
  });
});

describe("the launch audit runs on the launched agent's plan, before anything else", () => {
  it.each([
    ["a host shell", ["Bash"]],
    ["a host file tool", ["Read"]],
    ["an unknown tool", ["mcp__myco-rt__snapshot_host"]],
    ["the evidence writer", ["mcp__myco-rt__evidence"]],
  ])("a plan granting %s is refused: nothing sealed, agent never launched", async (_, extra) => {
    const record: MockRecord = { extraCalls: [], captured: false };
    const outcome = await runGatedTrial({
      vault,
      runId: "run-x",
      taskId: "df-s01",
      tasks,
      plan: gatedPlan("run-x", extra),
      transport: mockTransport("df-s01", "run-x", record),
      oracleSources: ORACLE_SOURCES,
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.audit.ok).toBe(false);
    expect(record.launchedWith).toBeUndefined();
    expect(readdirSync(vaultRoot)).toEqual([]);
  });

  it("an unpinned myco-rt server makes create a violation (pin from the real env)", async () => {
    const plan = gatedPlan("run-x", ["mcp__myco-rt__create"]);
    const unpinned: AgentLaunchPlan = {
      ...plan,
      mcpServers: {
        ...plan.mcpServers,
        "myco-rt": { command: "myco-rt-mcp", args: [], env: { MYCO_RT_SESSION_ID: "" } },
      },
    };
    const record: MockRecord = { extraCalls: [], captured: false };
    const outcome = await runGatedTrial({
      vault,
      runId: "run-x",
      taskId: "df-s01",
      tasks,
      plan: unpinned,
      transport: mockTransport("df-s01", "run-x", record),
      oracleSources: ORACLE_SOURCES,
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.audit.violations.map((v) => v.tool)).toEqual(["mcp__myco-rt__create"]);
    expect(record.launchedWith).toBeUndefined();
    // Pinned to this trial, create is allowed.
    const pinned = await runGatedTrial({
      vault,
      runId: "run-x",
      taskId: "df-s01",
      tasks,
      plan,
      transport: mockTransport("df-s01", "run-x", record),
      oracleSources: ORACLE_SOURCES,
    });
    expect(pinned.status).toBe("decided");
  });

  it("a transport that fails leaves the trial unstopped and uncaptured", async () => {
    const transport: GatedTrialTransport = {
      async runAgent() {
        throw new Error("agent crashed and may still be running");
      },
      async captureAfterStop() {
        throw new Error("must not be called");
      },
    };
    await expect(
      runGatedTrial({
        vault,
        runId: "run-x",
        taskId: "df-s01",
        tasks,
        plan: gatedPlan("run-x"),
        transport,
        oracleSources: ORACLE_SOURCES,
      }),
    ).rejects.toThrow(/crashed/);
    expect(readdirSync(join(vaultRoot, "run-x")).sort()).toEqual(["seal.json", "sealed"]);
  });

  it("the gate's own tool is classified for the audit", () => {
    expect(GATE_SERVER_CLASS["myco-gate"][GATE_TOOL].reach).toBe("gate");
  });
});
