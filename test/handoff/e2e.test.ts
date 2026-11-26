/**
 * Track N end to end on the mock transport (no VM, no model, no network beyond 127.0.0.1):
 *
 *   seal -> a scripted agent drives the mock desktop, gets stuck before saving, and calls
 *   myco_handoff_request over its MCP wire -> the operator is notified -> a scripted human sees
 *   it with `myco-handoff list`, saves on the live desktop, and answers `fixed-it` with
 *   `myco-handoff resolve` -> the agent resumes, calls the gate -> the agent stops, the harness
 *   captures -> the verdict comes from the sealed bytes only. The run record carries the
 *   handoff log, and the trial is labelled `assisted`.
 *
 * Then: the same desktop end state with and without a handoff gives the same verdict (a
 * handoff never changes a verdict), a human "fixed-it" cannot turn a refuted trial verified, and
 * a handoff nobody answers ends the attempt as handoff-timeout.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { validateSchema } from "../../schemas/validate.ts";
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
import { builtinTasks } from "../../src/gate/tasks.ts";
import {
  HANDOFF_AWAIT_TOOL,
  HANDOFF_REQUEST_TOOL,
  HANDOFF_SERVER_CLASS,
  handleHandoffLine,
} from "../../src/handoff/agent-server.ts";
import { HandoffBroker, type HandoffEvent, type HandoffNotice } from "../../src/handoff/broker.ts";
import { main as cli } from "../../src/handoff/cli.ts";
import { jsonlHandoffEventSink } from "../../src/handoff/events.ts";
import {
  newOperatorToken,
  type OperatorServer,
  startOperatorServer,
  writeConnectionFile,
} from "../../src/handoff/operator-server.ts";
import type { HandoffLog } from "../../src/handoff/protocol.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import { rtSessionIdFor } from "../../src/integrity/surface.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const ORACLE_SOURCES = ["src/gate/families.ts", "src/discovery/s0-sequence.ts"].map((rel) =>
  join(ROOT, rel),
);

let base: string;
let vault: VerdictVault;
let tasks: TaskRegistry;
let server: OperatorServer | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-handoff-e2e-"));
  mkdirSync(join(base, "agent"));
  vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
  tasks = buildRegistry(builtinTasks());
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(base, { recursive: true, force: true });
});

function plan(runId: string): AgentLaunchPlan {
  return {
    argv: [
      "-p",
      "add the items, save, then call the gate",
      "--strict-mcp-config",
      "--tools",
      "",
      "--mcp-config",
      join(base, "mcp.json"),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      [
        "mcp__myco-rt__observe",
        "mcp__myco-rt__act",
        `mcp__myco-gate__${GATE_TOOL}`,
        `mcp__myco-handoff__${HANDOFF_REQUEST_TOOL}`,
        `mcp__myco-handoff__${HANDOFF_AWAIT_TOOL}`,
      ].join(","),
    ],
    mcpServers: {
      "myco-rt": {
        command: "myco-rt-mcp",
        args: [],
        env: { MYCO_RT_SESSION_ID: rtSessionIdFor(runId) },
      },
      "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} },
      "myco-handoff": { command: "myco-handoff-mcp", args: [], env: {} },
    },
    mcpConfigPath: join(base, "mcp.json"),
  };
}

async function tool(gate: Gate, args: Record<string, unknown>): Promise<GateResult> {
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

async function handoffTool(broker: HandoffBroker, name: string, args: unknown) {
  const line = await handleHandoffLine(
    broker.agentChannel(),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    { waitMs: 25 },
  );
  return (JSON.parse(line ?? "{}") as { result: { structuredContent: Record<string, unknown> } })
    .result.structuredContent;
}

interface Scripted {
  /** Whether the agent asks for a handoff before saving. */
  readonly handoff: boolean;
  /** What the scripted human does with the desktop when notified (undefined: nothing, ever). */
  readonly human?: "save" | "nothing";
  readonly outcome?: "approve" | "fixed-it" | "reject";
}

interface TrialTrace {
  agentSaw: Record<string, unknown>[];
  midRun?: GateResult;
  humanListed?: string;
  agentStoppedOn?: string;
}

/**
 * The scripted agent types the task's items. With `handoff`, it asks the human before saving,
 * polls until the handoff closes, and saves itself only if the human approved (a `fixed-it`
 * means the human already saved). Without a handoff it saves itself.
 */
function transport(
  taskId: string,
  runId: string,
  broker: HandoffBroker,
  script: Scripted,
  trace: TrialTrace,
  human: (
    desktop: MockDesktop,
    session: Awaited<ReturnType<MockDesktop["create"]>>,
  ) => Promise<void>,
): GatedTrialTransport {
  const task = runTask(taskId);
  const desktop = new MockDesktop();
  let session: Awaited<ReturnType<MockDesktop["create"]>> | undefined;
  return {
    async runAgent(_plan, gate) {
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
      let save = true;
      if (script.handoff) {
        const humanDone = human(desktop, session);
        let r = await handoffTool(broker, HANDOFF_REQUEST_TOOL, {
          reason: "needs-approval",
          note: "About to save the list. OK to save?",
        });
        trace.agentSaw.push(r);
        while (r.status === "paused") {
          r = await handoffTool(broker, HANDOFF_AWAIT_TOOL, { handoffId: r.handoffId });
          trace.agentSaw.push(r);
        }
        await humanDone;
        if (r.status === "ended" || r.status === "rejected") {
          trace.agentStoppedOn = String(r.status);
          return; // the agent stops; no save, no gate call
        }
        save = r.outcome === "approve";
      }
      if (save) await desktop.act(session, { kind: "clickAt", x: 210, y: 284 });
      trace.midRun = await tool(gate, { taskId, runId, claim: task.agentClaim });
    },
    async captureAfterStop() {
      if (!session) throw new Error("no session");
      const bytes = Buffer.from(await desktop.readFile(session, task.storePath));
      await desktop.destroy();
      broker.close();
      return { [`persisted/${task.storePath}`]: bytes };
    },
  };
}

/** The scripted human: wait for the notice, look via the CLI, act on the desktop, resolve via the CLI. */
function scriptedHuman(
  noticed: Promise<HandoffNotice>,
  conn: string,
  script: Scripted,
  trace: TrialTrace,
) {
  return async (desktop: MockDesktop, session: Awaited<ReturnType<MockDesktop["create"]>>) => {
    if (script.human === undefined) return;
    const notice = await noticed;
    // A human takes longer than one long-poll: the agent sees "paused" at least once.
    await new Promise((r) => setTimeout(r, 80));
    const out = new PassThrough();
    const err = new PassThrough();
    expect(await cli(["list", "--connection", conn], { stdout: out, stderr: err })).toBe(0);
    trace.humanListed = (out.read() as Buffer).toString();
    if (script.human === "save") await desktop.act(session, { kind: "clickAt", x: 210, y: 284 });
    const args = ["resolve", notice.handoffId, script.outcome ?? "approve", "--connection", conn];
    if (script.outcome === "fixed-it") args.push("--note", "I saved it for you");
    expect(await cli(args, { stdout: new PassThrough(), stderr: err })).toBe(0);
  };
}

async function runTrial(taskId: string, runId: string, script: Scripted, timeoutMs = 60_000) {
  let notify: (n: HandoffNotice) => void = () => {};
  const noticed = new Promise<HandoffNotice>((r) => {
    notify = r;
  });
  const terminal: string[] = [];
  const eventsPath = join(base, `${runId}.handoffs.jsonl`);
  const broker = new HandoffBroker({
    runId,
    taskId,
    timeoutMs,
    events: jsonlHandoffEventSink(eventsPath),
    notifier: {
      notify: (n) => {
        terminal.push(`\u0007${n.handoffId} ${n.reason}`);
        notify(n);
      },
    },
  });
  const token = newOperatorToken();
  server = await startOperatorServer({ channel: broker.operatorChannel(), token });
  const conn = join(base, "operator", `${runId}.json`);
  writeConnectionFile(conn, server.url, token);
  const trace: TrialTrace = { agentSaw: [] };
  const outcome = await runGatedTrial({
    vault,
    runId,
    taskId,
    tasks,
    plan: plan(runId),
    transport: transport(
      taskId,
      runId,
      broker,
      script,
      trace,
      scriptedHuman(noticed, conn, script, trace),
    ),
    oracleSources: ORACLE_SOURCES,
    allowHandoffServer: true,
  });
  await server.close();
  server = undefined;
  if (outcome.status !== "decided")
    throw new Error(`audit refused: ${JSON.stringify(outcome.audit.violations)}`);
  const log = broker.log();
  // The run record (result.json shape) carries the handoff log.
  const record = {
    runId,
    taskId,
    taskParams: {},
    startedAt: "2026-11-26T15:00:00.000Z",
    steps: [],
    verdict: verdictOf(outcome.result),
    handoffs: log,
  };
  const events = readEvents(eventsPath);
  return { outcome, log, record, trace, terminal, events, token, conn };
}

function verdictOf(result: GateResult) {
  const passed = result.verdict === "verified";
  return {
    status: result.verdict,
    checks: [
      {
        name: "gate",
        passed,
        reason: result.reasonCodes.join(","),
        partial_score: { score: passed ? 1 : 0, weight: 1 },
      },
    ],
    score: passed ? 1 : 0,
    reasons: result.reasonCodes,
  };
}

function readEvents(path: string): HandoffEvent[] {
  try {
    return readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HandoffEvent);
  } catch {
    return [];
  }
}

describe("track N end to end: request, notify, human fixes on the desktop, resume, record", () => {
  it("the agent pauses, the human saves and answers fixed-it, the agent resumes; verdict from bytes", async () => {
    const r = await runTrial("df-s01", "run-h1", {
      handoff: true,
      human: "save",
      outcome: "fixed-it",
    });
    // The agent was paused, then resumed with the human's outcome and note.
    expect(r.trace.agentSaw[0]).toMatchObject({
      apiVersion: "myco.handoff/v1",
      status: "paused",
      handoffId: "ho-1",
    });
    expect(r.trace.agentSaw.at(-1)).toMatchObject({
      status: "resumed",
      outcome: "fixed-it",
      humanNote: "I saved it for you",
    });
    // The operator was notified and saw the handoff through the CLI.
    expect(r.terminal).toEqual(["\u0007ho-1 needs-approval"]);
    expect(JSON.parse(r.trace.humanListed ?? "{}").pending[0]).toMatchObject({
      handoffId: "ho-1",
      runId: "run-h1",
      taskId: "df-s01",
      reason: "needs-approval",
      source: "agent",
    });
    // The verdict is the gate's, from the sealed capture.
    expect(r.outcome.result.verdict).toBe("verified");
    expect(r.outcome.result.reasonCodes).toEqual(["ORACLE_PASS"]);
    expect(JSON.stringify(r.outcome.result)).not.toMatch(/handoff|fixed-it|assist/i);
    // The record shows it: who, what, when, how long; labelled assisted.
    expect(r.log.assistance).toBe("assisted");
    expect(r.log.attemptEnd).toBeNull();
    expect(r.log.entries).toHaveLength(1);
    const e = r.log.entries[0]!;
    expect(e).toMatchObject({
      handoffId: "ho-1",
      runId: "run-h1",
      taskId: "df-s01",
      source: "agent",
      policyId: null,
      reason: "needs-approval",
      note: "About to save the list. OK to save?",
      resolution: "fixed-it",
      resolvedBy: "operator:cli",
      operatorLabel: "operator",
      humanNote: "I saved it for you",
    });
    expect(Date.parse(e.resolvedAt) - Date.parse(e.requestedAt)).toBe(e.durationMs);
    expect(validateSchema(r.record, resultRecordSchema)).toEqual([]);
    // Trial events on disk beside the record (next to #518's ledger once it merges).
    expect(r.events.map((x) => x.event)).toEqual(["requested", "resolved"]);
    // Nothing operator-side leaked into the run record.
    const recordText = JSON.stringify(r.record);
    expect(recordText).not.toContain(r.token);
    expect(recordText).not.toContain(base);
  });

  it("the same end state gives the same verdict with or without a handoff", async () => {
    const plain = await runTrial("df-s01", "run-h2", { handoff: false });
    const approved = await runTrial("df-s01", "run-h3", {
      handoff: true,
      human: "nothing",
      outcome: "approve",
    });
    expect(plain.log.assistance).toBe("unassisted");
    expect(approved.log.assistance).toBe("human-gated");
    expect(approved.trace.agentSaw.at(-1)).toMatchObject({ status: "resumed", outcome: "approve" });
    expect(approved.outcome.result.verdict).toBe(plain.outcome.result.verdict);
    expect(approved.outcome.result.reasonCodes).toEqual(plain.outcome.result.reasonCodes);
    expect(approved.outcome.result.verdict).toBe("verified");
  });

  it("a human fixed-it cannot make a refuted trial verified: the bytes decide", async () => {
    // df-s02: the app silently drops the BUG items whatever anyone clicks.
    const r = await runTrial("df-s02", "run-h4", {
      handoff: true,
      human: "save",
      outcome: "fixed-it",
    });
    expect(r.log.assistance).toBe("assisted");
    expect(r.outcome.result.verdict).toBe("refuted");
    expect(r.outcome.result.accepted).toBe(false);
  });

  it("reject: the agent stops without saving; the gate decides from what was persisted", async () => {
    const r = await runTrial("df-s01", "run-h5", {
      handoff: true,
      human: "nothing",
      outcome: "reject",
    });
    expect(r.trace.agentStoppedOn).toBe("rejected");
    expect(r.trace.midRun).toBeUndefined();
    expect(r.outcome.result.verdict).not.toBe("verified");
    expect(r.log.entries[0]?.resolution).toBe("reject");
  });

  it("nobody answers: the attempt ends as handoff-timeout, recorded, never approved", async () => {
    const r = await runTrial("df-s01", "run-h6", { handoff: true }, 1_000);
    expect(r.trace.agentSaw.at(-1)).toEqual({
      apiVersion: "myco.handoff/v1",
      status: "ended",
      code: "HANDOFF_TIMEOUT",
    });
    expect(r.trace.agentStoppedOn).toBe("ended");
    expect(r.log.attemptEnd).toBe("handoff-timeout");
    expect(r.log.entries[0]).toMatchObject({ resolution: "timeout", resolvedBy: "host:timeout" });
    expect(r.events.map((x) => x.event)).toEqual(["requested", "resolved", "attempt-ended"]);
    expect(r.outcome.result.verdict).not.toBe("verified");
    expect(validateSchema(r.record, resultRecordSchema)).toEqual([]);
  });

  it("without the operator's opt-in, a plan that starts the handoff server is refused closed", async () => {
    const broker = new HandoffBroker({ runId: "run-h7", taskId: "df-s01" });
    const outcome = await runGatedTrial({
      vault,
      runId: "run-h7",
      taskId: "df-s01",
      tasks,
      plan: plan("run-h7"),
      transport: transport(
        "df-s01",
        "run-h7",
        broker,
        { handoff: false },
        { agentSaw: [] },
        async () => {},
      ),
      oracleSources: ORACLE_SOURCES,
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.audit.violations.map((v) => v.tool)).toContain("mcp__myco-handoff");
    expect(Object.keys(HANDOFF_SERVER_CLASS)).toEqual(["myco-handoff"]);
    expect(Object.keys(GATE_SERVER_CLASS)).toEqual(["myco-gate"]);
  });
});

describe("run record schema: handoffs field", () => {
  it("is optional, and a malformed log is refused", () => {
    const record = {
      runId: "r",
      taskId: "t",
      taskParams: {},
      startedAt: "x",
      steps: [],
      verdict: {
        status: "verified",
        checks: [
          {
            name: "gate",
            passed: true,
            reason: "ORACLE_PASS",
            partial_score: { score: 1, weight: 1 },
          },
        ],
        score: 1,
        reasons: [],
      },
    };
    expect(validateSchema(record, resultRecordSchema)).toEqual([]);
    const bad = {
      ...record,
      handoffs: {
        schema: "myco.handoff.log/1",
        assistance: "solo",
        attemptEnd: null,
        timeoutMs: 1000,
        entries: [],
      } as unknown as HandoffLog,
    };
    expect(validateSchema(bad, resultRecordSchema).length).toBeGreaterThan(0);
  });
});
