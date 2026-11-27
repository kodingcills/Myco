/**
 * TIF-268: the live trial environment with every VM seam faked. No reset script runs, no SSH,
 * no guest, no HCU binary, no model. Proves the wiring the live run depends on:
 *  - #546's boot class is read from the reset script's own stderr line;
 *  - the published fixture is checked against the task before anything reaches the guest;
 *  - the captured document is the HARNESS's read of the path it created, after the agent
 *    stopped (the agent never supplies it);
 *  - the shell policy denies the verifier's conversion dir and the harness dir, so a link
 *    that resolves there makes the row `uncertain` (violated), never verified;
 *  - an unreachable HCU makes the driver not ready (row `uncertain`), with its code;
 *  - the guest is released on success and on a failed prepare.
 */
import { describe, expect, it } from "vitest";
import type { Mcp } from "../../../src/baseline/c1.ts";
import { runHcuShellTrial } from "../../../src/baseline/hcu-shell/trial.ts";
import {
  HARNESS_DIR,
  type LiveDeps,
  liveEnvironment,
  parseBootClass,
  VERIFIER_TEMP,
} from "../../../src/baseline/hcu-shell-live/live-vm.ts";
import { PROBE_SCREENSHOT } from "../../../src/baseline/hcu-shell-live/planner.ts";
import { demoTasks, type FcTask, loadFcV1 } from "../../../src/baseline/hcu-shell-live/runner.ts";
import { scripted } from "../hcu-shell/planners.ts";
import { useClaudeTrap, useFetchTrap } from "./helpers.ts";

useClaudeTrap();
useFetchTrap();

const TASKS = demoTasks(loadFcV1("."));
const TASK = TASKS.find((t) => t.satisfiable) as FcTask;
const XLSX = "C:\\myco\\work\\hcu-shell-x\\n1\\fixture.xlsx";
const SAVED = Buffer.from("PK\u0003\u0004 saved workbook bytes");

const hcuMcp = (up = true): Mcp => ({
  async request(method, params) {
    if (!up) throw new Error("ssh: connect refused");
    if (method === "initialize") return { protocolVersion: "2025-06-18" };
    if (method === "tools/list") return { tools: [{ name: "GUI" }] };
    const actions = (params as { arguments: { actions: { type: string }[] } }).arguments.actions;
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true }) },
        ...(actions[0]?.type === "screenshot"
          ? [{ type: "image", mimeType: "image/png", data: PROBE_SCREENSHOT.data }]
          : []),
      ],
    };
  },
  async notify() {},
});

function deps(
  opts: {
    stderr?: string;
    resetCode?: number;
    hcuUp?: boolean;
    guestStdout?: string;
    openCalcFails?: boolean;
  } = {},
) {
  const log: string[] = [];
  const writes: string[] = [];
  const reads: string[] = [];
  const d: LiveDeps = {
    async reset(snapshot) {
      log.push(`reset ${snapshot}`);
      return {
        code: opts.resetCode ?? 0,
        stderr:
          opts.stderr ??
          "reset-trial-vm: boot class=cold first_ssh_s=40 guest_cpu_first_ssh_s=290 attempts=1\n",
        ms: 150_000,
      };
    },
    async startAgent() {
      log.push("agent");
      return {
        agent: {
          async readFile(p) {
            reads.push(p);
            return SAVED;
          },
          async writeFile(p) {
            writes.push(p);
            return 0;
          },
          async launch() {
            return 4242;
          },
          async uiaTree() {
            return { windows: [] };
          },
        },
        async stop() {
          log.push("agent-stop");
        },
      };
    },
    async guest(command) {
      log.push(`guest ${command.split(" ")[8]}`);
      return { stdout: opts.guestStdout ?? "", code: 0 };
    },
    openHcu(command) {
      log.push(`hcu ${command}`);
      return { mcp: hcuMcp(opts.hcuUp ?? true), close: () => log.push("hcu-close") };
    },
    async convertFixture(_agent, csv) {
      log.push(`convert ${csv.length}`);
      return { xlsxPath: XLSX, cleanup: async () => void log.push("cleanup") };
    },
    async openCalc() {
      if (opts.openCalcFails) throw Object.assign(new Error("uno"), { code: "calc-uno-timeout" });
      return 4242;
    },
    judge: () => ({ judge: async () => ({ kind: "unavailable" }), audit: async () => false }),
    host: () => ({ acPower: true, caffeinate: true, loadAvg1: 1 }),
  };
  return { d, log, writes, reads };
}

describe("parseBootClass", () => {
  it("reads the reset script's own line, the last one wins", () => {
    expect(parseBootClass("x\nreset-trial-vm: boot class=cold first_ssh_s=1\n")).toBe("cold");
    expect(
      parseBootClass(
        "reset-trial-vm: boot class=fast first_ssh_s=1\nreset-trial-vm: boot class=cold attempts=2\n",
      ),
    ).toBe("cold");
    expect(parseBootClass("reset-trial-vm: boot class=fast attempts=1\n")).toBe("fast");
    expect(parseBootClass("timing reset=1\n")).toBeNull();
    expect(parseBootClass("echo reset-trial-vm: boot class=cold\n")).toBeNull();
  });
});

describe("liveEnvironment.prepare", () => {
  it("resets to trial-base-v3, reports the boot class and wires HCU, shell and capture", async () => {
    const { d, log, writes, reads } = deps();
    const t = await liveEnvironment(".", d, "hcu.exe mcp").prepare(TASK, "hcu-shell-x");
    expect(log.slice(0, 2)).toEqual(["reset trial-base-v3", "agent"]);
    expect(t.bootClass).toBe("cold");
    expect(t.prepared.snapshot).toBe("trial-base-v3");
    expect(t.prepared.fixtureSha256).toBe(TASK.fixtureSha256);
    expect(t.prepared.driver.pipeReachable).toBe(true);
    // Defence in depth: the verifier's conversion dir and the harness dir are denied by name,
    // on top of lying outside the read roots.
    expect(t.prepared.shellPolicy.groundTruthDirs).toEqual([
      "c:/users/myco/appdata/local/temp",
      "c:/myco/harness",
    ]);
    expect(t.prepared.shellPolicy.readRoots).toEqual([
      "c:/myco/work/hcu-shell-x/n1",
      "c:/myco/scratch/hcu-shell-x",
    ]);
    expect(writes).toContain(`${HARNESS_DIR}\\hcu-shell.ps1`);
    expect(log).toContain("hcu hcu.exe mcp");
    // Capture: the harness reads the path IT created; nothing comes from the agent.
    expect(reads).toEqual([]);
    const doc = await t.prepared.capturePersisted();
    expect(reads).toEqual([XLSX]);
    expect(doc?.format).toBe("xlsx");
    expect(Buffer.from(doc?.bytes ?? []).equals(SAVED)).toBe(true);
    await t.release();
    expect(log).toContain("agent-stop");
    expect(log).toContain("cleanup");
  });
  it("reports a fast boot and a missing boot line as such (the runner halts on both)", async () => {
    const fast = await liveEnvironment(
      ".",
      deps({ stderr: "reset-trial-vm: boot class=fast\n" }).d,
    ).prepare(TASK, "k");
    expect(fast.bootClass).toBe("fast");
    const none = await liveEnvironment(".", deps({ stderr: "" }).d).prepare(TASK, "k");
    expect(none.bootClass).toBeNull();
  });
  it("refuses a failed reset with a code, before the guest is touched", async () => {
    const { d, log } = deps({ resetCode: 1 });
    await expect(liveEnvironment(".", d).prepare(TASK, "k")).rejects.toMatchObject({
      code: "reset-failed",
    });
    expect(log).toEqual(["reset trial-base-v3"]);
  });
  it("refuses a task whose published fixture does not match its hash, before any reset", async () => {
    const { d, log } = deps();
    const bad = { ...TASK, fixtureSha256: "f".repeat(64) };
    await expect(liveEnvironment(".", d).prepare(bad, "k")).rejects.toMatchObject({
      code: "fixture-mismatch",
    });
    expect(log).toEqual([]);
  });
  it("releases the guest when prepare fails part-way", async () => {
    const { d, log } = deps({ openCalcFails: true });
    await expect(liveEnvironment(".", d).prepare(TASK, "k")).rejects.toMatchObject({
      code: "calc-uno-timeout",
    });
    expect(log).toContain("cleanup");
    expect(log).toContain("agent-stop");
  });
  it("an unreachable HCU leaves the driver not ready, with its code, and the row uncertain", async () => {
    const t = await liveEnvironment(".", deps({ hcuUp: false }).d).prepare(TASK, "k");
    expect(t.prepared.driver.pipeReachable).toBe(false);
    expect(t.prepared.driver.diagnostic).toBe("hcu-unreachable");
    const row = await runHcuShellTrial(
      { index: 0, params: t.params, ...t.target },
      t.prepared,
      scripted(["done"]),
    );
    expect(row.verdict).toBe("uncertain");
    expect(row.verdictReason).toBe("driver-unreachable");
  });
  it("a shell read that resolves into the verifier's temp dir is a violation: uncertain, output withheld", async () => {
    const escaped = `${VERIFIER_TEMP}\\abc\\fixture.csv`;
    const guestStdout = `${JSON.stringify({ output: "the judge's CSV", accesses: [{ operation: "read", path: escaped }] })}\n`;
    const t = await liveEnvironment(".", deps({ guestStdout }).d).prepare(TASK, "k");
    const docDir = XLSX.replace(/\\[^\\]+$/, "")
      .replaceAll("\\", "/")
      .toLowerCase();
    const planner = scripted([{ shell: "cat", path: `${docDir}/notes.txt` }, "done"]);
    const row = await runHcuShellTrial(
      { index: 0, params: t.params, ...t.target },
      t.prepared,
      planner,
    );
    expect(row.shell.integrity).toBe("violated");
    expect(row.verdict).toBe("uncertain");
    expect(
      planner.turns.every((turn) => turn.shellHistory.every((h) => !h.result.includes("judge"))),
    ).toBe(true);
  });
  it("a shell call the guest cannot report is unaudited: uncertain", async () => {
    const t = await liveEnvironment(".", deps({ guestStdout: "Add-Type : failed\n" }).d).prepare(
      TASK,
      "k",
    );
    const docDir = XLSX.replace(/\\[^\\]+$/, "")
      .replaceAll("\\", "/")
      .toLowerCase();
    const row = await runHcuShellTrial(
      { index: 0, params: t.params, ...t.target },
      t.prepared,
      scripted([{ shell: "ls", path: docDir }, "done"]),
    );
    expect(row.shell.integrity).toBe("unaudited");
    expect(row.verdict).toBe("uncertain");
  });
});
