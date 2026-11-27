/**
 * The newcomer path, live (TIF-265 track D): clone, follow the docs, reach a working gate
 * on the Linux path, timed. Opt-in: runs with MYCO_NEWCOMER_PATH=1, and under
 * MYCO_NEWCOMER_PATH_REQUIRED=1 (the `newcomer path (ubuntu-latest)` CI job) a missing
 * prerequisite FAILS instead of skipping. $0: no model, no API, no secrets, no VM.
 *
 * Every command comes from a block marked `<!-- newcomer-path: name -->` in the docs
 * (newcomer-lib.ts); this file adds none. It runs them in order, as written:
 *
 *   1. linux-path.md `clone` (from <base>): git clone, cd myco, pnpm install, myco-linux --check.
 *      The one rewrite: the clone URL points at this checkout's HEAD (the commit under test);
 *   2. setup.md `setup` (from the clone): --dry-run must write nothing; init must print the
 *      four documented steps and write exactly .mcp.json and .codex/config.toml;
 *   3. README `readme-quickstart` (from the project): run again, must change no byte;
 *   4. setup.md `linux` (from the project): rebinds the gate to the shipped Linux task; then a
 *      SIMULATED task: the Linux path's scripted agents drive real headless Calc on the file
 *      under the written evidence root, and the official MCP client, spawned exactly from
 *      the written .mcp.json (environment PATH alone), must get `verified` for `honest` and
 *      `refuted` for `skips-save`.
 *
 * Commands get PATH, a fresh empty HOME, the documented MYCO_PYTHON / MYCO_SOFFICE overrides
 * and proxy settings (names passed through, values never printed). A non-zero exit, an
 * undocumented placeholder or a missing step fails the run: a newcomer would have had to do
 * something the docs do not say. Each command is timed; clone to the first verified verdict
 * must fit MYCO_NEWCOMER_BUDGET_S (default 600). The report (commands with the temp paths
 * masked, exit codes, durations, verdicts) is printed and written to $MYCO_NEWCOMER_REPORT.
 * The verdicts are SIMULATED and never evidence.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
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
import { describe, expect, it } from "vitest";
import { calcActuator, pythonUnoAvailable } from "../../src/linux/actuator.ts";
import { planFor, type ScriptedAgent } from "../../src/linux/agent.ts";
import { sofficeVersion } from "../../src/linux/soffice.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import type { CalcRecordEditParams } from "../../src/tasks/intent.ts";
import { documentedSteps, initArgv, markedBlock, stepHeaders, substitute } from "./newcomer-lib.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const CLONE_URL = "https://github.com/kodingcills/Myco.git";
const required = process.env.MYCO_NEWCOMER_PATH_REQUIRED === "1";
const optedIn = required || process.env.MYCO_NEWCOMER_PATH === "1";
const available =
  optedIn && process.platform === "linux" && sofficeVersion() !== null && pythonUnoAvailable();
const budgetS = Number(process.env.MYCO_NEWCOMER_BUDGET_S ?? "600");
/** Passed through by name only when set: documented overrides and network plumbing. */
const PASS_THROUGH = [
  "MYCO_PYTHON",
  "MYCO_SOFFICE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

interface Step {
  readonly block: string;
  readonly command: string;
  readonly cwd: string;
  readonly exit: number | null;
  readonly ms: number;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Relative path → sha256 of every file under `dir` (empty when it does not exist). */
function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
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

function argAfter(args: readonly string[], flag: string): string {
  const v = args[args.indexOf(flag) + 1];
  if (!args.includes(flag) || v === undefined) throw new Error(`written config has no ${flag}`);
  return v;
}

describe("newcomer path: clone, follow the docs, reach a working gate (Linux)", () => {
  it.runIf(required)("soffice and Python-UNO are installed (MYCO_NEWCOMER_PATH_REQUIRED=1)", () => {
    expect(process.platform).toBe("linux");
    expect(sofficeVersion(), "soffice --version must name LibreOffice").not.toBeNull();
    expect(pythonUnoAvailable(), "python3 -c 'import uno' must succeed").toBe(true);
  });

  it.skipIf(!available)(
    "every documented command succeeds as written, and the written config gives real verdicts",
    async () => {
      const t0 = Date.now();
      const base = realpathSync(mkdtempSync(join(tmpdir(), "myco-newcomer-")));
      const home = join(base, "home");
      const myco = join(base, "myco"); // linux-path.md: `git clone ... myco`
      const project = join(base, "project"); // "your project": an existing, empty directory
      mkdirSync(home);
      mkdirSync(project);
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
      for (const name of PASS_THROUGH) {
        const v = process.env[name];
        if (v !== undefined && v !== "") env[name] = v;
      }
      const mask = (s: string) => s.replaceAll(base, "<tmp>").replaceAll(REPO, "<checkout>");
      const log: string[] = [];
      const say = (line = "") => log.push(line);
      const steps: Step[] = [];

      say(
        `newcomer path @ ${spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()}`,
      );
      say(`environment names: ${Object.keys(env).sort().join(", ")} (HOME is a fresh empty dir)`);
      let firstVerifiedS: number | null = null;
      const verdicts: { agent: string; verdict: string; reasonCodes: string[] }[] = [];
      let completed = false;
      try {
        /**
         * Run one documented block's commands, in order, from `start`. `cd` moves the cwd (and
         * the directory must exist); every other line runs as written under bash. `after(i)`
         * runs right after command i. Returns each command's output and the final cwd.
         */
        const runBlock = (
          label: string,
          commands: readonly string[],
          start: string,
          after?: (i: number) => void,
        ): { outs: string[]; cwd: string } => {
          let cwd = start;
          const outs: string[] = [];
          say();
          say(`== ${label}`);
          commands.forEach((written, i) => {
            // The only rewrite besides the documented placeholders: clone the commit under test.
            const command = substitute(written, { myco, project }).replace(
              CLONE_URL,
              `file://${REPO}`,
            );
            const cd = /^cd (\S+)$/.exec(command);
            const began = Date.now();
            let exit: number | null = 0;
            let text = "";
            if (cd) {
              cwd = resolve(cwd, cd[1] as string);
              if (!existsSync(cwd)) exit = 1;
            } else {
              const r = spawnSync("bash", ["-c", command], {
                cwd,
                env,
                encoding: "utf8",
                timeout: 600_000,
              });
              exit = r.status;
              text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
            }
            const ms = Date.now() - began;
            steps.push({ block: label, command: mask(command), cwd: mask(cwd), exit, ms });
            say(`$ ${mask(written)}    (exit ${String(exit)}, ${(ms / 1000).toFixed(1)} s)`);
            if (command !== substitute(written, { myco, project }))
              say(`  (ran as: ${mask(command)}: the commit under test)`);
            expect(exit, `${written}\n${mask(text).slice(-4000)}`).toBe(0);
            outs.push(text);
            after?.(i);
          });
          return { outs, cwd };
        };
        const docBlock = (doc: string, name: string) => ({
          label: `${doc} <!-- newcomer-path: ${name} -->`,
          commands: markedBlock(readFileSync(join(myco, doc), "utf8"), name),
        });

        // 1. linux-path.md §2, from <base>. The clone does not exist yet, so this one block is
        //    read from the checkout; the clone is byte-identical at HEAD (asserted below).
        const cloneCommands = markedBlock(
          readFileSync(join(REPO, "docs/product/linux-path.md"), "utf8"),
          "clone",
        );
        expect(cloneCommands[0]).toBe(`git clone ${CLONE_URL} myco`);
        const cloned = runBlock(
          "docs/product/linux-path.md <!-- newcomer-path: clone -->",
          cloneCommands,
          base,
        );
        expect(cloned.cwd).toBe(myco);
        const head = (dir: string) =>
          spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
        expect(head(myco)).toBe(head(REPO));
        expect(
          spawnSync("git", ["-C", myco, "status", "--porcelain"], { encoding: "utf8" }).stdout,
        ).toBe("");

        // 2. setup.md quickstart, from the clone.
        const setupMd = readFileSync(join(myco, "docs/product/setup.md"), "utf8");
        const setup = docBlock("docs/product/setup.md", "setup");
        const setupCommands = setup.commands;
        const dryAt = setupCommands.findIndex((c) => initArgv(c)?.includes("--dry-run"));
        const realAt = setupCommands.findIndex((c) => {
          const a = initArgv(c);
          return a !== null && !a.includes("--dry-run");
        });
        expect(dryAt, "setup.md block has a --dry-run init").toBeGreaterThanOrEqual(0);
        expect(realAt, "setup.md block has a writing init after the dry run").toBeGreaterThan(
          dryAt,
        );
        const setupOut = runBlock(setup.label, setupCommands, myco, (i) => {
          // `--dry-run` writes nothing: the project is still empty right after it.
          if (i === dryAt) expect(files(project), "--dry-run wrote into the project").toEqual({});
        }).outs;
        const realOut = setupOut[realAt] as string;
        const headers = stepHeaders(realOut);
        const documented = documentedSteps(setupMd);
        expect(headers.map((h) => h.n)).toEqual(documented.map((d) => d.n));
        for (const d of documented) {
          const h = headers.find((x) => x.n === d.n);
          expect(h?.title.startsWith(d.title), `step ${d.n}: ${h?.title}`).toBe(true);
          expect(h?.total).toBe(documented.length);
        }
        expect(realOut).toContain("myco init: done");
        expect(realOut).toContain("create, new file");
        expect(Object.keys(files(project)).sort()).toEqual([".codex/config.toml", ".mcp.json"]);
        // Nothing user-level was touched: HOME holds only what pnpm and git cache.
        for (const n of [".claude", ".claude.json", ".codex"])
          expect(existsSync(join(home, n))).toBe(false);

        // 3. README quickstart from the project: a second run changes no byte.
        const before = files(project);
        const quick = docBlock("README.md", "readme-quickstart");
        const readmeOut = runBlock(quick.label, quick.commands, project).outs;
        expect(files(project)).toEqual(before);
        expect(readmeOut.at(-1)).toContain("unchanged");

        // 4. Linux path: rebind to the shipped task, then the simulated task.
        const linux = docBlock("docs/product/setup.md", "linux");
        runBlock(linux.label, linux.commands, project);
        const mcp = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")) as {
          mcpServers: Record<string, { command: string; args: string[] }>;
        };
        const entry = mcp.mcpServers["myco-gate"];
        expect(entry, "written .mcp.json has myco-gate").toBeDefined();
        if (entry === undefined) return;
        expect(entry.command.startsWith(myco), "the gate runs from the fresh clone").toBe(true);
        const taskId = argAfter(entry.args, "--task");
        const runId = argAfter(entry.args, "--run");
        const evidenceRoot = argAfter(entry.args, "--evidence-root");
        const tasksFile = argAfter(entry.args, "--tasks");
        expect(evidenceRoot).toBe(join(project, ".myco", "evidence"));
        const task = (
          JSON.parse(readFileSync(tasksFile, "utf8")) as {
            tasks: { id: string; stateFile: string; spec: CalcRecordEditParams }[];
          }
        ).tasks.find((t) => t.id === taskId);
        expect(task, `${taskId} in ${tasksFile}`).toBeDefined();
        if (task === undefined) return;
        const statePath = join(evidenceRoot, runId, task.stateFile);
        say();
        say(`== simulated task (SIMULATED: scripted agent, no model, not evidence)`);
        say(`gate: ${mask(entry.command)} ${entry.args.map(mask).join(" ")}`);

        const fixture = generateFixture(task.spec.fixtureSeed);
        const scenarios: { agent: ScriptedAgent; verdict: string }[] = [
          { agent: "honest", verdict: "verified" },
          { agent: "skips-save", verdict: "refuted" },
        ];
        for (const s of scenarios) {
          mkdirSync(dirname(statePath), { recursive: true });
          writeFileSync(statePath, fixture.csv);
          const plan = planFor(s.agent, { ...task.spec }, fixture.dataRows);
          const report = calcActuator().act(statePath, plan.cell, plan.value, plan.save);
          expect(report.ok, JSON.stringify(report)).toBe(true);
          const persisted = readFileSync(statePath);
          const transport = new StdioClientTransport({
            command: entry.command,
            args: [...entry.args],
            env: { PATH: env.PATH as string },
            stderr: "pipe",
          });
          const client = new Client({ name: "myco-newcomer", version: "0.1.0" });
          await client.connect(transport);
          let result: Record<string, unknown>;
          try {
            const tools = (await client.listTools()).tools.map((t) => t.name);
            expect(tools).toEqual(["myco_gate_check"]);
            const call = await client.callTool({
              name: "myco_gate_check",
              arguments: { taskId, runId, claim: plan.claim },
            });
            result = call.structuredContent as Record<string, unknown>;
          } finally {
            await client.close();
          }
          const codes = result.reasonCodes as string[];
          verdicts.push({ agent: s.agent, verdict: String(result.verdict), reasonCodes: codes });
          say(`${s.agent.padEnd(10)} → ${String(result.verdict)} [${codes.join(", ")}]`);
          expect(result.verdict, JSON.stringify(result)).toBe(s.verdict);
          expect(result.accepted).toBe(s.verdict === "verified");
          const ref = (result.evidenceRefs as { path: string; sha256: string }[])[0];
          expect(ref).toMatchObject({ path: task.stateFile, sha256: sha256(persisted) });
          if (s.verdict === "verified" && firstVerifiedS === null)
            firstVerifiedS = (Date.now() - t0) / 1000;
        }
        completed = true;
      } finally {
        // Written whether the run passed or failed, so a failing CI run still shows which
        // documented command broke and how long each one took.
        const totalS = (Date.now() - t0) / 1000;
        say();
        say(
          `clone → first verified verdict: ${firstVerifiedS === null ? "none" : `${firstVerifiedS.toFixed(1)} s`} (budget ${budgetS} s); total ${totalS.toFixed(1)} s${completed ? "" : "; INCOMPLETE"}`,
        );
        const report = {
          schema: "myco.newcomer-path/1",
          simulated: true,
          completed,
          budgetS,
          firstVerifiedS,
          totalS,
          steps,
          verdicts,
        };
        process.stdout.write(`\n----- newcomer path -----\n${log.join("\n")}\n`);
        const out = process.env.MYCO_NEWCOMER_REPORT;
        if (out !== undefined && out !== "") {
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
          writeFileSync(out.replace(/\.json$/, ".txt"), `${log.join("\n")}\n`);
        }
      }
      expect(firstVerifiedS).not.toBeNull();
      expect(
        firstVerifiedS as number,
        "clone → first verified verdict within budget",
      ).toBeLessThanOrEqual(budgetS);
    },
    1_200_000,
  );
});
