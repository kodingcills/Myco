/**
 * TIF-268: the live trial environment with every VM seam faked. No reset script runs, no SSH,
 * no guest, no HCU binary, no model. Proves the wiring the live run depends on:
 *  - #546's boot class is read from the reset script's own stderr line;
 *  - the published fixture is checked against the task before anything reaches the guest;
 *  - the captured document is the HARNESS's read of the path it created, after the agent
 *    stopped (the agent never supplies it);
 *  - the shell policy denies the verifier's conversion dir and the harness dir, so a link
 *    that resolves there makes the row `uncertain` (violated), never verified;
 *  - an unreachable HCU is a harness fault with its own code: no row, nothing counted, and the
 *    runner aborts on the second one (round 2, D3);
 *  - the reset spawner passes the session lock on FD 9 (a real stub reset under exec 9>lock);
 *  - the guest is released on success and on a failed prepare.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Mcp } from "../../../src/baseline/c1.ts";
import { runHcuShellTrial } from "../../../src/baseline/hcu-shell/trial.ts";
import {
  defaultLiveDeps,
  HARNESS_DIR,
  type LiveDeps,
  liveEnvironment,
  parseBootClass,
  RESET_STDIO,
  VERIFIER_TEMP,
} from "../../../src/baseline/hcu-shell-live/live-vm.ts";
import {
  createSubscriptionPlanner,
  HCU_PLANNER_MODEL,
  PROBE_SCREENSHOT,
} from "../../../src/baseline/hcu-shell-live/planner.ts";
import {
  attemptsSpent,
  demoTasks,
  EXIT,
  exitCodeFor,
  type FcTask,
  hcuRunPlan,
  LIVE_STATUS_FILE,
  loadFcV1,
  readLedger,
  runHcuShell,
  USAGE_LIMIT_REPORT,
} from "../../../src/baseline/hcu-shell-live/runner.ts";
import {
  CLEAN_RESULT_FAULT_PHRASES,
  FAULT_WORDING,
  USAGE_LIMIT_PHRASES as GATE_USAGE_LIMIT_PHRASES,
  NBSP,
  spaced,
  THIN_SPACE,
  UNMAPPED_STRUCTURED,
} from "../../pilot/helpers.ts";
import { scripted } from "../hcu-shell/planners.ts";
import {
  fakeClaude,
  init,
  result,
  stream,
  USAGE_LIMIT_PHRASES,
  useClaudeTrap,
  useFetchTrap,
  VERDICT_QUOTA_TEXTS,
} from "./helpers.ts";

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
    // Seed read-back (as #598): the harness read the seeded document before the agent ran.
    expect(reads).toEqual([XLSX]);
    expect(t.capture).toEqual({
      guestPath: XLSX,
      seededSha256: createHash("sha256").update(SAVED).digest("hex"),
    });
    // Capture: the harness reads the path IT created; nothing comes from the agent.
    const doc = await t.prepared.capturePersisted();
    expect(reads).toEqual([XLSX, XLSX]);
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
  it("an unreachable HCU is a harness fault with its own code, and the guest is released (round 2, D3)", async () => {
    const { d, log } = deps({ hcuUp: false });
    await expect(liveEnvironment(".", d).prepare(TASK, "k")).rejects.toMatchObject({
      code: "hcu-unreachable",
    });
    expect(log).toContain("hcu-close");
    expect(log).toContain("cleanup");
    expect(log).toContain("agent-stop");
  });
  it("end to end: an unreachable HCU counts nothing, never calls the planner, and aborts with its code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-live-"));
    let acted = 0;
    const r = await runHcuShell({
      outDir: dir,
      repoRoot: ".",
      tasks: TASKS,
      plan: hcuRunPlan(TASKS, { hcuGuestCommand: "hcu mcp", guestShellSha256: "0".repeat(64) }),
      env: liveEnvironment(".", deps({ hcuUp: false }).d),
      planner: {
        paid: true,
        act: async () => {
          acted++;
          return { calls: [] };
        },
      },
      plannerModelId: HCU_PLANNER_MODEL,
      sleep: async () => undefined,
      load1m: () => 0,
    });
    expect(r).toMatchObject({ status: "aborted", code: "hcu-unreachable", decided: 0, failed: 2 });
    expect(exitCodeFor(r)).toBe(EXIT.repeatFailure);
    expect(acted).toBe(0);
    expect(readdirSync(join(dir, "rows"))).toEqual([]);
    expect(readLedger(dir).filter((l) => l.type === "decided")).toEqual([]);
  });
  it("a seeded document that cannot be read back fails closed before the agent runs", async () => {
    for (const readFile of [
      async () => Buffer.alloc(0),
      async () => {
        throw new Error("read failed");
      },
    ]) {
      const { d, log } = deps();
      const start = d.startAgent;
      d.startAgent = async () => {
        const s = await start();
        return { ...s, agent: { ...s.agent, readFile } };
      };
      await expect(liveEnvironment(".", d).prepare(TASK, "k")).rejects.toMatchObject({
        code: "seed-readback-failed",
      });
      expect(log.some((l) => l.startsWith("hcu "))).toBe(false);
      expect(log).toContain("agent-stop");
    }
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

describe("the VM lock reaches the reset through FD 9 (round 2, D4)", () => {
  const probe = resolve("test/baseline/hcu-shell-live/fixtures/reset-fd9-probe.ts");
  /** A stub reset: reports the inode FD 9 refers to (or none), then a cold boot line. */
  function stub(): string {
    const dir = mkdtempSync(join(tmpdir(), "reset-stub-"));
    const path = join(dir, "reset-trial-vm.sh");
    writeFileSync(
      path,
      [
        "#!/bin/bash",
        "ino=$(ls -iL /dev/fd/9 2>/dev/null | awk '{print $1}')",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal bash parameter expansion.
        'echo "fd9-inode=${ino:-none}" >&2',
        'echo "reset-trial-vm: boot class=cold" >&2',
        "",
      ].join("\n"),
    );
    return path;
  }
  const launch = (script: string) =>
    spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env },
    });

  it("passes FD 9 and closes FDs 3-8", () => {
    expect(RESET_STDIO[9]).toBe(9);
    expect(RESET_STDIO.slice(3, 9)).toEqual(Array(6).fill("ignore"));
  });
  it("under `exec 9>lock; node --import tsx ...` the reset process holds the lock file on FD 9", () => {
    const lock = join(mkdtempSync(join(tmpdir(), "vm-lock-")), "myco-win11.vm.lock");
    writeFileSync(lock, "");
    const s = stub();
    const r = launch(`exec 9>"${lock}"; exec node --import tsx "${probe}" "${s}"`);
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(out.code).toBe(0);
    expect(out.stderr).toContain(`fd9-inode=${statSync(lock).ino}`);
    expect(parseBootClass(out.stderr)).toBe("cold");
    // Without the session's FD 9 the reset sees nothing there (it would refuse the lock).
    const bare = launch(`exec 9>&-; exec node --import tsx "${probe}" "${s}"`);
    const none = JSON.parse(bare.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(none.stderr).not.toContain(`fd9-inode=${statSync(lock).ino}`);
  }, 60_000);
  it("the documented launch commands use node --import tsx, never npx", () => {
    const want = "scripts/vm-session.sh -- node --import tsx scripts/m2-hcu-shell-run.ts launch";
    for (const file of ["docs/benchmark/hcu-shell-runbook.md", "scripts/m2-hcu-shell-run.ts"]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toContain(want);
      expect(text, file).not.toMatch(/vm-session\.sh -- npx/);
    }
  });
  it("the real VM seams are never built under a test runner", () => {
    expect(() => defaultLiveDeps(".")).toThrow(/never built under a test runner/);
  });
});

/**
 * Round 3 (verifier N1, N2; lead rulings 02:18Z and 03:05Z), end to end: the REAL subscription
 * planner (`createSubscriptionPlanner`, a fake spawn) driving `runHcuShell` over
 * `liveEnvironment(deps())`, `maxTrials: 2`, exactly the verifier's probe. A usage-limit notice
 * the CLI returns as a clean result with no parseable decision, or as plain (non-JSON) stdout
 * with exit 0 or 1, stops the run at once: exit 7, one subscription call, no row, no decided
 * line, no failed line (no attempt spent), the lead's report on the log and as the heartbeat's
 * lastLog. A result with a valid decision is never reclassified.
 */
describe("a usage-limit notice stops the run end to end (round 3, N1 / N2)", () => {
  const quotaRun = async (replies: Parameters<typeof fakeClaude>[0]) => {
    const dir = mkdtempSync(join(tmpdir(), "hcu-quota-"));
    const fake = fakeClaude(replies);
    const lines: string[] = [];
    const planner = createSubscriptionPlanner({
      spawn: fake.spawn,
      command: "claude",
      env: { HOME: "/home/op", PATH: "/usr/bin" },
      cwd: dir,
      price: () => 0.001,
      callTimeoutMs: 5_000,
      killGraceMs: 50,
    });
    const r = await runHcuShell({
      outDir: dir,
      repoRoot: ".",
      tasks: TASKS,
      plan: hcuRunPlan(TASKS, { hcuGuestCommand: "hcu mcp", guestShellSha256: "0".repeat(64) }),
      env: liveEnvironment(".", deps().d),
      planner,
      plannerModelId: HCU_PLANNER_MODEL,
      maxTrials: 2,
      sleep: async () => undefined,
      load1m: () => 0,
      log: (l) => lines.push(l),
    });
    return { dir, r, fake, lines };
  };
  const expectUsageStop = (q: Awaited<ReturnType<typeof quotaRun>>) => {
    expect(q.r).toMatchObject({
      status: "halted",
      code: "planner-usage-limit",
      decided: 0,
      failed: 0,
    });
    expect(exitCodeFor(q.r)).toBe(EXIT.usageLimit);
    expect(q.fake.calls).toHaveLength(1);
    expect(readdirSync(join(q.dir, "rows"))).toEqual([]);
    const ledger = readLedger(q.dir);
    expect(ledger.filter((l) => l.type === "decided")).toEqual([]);
    expect(ledger.filter((l) => l.type === "failed")).toEqual([]);
    expect(attemptsSpent(ledger).size).toBe(0);
    expect(ledger.filter((l) => l.type === "start")).toHaveLength(1);
    expect(ledger.at(-1)).toMatchObject({ type: "halt", code: "planner-usage-limit" });
    expect(q.lines).toContain(USAGE_LIMIT_REPORT);
    const status = JSON.parse(readFileSync(join(q.dir, LIVE_STATUS_FILE), "utf8"));
    expect(status).toMatchObject({ lastLog: USAGE_LIMIT_REPORT, status: "halted" });
  };
  const QUOTA = [...VERDICT_QUOTA_TEXTS, ...USAGE_LIMIT_PHRASES];

  it.each(QUOTA)("N1: a clean result %j with no decision halts exit 7", async (text) => {
    expectUsageStop(await quotaRun([{ stdout: stream(init(), result(text)), code: 0 }]));
  });
  it.each(QUOTA.flatMap((t) => [[t, 0] as const, [t, 1] as const]))(
    "N2: plain stdout %j, exit %d, halts exit 7",
    async (text, code) => {
      expectUsageStop(await quotaRun([{ stdout: text, code }]));
    },
  );
  it("a result with a valid decision is never reclassified, whatever its text", async () => {
    const decision = JSON.stringify({
      tool: "type_text",
      arguments: { x: 10, y: 10, text: "Weekly limit reached ∙ resets Mon" },
    });
    const q = await quotaRun([
      { stdout: stream(init(), result(decision)), code: 0 },
      { stdout: stream(init(), result('{"claim":"done"}')), code: 0 },
    ]);
    expect(q.r.status).not.toBe("halted");
    expect(exitCodeFor(q.r)).not.toBe(EXIT.usageLimit);
    expect(q.r.decided).toBeGreaterThanOrEqual(1);
    expect(q.lines).not.toContain(USAGE_LIMIT_REPORT);
  });
  it("task data with 429 / 401 / 403 and no decision stays the agent's turn (planner-no-action)", async () => {
    const q = await quotaRun([
      { stdout: stream(init(), result("EMP-0127 401, EMP-0090 403, qty 429")), code: 0 },
    ]);
    expect(q.r).toMatchObject({ decided: 2, failed: 0 });
    expect(exitCodeFor(q.r)).not.toBe(EXIT.usageLimit);
    expect(q.fake.calls.length).toBeGreaterThan(1);
  });
  it("plain stdout with no quota wording is still a per-trial transport error", async () => {
    const q = await quotaRun([{ stdout: "not json", code: 1 }]);
    expect(q.r).toMatchObject({ status: "aborted", code: "planner-transport-error", failed: 2 });
  });

  /**
   * Round 4 (lead rulings 03:58Z and 05:39Z; the myco-gate arm's #607): the arm imports the
   * myco-gate arm's classifier, so the same vectors stop it. The phrases are the myco-gate arm's
   * own (`test/pilot/helpers.ts`), "You've hit your limit" among them.
   */
  const SPACES = [
    ["NBSP", NBSP],
    ["thin space U+2009", THIN_SPACE],
    ["tab", "\t"],
  ] as const;
  const decisionReplies = (decisionText: string, stderr = "") => [
    {
      stdout: stream(
        init(),
        result(
          JSON.stringify({ tool: "type_text", arguments: { x: 10, y: 10, text: decisionText } }),
        ),
      ),
      stderr,
      code: 0,
    },
    { stdout: stream(init(), result('{"claim":"done"}')), stderr, code: 0 },
  ];
  const expectAgentOutcome = (q: Awaited<ReturnType<typeof quotaRun>>) => {
    expect(q.r.status).not.toBe("halted");
    // maxTrials 2 of more: the invocation pauses at its cap (exit 4) once both are decided.
    expect(exitCodeFor(q.r)).toBe(EXIT.paused);
    expect(q.r.status).not.toMatch(/halted|aborted/);
    expect(q.r.decided).toBe(2);
    expect(q.fake.calls.length).toBeGreaterThan(1);
    expect(q.lines).not.toContain(USAGE_LIMIT_REPORT);
  };
  it.each(GATE_USAGE_LIMIT_PHRASES.flatMap((t) => [[t, 0] as const, [t, 1] as const]))(
    "S1: %j on stderr only, with a clean claimless result, exit %d, halts exit 7",
    async (text, code) => {
      expectUsageStop(await quotaRun([{ stdout: stream(init(), result("")), stderr: text, code }]));
    },
  );
  it.each(GATE_USAGE_LIMIT_PHRASES.flatMap((t) => SPACES.map(([l, s]) => [t, l, s] as const)))(
    "S2: %j with %s halts exit 7 as a clean result and as plain stdout (exit 0 and 1)",
    async (phrase, _label, space) => {
      const text = spaced(phrase, space);
      expectUsageStop(await quotaRun([{ stdout: stream(init(), result(text)), code: 0 }]));
      expectUsageStop(await quotaRun([{ stdout: text, code: 0 }]));
      expectUsageStop(await quotaRun([{ stdout: text, code: 1 }]));
    },
  );
  it.each(GATE_USAGE_LIMIT_PHRASES.flatMap((t) => SPACES.map(([l, s]) => [t, l, s] as const)))(
    "negative: %j with %s inside a valid decision, or on stderr beside one, is the agent's",
    async (phrase, _label, space) => {
      const text = spaced(phrase, space);
      expectAgentOutcome(await quotaRun(decisionReplies(text)));
      expectAgentOutcome(await quotaRun(decisionReplies("B2", text)));
    },
  );
  it.each([
    ["clean result", "EMP-0127 401, EMP-0090 403, qty 429", ""],
    ["stderr", "", "API Error: 401 · HTTP 403 Forbidden · qty 429"],
    ["clean result + stderr", "qty 429; HTTP 401", "403 forbidden; billing address; credential"],
  ])(
    "401 / 403 / 429 task data with no usage wording (%s) stays the agent's turn",
    async (_l, text, stderr) => {
      const q = await quotaRun([{ stdout: stream(init(), result(text)), stderr, code: 0 }]);
      expect(q.r).toMatchObject({ decided: 2, failed: 0 });
      // maxTrials 2 of more: the invocation pauses at its cap (exit 4) once both are decided.
      expect(exitCodeFor(q.r)).toBe(EXIT.paused);
      expect(q.r.status).not.toMatch(/halted|aborted/);
      expect(q.lines).not.toContain(USAGE_LIMIT_REPORT);
    },
  );
  it.each(
    CLEAN_RESULT_FAULT_PHRASES.flatMap(([t, cls]) => [
      [t, cls, "text"] as const,
      [t, cls, "stderr"] as const,
    ]),
  )(
    "L1: %j (%s) on a claimless clean result's %s halts exit 5, nothing counted",
    async (phrase, cls, where) => {
      const text = spaced(phrase, NBSP);
      const q = await quotaRun([
        where === "text"
          ? { stdout: stream(init(), result(text)), code: 0 }
          : { stdout: stream(init(), result("")), stderr: text, code: 0 },
      ]);
      expect(q.r).toMatchObject({
        status: "halted",
        code: `planner-${cls}`,
        decided: 0,
        failed: 0,
      });
      expect(exitCodeFor(q.r)).toBe(EXIT.subscriptionStop);
      expect(q.fake.calls).toHaveLength(1);
      expect(readdirSync(join(q.dir, "rows"))).toEqual([]);
      expect(attemptsSpent(readLedger(q.dir)).size).toBe(0);
    },
  );
  it.each(CLEAN_RESULT_FAULT_PHRASES.map(([t]) => t))(
    "L1 negative: %j inside a valid decision is the agent's",
    async (phrase) => {
      expectAgentOutcome(await quotaRun(decisionReplies(phrase)));
      expectAgentOutcome(await quotaRun(decisionReplies("B2", phrase)));
    },
  );
  it.each(
    UNMAPPED_STRUCTURED.flatMap(([field, extra]) =>
      FAULT_WORDING.filter(([, cls]) => cls !== "rate-limit").map(
        ([t, cls]) => [field, t, cls, extra] as const,
      ),
    ),
  )("B2: unmapped %s with %j halts as %s, no attempt spent", async (_f, text, cls, extra) => {
    const q = await quotaRun([
      { stdout: stream(init(), result(text, { is_error: true, ...extra })), code: 1 },
    ]);
    expect(q.r).toMatchObject({ status: "halted", code: `planner-${cls}`, decided: 0, failed: 0 });
    expect(q.fake.calls).toHaveLength(1);
    expect(attemptsSpent(readLedger(q.dir)).size).toBe(0);
  });
  it("B2 control: an unmapped status 500 with no wording is still a per-trial error result", async () => {
    const q = await quotaRun([
      { stdout: stream(init(), result("odd", { is_error: true, api_error_status: 500 })), code: 1 },
    ]);
    expect(q.r).toMatchObject({ status: "aborted", code: "planner-error-result" });
  });
});
