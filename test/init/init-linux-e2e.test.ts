/**
 * `myco init` end to end on the Linux path (TIF-265 track D, scope addition 7194951511).
 *
 * One chain, no model, no VM, $0:
 *   1. `bin/myco init` WITHOUT --skip-desktop detects and attaches the headless Linux Calc
 *      path (real soffice, real Python-UNO), starts the real gate once, and writes the
 *      project-local configs (`.mcp.json`, `.codex/config.toml`);
 *   2. the WRITTEN configs are parsed: the evidence root, task, run and tasks file all come
 *      from the args init wrote, not from this test;
 *   3. the existing Linux path drives a real headless LibreOffice Calc: the same fixture
 *      (`generateFixture`), the same scripted agents (`planFor`: honest, wrong-row,
 *      skips-save) and the same actuator (`calcActuator`, scripts/linux/calc_actuator.py)
 *      the `myco-linux --demo` run uses. Calc opens the fixture CSV that sits at
 *      `<evidence-root>/<run>/<stateFile>`, types the edit, and saves (or not), so the
 *      persisted bytes the gate reads are exactly the bytes Calc wrote (the gate stays
 *      CSV-only for Calc);
 *   4. the official MCP client (`@modelcontextprotocol/sdk`) spawns the server exactly from
 *      each written config (command and args as written, environment `PATH` alone) and calls
 *      `myco_gate_check` with only taskId/runId/claim;
 *   5. the verdict must be real: `verified` / ORACLE_PASS for the honest edit, `refuted` with
 *      oracle codes for the wrong row and for the edit that was never saved.
 *
 * Opt-in like test/linux/linux-path.test.ts: it runs with MYCO_LINUX_PATH=1 or
 * MYCO_LINUX_PATH_REQUIRED=1 (the `linux path` CI job, where it has its own step) and skips
 * without soffice or Python-UNO, except under MYCO_LINUX_PATH_REQUIRED=1, where a missing
 * prerequisite FAILS. The run's transcript is printed, and written to
 * $MYCO_INIT_E2E_TRANSCRIPT when that is set (CI uploads it with the linux-path runs).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { calcActuator, pythonUnoAvailable } from "../../src/linux/actuator.ts";
import { planFor, type ScriptedAgent } from "../../src/linux/agent.ts";
import { DEMO_TASK } from "../../src/linux/run.ts";
import { sofficeVersion } from "../../src/linux/soffice.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const required = process.env.MYCO_LINUX_PATH_REQUIRED === "1";
const optedIn = required || process.env.MYCO_LINUX_PATH === "1";
const available =
  optedIn && process.platform === "linux" && sofficeVersion() !== null && pythonUnoAvailable();
// Assembled so that this file never carries a key-shaped literal.
const MARKER = ["MYCO", "FAKE", "SECRET", "e2e", "51d3"].join("-");
const TASK_ID = "linux-calc-edit";
const RUN_ID = "e2e";
const STATE_FILE = "saved.csv";

interface Scenario {
  readonly agent: ScriptedAgent;
  readonly verdict: "verified" | "refuted";
  readonly codes: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
  // CLAIM_RECORDED: the claim was logged; it never feeds the verdict.
  { agent: "honest", verdict: "verified", codes: ["ORACLE_PASS", "CLAIM_RECORDED"] },
  {
    agent: "wrong-row",
    verdict: "refuted",
    codes: ["ORACLE_FAIL", "TARGET_MISMATCH", "DOCUMENT_COLLATERAL", "CLAIM_RECORDED"],
  },
  {
    agent: "skips-save",
    verdict: "refuted",
    codes: ["ORACLE_FAIL", "TARGET_MISMATCH", "CLAIM_RECORDED"],
  },
];

interface ServerEntry {
  readonly command: string;
  readonly args: readonly string[];
}

function argAfter(args: readonly string[], flag: string): string {
  const at = args.indexOf(flag);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined) throw new Error(`written config has no ${flag}`);
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under `dir` (relative path → sha256), to show what a step changed. */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = sha256(readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/** The official MCP client, spawning the server exactly as the written config says. */
async function gateCheck(
  entry: ServerEntry,
  request: { taskId: string; runId: string; claim: string },
): Promise<{ tools: string[]; result: Record<string, unknown> }> {
  const transport = new StdioClientTransport({
    command: entry.command,
    args: [...entry.args],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stderr: "pipe",
  });
  const client = new Client({ name: "myco-init-e2e", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const call = await client.callTool({ name: "myco_gate_check", arguments: request });
    return { tools, result: call.structuredContent as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

describe("myco init, end to end on the Linux path", () => {
  it.runIf(required)("soffice and Python-UNO are installed (MYCO_LINUX_PATH_REQUIRED=1)", () => {
    expect(process.platform).toBe("linux");
    expect(sofficeVersion(), "soffice --version must name LibreOffice").not.toBeNull();
    expect(pythonUnoAvailable(), "python3 -c 'import uno' must succeed").toBe(true);
  });

  it.skipIf(!available)(
    "init attaches headless Calc and writes the configs; a scripted MCP client gets real verdicts through them",
    async () => {
      const log: string[] = [];
      const say = (line = "") => log.push(line);
      const base = realpathSync(mkdtempSync(join(tmpdir(), "myco-init-e2e-")));
      const home = join(base, "home");
      const project = join(base, "project");
      mkdirSync(home);
      mkdirSync(project);
      writeFileSync(
        join(project, "tasks.json"),
        `${JSON.stringify(
          {
            tasks: [
              {
                id: TASK_ID,
                title: "Linux path demo edit (calc-record-edit)",
                family: "calc-record-edit",
                stateFile: STATE_FILE,
                spec: { ...DEMO_TASK },
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      // 1. One command, desktop check included (no --skip-desktop). A planted fake marker
      //    sits in the environment next to the names init reads.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        ANTHROPIC_API_KEY: MARKER,
        MYCO_FAKE_SECRET: MARKER,
      };
      for (const name of ["MYCO_PYTHON", "MYCO_SOFFICE"] as const) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const argv = ["init", "--task", TASK_ID, "--run", RUN_ID, "--tasks", "tasks.json"];
      say(`$ bin/myco ${argv.join(" ")}    (cwd: <project>, HOME: <temp home>)`);
      const init = spawnSync(join(REPO, "bin", "myco"), argv, {
        cwd: project,
        encoding: "utf8",
        env,
        timeout: 180_000,
      });
      const initText = `${init.stdout}${init.stderr}`;
      say(initText.replaceAll(base, "<tmp>").replaceAll(REPO, "<repo>").trimEnd());
      say(`(exit ${String(init.status)})`);
      expect(init.status, initText).toBe(0);
      expect(initText).toMatch(/ok {2}soffice \(.*\): LibreOffice/);
      expect(initText).toContain("ok  python-uno");
      expect(initText).toContain("attached:");
      expect(initText).toContain("a call naming another task: uncertain / ASSIGNMENT_MISMATCH");
      expect(initText).toContain("myco init: done");
      expect(initText).not.toContain(MARKER);
      expect(readdirSync(home)).toEqual([]); // HOME untouched
      expect(Object.keys(files(project)).sort()).toEqual([
        ".codex/config.toml",
        ".mcp.json",
        "tasks.json",
      ]);

      // 2. Parse the WRITTEN configs; everything below comes from them.
      const mcpJson = readFileSync(join(project, ".mcp.json"), "utf8");
      const codexToml = readFileSync(join(project, ".codex", "config.toml"), "utf8");
      expect(mcpJson + codexToml).not.toContain(MARKER);
      const claude = JSON.parse(mcpJson).mcpServers["myco-gate"] as ServerEntry & {
        type: string;
      };
      const codex = (
        parseToml(codexToml) as unknown as { mcp_servers: Record<string, ServerEntry> }
      ).mcp_servers["myco-gate"] as ServerEntry;
      expect(Object.keys(claude).sort()).toEqual(["args", "command", "type"]); // no env
      expect(Object.keys(codex).sort()).toEqual(["args", "command"]);
      expect({ command: codex.command, args: codex.args }).toEqual({
        command: claude.command,
        args: claude.args,
      });
      const evidenceRoot = argAfter(claude.args, "--evidence-root");
      const taskId = argAfter(claude.args, "--task");
      const runId = argAfter(claude.args, "--run");
      const tasksFile = argAfter(claude.args, "--tasks");
      expect(evidenceRoot).toBe(join(project, ".myco", "evidence"));
      expect([taskId, runId, tasksFile]).toEqual([TASK_ID, RUN_ID, join(project, "tasks.json")]);
      const stateFile = (
        JSON.parse(readFileSync(tasksFile, "utf8")) as { tasks: { stateFile: string }[] }
      ).tasks[0]?.stateFile as string;
      const statePath = join(evidenceRoot, runId, stateFile);
      say();
      say("written .mcp.json → myco-gate:");
      say(`  command: ${claude.command.replaceAll(base, "<tmp>").replaceAll(REPO, "<repo>")}`);
      say(
        `  args:    ${claude.args.map((a) => a.replaceAll(base, "<tmp>").replaceAll(REPO, "<repo>")).join(" ")}`,
      );
      say("written .codex/config.toml → [mcp_servers.myco-gate]: same command and args");
      say(`persisted state the gate reads: ${statePath.replaceAll(base, "<tmp>")}`);

      const fixture = generateFixture(DEMO_TASK.fixtureSeed);
      for (const scenario of SCENARIOS) {
        // 3. Drive the Linux path: real headless Calc edits the file under the evidence root.
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, fixture.csv);
        const plan = planFor(scenario.agent, { ...DEMO_TASK }, fixture.dataRows);
        const report = calcActuator().act(statePath, plan.cell, plan.value, plan.save);
        expect(report.ok, JSON.stringify(report)).toBe(true);
        expect(report.after).toBe(plan.value); // Calc showed the typed value either way
        const persisted = readFileSync(statePath);
        // The honest and wrong-row agents saved: Calc rewrote the file. skips-save did not.
        expect(persisted.equals(Buffer.from(fixture.csv)), scenario.agent).toBe(!plan.save);
        say();
        say(
          `== ${scenario.agent}: Calc typed "${plan.value}" into ${plan.cell}; ${plan.save ? "saved" : "did NOT save"}`,
        );
        say(`   claim: ${plan.claim}`);
        say(`   persisted ${stateFile}: ${persisted.length} bytes, sha256 ${sha256(persisted)}`);

        // 4–5. The scripted client, through each written config.
        for (const [label, entry] of [
          [".mcp.json", claude],
          [".codex/config.toml", codex],
        ] as const) {
          const { tools, result } = await gateCheck(entry, { taskId, runId, claim: plan.claim });
          expect(tools).toEqual(["myco_gate_check"]);
          expect(result.apiVersion).toBe("myco.gate/v1");
          expect(result.verdict, JSON.stringify(result)).toBe(scenario.verdict);
          expect(result.accepted).toBe(scenario.verdict === "verified");
          expect(result.reasonCodes).toEqual(scenario.codes);
          expect(result.request).toEqual({ taskId, runId, claim: plan.claim });
          // Bound to the bytes Calc persisted for this trial.
          const ref = (result.evidenceRefs as { path: string; sha256: string }[])[0];
          expect(ref).toMatchObject({ path: stateFile, sha256: sha256(persisted) });
          say(
            `   via ${label.padEnd(18)} myco_gate_check → ${String(result.verdict)} [${(result.reasonCodes as string[]).join(", ")}]`,
          );
          if (label === ".mcp.json")
            for (const reason of result.reasons as string[]) say(`     - ${reason}`);
        }
      }
      expect(readdirSync(home)).toEqual([]);
      say();
      say("all scenarios produced their expected verdict through the written configs");

      const transcript = `${log.join("\n")}\n`;
      process.stdout.write(`\n----- myco init end-to-end transcript -----\n${transcript}`);
      const out = process.env.MYCO_INIT_E2E_TRANSCRIPT;
      if (out !== undefined && out !== "") {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, transcript);
      }
    },
    300_000,
  );
});
