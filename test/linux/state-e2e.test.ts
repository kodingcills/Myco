/**
 * Capability track I, end to end on the Linux path, $0: a scripted (no-model) client uses the
 * real `myco-state` MCP server, over stdio, against a real live headless Calc, to find and
 * read the cell it then edits; then the gate decides from the persisted bytes it captured.
 *
 *   audit the structured-state arm's launch plan → seal the trial → start live Calc on the
 *   agent's copy → spawn `myco-state mcp` exactly as the plan says → the client reads the
 *   header and key column to locate the target (no ground truth), reads the cell, edits it
 *   through the acting channel, reads it back live (modified: true), saves (modified: false)
 *   → agent stops → capture → the gate's verdict.
 *
 * The second case is the reason the docs say live state is not proof: the client sees its
 * edit in the live state, never saves, and the gate refutes from the saved file.
 *
 * Planted markers (PLANTED_FAKE_MARKER) sit in the pristine fixture, the vault, the oracle
 * config and another trial's dir; no byte the state server writes contains one, nor any of
 * those host paths.
 *
 * Opt-in like linux-path.test.ts: MYCO_LINUX_PATH=1, or MYCO_LINUX_PATH_REQUIRED=1 (the
 * `linux path` CI job), where a missing soffice / Python-UNO FAILS instead of skipping.
 * Without them, or without LibreOffice, it skips cleanly.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerTask } from "../../src/benchmark/gated-rows.ts";
import { createSealedGate, gateGroundTruth } from "../../src/gate/sealed.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { pythonUnoAvailable } from "../../src/linux/actuator.ts";
import { csvToXlsxBytes, sofficeVersion, xlsxToCsvBytes } from "../../src/linux/soffice.ts";
import { auditCapabilityArmLaunch, capabilityArmPlan } from "../../src/state/arms.ts";
import { startLiveCalc } from "../../src/state/linux/live-calc.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies are read loosely in tests
type Json = any;

const ROOT = resolve(import.meta.dirname, "..", "..");
const MARKER = "PLANTED_FAKE_MARKER";
const required = process.env.MYCO_LINUX_PATH_REQUIRED === "1";
const optedIn = required || process.env.MYCO_LINUX_PATH === "1";
const available = optedIn && sofficeVersion() !== null && pythonUnoAvailable();
const TIMEOUT = 180_000;

describe("prerequisites (structured state)", () => {
  it.runIf(required)("soffice and Python-UNO are installed (MYCO_LINUX_PATH_REQUIRED=1)", () => {
    expect(sofficeVersion(), "soffice --version").not.toBeNull();
    expect(pythonUnoAvailable(), "python3 -c 'import uno'").toBe(true);
  });
});

/** A minimal scripted MCP client over a child's stdio; records every byte the server sent. */
class ScriptedClient {
  private next = 1;
  private readonly waiting = new Map<number, (msg: Json) => void>();
  readonly wire: string[] = [];
  readonly stderr: string[] = [];
  calls = 0;
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      this.wire.push(line);
      const msg = JSON.parse(line) as { id: number };
      this.waiting.get(msg.id)?.(msg);
      this.waiting.delete(msg.id);
    });
    child.stderr.on("data", (c: Buffer) => this.stderr.push(c.toString("utf8")));
  }
  request(method: string, params: object = {}): Promise<Json> {
    const id = this.next++;
    return new Promise((done) => {
      this.waiting.set(id, done);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async tool(name: string, args: object = {}): Promise<Json> {
    this.calls += 1;
    const reply = await this.request("tools/call", { name, arguments: args });
    return reply.result.structuredContent;
  }
  async close(): Promise<void> {
    const exited = new Promise((done) => this.child.once("exit", done));
    this.child.stdin.end();
    await exited;
  }
}

describe.skipIf(!available)("structured state against a live headless Calc", () => {
  let base: string;
  let layout: Record<string, string>;
  beforeAll(() => {
    // Spaces in the host path, like the round-1 verifier's probe: a file URL or path with
    // spaces must not slip past the scrubber or the withheld list.
    base = mkdtempSync(join(tmpdir(), "myco state e2e-"));
    layout = {
      runs: join(base, "runs"),
      vault: join(base, "vault"),
      oracle: join(base, "oracle"),
      other: join(base, "runs", "run-other", "agent"),
    };
    for (const d of [layout.runs, layout.oracle, layout.other])
      mkdirSync(d as string, { recursive: true });
    writeFileSync(
      join(layout.oracle as string, "config.json"),
      JSON.stringify({ expected: `${MARKER}-oracle` }),
    );
    writeFileSync(join(layout.other as string, "saved.csv"), `id,name\nEMP-0007,${MARKER}-other\n`);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  async function trial(runId: string, save: boolean) {
    const params = {
      fixtureSeed: "linux-path",
      rowKey: "EMP-0007",
      column: "name",
      newValue: "STATE-I-0007",
    };
    const trialDir = join(layout.runs as string, runId);
    const agentDir = join(trialDir, "agent");
    const fixtureDir = join(trialDir, "fixture");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(fixtureDir, { recursive: true });
    const fixture = generateFixture(params.fixtureSeed);
    const pristine = join(fixtureDir, "fixture.csv");
    writeFileSync(pristine, fixture.csv);
    const docPath = join(agentDir, "saved.xlsx");
    writeFileSync(docPath, csvToXlsxBytes(pristine));
    // The pristine copy gets a marker only after the agent's copy was made from it.
    writeFileSync(pristine, `${fixture.csv}EMP-9999,${MARKER}-pristine,0,2024-01-01,$0.00\n`);

    // Seal the trial; the gate is bound to it and reads only what the harness captures.
    const reg = registerTask({
      taskId: `cap-i-${runId}`,
      fixtureSeed: params.fixtureSeed,
      intent: params,
    });
    if (!reg.ok) throw new Error(reg.reason);
    const task = reg.registry.get(`cap-i-${runId}`);
    if (!task) throw new Error("task missing");
    const vaultRoot = join(layout.vault as string, runId);
    const vault = new VerdictVault({ root: vaultRoot, key: newVaultKey(), agentRoots: [agentDir] });
    const receipt = vault.seal(runId, {
      groundTruth: gateGroundTruth(task),
      fixtures: {},
      oracle: {
        id: `${task.family.id}@${task.family.version}`,
        sourceFiles: [join(ROOT, "src", "gate", "families.ts")],
      },
    });
    writeFileSync(join(layout.vault as string, `${runId}.${MARKER}.txt`), `${MARKER}-vault`);
    const gate = createSealedGate({
      tasks: reg.registry,
      vault,
      binding: { runId, receipt },
      taskId: task.id,
    });

    const live = await startLiveCalc({ docPath, runId });
    const withheld = [
      base,
      trialDir,
      fixtureDir,
      vaultRoot,
      layout.oracle as string,
      layout.other as string,
    ];
    const plan = capabilityArmPlan({
      arm: "structured-state",
      runId,
      instruction: `Set record ${params.rowKey}, column ${params.column}, to "${params.newValue}" and save.`,
      configDir: trialDir,
      stateServer: {
        command: join(ROOT, "node_modules", ".bin", "tsx"),
        args: [join(ROOT, "scripts", "myco-state.ts"), "mcp"],
      },
      statePipe: live.pipe,
      withheld,
    });
    const audit = auditCapabilityArmLaunch(plan, { arm: "structured-state", runId, trialDir });
    expect(audit.violations).toEqual([]);

    const server = plan.mcpServers["myco-state"];
    if (!server) throw new Error("no state server in the plan");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...server.env,
    };
    if (process.env.MYCO_PYTHON) env.MYCO_PYTHON = process.env.MYCO_PYTHON;
    const child = spawn(server.command, [...server.args], { env, stdio: ["pipe", "pipe", "pipe"] });
    const client = new ScriptedClient(child);
    const trace: Record<string, unknown> = {};
    try {
      const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
      expect(init.result.serverInfo.name).toBe("myco-state");
      const tools = await client.request("tools/list");
      expect(tools.result.tools.map((t: { name: string }) => t.name)).toHaveLength(4);

      // Locate the target from the app's own state: header row, then the key column.
      const sheets = await client.tool("state_list_sheets");
      expect(sheets.ok).toBe(true);
      const used = sheets.data.sheets[0].usedRange as string;
      const lastRow = Number(/(\d+)$/.exec(used)?.[1]);
      const header = await client.tool("state_read_range", { range: "A1:F1" });
      const col = (header.data.rows[0] as Array<{ value: unknown; ref: string }>).find(
        (c) => c.value === params.column,
      );
      const keys = await client.tool("state_read_range", { range: `A2:A${lastRow}` });
      const keyCell = (keys.data.rows as Array<Array<{ value: unknown; ref: string }>>).find(
        (r) => r[0]?.value === params.rowKey,
      )?.[0];
      if (!col || !keyCell) throw new Error("target not found in live state");
      const ref = `${col.ref.replace(/\d+$/, "")}${keyCell.ref.replace(/^[A-Z]+/, "")}`;
      trace.ref = ref;

      const before = await client.tool("state_read_range", { range: ref });
      trace.before = before.data.rows[0][0].value;
      expect(trace.before).not.toBe(params.newValue);
      expect((await client.tool("state_document_status")).data.modified).toBe(false);

      // Act through the arm's acting channel, then read the same cell back from live state.
      expect(live.type(ref, params.newValue).ok).toBe(true);
      const after = await client.tool("state_read_range", { range: ref });
      trace.after = after.data.rows[0][0].value;
      expect(trace.after).toBe(params.newValue);
      trace.modifiedAfterEdit = (await client.tool("state_document_status")).data.modified;
      expect(trace.modifiedAfterEdit).toBe(true);

      if (save) {
        expect(live.save().ok).toBe(true);
        trace.modifiedAfterSave = (await client.tool("state_document_status")).data.modified;
        expect(trace.modifiedAfterSave).toBe(false);
      }
      // The UI tree is "where available" (docs/state/tools.md): a headless soffice without an
      // accessibility implementation answers UI_TREE_UNAVAILABLE, a code, never a crash. Any
      // other outcome fails, and the message carries the code and the operator's diagnostics.
      const tree = await client.tool("state_ui_tree", { maxDepth: 2, maxNodes: 20 });
      trace.treeCode = tree.ok ? "ok" : tree.code;
      expect(
        trace.treeCode,
        `state_ui_tree gave ${JSON.stringify(trace.treeCode)}; server stderr: ${client.stderr.join("").slice(-1500)}`,
      ).toMatch(/^(ok|UI_TREE_UNAVAILABLE)$/);
      if (tree.ok) expect(tree.data.nodes).toBeLessThanOrEqual(20);

      // The document's host path, re-spelled and pasted as a plain value (no formula):
      // separators swapped and the leading `/` cut (round-2 D5). Withheld by the
      // separator-insensitive match against the withheld list.
      const respelled = `${trialDir.slice(1).replace(/\//g, "|")}|saved.xlsx`;
      expect(live.type("H4", respelled).ok).toBe(true);
      const pasted = await client.tool("state_read_range", { range: "H4" });
      trace.pastedPath = pasted.ok ? pasted.data.rows[0][0] : pasted.code;
      expect(trace.pastedPath, JSON.stringify(trace.pastedPath)).toBe("OUTPUT_WITHHELD");
      expect((await client.tool("state_read_range", { range: "A1" })).ok).toBe(true);

      // A formula that surfaces the document's host path (round-1 D2), and a second formula
      // that re-spells it (round-2 D5, the verifier's probe). While any CELL/INFO formula is
      // in the document, every cell read is withheld, including cells that never touch it.
      expect(live.type("H2", '=CELL("filename")').ok).toBe(true);
      const probe = await client.tool("state_read_range", { range: "H2" });
      trace.cellFilename = probe.ok ? probe.data.rows[0][0] : probe.code;
      expect(trace.cellFilename, JSON.stringify(trace.cellFilename)).toBe("OUTPUT_WITHHELD");
      expect(live.type("H3", "=MID(H2;10;300)").ok).toBe(true);
      const mid = await client.tool("state_read_range", { range: "H3" });
      trace.midFilename = mid.ok ? mid.data.rows[0][0] : mid.code;
      expect(trace.midFilename, JSON.stringify(trace.midFilename)).toBe("OUTPUT_WITHHELD");
      const innocuous = await client.tool("state_read_range", { range: "A1" });
      expect(innocuous.ok ? "ok" : innocuous.code).toBe("OUTPUT_WITHHELD");
      const treeTainted = await client.tool("state_ui_tree", { maxDepth: 2, maxNodes: 20 });
      expect(treeTainted.ok ? "ok" : treeTainted.code).toMatch(
        /^(OUTPUT_WITHHELD|UI_TREE_UNAVAILABLE)$/,
      );
      // The sheet list and save state stay readable (no cell text in them).
      expect((await client.tool("state_document_status")).ok).toBe(true);
      // A hostile call: the server answers with a code, nothing else.
      expect(
        await client.tool("state_read_range", { range: "A1", path: join(vaultRoot, "x") }),
      ).toMatchObject({ code: "UNKNOWN_FIELD" });
    } finally {
      await client.close();
      await live.stop();
    }

    // The agent stopped: capture the persisted bytes, and the gate decides from them alone.
    vault.markAgentStopped(runId);
    vault.capture(runId, { "persisted/doc.csv": new Uint8Array(xlsxToCsvBytes(docPath)) });
    const verdict = await gate.check({ taskId: task.id, runId });

    const everything = [...client.wire, ...client.stderr].join("\n");
    expect(everything).not.toContain(MARKER);
    for (const p of withheld) expect(client.wire.join("\n")).not.toContain(p);
    return { verdict, trace, calls: client.calls };
  }

  it(
    "a scripted client reads the cell it then edits; the gate verifies from the captured file",
    async () => {
      const { verdict, trace, calls } = await trial("run-state-honest", true);
      expect(trace.ref).toBe("B8");
      expect(verdict.verdict).toBe("verified");
      expect(calls).toBeGreaterThanOrEqual(8);
    },
    TIMEOUT,
  );

  it(
    "live state shows the edit, the client never saves, and the gate refutes (state is not proof)",
    async () => {
      const { verdict, trace } = await trial("run-state-unsaved", false);
      expect(trace.after).toBe("STATE-I-0007");
      expect(trace.modifiedAfterEdit).toBe(true);
      expect(verdict.verdict).toBe("refuted");
    },
    TIMEOUT,
  );
});
