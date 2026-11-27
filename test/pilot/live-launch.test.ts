/**
 * TIF-274: the live Claude driver with VM-side host capture, wired into both runners' launch.
 *
 * Nothing here starts a real trial, touches a VM or calls a model. The VM is a fake
 * `VmBackend` (an in-memory guest), `claude` is a fake `spawn` that replays canned
 * `--output-format json` output, and a TRAP `claude` binary is first on PATH for the whole
 * file: if anything ran the real CLI by name, the trap writes a marker and the last test fails.
 * `realVmBackend` itself refuses to be built under vitest.
 */
import { type ChildProcess, type SpawnOptions, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scriptedDocument } from "../../src/benchmark/r1-dryrun.ts";
import { AbRefusal, abPlanSha256, loadPrereg, type runAbStage } from "../../src/pilot/ab.ts";
import { apiKeyPathRefusal, claudeDriver, type SpawnFn } from "../../src/pilot/claude-transport.ts";
import { CHILD_ENV_ALLOWLIST, configSha256, type PilotConfig } from "../../src/pilot/config.ts";
import { COST_BASIS } from "../../src/pilot/cost.ts";
import { fakeDriver, PILOT_DRY_RUN_PLANNER, virtualClock } from "../../src/pilot/dry-run.ts";
import { trialLaunchPlan } from "../../src/pilot/launch.ts";
import {
  AttemptLedger,
  type AttemptRecord,
  faultSignature,
  loadLedger,
  PROGRESS_FILE,
  resumeFaultSignature,
  taskStatus,
  transientFaultCounts,
} from "../../src/pilot/ledger.ts";
import {
  EXIT,
  exitCodeFor,
  LIVE_STATUS_FILE,
  type LiveDeps,
  LiveStatus,
  launchAbLive,
  launchR1Live,
  USAGE_LIMIT_REPORT,
} from "../../src/pilot/live-launch.ts";
import { HarnessFault, runPilot } from "../../src/pilot/runner.ts";
import {
  DEFAULT_GUEST_ROOT,
  guestTrialPaths,
  HOST_CAPTURE_FILE,
  liveVmDriver,
  parseBootClass,
  realVmBackend,
  taskFixtureBytes,
  VM_FAULT,
  type VmBackend,
} from "../../src/pilot/vm-capture.ts";
import {
  CLEAN_RESULT_FAULT_PHRASES,
  CLEAN_RESULT_TASK_DATA,
  config,
  FAULT_WORDING,
  FOLDED_USAGE_PHRASES,
  NBSP,
  PUBLISHED,
  ROOT,
  SOURCES,
  spaced,
  THIN_SPACE,
  tmp,
  UNICODE_SPACES,
  UNMAPPED_STRUCTURED,
  USAGE_LIMIT_PHRASES,
  ZWSP,
} from "./helpers.ts";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------
// The trap: a `claude` first on PATH that records any invocation and fails.
// ---------------------------------------------------------------------------------------------

const TRAP_DIR = tmp("myco-trap-claude-");
const TRAP_MARK = join(TRAP_DIR, "INVOKED");
let savedPath: string | undefined;
beforeAll(() => {
  writeFileSync(
    join(TRAP_DIR, "claude"),
    `#!/bin/sh\necho "trap claude invoked: $*" >> "${TRAP_MARK}"\nexit 97\n`,
  );
  chmodSync(join(TRAP_DIR, "claude"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${TRAP_DIR}:${savedPath ?? ""}`;
});
afterAll(() => {
  process.env.PATH = savedPath;
});

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

type Event = string;

/** An in-memory guest behind a fake VM backend; `events` records the order of every step. */
function fakeVm(
  o: {
    bootClass?: "cold" | "fast" | null;
    failReset?: boolean;
    failOpen?: boolean;
    failCaptureRead?: boolean;
    corruptSeed?: boolean;
  } = {},
) {
  const guest = new Map<string, Buffer>();
  const events: Event[] = [];
  let reads = 0;
  const backend: VmBackend = {
    async reset() {
      events.push("reset");
      if (o.failReset) throw new Error("utm said no");
      return { bootClass: o.bootClass === undefined ? "cold" : o.bootClass };
    },
    async open() {
      events.push("open");
      if (o.failOpen) throw new Error("tunnel down");
      reads = 0; // one channel per attempt: its first read is the seed check, its second the capture
      return {
        async writeFile(p, b) {
          events.push(`write ${p}`);
          guest.set(p, Buffer.from(b));
          return b.length;
        },
        async readFile(p) {
          reads++;
          events.push(`read ${p}`);
          if (o.corruptSeed && reads === 1) return Buffer.from("not what was written");
          if (o.failCaptureRead && reads > 1) throw new Error("read_file OP_FAILED");
          const b = guest.get(p);
          if (b === undefined) throw new Error("missing");
          return b;
        },
        async close() {
          events.push("close");
        },
      };
    },
  };
  return { backend, guest, events, built: 0 };
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

const resultJson = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  });

/**
 * A fake `claude`: replays `output(n)` (stdout, stderr, exit code) for the n-th spawn, after
 * running `during` (what the "agent" does while it runs, e.g. edit the guest document).
 */
function fakeClaude(
  output: (n: number) => { stdout: string; stderr?: string; code?: number },
  during?: (call: SpawnCall, n: number) => void,
) {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const n = calls.length;
    if (command !== "claude") throw new Error(`unexpected command ${command}`);
    during?.(call, n);
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const out = new PassThrough();
    const err = new PassThrough();
    Object.assign(child, { stdout: out, stderr: err, kill: () => true });
    const o = output(n);
    setImmediate(() => {
      out.write(o.stdout);
      if (o.stderr) err.write(o.stderr);
      out.end();
      err.end();
      setImmediate(() => child.emit("close", o.code ?? 0));
    });
    return child;
  };
  return { spawn, calls };
}

const twoTrials = (c: PilotConfig = config()): PilotConfig => ({
  ...c,
  trials: ["fc-v1-001", "fc-v1-002"],
});

function deps(
  vm: ReturnType<typeof fakeVm>,
  claude: ReturnType<typeof fakeClaude>,
  over: Partial<LiveDeps> = {},
): LiveDeps & { lines: string[] } {
  const clock = virtualClock(Date.parse("2026-11-27T00:00:00Z"));
  const lines: string[] = [];
  return {
    env: { PATH: process.env.PATH ?? "", HOME: "/h" },
    vmLockOwned: () => true,
    vmBackend: () => {
      vm.built++;
      return vm.backend;
    },
    spawn: claude.spawn,
    claudeCommand: "claude",
    log: (l) => lines.push(l),
    sleep: clock.sleep,
    now: clock.now,
    heartbeatMs: 3_600_000,
    lines,
    ...over,
  };
}

function r1Opts(cfg: PilotConfig, outDir: string, over: Record<string, unknown> = {}) {
  return {
    config: cfg,
    published: PUBLISHED,
    outDir,
    repoRoot: ROOT,
    oracleSources: SOURCES,
    launchRealTrials: true,
    planSha256: configSha256(cfg),
    ...over,
  };
}

const task1 = () => {
  const t = PUBLISHED.find((x) => x.taskId === "fc-v1-001");
  if (t === undefined) throw new Error("fixture");
  return t;
};
const guestDoc = (trialKey: string) => guestTrialPaths(DEFAULT_GUEST_ROOT, trialKey).persisted;
const ledgerEnds = (out: string) =>
  [...loadLedger(join(out, PROGRESS_FILE)).byTask.values()]
    .flat()
    .map((a) => a.end)
    .filter((e) => e !== null);

// ---------------------------------------------------------------------------------------------

describe("R1 launch: refuses without each precondition, before anything is touched", () => {
  const base = twoTrials();
  const cases: [string, PilotConfig, Record<string, unknown>, Partial<LiveDeps>, RegExp][] = [
    ["no --launch-real-trials", base, { launchRealTrials: false }, {}, /--launch-real-trials/],
    ["no --plan-sha256", base, { planSha256: undefined }, {}, /--plan-sha256/],
    ["a wrong --plan-sha256", base, { planSha256: "0".repeat(64) }, {}, /--plan-sha256/],
    [
      "an API-path credential name in the environment",
      base,
      {},
      { env: { PATH: "/bin", ANTHROPIC_API_KEY: "synthetic-not-a-key-91c2" } },
      /API-path credential variable\(s\) configured: ANTHROPIC_API_KEY/,
    ],
    [
      "an API-path credential name in the agent's allowlist",
      { ...base, childEnvAllowlist: [...CHILD_ENV_ALLOWLIST, "ANTHROPIC_AUTH_TOKEN"] },
      {},
      {},
      /ANTHROPIC_AUTH_TOKEN in the agent's environment allowlist/,
    ],
    [
      "the VM session lock not held",
      base,
      {},
      { vmLockOwned: () => false },
      /the VM session lock is not held/,
    ],
    [
      "concurrency 2",
      { ...base, pacing: { ...base.pacing, concurrency: 2 } },
      {},
      {},
      /needs concurrency 1/,
    ],
  ];
  for (const [name, cfg, over, depOver, why] of cases)
    it(name, async () => {
      const vm = fakeVm();
      const claude = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
      const out = tmp();
      const d = deps(vm, claude, depOver);
      const r = await launchR1Live(r1Opts(cfg, out, { planSha256: configSha256(cfg), ...over }), d);
      expect(r.exitCode).toBe(EXIT.refused);
      expect(r.refusals.join("\n")).toMatch(why);
      expect(r.refusals).toHaveLength(1);
      expect(r.result).toBeNull();
      // Nothing was touched: no VM backend built, no `claude` spawned, no ledger, no heartbeat.
      expect(vm.built).toBe(0);
      expect(vm.events).toEqual([]);
      expect(claude.calls).toEqual([]);
      expect(existsSync(join(out, PROGRESS_FILE))).toBe(false);
      expect(existsSync(join(out, LIVE_STATUS_FILE))).toBe(false);
      // A refusal names variables, never a value.
      expect(r.refusals.join("\n")).not.toContain("synthetic-not-a-key-91c2");
    });
});

describe("R1 launch with every precondition and fakes reaches the live driver", () => {
  it("resets, seeds, runs claude with the audited argv, captures host-side, decides", async () => {
    const vm = fakeVm();
    const claude = fakeClaude(
      () => ({ stdout: resultJson("Edited.\nDONE") }),
      (call) => {
        // The "agent" edits the document in the guest (what a real trial's VM-side work does).
        const key = call.options.cwd?.toString().split("/").pop() as string;
        const task = PUBLISHED.find((t) => key.includes(t.taskId));
        if (task !== undefined) vm.guest.set(guestDoc(key), Buffer.from(scriptedDocument(task)));
      },
    );
    const out = tmp();
    const cfg = twoTrials();
    const r = await launchR1Live(r1Opts(cfg, out), deps(vm, claude));
    expect(r.refusals).toEqual([]);
    expect(r.exitCode).toBe(EXIT.complete);
    expect(r.result).toMatchObject({ status: "complete", ran: 2, faulted: 0, stopCode: null });

    // claude: exactly the audited plan's argv, allowlisted environment names only.
    expect(claude.calls).toHaveLength(2);
    for (const [i, call] of claude.calls.entries()) {
      const task = PUBLISHED.find((t) => t.taskId === cfg.trials[i]) as (typeof PUBLISHED)[0];
      const key = `r1p-${task.taskId}-a1`;
      const plan = trialLaunchPlan(
        cfg,
        task,
        { runId: key, trialKey: key },
        join(out, "trials", key),
        ROOT,
      );
      expect(call.args).toEqual(plan.argv);
      expect(
        Object.keys(call.options.env ?? {}).every((k) => CHILD_ENV_ALLOWLIST.includes(k)),
      ).toBe(true);
    }
    // The VM step, in order, per trial: reset, open, seed (write + read back), [agent], capture, close.
    const k1 = guestDoc("r1p-fc-v1-001-a1");
    expect(vm.events.slice(0, 6)).toEqual([
      "reset",
      "open",
      `write ${k1}`,
      `read ${k1}`,
      `read ${k1}`,
      "close",
    ]);
    expect(vm.events.filter((e) => e === "reset")).toHaveLength(2);

    // Decided rows, the live planner, the gate VERIFIED on the host's capture.
    const ends = ledgerEnds(out);
    expect(ends.map((e) => e.outcome)).toEqual(["decided", "decided"]);
    for (const e of ends) {
      expect(e.armRow?.plannerModelId).toBe(cfg.model);
      expect(e.armRow?.gate?.verdict).toBe("verified");
    }
    // The heartbeat: finished, the exit code, cost labelled a token-derived estimate.
    const status = JSON.parse(readFileSync(join(out, LIVE_STATUS_FILE), "utf8"));
    expect(status).toMatchObject({ state: "finished", exitCode: 0, costBasis: COST_BASIS });
    expect(status.costBasis).toMatch(/token-derived estimate/);
    expect(status.costEstimate.basis).toMatch(/token-derived estimate/);
  });
});

describe("the capture comes from the host's read of the guest, never from the agent", () => {
  it("agent-forged files on the host are ignored; the sealed bytes are the guest's", async () => {
    const vm = fakeVm();
    const forged = scriptedDocument(task1()); // the CORRECT document, forged by the agent
    const claude = fakeClaude(
      () => ({ stdout: resultJson("All done.\nDONE") }),
      (call) => {
        // The agent writes a correct-looking document everywhere it can reach on the host.
        const dir = call.options.cwd?.toString() as string;
        writeFileSync(join(dir, "doc.csv"), forged);
        mkdirSync(join(dir, "persisted"), { recursive: true });
        writeFileSync(join(dir, "persisted", "doc.csv"), forged);
        writeFileSync(join(dir, "gate-evidence", "doc.csv"), forged);
        writeFileSync(join(dir, HOST_CAPTURE_FILE), "{}");
        // ... and leaves the guest document untouched (the seeded fixture).
      },
    );
    const out = tmp();
    const cfg = { ...config(), trials: ["fc-v1-001"] };
    const r = await launchR1Live(r1Opts(cfg, out), deps(vm, claude));
    expect(r.exitCode).toBe(EXIT.complete);
    const fixture = taskFixtureBytes(ROOT, task1());
    const [end] = ledgerEnds(out);
    // The row's persisted hash is the guest's (the untouched fixture), not the forgery's ...
    expect(end?.armRow?.persistedSha256).toBe(sha256(fixture));
    expect(end?.armRow?.persistedSha256).not.toBe(sha256(forged));
    // ... so the agent's DONE is refuted, not accepted.
    expect(end?.armRow?.gate?.verdict).toBe("refuted");
    expect(end?.armRow?.accepted).toBe(false);
    // The vault holds the guest bytes and the host's provenance record.
    const vaultRun = join(out, "vault", "r1p-fc-v1-001-a1", "captured");
    expect(sha256(readFileSync(join(vaultRun, "persisted", "doc.csv")))).toBe(sha256(fixture));
    const prov = JSON.parse(readFileSync(join(vaultRun, HOST_CAPTURE_FILE), "utf8"));
    expect(prov).toMatchObject({
      schema: "myco.pilot.host-capture/1",
      guestPath: guestDoc("r1p-fc-v1-001-a1"),
      persistedSha256: sha256(fixture),
      seededSha256: sha256(fixture),
      resetBootClass: "cold",
    });
  });

  it("an unreadable guest document is a harness fault, never an empty document", async () => {
    const vm = fakeVm({ failCaptureRead: true });
    const claude = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
    const out = tmp();
    const cfg = { ...config(), trials: ["fc-v1-001"] };
    const r = await launchR1Live(r1Opts(cfg, out), deps(vm, claude));
    const ends = ledgerEnds(out);
    expect(ends.every((e) => e.outcome === "harness-fault")).toBe(true);
    expect(ends[0]?.harnessClass).toBe("transport-error");
    expect(ends.some((e) => e.outcome === "decided")).toBe(false);
    // Two identical read failures in a row stop the run (code 6), no third attempt.
    expect(r.exitCode).toBe(EXIT.repeatFailure);
    expect(claude.calls).toHaveLength(2);
  });

  it("the guest path is the harness's, from the trial key alone; traversal is refused", () => {
    expect(guestTrialPaths("C:\\myco\\pilot", "r1p-fc-v1-001-a1")).toEqual({
      dir: "C:\\myco\\pilot\\r1p-fc-v1-001-a1",
      persisted: "C:\\myco\\pilot\\r1p-fc-v1-001-a1\\doc.csv",
    });
    for (const key of ["../x", "a\\b", "A-upper", "", "a/b", "x..y\\z"])
      expect(() => guestTrialPaths("C:\\myco\\pilot", key), key).toThrow(/bad trial key/);
    for (const root of ["C:\\myco\\..\\x", "myco\\pilot", "C:\\my co", "C:\\x\\", "\\\\host\\s"])
      expect(() => guestTrialPaths(root, "k"), root).toThrow(/bad guest root/);
  });

  it("the seeded fixture is sha-checked against the task", () => {
    const t = task1();
    expect(sha256(taskFixtureBytes(ROOT, t))).toBe(t.fixtureSha256);
    expect(() => taskFixtureBytes(ROOT, { ...t, fixtureSha256: "0".repeat(64) })).toThrow(
      /fixtureSha256/,
    );
    expect(() => taskFixtureBytes(ROOT, { ...t, fixtureFile: "../../etc/passwd" })).toThrow(
      /unexpected fixture path/,
    );
  });
});

describe("VM step failures are code-only harness faults", () => {
  const ctxFor = (trialKey: string) => {
    const trialDir = tmp();
    mkdirSync(join(trialDir, "gate-evidence"), { recursive: true });
    return {
      task: task1(),
      runId: trialKey,
      trialKey,
      trialDir,
      signal: new AbortController().signal,
    };
  };
  const plan = (dir: string) =>
    trialLaunchPlan(config(), task1(), { runId: "k", trialKey: "k" }, dir, ROOT);
  const drive = async (vm: ReturnType<typeof fakeVm>) => {
    const claude = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
    const driver = liveVmDriver(
      { spawn: claude.spawn, command: "claude", env: {}, envAllowlist: CHILD_ENV_ALLOWLIST },
      { backend: vm.backend, repoRoot: ROOT },
    );
    const ctx = ctxFor("r1p-fc-v1-001-a1");
    const t = driver.transport(ctx);
    let fault: unknown = null;
    try {
      await t.runAgent(plan(ctx.trialDir), null);
      await t.captureAfterStop();
    } catch (error) {
      fault = error;
    }
    return { fault, claude, t };
  };

  for (const [name, o, cls, msg] of [
    ["reset fails", { failReset: true }, "spawn-failed", VM_FAULT.reset],
    ["channel does not open", { failOpen: true }, "transport-error", VM_FAULT.open],
    ["seed does not read back", { corruptSeed: true }, "transport-error", VM_FAULT.seedReadBack],
    ["capture read fails", { failCaptureRead: true }, "transport-error", VM_FAULT.read],
  ] as const)
    it(name, async () => {
      const vm = fakeVm(o);
      const { fault, claude } = await drive(vm);
      expect(fault).toBeInstanceOf(HarnessFault);
      expect((fault as HarnessFault).harnessClass).toBe(cls);
      expect((fault as HarnessFault).message).toBe(msg);
      // A failure before the agent never starts claude; the channel is always closed.
      if (name !== "capture read fails") expect(claude.calls).toHaveLength(0);
      if (vm.events.includes("open") && !o.failOpen) expect(vm.events.at(-1)).toBe("close");
    });

  it("reports the reset's boot class to the runner (#546 / #563); none when unmeasured", async () => {
    for (const boot of ["cold", "fast"] as const) {
      const { t, fault } = await drive(fakeVm({ bootClass: boot }));
      expect(fault).toBeNull();
      expect(t.report().resetBootClass).toBe(boot);
    }
    const { t } = await drive(fakeVm({ bootClass: null }));
    expect(Object.hasOwn(t.report(), "resetBootClass")).toBe(false);
  });

  it("parses reset-trial-vm.sh's boot line (the last one wins)", () => {
    expect(
      parseBootClass(
        "reset-trial-vm: fast boot (guest CPU 9s ...)\nreset-trial-vm: boot class=fast first_ssh_s=20 guest_cpu_first_ssh_s=9 attempts=1\nreset-trial-vm: boot class=cold first_ssh_s=140 guest_cpu_first_ssh_s=280 attempts=2\n",
      ),
    ).toBe("cold");
    expect(parseBootClass("reset-trial-vm: boot class=fast first_ssh_s=1 x")).toBe("fast");
    expect(parseBootClass("reset-trial-vm: ready on 'trial-base-v3'")).toBeNull();
    expect(parseBootClass("xreset-trial-vm: boot class=cold first")).toBeNull();
    expect(parseBootClass("reset-trial-vm: boot class=warm first")).toBeNull();
  });

  it("the real VM backend is never built under a test runner", () => {
    expect(() => realVmBackend({ repoRoot: ROOT, inheritLockFd: false })).toThrow(
      /never built under a test runner/,
    );
  });
});

describe("auth, credit, billing and quota errors stop the run with a code (no retry)", () => {
  const errorResult = (assistant: Record<string, unknown>) =>
    JSON.stringify([
      { type: "assistant", message: { content: [] }, ...assistant },
      JSON.parse(resultJson("API Error", { is_error: true, subtype: "error_during_execution" })),
    ]);
  for (const [name, output, code] of [
    ["billing_error", { stdout: errorResult({ error: "billing_error" }), code: 1 }, "billing"],
    ["HTTP 402", { stdout: errorResult({ api_error_status: 402 }), code: 1 }, "billing"],
    [
      "credit balance on stderr",
      { stdout: "", stderr: "Credit balance is too low", code: 1 },
      "billing",
    ],
    [
      "quota exceeded",
      { stdout: "", stderr: "Error: quota exceeded for this account", code: 1 },
      "billing",
    ],
    [
      "authentication_failed",
      { stdout: errorResult({ error: "authentication_failed" }), code: 1 },
      "auth",
    ],
    ["not logged in", { stdout: "", stderr: "Not logged in · Please run /login", code: 1 }, "auth"],
  ] as const)
    it(name, async () => {
      const vm = fakeVm();
      const claude = fakeClaude(() => output);
      const out = tmp();
      const r = await launchR1Live(r1Opts(twoTrials(), out), deps(vm, claude));
      expect(r.exitCode).toBe(EXIT.subscriptionStop);
      expect(r.result?.stopCode).toBe(code);
      expect(r.result?.status).toBe("paused");
      // Stopped at once: one spawn, one reset, no back-off wait, no second trial.
      expect(claude.calls).toHaveLength(1);
      expect(vm.events.filter((e) => e === "reset")).toHaveLength(1);
      const ends = ledgerEnds(out);
      expect(ends.map((e) => [e.outcome, e.harnessClass])).toEqual([["harness-fault", code]]);
      const status = JSON.parse(readFileSync(join(out, LIVE_STATUS_FILE), "utf8"));
      expect(status).toMatchObject({ state: "finished", exitCode: 5 });
    });
});

describe("an API-key fallback is refused", () => {
  it("a run whose init message names an API key source stops (code api-key), never decided", async () => {
    const vm = fakeVm();
    const claude = fakeClaude(() => ({
      stdout: JSON.stringify([
        { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" },
        JSON.parse(resultJson("Edited.\nDONE")),
      ]),
    }));
    const out = tmp();
    const r = await launchR1Live(r1Opts(twoTrials(), out), deps(vm, claude));
    expect(r.exitCode).toBe(EXIT.subscriptionStop);
    expect(r.result?.stopCode).toBe("api-key");
    expect(claude.calls).toHaveLength(1);
    expect(ledgerEnds(out).map((e) => [e.outcome, e.harnessClass])).toEqual([
      ["harness-fault", "auth"],
    ]);
  });

  it("the subscription's own source (none) is the agent's outcome", async () => {
    const vm = fakeVm();
    const claude = fakeClaude(() => ({
      stdout: JSON.stringify([
        { type: "system", subtype: "init", apiKeySource: "none" },
        JSON.parse(resultJson("Edited.\nNOT DONE")),
      ]),
    }));
    const out = tmp();
    const r = await launchR1Live(r1Opts(twoTrials(), out), deps(vm, claude));
    expect(r.exitCode).toBe(EXIT.complete);
    expect(ledgerEnds(out).every((e) => e.outcome === "decided")).toBe(true);
  });

  it("claudeDriver refuses an allowlist that would pass an API credential to claude", () => {
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK"]) {
      const opts = {
        spawn: fakeClaude(() => ({ stdout: "" })).spawn,
        command: "claude",
        env: {},
        envAllowlist: [...CHILD_ENV_ALLOWLIST, name],
        capture: async () => ({}),
      };
      expect(apiKeyPathRefusal(opts), name).toContain(name);
      expect(() => claudeDriver(opts), name).toThrow(/allowlist/);
    }
    expect(apiKeyPathRefusal({ envAllowlist: CHILD_ENV_ALLOWLIST })).toBeNull();
  });
});

describe("two identical harness failures in a row abort the run", () => {
  it("live: the same failure twice stops (code 6) before the attempt budget (3) is spent", async () => {
    const vm = fakeVm();
    const claude = fakeClaude(() => ({ stdout: "not json", code: 1 }));
    const out = tmp();
    const r = await launchR1Live(r1Opts(twoTrials(), out), deps(vm, claude));
    expect(twoTrials().pacing.maxAttemptsPerTrial).toBe(3);
    expect(r.exitCode).toBe(EXIT.repeatFailure);
    expect(r.result?.stopCode).toBe("repeat-failure");
    expect(claude.calls).toHaveLength(2);
    expect(ledgerEnds(out).map((e) => e.harnessClass)).toEqual([
      "transport-error",
      "transport-error",
    ]);
  });

  it("two DIFFERENT failures do not abort; a decided trial resets the count", async () => {
    const vm = fakeVm();
    // trial 1: transport-error, then error-result (different), then decided; trial 2: the SAME
    // error-result as trial 1's last fault, which is not a repeat: a decided trial came between.
    const outputs = [
      { stdout: "not json", code: 1 },
      { stdout: resultJson("x", { is_error: true, subtype: "error_max_turns" }), code: 0 },
      { stdout: resultJson("x\nDONE") },
      { stdout: resultJson("x", { is_error: true, subtype: "error_max_turns" }), code: 0 },
      { stdout: resultJson("x\nDONE") },
    ];
    const claude = fakeClaude((n) => outputs[n - 1] as (typeof outputs)[0]);
    const out = tmp();
    const r = await launchR1Live(r1Opts(twoTrials(), out), deps(vm, claude));
    expect(r.exitCode).toBe(EXIT.complete);
    expect(r.result).toMatchObject({ status: "complete", ran: 2, faulted: 3, stopCode: null });
    expect(claude.calls).toHaveLength(5);
  });

  it("simulated runs keep the old budget by default; the option turns the rule on", async () => {
    const run = async (abortOnRepeatedFailure?: boolean) => {
      const clock = virtualClock();
      const driver = fakeDriver({
        beforeAgent: (ctx) => {
          if (ctx.task.taskId === "fc-v1-001") throw new HarnessFault("timeout", "same every time");
        },
      });
      const r = await runPilot({
        config: twoTrials(),
        published: PUBLISHED,
        outDir: tmp(),
        repoRoot: ROOT,
        oracleSources: SOURCES,
        driver,
        plannerModelId: PILOT_DRY_RUN_PLANNER,
        sleep: clock.sleep,
        now: clock.now,
        ...(abortOnRepeatedFailure === undefined ? {} : { abortOnRepeatedFailure }),
      });
      return { r, launched: driver.launched.length };
    };
    const off = await run();
    expect(off.r).toMatchObject({ status: "incomplete", stopCode: null, exhausted: ["fc-v1-001"] });
    expect(off.launched).toBe(4); // 3 attempts of fc-v1-001, then fc-v1-002
    const on = await run(true);
    expect(on.r).toMatchObject({ status: "paused", stopCode: "repeat-failure" });
    expect(on.launched).toBe(2);
  });
});

describe("resume continues from the durable ledger", () => {
  it("billing stops never spend the attempt budget: resume after three stops still runs the trial", async () => {
    const out = tmp();
    const cfg = { ...config(), trials: ["fc-v1-001"] };
    const billing = () => ({ stdout: "", stderr: "Credit balance is too low", code: 1 });
    for (let i = 0; i < cfg.pacing.maxAttemptsPerTrial; i++) {
      const r = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), fakeClaude(billing)));
      expect(r.exitCode).toBe(EXIT.subscriptionStop);
    }
    const ok = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
    const r = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), ok));
    expect(r.exitCode).toBe(EXIT.complete);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]?.options.cwd?.toString()).toMatch(/r1p-fc-v1-001-a4$/);
  });

  it("after a billing stop, the same launch skips decided trials and re-runs the stopped one in place", async () => {
    const out = tmp();
    const cfg = twoTrials();
    const vm1 = fakeVm();
    const first = fakeClaude((n) =>
      n === 1
        ? { stdout: resultJson("x\nDONE") }
        : { stdout: "", stderr: "Credit balance is too low", code: 1 },
    );
    const r1 = await launchR1Live(r1Opts(cfg, out), deps(vm1, first));
    expect(r1.exitCode).toBe(EXIT.subscriptionStop);

    const vm2 = fakeVm();
    const second = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
    const r2 = await launchR1Live(r1Opts(cfg, out), deps(vm2, second));
    expect(r2.exitCode).toBe(EXIT.complete);
    expect(r2.result).toMatchObject({ status: "complete", ran: 1, skipped: 1 });
    // Only fc-v1-002 ran again, as attempt 2 superseding the billing-stopped attempt 1.
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.options.cwd?.toString()).toMatch(/r1p-fc-v1-002-a2$/);
    const attempts = loadLedger(join(out, PROGRESS_FILE)).byTask.get("fc-v1-002") ?? [];
    expect(attempts.map((a) => [a.start.trialKey, a.start.supersedes, a.end?.outcome])).toEqual([
      ["r1p-fc-v1-002-a1", null, "harness-fault"],
      ["r1p-fc-v1-002-a2", "r1p-fc-v1-002-a1", "decided"],
    ]);
  });
});

describe("A/B launch", () => {
  const LOADED = loadPrereg(ROOT);
  const sha = abPlanSha256(LOADED, 0, PUBLISHED);
  const abOpts = (out: string, over: Record<string, unknown> = {}) => ({
    loaded: LOADED,
    stage: 0 as const,
    published: PUBLISHED,
    outRoot: out,
    repoRoot: ROOT,
    oracleSources: SOURCES,
    launchRealTrials: true,
    planSha256: sha,
    ...over,
  });

  it("refuses with today's real preconditions (GO file, format, vocabulary) and the VM lock", async () => {
    const vm = fakeVm();
    const claude = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
    const r = await launchAbLive(abOpts(tmp()), deps(vm, claude, { vmLockOwned: () => false }));
    expect(r.exitCode).toBe(EXIT.refused);
    const all = r.refusals.join("\n");
    expect(all).toMatch(/no lead GO/);
    expect(all).toMatch(/the gate cannot read the task format/);
    expect(all).toMatch(/the VM session lock is not held/);
    expect(all).not.toMatch(/no live driver is wired/);
    expect(vm.built).toBe(0);
    expect(claude.calls).toEqual([]);
  });

  for (const [name, over, depOver, why] of [
    ["no flag", { launchRealTrials: false }, {}, /--launch-real-trials/],
    ["wrong plan sha", { planSha256: "f".repeat(64) }, {}, /abPlanSha256/],
    ["lock not held", {}, { vmLockOwned: () => false }, /VM session lock/],
    ["API name in env", {}, { env: { ANTHROPIC_API_KEY: "" } }, /ANTHROPIC_API_KEY/],
  ] as const)
    it(`with the real-run preconditions met (seam), still refuses: ${name}`, async () => {
      const vm = fakeVm();
      const claude = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
      let ran = false;
      const r = await launchAbLive(abOpts(tmp(), over), deps(vm, claude, depOver), {
        // Only the committed-file preconditions are stood in for; the flag and sha stay real.
        refusals: (o) =>
          [
            o.launchRealTrials !== true ? "needs --launch-real-trials" : null,
            o.liveLaunchSha256 !== sha ? "needs liveLaunchSha256 = abPlanSha256" : null,
          ].filter((x): x is string => x !== null),
        runStage: async () => {
          ran = true;
          throw new Error("must not run");
        },
      });
      expect(r.exitCode).toBe(EXIT.refused);
      expect(r.refusals.join("\n")).toMatch(why);
      expect(ran).toBe(false);
      expect(vm.built).toBe(0);
    });

  it("with every precondition and fakes, the stage runs on the live VM driver", async () => {
    const vm = fakeVm({ bootClass: "cold" });
    const claude = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
    const out = tmp();
    const seen: Parameters<typeof runAbStage>[0][] = [];
    const r = await launchAbLive(abOpts(out), deps(vm, claude), {
      refusals: () => [],
      runStage: async (o) => {
        seen.push(o);
        // Drive one transport of the driver the launch built: it is the live VM driver.
        const ctx = {
          task: task1(),
          runId: "ab-s0-on-fc-v1-001-a1",
          trialKey: "ab-s0-on-fc-v1-001-a1",
          trialDir: tmp(),
          signal: new AbortController().signal,
        };
        mkdirSync(join(ctx.trialDir, "gate-evidence"));
        const t = o.driver.transport(ctx);
        await t.runAgent(trialLaunchPlan(config(), task1(), ctx, ctx.trialDir, ROOT), null);
        const cap = await t.captureAfterStop();
        expect(Object.keys(cap).sort()).toEqual([HOST_CAPTURE_FILE, "persisted/doc.csv"]);
        expect(t.report().resetBootClass).toBe("cold");
        return {
          status: "complete",
          reason: null,
          stage: 0,
          chunksRun: 1,
          chunksDone: 1,
          chunks: 1,
          stopCode: null,
        };
      },
    });
    expect(r.exitCode).toBe(EXIT.complete);
    expect(seen).toHaveLength(1);
    const o = seen[0] as Parameters<typeof runAbStage>[0];
    expect(o.driver.simulated).toBe(false);
    expect(o.launchRealTrials).toBe(true);
    expect(o.liveLaunchSha256).toBe(sha);
    expect(o.plannerModelId).toBe("claude-sonnet-5-5");
    expect(vm.events[0]).toBe("reset");
    expect(claude.calls).toHaveLength(1);
    const status = JSON.parse(readFileSync(join(out, "stage0", LIVE_STATUS_FILE), "utf8"));
    expect(status).toMatchObject({ runner: "corrections-ab", state: "finished", exitCode: 0 });
  });

  it("the runner's own re-check still refuses when only the launch's check is bypassed", async () => {
    const vm = fakeVm();
    const claude = fakeClaude(() => ({ stdout: resultJson("x\nDONE") }));
    await expect(
      launchAbLive(abOpts(tmp()), deps(vm, claude), { refusals: () => [] }),
    ).rejects.toBeInstanceOf(AbRefusal);
    expect(vm.events).toEqual([]);
    expect(claude.calls).toEqual([]);
  });

  it("a stage's stop code maps to the CLI exit code", () => {
    expect(exitCodeFor({ status: "complete", stopCode: null })).toBe(0);
    expect(exitCodeFor({ status: "paused", stopCode: null })).toBe(4);
    expect(exitCodeFor({ status: "halted", stopCode: null })).toBe(4);
    expect(exitCodeFor({ status: "paused", stopCode: "billing" })).toBe(5);
    expect(exitCodeFor({ status: "paused", stopCode: "auth" })).toBe(5);
    expect(exitCodeFor({ status: "paused", stopCode: "api-key" })).toBe(5);
    expect(exitCodeFor({ status: "paused", stopCode: "repeat-failure" })).toBe(6);
  });
});

describe("the heartbeat file (watchdog-friendly)", () => {
  it("is rewritten atomically on a timer while the run is quiet", async () => {
    const dir = tmp();
    let t = 1_000;
    const s = new LiveStatus(dir, "r1-pilot", () => t, 5);
    const first = JSON.parse(readFileSync(join(dir, LIVE_STATUS_FILE), "utf8"));
    expect(first).toMatchObject({ state: "running", pid: process.pid, runner: "r1-pilot" });
    t = 9_000;
    await new Promise((r) => setTimeout(r, 40));
    const later = JSON.parse(readFileSync(join(dir, LIVE_STATUS_FILE), "utf8"));
    expect(Date.parse(later.updatedAt)).toBe(9_000);
    s.log("trial 1 decided");
    s.finish({ exitCode: 0 });
    expect(JSON.parse(readFileSync(join(dir, LIVE_STATUS_FILE), "utf8"))).toMatchObject({
      state: "finished",
      lastLog: "trial 1 decided",
      exitCode: 0,
    });
  });
});

describe("the real CLIs, with the trap claude first on PATH", () => {
  // A minimal environment: no inherited API-path name, no VM lock owner, VITEST kept so the
  // real VM backend would refuse even if a guard were bypassed.
  const env = () => ({
    PATH: `${TRAP_DIR}:${savedPath ?? "/usr/bin:/bin"}`,
    HOME: tmp("myco-cli-home-"),
    VITEST: "1",
  });
  const run = (script: string, args: string[]) =>
    spawnSync("npx", ["tsx", join(ROOT, "scripts", script), ...args], {
      cwd: ROOT,
      env: env(),
      encoding: "utf8",
      timeout: 45_000,
      killSignal: "SIGKILL",
    });

  it("R1: the flag and the right plan hash, outside vm-session.sh: refused, nothing run", {
    timeout: 60_000,
  }, () => {
    const out = tmp();
    const plan = JSON.parse(run("m2-r1-pilot.ts", ["plan", "--out", out]).stdout) as {
      configSha256: string;
    };
    const r = run("m2-r1-pilot.ts", [
      "launch",
      "--out",
      out,
      "--launch-real-trials",
      "--plan-sha256",
      plan.configSha256,
    ]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/the VM session lock is not held/);
    expect(existsSync(join(out, PROGRESS_FILE))).toBe(false);
    expect(existsSync(TRAP_MARK)).toBe(false);
  });

  it("A/B: launch refuses with every unmet precondition, no 'not wired' reason", {
    timeout: 60_000,
  }, () => {
    const sha = abPlanSha256(loadPrereg(ROOT), 0, PUBLISHED);
    const out = tmp();
    const r = run("m2-corrections-ab-run.ts", [
      "launch",
      "--stage",
      "0",
      "--out",
      out,
      "--launch-real-trials",
      "--plan-sha256",
      sha,
    ]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/no lead GO/);
    expect(r.stderr).toMatch(/the VM session lock is not held/);
    expect(r.stderr).not.toMatch(/no live driver is wired/);
    expect(existsSync(join(out, "stage0", LIVE_STATUS_FILE))).toBe(false);
    expect(existsSync(TRAP_MARK)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// PR #598 round 2
// ---------------------------------------------------------------------------------------------

const notJson = { stdout: "not json", code: 1 };
const decided = { stdout: resultJson("x\nDONE") };
const attemptsOf = (out: string, taskId: string) =>
  loadLedger(join(out, PROGRESS_FILE)).byTask.get(taskId) ?? [];

describe("round 2, D1: the repeat-failure rule survives --resume", () => {
  it("the verifier's repro: resume with the same failure stops after ONE spawn, no next trial", async () => {
    const out = tmp();
    const cfg = twoTrials();
    const first = fakeClaude(() => notJson);
    const r1 = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), first));
    expect(r1.exitCode).toBe(EXIT.repeatFailure);
    expect(first.calls).toHaveLength(2);
    // The fault's message is in the ledger.
    expect(ledgerEnds(out).map((e) => e.faultMessage)).toEqual([
      "claude exited 1 without a JSON result (stderr 0 bytes)",
      "claude exited 1 without a JSON result (stderr 0 bytes)",
    ]);
    const vm2 = fakeVm();
    const second = fakeClaude(() => notJson);
    const r2 = await launchR1Live(r1Opts(cfg, out), deps(vm2, second));
    expect(r2.exitCode).toBe(EXIT.repeatFailure);
    expect(r2.result?.stopCode).toBe("repeat-failure");
    expect(second.calls).toHaveLength(1);
    expect(vm2.events.filter((e) => e === "reset")).toHaveLength(1);
    expect(attemptsOf(out, "fc-v1-002")).toHaveLength(0);
  });

  it("a fault, then a crash, then the identical fault after resume: still aborts", async () => {
    const out = tmp();
    const cfg = twoTrials();
    // Run 1: one fault, then the operator's PAUSE stops new starts.
    const first = fakeClaude(
      () => notJson,
      () => writeFileSync(join(out, "PAUSE"), ""),
    );
    const r1 = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), first));
    expect(r1.exitCode).toBe(EXIT.paused);
    expect(first.calls).toHaveLength(1);
    // The runner then dies mid-trial in attempt 2: a start with no end.
    const path = join(out, PROGRESS_FILE);
    new AttemptLedger(path, false).start({
      taskId: "fc-v1-001",
      attempt: 2,
      trialKey: "r1p-fc-v1-001-a2",
      runId: "r1p-fc-v1-001-a2",
      supersedes: "r1p-fc-v1-001-a1",
    });
    rmSync(join(out, "PAUSE"));
    const second = fakeClaude(() => notJson);
    const r2 = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), second));
    expect(r2.exitCode).toBe(EXIT.repeatFailure);
    expect(second.calls).toHaveLength(1);
    expect(attemptsOf(out, "fc-v1-001").map((a) => a.end?.harnessClass)).toEqual([
      "transport-error",
      "crash",
      "transport-error",
    ]);
    expect(attemptsOf(out, "fc-v1-002")).toHaveLength(0);
  });

  it("after resume a DIFFERENT failure of the same class does not abort (no decided trial between); then both trials decide", async () => {
    const out = tmp();
    const cfg = twoTrials();
    const first = fakeClaude(
      () => notJson,
      () => writeFileSync(join(out, "PAUSE"), ""),
    );
    await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), first));
    rmSync(join(out, "PAUSE"));
    const outputs = [{ stdout: "not json", stderr: "boom", code: 1 }, decided, decided];
    const second = fakeClaude((n) => outputs[n - 1] as (typeof outputs)[0]);
    const r2 = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), second));
    expect(r2.exitCode).toBe(EXIT.complete);
    expect(second.calls).toHaveLength(3);
  });

  it("resumeFaultSignature: last counted fault in file order; decided clears; exempt and recovered ends skipped", () => {
    const end = (o: Record<string, unknown>) =>
      ({
        schema: "myco.pilot.attempt/1",
        event: "end",
        trialKey: "k",
        recovered: false,
        armRow: null,
        cost: null,
        at: "",
        outcome: "harness-fault",
        ...o,
      }) as unknown as Parameters<typeof resumeFaultSignature>[0][number];
    const te = end({ harnessClass: "transport-error", faultMessage: "m" });
    const sig = faultSignature("transport-error", "m");
    expect(resumeFaultSignature([])).toBeNull();
    expect(resumeFaultSignature([te])).toBe(sig);
    expect(resumeFaultSignature([te, end({ outcome: "decided", harnessClass: null })])).toBeNull();
    for (const cls of ["rate-limit", "auth", "billing", "usage-limit"])
      expect(resumeFaultSignature([te, end({ harnessClass: cls, faultMessage: "z" })])).toBe(sig);
    expect(
      resumeFaultSignature([
        te,
        end({ harnessClass: "crash", recovered: true, faultMessage: "c" }),
      ]),
    ).toBe(sig);
    expect(resumeFaultSignature([te, end({ harnessClass: "timeout" })])).toBeNull();
    expect(resumeFaultSignature([te, end({ harnessClass: "timeout", faultMessage: "m" })])).toBe(
      faultSignature("timeout", "m"),
    );
  });
});

describe("round 2, D3: the subscription's usage limit stops; transient limits back off, bounded", () => {
  it("each quota phrasing stops at once: exit 7, one spawn, zero attempts spent, report for the lead", async () => {
    for (const phrase of USAGE_LIMIT_PHRASES) {
      for (const output of [
        { stdout: "", stderr: phrase, code: 1 },
        { stdout: resultJson(phrase, { is_error: true }), code: 1 },
      ]) {
        const out = tmp();
        const cfg = twoTrials(config({ maxAttemptsPerTrial: 1 }));
        const vm = fakeVm();
        const claude = fakeClaude(() => output);
        const d = deps(vm, claude);
        const r = await launchR1Live(r1Opts(cfg, out), d);
        expect([phrase, r.exitCode]).toEqual([phrase, EXIT.usageLimit]);
        expect(r.result?.stopCode).toBe("usage-limit");
        expect(r.result?.reason).toMatch(/must go to the lead/);
        expect(d.lines).toContain(USAGE_LIMIT_REPORT);
        expect(claude.calls).toHaveLength(1);
        expect(vm.events.filter((e) => e === "reset")).toHaveLength(1);
        const list = attemptsOf(out, "fc-v1-001");
        expect(list.map((a) => a.end?.harnessClass)).toEqual(["usage-limit"]);
        // Zero attempts consumed: even with a budget of 1 the trial is still open.
        expect(taskStatus(list, 1)).toMatchObject({ kind: "open", nextAttempt: 2 });
        const status = JSON.parse(readFileSync(join(out, LIVE_STATUS_FILE), "utf8"));
        expect(status.exitCode).toBe(EXIT.usageLimit);
      }
    }
    expect(exitCodeFor({ status: "paused", stopCode: "usage-limit" })).toBe(7);
  });

  it("a transient 429/529/overloaded backs off within bounds and keeps the attempt budget", async () => {
    for (const fault of [
      { stdout: "", stderr: "API Error: 429 rate_limit_error", code: 1 },
      { stdout: "", stderr: "API Error: 529 overloaded_error", code: 1 },
      {
        stdout: JSON.stringify([
          { type: "assistant", error: "overloaded", message: { content: [] } },
          JSON.parse(resultJson("API Error", { is_error: true })),
        ]),
        code: 1,
      },
    ]) {
      const out = tmp();
      const cfg = twoTrials(config({ maxAttemptsPerTrial: 1, interTrialDelayS: 0 }));
      const vm = fakeVm();
      const outputs = [fault, decided, decided];
      const claude = fakeClaude((n) => outputs[n - 1] as (typeof outputs)[0]);
      const clock = virtualClock(Date.parse("2026-11-27T00:00:00Z"));
      const r = await launchR1Live(
        r1Opts(cfg, out),
        deps(vm, claude, { sleep: clock.sleep, now: clock.now }),
      );
      expect(r.exitCode).toBe(EXIT.complete);
      expect(r.result).toMatchObject({ status: "complete", ran: 2, faulted: 1, stopCode: null });
      // Re-run once, after the back-off: within [rateLimitBackoffS, rateLimitBackoffMaxS].
      const backoff = clock.waits.filter((w) => w > 0);
      expect(backoff.length).toBeGreaterThan(0);
      expect(Math.max(...backoff)).toBeLessThanOrEqual(cfg.pacing.rateLimitBackoffMaxS * 1000);
      expect(backoff.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(
        cfg.pacing.rateLimitBackoffS * 1000,
      );
      // The trial's budget of ONE attempt was not spent by the limit: attempt 2 decided it.
      expect(attemptsOf(out, "fc-v1-001").map((a) => a.end?.outcome)).toEqual([
        "harness-fault",
        "decided",
      ]);
      // One extra cold reset for the limited trial, none for the other.
      expect(vm.events.filter((e) => e === "reset")).toHaveLength(3);
    }
  });

  it("a second transient limit on the same trial pauses instead of a further cold reset", async () => {
    const out = tmp();
    const cfg = twoTrials();
    expect(cfg.pacing.maxConsecutiveRateLimits).toBeGreaterThan(2);
    const vm = fakeVm();
    const claude = fakeClaude(() => ({ stdout: "", stderr: "API Error: 429", code: 1 }));
    const r = await launchR1Live(r1Opts(cfg, out), deps(vm, claude));
    expect(r.exitCode).toBe(EXIT.paused);
    expect(r.result).toMatchObject({ status: "paused", stopCode: null, exhausted: [] });
    expect(r.result?.reason).toMatch(/no further cold reset/);
    expect(claude.calls).toHaveLength(2);
    expect(vm.events.filter((e) => e === "reset")).toHaveLength(2);
    const list = attemptsOf(out, "fc-v1-001");
    expect(taskStatus(list, cfg.pacing.maxAttemptsPerTrial).kind).toBe("open");
    expect(r.result).toMatchObject({ transientCapped: ["fc-v1-001"] });
    // Round 3, F2: the cap is ledger-durable. A resume does not start fc-v1-001 again (no third
    // cold reset); it runs the other trial and stays paused, naming the capped trial.
    const vm2 = fakeVm();
    const again = fakeClaude(() => decided);
    const r2 = await launchR1Live(r1Opts(cfg, out), deps(vm2, again));
    expect(r2.exitCode).toBe(EXIT.paused);
    expect(r2.result).toMatchObject({ status: "paused", stopCode: null, ran: 1 });
    expect(r2.result).toMatchObject({ transientCapped: ["fc-v1-001"] });
    expect(r2.result?.reason).toMatch(/fc-v1-001\. Take them to the lead/);
    expect(again.calls.map((c) => c.options.cwd?.toString().split("/").pop())).toEqual([
      "r1p-fc-v1-002-a1",
    ]);
    expect(vm2.events.filter((e) => e === "reset")).toHaveLength(1);
    expect(attemptsOf(out, "fc-v1-001")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// PR #598 round 3
// ---------------------------------------------------------------------------------------------

const keyOf = (c: SpawnCall) => c.options.cwd?.toString().split("/").pop() as string;

describe("round 3, F2: at most one extra cold reset per trial, in total, across --resume", () => {
  // fc-v1-001 hits a persistent transient limit; fc-v1-002 decides.
  const persistent529 = (c: SpawnCall) =>
    keyOf(c).startsWith("r1p-fc-v1-001-")
      ? { stdout: "", stderr: "API Error: 529 overloaded_error", code: 1 }
      : decided;

  for (const [name, pacing] of [
    ["the second limit pauses in-run (default pacing)", {}],
    [
      "each invocation pauses after one limit (maxConsecutiveRateLimits 1)",
      { maxConsecutiveRateLimits: 1 },
    ],
  ] as const)
    it(`a persistent 529 over the first run and 3 resumes: 2 spawns and 2 resets for the trial in total (${name})`, async () => {
      const out = tmp();
      const cfg = twoTrials(config({ maxAttemptsPerTrial: 1, ...pacing }));
      const allKeys: string[] = [];
      let resetsTotal = 0;
      const exits: number[] = [];
      for (let inv = 0; inv < 4; inv++) {
        const vm = fakeVm();
        const calls: SpawnCall[] = [];
        const claude = fakeClaude(
          (n) => persistent529(calls[n - 1] as SpawnCall),
          (c) => calls.push(c),
        );
        const r = await launchR1Live(r1Opts(cfg, out), deps(vm, claude));
        exits.push(r.exitCode);
        allKeys.push(...claude.calls.map(keyOf));
        resetsTotal += vm.events.filter((e) => e === "reset").length;
      }
      const t1 = allKeys.filter((k) => k.startsWith("r1p-fc-v1-001-"));
      // One normal start plus ONE extra cold reset, never more, over all four invocations.
      expect(t1).toEqual(["r1p-fc-v1-001-a1", "r1p-fc-v1-001-a2"]);
      expect(allKeys.filter((k) => k.startsWith("r1p-fc-v1-002-"))).toEqual(["r1p-fc-v1-002-a1"]);
      expect(resetsTotal).toBe(3);
      // Every invocation pauses (resumable, exit 4); none completes with the trial open.
      expect(exits.every((e) => e === EXIT.paused)).toBe(true);
      // The trial's attempt budget (1) is not spent by the limit: it is open, not exhausted.
      expect(taskStatus(attemptsOf(out, "fc-v1-001"), 1).kind).toBe("open");
    });

  it("transientFaultCounts counts every invocation's rate-limit ends per task, nothing else", () => {
    const rec = (cls: string | null, open = false): AttemptRecord =>
      ({ start: {}, end: open ? null : { harnessClass: cls } }) as unknown as AttemptRecord;
    const m = new Map([
      ["a", [rec("rate-limit"), rec("transport-error"), rec("rate-limit")]],
      ["b", [rec("usage-limit"), rec("auth"), rec(null), rec(null, true)]],
    ]);
    expect([...transientFaultCounts(m)]).toEqual([["a", 2]]);
  });
});

describe("round 3, R2-D3a/b: quota wording stops with exit 7 on plain stdout and in a claimless clean result", () => {
  const expectUsageStop = async (output: { stdout: string; stderr?: string; code?: number }) => {
    const out = tmp();
    const cfg = twoTrials(config({ maxAttemptsPerTrial: 1 }));
    const vm = fakeVm();
    const claude = fakeClaude(() => output);
    const d = deps(vm, claude);
    const r = await launchR1Live(r1Opts(cfg, out), d);
    const list = attemptsOf(out, "fc-v1-001");
    return {
      exit: r.exitCode,
      stopCode: r.result?.stopCode,
      spawns: claude.calls.length,
      resets: vm.events.filter((e) => e === "reset").length,
      classes: list.map((a) => a.end?.harnessClass),
      open: taskStatus(list, 1).kind,
      report: d.lines.includes(USAGE_LIMIT_REPORT),
      t2: attemptsOf(out, "fc-v1-002").length,
    };
  };
  const STOPPED = {
    exit: EXIT.usageLimit,
    stopCode: "usage-limit",
    spawns: 1,
    resets: 1,
    classes: ["usage-limit"],
    open: "open",
    report: true,
    t2: 0,
  };

  it("R2-D3a: every phrasing on plain stdout, exit 1 and exit 0: exit 7, one spawn, one reset, zero attempts, lead report", async () => {
    for (const phrase of USAGE_LIMIT_PHRASES)
      for (const code of [1, 0])
        expect([phrase, code, await expectUsageStop({ stdout: phrase, code })]).toEqual([
          phrase,
          code,
          STOPPED,
        ]);
  });

  it("R2-D3b: the verdict's exact clean result, and each phrasing as a clean result, stop with exit 7", async () => {
    const exact =
      '{"type":"result","subtype":"success","is_error":false,"result":"Claude AI usage limit reached|1700000000"}';
    expect(await expectUsageStop({ stdout: exact, code: 0 })).toEqual(STOPPED);
    for (const phrase of USAGE_LIMIT_PHRASES)
      expect([phrase, await expectUsageStop({ stdout: resultJson(phrase), code: 0 })]).toEqual([
        phrase,
        STOPPED,
      ]);
  });

  it("R2-D3b: a clean result with 429/401/403 task data, or with a claim line plus usage words, stays the agent's outcome", async () => {
    for (const text of [
      "EMP-0055 qty 429; EMP-0127 qty 401; EMP-0090 qty 403",
      "Claude AI usage limit reached|1700000000\nDONE",
      "5-hour limit reached ∙ resets 3pm\nNOT DONE",
      "The weekly limit column is fixed.\nDONE",
    ]) {
      const out = tmp();
      const claude = fakeClaude(() => ({ stdout: resultJson(text), code: 0 }));
      const r = await launchR1Live(r1Opts(twoTrials(), out), deps(fakeVm(), claude));
      expect([text, r.exitCode]).toEqual([text, EXIT.complete]);
      expect(r.result).toMatchObject({ status: "complete", ran: 2, faulted: 0, stopCode: null });
      const end = attemptsOf(out, "fc-v1-001")[0]?.end;
      expect(end?.outcome).toBe("decided");
      const want = text.endsWith("NOT DONE")
        ? "not-done"
        : text.endsWith("DONE")
          ? "done"
          : "no-claim";
      expect([text, end?.armRow?.claim]).toEqual([text, want]);
    }
  });
});

describe("#606 S1+S2: stderr-only quota wording on a claimless clean result, and Unicode whitespace, stop with exit 7", () => {
  const launchWith = async (output: { stdout: string; stderr?: string; code?: number }) => {
    const out = tmp();
    const cfg = twoTrials(config({ maxAttemptsPerTrial: 1 }));
    const vm = fakeVm();
    const claude = fakeClaude(() => output);
    const d = deps(vm, claude);
    const r = await launchR1Live(r1Opts(cfg, out), d);
    const list = attemptsOf(out, "fc-v1-001");
    return {
      exit: r.exitCode,
      stopCode: r.result?.stopCode ?? null,
      spawns: claude.calls.length,
      resets: vm.events.filter((e) => e === "reset").length,
      classes: list.map((a) => a.end?.harnessClass ?? null),
      open: taskStatus(list, 1).kind,
      report: d.lines.includes(USAGE_LIMIT_REPORT),
      t2: attemptsOf(out, "fc-v1-002").length,
      outcomes: list.map((a) => a.end?.outcome ?? null),
      // Only a decided end's arm row is counted (`ledgerRows`); its claim is the agent's.
      claim: list[0]?.end?.outcome === "decided" ? (list[0].end.armRow?.claim ?? null) : null,
    };
  };
  // Exit 7, one spawn, one reset, the trial still open with its one attempt unspent (nothing
  // counted), the lead report, and the next trial never started.
  const STOPPED = {
    exit: EXIT.usageLimit,
    stopCode: "usage-limit",
    spawns: 1,
    resets: 1,
    classes: ["usage-limit"],
    open: "open",
    report: true,
    t2: 0,
    outcomes: ["harness-fault"],
    claim: null,
  };
  // The agent's outcome: both trials decided, the claim as written, no stop.
  const decidedAs = (claim: string) => ({
    exit: EXIT.complete,
    stopCode: null,
    spawns: 2,
    resets: 2,
    classes: [null],
    open: "done",
    report: false,
    t2: 1,
    outcomes: ["decided"],
    claim,
  });

  it("S1: every phrasing on stderr only, with a claimless clean result, exit 0 and exit 1: exit 7, one spawn, one reset, zero attempts, lead report", async () => {
    for (const phrase of USAGE_LIMIT_PHRASES)
      for (const code of [0, 1])
        expect([
          phrase,
          code,
          await launchWith({ stdout: resultJson("I edited the document."), stderr: phrase, code }),
        ]).toEqual([phrase, code, STOPPED]);
  });

  it("S1: the same stderr with a DONE / NOT DONE claim line on a clean result stays the agent's outcome", async () => {
    for (const phrase of USAGE_LIMIT_PHRASES)
      for (const [line, claim] of [
        ["DONE", "done"],
        ["NOT DONE", "not-done"],
      ] as const)
        expect([
          phrase,
          line,
          await launchWith({ stdout: resultJson(`Edited.\n${line}`), stderr: phrase, code: 0 }),
        ]).toEqual([phrase, line, decidedAs(claim)]);
  });

  // Split per phrase (#607 round 1, D1): each phrase's matrix is one test, well inside the
  // default timeout on the macOS runner. The matrix itself is unchanged.
  it.each(USAGE_LIMIT_PHRASES)(
    "S2: %s with each Unicode whitespace, on stderr, on plain stdout and as a claimless clean result: exit 7",
    async (phrase) => {
      for (const [name, sp] of UNICODE_SPACES) {
        const t = spaced(phrase, sp);
        for (const [shape, output] of [
          ["stderr", { stdout: "", stderr: t, code: 1 }],
          ["plain stdout", { stdout: t, code: 1 }],
          ["plain stdout, exit 0", { stdout: t, code: 0 }],
          ["clean claimless result", { stdout: resultJson(t), code: 0 }],
          ["stderr, claimless clean result", { stdout: resultJson("Edited."), stderr: t, code: 0 }],
        ] as const)
          expect([phrase, name, shape, await launchWith(output)]).toEqual([
            phrase,
            name,
            shape,
            STOPPED,
          ]);
      }
    },
  );

  it.each(USAGE_LIMIT_PHRASES)(
    "S2: %s, spaced, with a claim line on a clean result stays the agent's outcome",
    async (phrase) => {
      for (const [name, sp] of UNICODE_SPACES) {
        const t = spaced(phrase, sp);
        expect([
          phrase,
          name,
          await launchWith({ stdout: resultJson(`${t}\nDONE`), stderr: t, code: 0 }),
        ]).toEqual([phrase, name, decidedAs("done")]);
        expect([
          phrase,
          name,
          await launchWith({ stdout: resultJson(`${t}\nNOT DONE`), code: 0 }),
        ]).toEqual([phrase, name, decidedAs("not-done")]);
      }
    },
  );

  it("negatives: 401/403/429 task data with NBSP (in the result or on stderr) stays the agent's outcome", async () => {
    const nb = NBSP;
    for (const [stdout, stderr] of [
      [resultJson(spaced("EMP-0055 qty 429; EMP-0127 qty 401; EMP-0090 qty 403", nb)), ""],
      [resultJson("Edited."), spaced("API Error: 429 Too Many Requests", nb)],
      [resultJson("Edited."), spaced("HTTP 401 Unauthorized; 403 Forbidden", nb)],
      [resultJson(spaced("qty 429\nqty 401\nqty 403", nb)), spaced("status 429 401 403", nb)],
    ] as const)
      expect([stdout, stderr, await launchWith({ stdout, stderr, code: 0 })]).toEqual([
        stdout,
        stderr,
        decidedAs("no-claim"),
      ]);
  });

  it("round 2 F-A: quota wording with a format character or a hyphen variant inside stops with exit 7 on every shape; a claim line keeps the agent's outcome", async () => {
    for (const [name, t] of FOLDED_USAGE_PHRASES) {
      for (const [shape, output] of [
        ["stderr", { stdout: "", stderr: t, code: 1 }],
        ["plain stdout", { stdout: t, code: 1 }],
        ["plain stdout, exit 0", { stdout: t, code: 0 }],
        ["clean claimless result", { stdout: resultJson(t), code: 0 }],
        ["stderr, claimless clean result", { stdout: resultJson("Edited."), stderr: t, code: 0 }],
      ] as const)
        expect([name, shape, await launchWith(output)]).toEqual([name, shape, STOPPED]);
      expect([name, await launchWith({ stdout: resultJson(`${t}\nDONE`), stderr: t })]).toEqual([
        name,
        decidedAs("done"),
      ]);
    }
  });

  it("round 2 F-B: billing and auth wording with NBSP, a thin space or ZWSP on plain stdout or stderr stops with exit 5, not a spent attempt", async () => {
    for (const [text, cls] of [
      ["Credit balance is too low", "billing"],
      ["You're out of extra usage", "billing"],
      ["Not logged in", "auth"],
      ["OAuth token has expired", "auth"],
    ] as const)
      for (const sp of [NBSP, THIN_SPACE, ZWSP])
        for (const output of [
          { stdout: spaced(text, sp), code: 1 },
          { stdout: "", stderr: spaced(text, sp), code: 1 },
        ]) {
          const r = await launchWith(output);
          expect([
            text,
            sp.charCodeAt(0),
            output.stdout === "",
            r.exit,
            r.stopCode,
            r.classes,
          ]).toEqual([
            text,
            sp.charCodeAt(0),
            output.stdout === "",
            EXIT.subscriptionStop,
            cls,
            [cls],
          ]);
        }
  });

  it("round 2 F-B: the broad vocabulary with NBSP or a thin space is never applied to a clean result", async () => {
    for (const sp of [NBSP, THIN_SPACE])
      for (const [stdout, stderr] of [
        [resultJson(spaced("You've hit your rate limit", sp)), spaced("rate limit reached", sp)],
        [resultJson(spaced("Too many requests; billing address updated", sp)), ""],
        [resultJson("Edited."), spaced("quota column fixed; credential field cleared; 403", sp)],
      ] as const)
        expect([stdout, stderr, await launchWith({ stdout, stderr, code: 0 })]).toEqual([
          stdout,
          stderr,
          decidedAs("no-claim"),
        ]);
  });

  // A billing or auth stop: exit 5 with the class as the stop code, one spawn, one reset, the
  // trial still open with its one attempt unspent, nothing counted, the next trial not started.
  const subscriptionStopped = (cls: string) => ({
    exit: EXIT.subscriptionStop,
    stopCode: cls,
    spawns: 1,
    resets: 1,
    classes: [cls],
    open: "open",
    report: false,
    t2: 0,
    outcomes: ["harness-fault"],
    claim: null,
  });
  // A transient limit, repeated: backed off once (one extra cold reset), then paused with the
  // trial open and its attempt unspent (the ledger-durable cap, round 3 F2).
  const TRANSIENT_PAUSED = {
    exit: EXIT.paused,
    stopCode: null,
    spawns: 2,
    resets: 2,
    classes: ["rate-limit", "rate-limit"],
    open: "open",
    report: false,
    t2: 0,
    outcomes: ["harness-fault", "harness-fault"],
    claim: null,
  };
  const expectedFor = (cls: string) =>
    cls === "usage-limit"
      ? STOPPED
      : cls === "rate-limit"
        ? TRANSIENT_PAUSED
        : subscriptionStopped(cls);

  it("round 2 F-B, updated by round 3 L1: the exact CLI billing and auth phrases on a claimless clean result now stop with exit 5", async () => {
    for (const sp of [NBSP, THIN_SPACE])
      for (const [stdout, stderr, cls] of [
        [resultJson(spaced("Credit balance is too low; not logged in", sp)), "", "auth"],
        [
          resultJson("Edited."),
          spaced("Too many requests; Credit balance is too low", sp),
          "billing",
        ],
      ] as const)
        expect([stdout, stderr, await launchWith({ stdout, stderr, code: 0 })]).toEqual([
          stdout,
          stderr,
          subscriptionStopped(cls),
        ]);
  });

  // #607 round 3, B2: an unmapped structured class no longer hides the text vocabulary.
  it.each(UNMAPPED_STRUCTURED)(
    "round 3 B2: %s with quota, billing, auth or transient wording stops or backs off as its class, the attempt unspent",
    async (_name, s) => {
      const withAssistant = (res: string | null) =>
        JSON.stringify([
          { type: "assistant", message: { content: [] }, ...s },
          ...(res === null ? [] : [JSON.parse(res)]),
        ]);
      const errRes = (text: string) =>
        resultJson(text, { is_error: true, subtype: "error_during_execution" });
      for (const [t, cls] of FAULT_WORDING)
        for (const [shape, output] of [
          ["error result text", { stdout: withAssistant(errRes(t)), code: 1 }],
          [
            "stderr with an error result",
            { stdout: withAssistant(errRes("API Error")), stderr: t, code: 1 },
          ],
          ["no result event, stderr", { stdout: withAssistant(null), stderr: t, code: 1 }],
          [
            "clean-looking DONE result, exit 0, stderr",
            { stdout: withAssistant(resultJson("x\nDONE")), stderr: t, code: 0 },
          ],
        ] as const)
          expect([t, shape, await launchWith(output)]).toEqual([t, shape, expectedFor(cls)]);
      // With no vocabulary the structured class stands: an unclassified error result, which
      // is re-run and spends the attempt (unchanged behaviour).
      const plain = await launchWith({
        stdout: withAssistant(errRes("Something went wrong.")),
        code: 1,
      });
      expect(plain.classes[0]).toBe("error-result");
      expect(plain.open).not.toBe("open");
    },
  );

  // #607 round 3, L1, end to end.
  it("round 3 L1: each narrow billing or auth phrase as a claimless clean result (text or stderr-only) stops with exit 5; with a claim line it is decided; task data stays no-claim", async () => {
    for (const [t0, cls] of CLEAN_RESULT_FAULT_PHRASES)
      for (const t of [t0, spaced(t0, NBSP), spaced(t0, ZWSP)]) {
        for (const [shape, output] of [
          ["clean claimless result", { stdout: resultJson(t), code: 0 }],
          ["stderr, claimless clean result", { stdout: resultJson("Edited."), stderr: t, code: 0 }],
        ] as const)
          expect([t, shape, await launchWith(output)]).toEqual([
            t,
            shape,
            subscriptionStopped(cls),
          ]);
        expect([
          t,
          await launchWith({ stdout: resultJson(`${t}\nDONE`), stderr: t, code: 0 }),
        ]).toEqual([t, decidedAs("done")]);
        expect([t, await launchWith({ stdout: resultJson(`${t}\nNOT DONE`), code: 0 })]).toEqual([
          t,
          decidedAs("not-done"),
        ]);
      }
    for (const t of CLEAN_RESULT_TASK_DATA)
      for (const output of [
        { stdout: resultJson(t), code: 0 },
        { stdout: resultJson("Edited."), stderr: spaced(t, NBSP), code: 0 },
      ])
        expect([t, await launchWith(output)]).toEqual([t, decidedAs("no-claim")]);
  });

  it("the A/B launch's live driver shares the classifier: stderr-only and NBSP quota wording is usage-limit there too", async () => {
    const LOADED = loadPrereg(ROOT);
    for (const output of [
      { stdout: resultJson("Edited."), stderr: "Claude AI usage limit reached|1700000000" },
      { stdout: resultJson(spaced("5-hour limit reached ∙ resets 3pm", NBSP)) },
      { stdout: spaced("Weekly limit reached ∙ resets Mon", String.fromCharCode(0x202f)), code: 1 },
    ]) {
      const claude = fakeClaude(() => output);
      const faults: unknown[] = [];
      const r = await launchAbLive(
        {
          loaded: LOADED,
          stage: 0,
          published: PUBLISHED,
          outRoot: tmp(),
          repoRoot: ROOT,
          oracleSources: SOURCES,
          launchRealTrials: true,
          planSha256: abPlanSha256(LOADED, 0, PUBLISHED),
        },
        deps(fakeVm(), claude),
        {
          refusals: () => [],
          runStage: async (o) => {
            const ctx = {
              task: task1(),
              runId: "ab-s0-on-fc-v1-001-a1",
              trialKey: "ab-s0-on-fc-v1-001-a1",
              trialDir: tmp(),
              signal: new AbortController().signal,
            };
            mkdirSync(join(ctx.trialDir, "gate-evidence"));
            const t = o.driver.transport(ctx);
            await t
              .runAgent(trialLaunchPlan(config(), task1(), ctx, ctx.trialDir, ROOT), null)
              .catch((e: unknown) => faults.push(e));
            return {
              status: "complete",
              reason: null,
              stage: 0,
              chunksRun: 1,
              chunksDone: 1,
              chunks: 1,
              stopCode: null,
            };
          },
        },
      );
      expect(r.exitCode).toBe(EXIT.complete);
      expect(claude.calls).toHaveLength(1);
      expect(faults).toHaveLength(1);
      expect(faults[0]).toBeInstanceOf(HarnessFault);
      expect([output, (faults[0] as HarnessFault).harnessClass]).toEqual([output, "usage-limit"]);
    }
  });
});

describe("round 3: the A/B launch reports a usage-limit stop to the lead (kills O-6)", () => {
  it("a stage that stopped on usage-limit: exit 7, the lead report on the log and in the heartbeat", async () => {
    const LOADED = loadPrereg(ROOT);
    const sha = abPlanSha256(LOADED, 0, PUBLISHED);
    const out = tmp();
    const d = deps(
      fakeVm(),
      fakeClaude(() => decided),
    );
    const r = await launchAbLive(
      {
        loaded: LOADED,
        stage: 0,
        published: PUBLISHED,
        outRoot: out,
        repoRoot: ROOT,
        oracleSources: SOURCES,
        launchRealTrials: true,
        planSha256: sha,
      },
      d,
      {
        refusals: () => [],
        runStage: async () => ({
          status: "paused",
          reason: "chunk 0, arm on: stopped (usage-limit)",
          stage: 0,
          chunksRun: 0,
          chunksDone: 0,
          chunks: 1,
          stopCode: "usage-limit",
        }),
      },
    );
    expect(r.exitCode).toBe(EXIT.usageLimit);
    expect(d.lines).toContain(USAGE_LIMIT_REPORT);
    const status = JSON.parse(readFileSync(join(out, "stage0", LIVE_STATUS_FILE), "utf8"));
    expect(status).toMatchObject({
      runner: "corrections-ab",
      state: "finished",
      exitCode: EXIT.usageLimit,
      lastLog: USAGE_LIMIT_REPORT,
    });
  });
});

describe("round 3: a decided end before the stop clears the resume seed (kills O-10)", () => {
  it("fault, decided, PAUSE, resume, the same fault: no abort; the run completes", async () => {
    const out = tmp();
    const cfg = twoTrials();
    // Run 1: fc-v1-001 faults, then decides on its re-run; PAUSE stops before fc-v1-002.
    const first = fakeClaude(
      (n) => (n === 1 ? notJson : decided),
      (_c, n) => {
        if (n === 2) writeFileSync(join(out, "PAUSE"), "");
      },
    );
    const r1 = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), first));
    expect(r1.exitCode).toBe(EXIT.paused);
    expect(first.calls).toHaveLength(2);
    expect(ledgerEnds(out).map((e) => e.outcome)).toEqual(["harness-fault", "decided"]);
    expect(resumeFaultSignature(loadLedger(join(out, PROGRESS_FILE)).ends)).toBeNull();
    rmSync(join(out, "PAUSE"));
    // Run 2: the identical fault once on fc-v1-002, then it decides: not a repeat.
    const second = fakeClaude((n) => (n === 1 ? notJson : decided));
    const r2 = await launchR1Live(r1Opts(cfg, out), deps(fakeVm(), second));
    expect(r2.exitCode).toBe(EXIT.complete);
    expect(r2.result).toMatchObject({ status: "complete", stopCode: null });
    expect(second.calls).toHaveLength(2);
  });
});

describe("round 2, D4: same class, different message is not a repeat", () => {
  it("two transport-errors with different messages, then success: completes", async () => {
    const outputs = [notJson, { stdout: "not json", stderr: "boom", code: 1 }, decided, decided];
    const claude = fakeClaude((n) => outputs[n - 1] as (typeof outputs)[0]);
    const out = tmp();
    const r = await launchR1Live(r1Opts(twoTrials(), out), deps(fakeVm(), claude));
    expect(r.exitCode).toBe(EXIT.complete);
    expect(r.result).toMatchObject({ status: "complete", ran: 2, faulted: 2, stopCode: null });
    const ends = attemptsOf(out, "fc-v1-001").map((a) => a.end);
    expect(ends[0]?.harnessClass).toBe(ends[1]?.harnessClass);
    expect(ends[0]?.faultMessage).not.toBe(ends[1]?.faultMessage);
    // ... and the same two identical ones do stop.
    const same = fakeClaude((n) => (n <= 2 ? notJson : decided));
    const r2 = await launchR1Live(r1Opts(twoTrials(), tmp()), deps(fakeVm(), same));
    expect(r2.exitCode).toBe(EXIT.repeatFailure);
    expect(same.calls).toHaveLength(2);
  });
});

describe("the trap claude was never run", () => {
  it("no test in this file invoked a `claude` binary", () => {
    expect(existsSync(TRAP_MARK)).toBe(false);
  });
});
