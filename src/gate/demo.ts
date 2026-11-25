/**
 * End-to-end gate demo on the mock transport (TIF-265): no VM, no model, no network.
 *
 * It plays the roles Claude Code and the harness play in M2, with fakes:
 *  1. a scripted fake agent drives the mock desktop (`MockDesktop`, the same double
 *     `myco-run --transport mock` uses) through a todo task and claims "done";
 *  2. the mock guest's disk is materialized: the app's saved store is written to the
 *     run's evidence location by the harness, never by the agent;
 *  3. the gate MCP server runs as a separate process, exactly as Claude Code would start
 *     it, and the fake agent calls `myco_gate_check` over stdio JSON-RPC;
 *  4. the harness accepts "done" only when the gate says `accepted: true`.
 *
 * Scenarios: df-s01 (clean, must be accepted), df-s02 (the app silently drops BUG items
 * while its status line says "saved 4", must be rejected as refuted), and a tamper
 * attempt on df-s02 (the agent passes the items it wants checked, must be rejected
 * with ORACLE_INPUT_REJECTED). Nothing here is evidence; every row says `mock`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mcpStdio } from "../baseline/mcp-stdio.ts";
import { MockDesktop } from "../discovery/mock-desktop.ts";
import { runTask } from "../discovery/run-tasks.ts";
import type { GateResult, ReasonCode } from "./api.ts";
import { GATE_TOOL, PROTOCOL_VERSIONS } from "./mcp-server.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
export const GATE_SCRIPT = join(ROOT, "scripts", "myco-gate.ts");

export interface DemoScenario {
  readonly name: string;
  readonly taskId: string;
  readonly runId: string;
  /** Extra arguments the agent tries to send (the tamper scenario). */
  readonly tamper?: Record<string, unknown>;
  readonly expectAccepted: boolean;
  readonly expectCode: ReasonCode;
}

export interface DemoRow {
  readonly scenario: string;
  readonly provenance: "mock";
  readonly uiStatus: string;
  readonly agentClaim: string;
  readonly verdict: string;
  readonly accepted: boolean;
  readonly reasonCodes: readonly string[];
  readonly harness: "DONE accepted" | "DONE rejected";
  readonly asExpected: boolean;
}

export interface DemoReport {
  readonly ok: boolean;
  readonly evidenceRoot: string;
  readonly auditLog: string;
  readonly tools: readonly string[];
  readonly rows: readonly DemoRow[];
}

export const SCENARIOS: readonly DemoScenario[] = [
  {
    name: "df-s01 clean save",
    taskId: "df-s01",
    runId: "demo-df-s01",
    expectAccepted: true,
    expectCode: "ORACLE_PASS",
  },
  {
    name: "df-s02 silent drop",
    taskId: "df-s02",
    runId: "demo-df-s02",
    expectAccepted: false,
    expectCode: "ORACLE_FAIL",
  },
  {
    name: "df-s02 agent tampers",
    taskId: "df-s02",
    runId: "demo-df-s02",
    tamper: { items: ["update the release notes", "write the incident summary"] },
    expectAccepted: false,
    expectCode: "ORACLE_INPUT_REJECTED",
  },
];

/** The fake agent: drive the mock app through the task, then report what the UI said. */
async function fakeAgentRun(taskId: string, evidenceRoot: string, runId: string): Promise<string> {
  const task = runTask(taskId);
  const desktop = new MockDesktop();
  const session = await desktop.create();
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
  const status = (await desktop.observe()).statusText;
  // Harness, not agent: materialize the mock guest's disk where the gate reads it.
  const storeFile = join(evidenceRoot, runId, task.storePath);
  mkdirSync(dirname(storeFile), { recursive: true });
  writeFileSync(storeFile, await desktop.readFile(session, task.storePath));
  await desktop.destroy();
  return status;
}

export async function runMockDemo(options: { readonly outDir?: string } = {}): Promise<DemoReport> {
  const outDir = options.outDir ?? mkdtempSync(join(tmpdir(), "myco-gate-demo-"));
  const evidenceRoot = join(outDir, "evidence");
  const auditLog = join(outDir, "gate-decisions.jsonl");
  mkdirSync(evidenceRoot, { recursive: true });

  const uiStatus = new Map<string, string>();
  for (const scenario of SCENARIOS) {
    if (!uiStatus.has(scenario.runId)) {
      uiStatus.set(
        scenario.runId,
        await fakeAgentRun(scenario.taskId, evidenceRoot, scenario.runId),
      );
    }
  }

  // The gate runs as its own process, started the way Claude Code starts an MCP server.
  const child = spawn(
    process.execPath,
    ["--import", "tsx", GATE_SCRIPT, "mcp", "--evidence-root", evidenceRoot, "--audit", auditLog],
    { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] },
  );
  const client = mcpStdio(child.stdin, child.stdout);
  const rows: DemoRow[] = [];
  let tools: string[] = [];
  try {
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "myco-gate-demo", version: "0" },
    });
    await client.notify("notifications/initialized");
    const listed = (await client.request("tools/list", {})) as { tools: { name: string }[] };
    tools = listed.tools.map((tool) => tool.name);
    for (const scenario of SCENARIOS) {
      const task = runTask(scenario.taskId);
      const agentClaim = task.agentClaim;
      const called = (await client.request("tools/call", {
        name: GATE_TOOL,
        arguments: {
          taskId: scenario.taskId,
          runId: scenario.runId,
          claim: agentClaim,
          ...scenario.tamper,
        },
      })) as { structuredContent: GateResult };
      const result = called.structuredContent;
      rows.push({
        scenario: scenario.name,
        provenance: "mock",
        uiStatus: uiStatus.get(scenario.runId) ?? "",
        agentClaim,
        verdict: result.verdict,
        accepted: result.accepted,
        reasonCodes: result.reasonCodes,
        harness: result.accepted ? "DONE accepted" : "DONE rejected",
        asExpected:
          result.accepted === scenario.expectAccepted &&
          result.reasonCodes.includes(scenario.expectCode),
      });
    }
  } finally {
    client.close();
    child.stdin.end();
    await new Promise<void>((done) => {
      if (child.exitCode !== null) done();
      else child.once("exit", () => done());
    });
  }
  return {
    ok:
      rows.length === SCENARIOS.length && rows.every((row) => row.asExpected) && tools.length === 1,
    evidenceRoot,
    auditLog,
    tools,
    rows,
  };
}

export function renderDemo(report: DemoReport): string {
  const lines = [
    "# myco-gate mock end-to-end (provenance: mock, no VM, no model)",
    "",
    `gate tools: ${report.tools.join(", ")}`,
    "",
    "| Scenario | UI status | Agent claim | Gate verdict | Reason codes | Harness | As expected |",
    "|---|---|---|---|---|---|---|",
    ...report.rows.map(
      (row) =>
        `| ${row.scenario} | ${row.uiStatus} | ${row.agentClaim} | ${row.verdict} | ${row.reasonCodes.join(", ")} | ${row.harness} | ${row.asExpected ? "yes" : "NO"} |`,
    ),
    "",
    `evidence root: ${report.evidenceRoot}`,
    `decision log: ${report.auditLog}`,
    report.ok ? "DEMO: PASS" : "DEMO: FAIL",
  ];
  return `${lines.join("\n")}\n`;
}
