/**
 * Track L — the trial pool's guards, on a portable fake backend (runs on macOS and Linux).
 *
 * Every guard here is mutation-proved: the PR body's mutation table names the line each
 * test kills. The fake backend has no isolation of its own, which is what lets the
 * contamination tests leak on purpose and prove the detector catches it.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateResult } from "../../src/gate/api.ts";
import {
  type AgentBehaviour,
  claimFor,
  editedCsv,
  type ScriptedDesktopAgent,
  scriptedFileAgent,
} from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import {
  CAPTURE_LIMIT_BYTES,
  CaptureRefused,
  captureRegularFile,
  countedVerified,
  MARKER_ENV,
  MARKER_FILE,
  type PoolOptions,
  PoolRefused,
  runPool,
  type TrialSpec,
  writeHarnessFile,
} from "../../src/parallel/pool.ts";
import {
  CALC_ORACLE_SOURCES,
  L_TASK_ID,
  L_TASK_SPEC,
  lTaskRegistry,
} from "../../src/parallel/throughput.ts";
import { type FakeBackend, fakeBackend, STRONG } from "./fake-backend.ts";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-pool-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const CAPS = {
  maxConcurrent: 2,
  memoryMbPerTrial: 64,
  cpusPerTrial: 1,
  cpuSecondsPerTrial: 60,
  trialTimeoutMs: 20_000,
  memoryBudgetMb: 1024,
  cpuBudget: 1,
} as const;

function options(backend: FakeBackend, extra: Partial<PoolOptions> = {}): PoolOptions {
  return {
    backend,
    caps: { ...CAPS, cpuBudget: 2 },
    requirements: STRICT_REQUIREMENTS,
    runRoot: join(base, "run"),
    tasks: lTaskRegistry(),
    oracleSources: CALC_ORACLE_SOURCES,
    ...extra,
  };
}

const trial = (runId: string, agent: ScriptedDesktopAgent | AgentBehaviour): TrialSpec => ({
  runId,
  taskId: L_TASK_ID,
  agent: typeof agent === "string" ? scriptedFileAgent(agent) : agent,
});

function barrier(n: number): () => Promise<void> {
  let count = 0;
  let open: () => void = () => {};
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return async () => {
    count++;
    if (count >= n) open();
    await opened;
  };
}

/** An agent from a function, simulated like every scripted agent. */
function agent(id: string, run: ScriptedDesktopAgent["run"]): ScriptedDesktopAgent {
  return { id, simulated: true, run };
}

/** Write the honest saved CSV inside the desktop, then call the gate. */
async function honestSave(ctx: Parameters<ScriptedDesktopAgent["run"]>[0]) {
  await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
    input: editedCsv(ctx.spec, "honest"),
  });
  const claim = claimFor(ctx.spec);
  await ctx.callGate(claim);
  return { claim, output: "" };
}

describe("pool: verdicts through the unchanged gated path, one vault and gate per trial", () => {
  it("honest is counted verified; skips-save and wrong-row are refuted; the mid-run gate call is uncertain", async () => {
    const backend = fakeBackend();
    const report = await runPool(options(backend), [
      trial("t-honest", "honest"),
      trial("t-skip", "skips-save"),
      trial("t-wrong", "wrong-row"),
    ]);
    const by = Object.fromEntries(report.trials.map((t) => [t.runId, t]));
    expect(by["t-honest"]?.gate?.verdict).toBe("verified");
    expect(by["t-honest"]?.countedVerified).toBe(true);
    expect(by["t-honest"]?.disqualifiers).toEqual([]);
    expect(by["t-skip"]?.gate?.verdict).toBe("refuted");
    expect(by["t-wrong"]?.gate?.verdict).toBe("refuted");
    expect(by["t-skip"]?.countedVerified).toBe(false);
    // Before stop and capture the gate never verifies (sealed-gate rule, unchanged).
    for (const t of report.trials) expect(t.agentSaw?.verdict).toBe("uncertain");
    expect(report.verifiedCount).toBe(1);
    expect(report.simulated).toBe(true);
    // Fresh desktop per trial, all destroyed.
    expect(backend.created.sort()).toEqual(["t-honest", "t-skip", "t-wrong"]);
    expect(backend.live.size).toBe(0);
    expect(readdirSync(join(base, "run", "trials"))).toEqual([]);
  });

  it("each trial has its own vault dir and evidence root, and its gate refuses every other run id", async () => {
    const report = await runPool(options(fakeBackend()), [
      trial("a1", "honest"),
      trial("b1", "honest"),
    ]);
    expect(readdirSync(join(base, "run", "vaults")).sort()).toEqual(["a1", "b1"]);
    expect(readdirSync(join(base, "run", "evidence")).sort()).toEqual(["a1", "b1"]);
    for (const t of report.trials) {
      expect(t.gate?.request.runId).toBe(t.runId);
      const rec = JSON.parse(
        readFileSync(join(base, "run", "evidence", t.runId, "record.json"), "utf8"),
      );
      expect(rec.runId).toBe(t.runId);
    }
  });
});

describe("pool: isolation requirements fail closed", () => {
  it.each([
    ["a shared network", { network: "shared" as const }],
    ["a shared /tmp", { tmp: "env" as const }],
    ["visible host dirs", { hostDirsHidden: false }],
    ["no private root", { privateRoot: false }],
  ])("a desktop with %s is refused before sealing and destroyed", async (_n, weaken) => {
    const backend = fakeBackend({ isolation: () => ({ ...STRONG, ...weaken }) });
    const report = await runPool(options(backend), [trial("weak-1", "honest")]);
    const t = report.trials[0];
    expect(t?.disqualifiers).toContain("isolation");
    expect(t?.gate).toBeNull();
    expect(t?.countedVerified).toBe(false);
    expect(existsSync(join(base, "run", "vaults", "weak-1"))).toBe(false);
    expect(backend.destroyed).toEqual(["weak-1"]);
  });

  it("an Xvfb requirement refuses a desktop without a display", async () => {
    const report = await runPool(
      options(fakeBackend(), { requirements: { ...STRICT_REQUIREMENTS, display: "xvfb" } }),
      [trial("nodisp", "honest")],
    );
    expect(report.trials[0]?.disqualifiers).toEqual(["isolation"]);
  });
});

describe("pool: resource caps", () => {
  it("never runs more desktops at once than maxConcurrent", async () => {
    const backend = fakeBackend({ createDelayMs: 20 });
    const slow = agent("slow", async (ctx) => {
      await new Promise((r) => setTimeout(r, 60));
      return honestSave(ctx);
    });
    const report = await runPool(
      options(backend, { caps: { ...CAPS, maxConcurrent: 3, cpuBudget: 3 } }),
      Array.from({ length: 7 }, (_, i) => trial(`c-${i}`, slow)),
    );
    expect(backend.peakLive).toBe(3);
    expect(report.peakConcurrent).toBe(3);
    expect(report.verifiedCount).toBe(7);
  });

  it.each([
    ["maxConcurrent 0", { maxConcurrent: 0 }],
    ["fractional memory", { memoryMbPerTrial: 1.5 }],
    ["NaN timeout", { trialTimeoutMs: Number.NaN }],
    ["memory oversubscribed", { maxConcurrent: 2, memoryMbPerTrial: 600, memoryBudgetMb: 1024 }],
    ["cpu oversubscribed", { maxConcurrent: 2, cpuBudget: 1 }],
    ["above the hard ceiling", { maxConcurrent: 65, cpuBudget: 1, cpusPerTrial: 1 }],
  ])("refuses to start with %s, before any desktop exists", async (_n, bad) => {
    const backend = fakeBackend();
    await expect(
      runPool(options(backend, { caps: { ...CAPS, cpuBudget: 2, ...bad } }), [
        trial("cap-1", "honest"),
      ]),
    ).rejects.toBeInstanceOf(PoolRefused);
    expect(backend.created).toEqual([]);
  });

  it("a trial past its wall-clock cap is a timeout, destroyed, never verified", async () => {
    const backend = fakeBackend();
    const hang = agent("hang", async (ctx) => {
      await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
        input: editedCsv(ctx.spec, "honest"),
      });
      await new Promise((r) => setTimeout(r, 5_000));
      return { claim: "late", output: "" };
    });
    const report = await runPool(
      options(backend, { caps: { ...CAPS, cpuBudget: 2, trialTimeoutMs: 200 } }),
      [trial("slow-1", hang)],
    );
    expect(report.trials[0]?.disqualifiers).toContain("timeout");
    expect(report.trials[0]?.countedVerified).toBe(false);
    expect(backend.live.size).toBe(0);
  });

  it("a desktop the watchdog flagged over a cap is never counted verified", async () => {
    const backend = fakeBackend({ breach: () => ({ cap: "memory", observed: 900, limit: 64 }) });
    const report = await runPool(options(backend), [trial("mem-1", "honest")]);
    expect(report.trials[0]?.disqualifiers).toContain("resource-cap");
    expect(report.trials[0]?.breach?.cap).toBe("memory");
    expect(report.trials[0]?.countedVerified).toBe(false);
  });

  it("a desktop whose teardown left a process or its root is never counted verified", async () => {
    for (const [i, bad] of [{ processesGone: false }, { rootRemoved: false }].entries()) {
      const report = await runPool(
        options(fakeBackend({ destroy: () => bad }), { runRoot: join(base, `td-${i}`) }),
        [trial("td-1", "honest")],
      );
      expect(report.trials[0]?.gate?.verdict).toBe("verified");
      expect(report.trials[0]?.disqualifiers).toEqual(["teardown"]);
      expect(report.trials[0]?.countedVerified).toBe(false);
    }
  });
});

describe("pool: run ids that collide after case folding", () => {
  it("a batch with Run-A and run-a is refused before anything starts", async () => {
    const backend = fakeBackend();
    await expect(
      runPool(options(backend), [trial("Run-A", "honest"), trial("run-a", "honest")]),
    ).rejects.toThrow(/duplicate-folded/);
    expect(backend.created).toEqual([]);
  });

  it("two pools sharing a lock dir: the second claim of a folded-equal id is refused while the first runs", async () => {
    const lockDir = join(base, "locks");
    const holdFirst = barrier(2);
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    const first = runPool(
      options(fakeBackend(), {
        runRoot: join(base, "p1"),
        lockDir,
        onDesktop: async () => {
          await holdFirst();
          await released;
        },
      }),
      [trial("Shared-Run", "honest")],
    );
    // Wait until the first pool's trial holds its claim and desktop.
    const secondBackend = fakeBackend();
    const waitForFirst = holdFirst();
    await waitForFirst;
    const second = await runPool(options(secondBackend, { runRoot: join(base, "p2"), lockDir }), [
      trial("shared-run", "honest"),
    ]);
    release();
    const firstReport = await first;
    expect(second.trials[0]?.disqualifiers).toEqual(["run-id"]);
    expect(second.trials[0]?.error).toMatch(/^locked:/);
    expect(secondBackend.created).toEqual([]);
    expect(firstReport.trials[0]?.countedVerified).toBe(true);
    // Released after the first pool finished: the id can be claimed again.
    const third = await runPool(options(fakeBackend(), { runRoot: join(base, "p3"), lockDir }), [
      trial("SHARED-RUN", "honest"),
    ]);
    expect(third.trials[0]?.countedVerified).toBe(true);
  });

  it("a reused run root never reuses a trial dir", async () => {
    await runPool(options(fakeBackend()), [trial("again", "honest")]);
    // Simulate a left-over dir from a crashed run.
    mkdirSync(join(base, "run", "trials", "again2"));
    const report = await runPool(options(fakeBackend()), [trial("again2", "honest")]);
    expect(report.trials[0]?.disqualifiers).toEqual(["harness-error"]);
  });
});

describe("pool: contamination (markers planted in one trial must not appear in another)", () => {
  it("every trial's own marker is planted in its workspace and env, and found by the scan", async () => {
    const seen: Record<string, string> = {};
    const report = await runPool(options(fakeBackend()), [
      trial(
        "own-1",
        agent("echo-marker", async (ctx) => {
          const r = await ctx.desktop.exec("sh", ["-c", `printf %s "$${MARKER_ENV}"`]);
          seen.env = r.stdout;
          seen.file = readFileSync(join(ctx.desktop.paths.workspace, MARKER_FILE), "utf8").trim();
          return honestSave(ctx);
        }),
      ),
    ]);
    expect(seen.env).toMatch(/^MYCO-L-MARK-[0-9a-f]{32}$/);
    expect(seen.file).toBe(seen.env);
    expect(report.trials[0]?.ownMarkerSeen).toBe(true);
    expect(report.trials[0]?.countedVerified).toBe(true);
  });

  it("a leak into another trial's workspace (possible on this unisolated backend) is caught both ways", async () => {
    const backend = fakeBackend();
    const bothReady = barrier(2);
    const leaked = barrier(2);
    let victimWorkspace = "";
    const report = await runPool(
      options(backend, {
        onDesktop: (runId, desktop) => {
          if (runId === "victim") victimWorkspace = desktop.paths.workspace;
        },
      }),
      [
        trial(
          "leaker",
          agent("leaker", async (ctx) => {
            await bothReady();
            await ctx.desktop.exec("sh", [
              "-c",
              `printf %s "$${MARKER_ENV}" > "$1/note.txt"`,
              "sh",
              victimWorkspace,
            ]);
            await leaked();
            return honestSave(ctx);
          }),
        ),
        trial(
          "victim",
          agent("victim", async (ctx) => {
            await bothReady();
            await leaked();
            return honestSave(ctx);
          }),
        ),
      ],
    );
    const by = Object.fromEntries(report.trials.map((t) => [t.runId, t]));
    expect(by.victim?.gate?.verdict).toBe("verified");
    expect(by.victim?.foreignMarkers).toEqual(["leaker"]);
    expect(by.victim?.disqualifiers).toContain("contaminated");
    expect(by.leaker?.disqualifiers).toContain("leaked");
    expect(by.victim?.countedVerified).toBe(false);
    expect(by.leaker?.countedVerified).toBe(false);
    expect(report.verifiedCount).toBe(0);
    expect(report.contaminatedCount).toBe(1);
  });

  it("another trial's marker in this trial's claim (its verdict record) is contamination", async () => {
    const ready = barrier(2);
    let otherWorkspace = "";
    const report = await runPool(
      options(fakeBackend(), {
        onDesktop: (runId, d) => {
          if (runId === "src") otherWorkspace = d.paths.workspace;
        },
      }),
      [
        trial(
          "thief",
          agent("thief", async (ctx) => {
            await ready();
            const stolen = readFileSync(join(otherWorkspace, MARKER_FILE), "utf8").trim();
            await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
              input: editedCsv(ctx.spec, "honest"),
            });
            const claim = `done ${stolen}`;
            await ctx.callGate(claim);
            return { claim, output: "" };
          }),
        ),
        trial(
          "src",
          agent("src", async (ctx) => {
            await ready();
            return honestSave(ctx);
          }),
        ),
      ],
    );
    const thief = report.trials.find((t) => t.runId === "thief");
    expect(thief?.foreignMarkers).toEqual(["src"]);
    expect(thief?.countedVerified).toBe(false);
  });

  it.each([
    ["only in the claim it sent to its gate mid-run (the agent-seen gate record)", "gate"],
    ["only in its output (its evidence root)", "output"],
  ])("another trial's marker %s is contamination", async (_n, where) => {
    const ready = barrier(2);
    let otherWorkspace = "";
    const report = await runPool(
      options(fakeBackend(), {
        onDesktop: (runId, d) => {
          if (runId === "src2") otherWorkspace = d.paths.workspace;
        },
      }),
      [
        trial(
          "thief2",
          agent("thief2", async (ctx) => {
            await ready();
            const stolen = readFileSync(join(otherWorkspace, MARKER_FILE), "utf8").trim();
            await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
              input: editedCsv(ctx.spec, "honest"),
            });
            await ctx.callGate(where === "gate" ? `done ${stolen}` : "done");
            return { claim: "done", output: where === "output" ? stolen : "" };
          }),
        ),
        trial(
          "src2",
          agent("src2", async (ctx) => {
            await ready();
            return honestSave(ctx);
          }),
        ),
      ],
    );
    const thief = report.trials.find((t) => t.runId === "thief2");
    expect(thief?.gate?.verdict).toBe("verified");
    expect(thief?.foreignMarkers).toEqual(["src2"]);
    expect(thief?.countedVerified).toBe(false);
  });

  it("an agent that deletes its own marker cannot be counted verified (the scan proved nothing)", async () => {
    const report = await runPool(options(fakeBackend()), [
      trial(
        "erase-1",
        agent("erase", async (ctx) => {
          await ctx.desktop.exec("rm", ["-f", MARKER_FILE]);
          return honestSave(ctx);
        }),
      ),
    ]);
    expect(report.trials[0]?.gate?.verdict).toBe("verified");
    expect(report.trials[0]?.disqualifiers).toEqual(["own-marker-missing"]);
    expect(report.trials[0]?.countedVerified).toBe(false);
  });
});

describe("pool: the host-side capture follows no link the agent planted", () => {
  const honestElsewhere = () => {
    const p = join(base, "elsewhere.csv");
    writeFileSync(p, editedCsv(L_TASK_SPEC, "honest"));
    return p;
  };

  it.each([
    [
      "a symlink to an honest file elsewhere",
      (ws: string, file: string) => {
        rmSync(join(ws, "sheet.csv"));
        symlinkSync(file, join(ws, "sheet.csv"));
      },
    ],
    [
      "a hard link to an honest file elsewhere",
      (ws: string, file: string) => {
        rmSync(join(ws, "sheet.csv"));
        linkSync(file, join(ws, "sheet.csv"));
      },
    ],
  ])("%s is refused: capture-refused, never verified", async (_n, plant) => {
    const target = honestElsewhere();
    const report = await runPool(options(fakeBackend()), [
      trial(
        "link-1",
        agent("linker", async (ctx) => {
          plant(ctx.desktop.paths.workspace, target);
          const claim = claimFor(ctx.spec);
          await ctx.callGate(claim);
          return { claim, output: "" };
        }),
      ),
    ]);
    expect(report.trials[0]?.disqualifiers).toEqual(["capture-refused"]);
    expect(report.trials[0]?.gate).toBeNull();
    expect(report.trials[0]?.countedVerified).toBe(false);
  });

  it("a workspace swapped for a symlink is refused", () => {
    const real = join(base, "ws");
    mkdirSync(real);
    const other = join(base, "other");
    mkdirSync(other);
    writeFileSync(join(other, "sheet.csv"), "x");
    rmSync(real, { recursive: true });
    symlinkSync(other, real);
    expect(() => captureRegularFile(join(realpathSync(base), "ws"), "sheet.csv")).toThrow(
      CaptureRefused,
    );
  });

  it("a plain regular file is captured", () => {
    const ws = join(base, "ws2");
    mkdirSync(ws);
    writeFileSync(join(ws, "sheet.csv"), "ok");
    expect(captureRegularFile(realpathSync(ws), "sheet.csv").toString()).toBe("ok");
  });

  it("a hard-linked state file is refused with its code", () => {
    const ws = join(base, "ws3");
    mkdirSync(ws);
    writeFileSync(join(ws, "sheet.csv"), "x");
    linkSync(join(ws, "sheet.csv"), join(base, "elsewhere.csv"));
    expect(() => captureRegularFile(realpathSync(ws), "sheet.csv")).toThrow(/^hard-linked:/);
  });

  it("a state file over the capture limit is refused, never read", () => {
    const ws = join(base, "ws4");
    mkdirSync(ws);
    writeFileSync(join(ws, "sheet.csv"), "");
    // Sparse: no real bytes on disk, but an unbounded read would allocate all of it.
    spawnSync("truncate", ["-s", String(CAPTURE_LIMIT_BYTES + 1), join(ws, "sheet.csv")]);
    expect(() => captureRegularFile(realpathSync(ws), "sheet.csv")).toThrow(/^too-large:/);
  });
});

// ---------------------------------------------------------------------------------------
// Special files planted as the state file (round-1 D2). A blocking open of a FIFO freezes
// the event loop, so each case runs in a child process killed after a hard limit: a
// regression is a failed test, never a frozen run.
// ---------------------------------------------------------------------------------------

const TSX = resolve(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
const CHILD = join(import.meta.dirname, "special-file-child.ts");
const HARD_LIMIT_MS = 30_000;

function child(args: readonly string[]): { refused?: string; bytes?: number } & {
  disqualifiers?: string[];
  counted?: boolean;
  error?: string;
} {
  const r = spawnSync(TSX, [CHILD, ...args], {
    encoding: "utf8",
    timeout: HARD_LIMIT_MS,
    killSignal: "SIGKILL",
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `child did not finish (status ${String(r.status)}, signal ${String(r.signal)}): ${r.stderr}`,
    );
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
}

describe.skipIf(process.platform === "win32")(
  "special file as the state file: fail closed, never hang",
  () => {
    it.each([
      ["fifo", "not-regular"],
      ["dir", "not-regular"],
      ["socket", "not-regular"],
    ] as const)(
      "capture refuses a %s with code %s, at once",
      (kind, code) => {
        const ws = join(base, `ws-${kind}`);
        mkdirSync(ws);
        const path = join(ws, "sheet.csv");
        if (kind === "fifo") spawnSync("mkfifo", [path]);
        else if (kind === "dir") mkdirSync(path);
        else
          spawnSync("python3", [
            "-c",
            "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
            path,
          ]);
        // The special file must really exist, or the case would pass as "missing".
        expect(lstatSync(path).isFile()).toBe(false);
        const t0 = Date.now();
        expect(child(["capture", ws, "sheet.csv"])).toEqual({ refused: code });
        expect(Date.now() - t0).toBeLessThan(HARD_LIMIT_MS);
      },
      HARD_LIMIT_MS + 5_000,
    );

    it(
      "the non-blocking open returns at once on a FIFO (a file swapped after the lstat)",
      () => {
        const fifo = join(base, "swapped");
        spawnSync("mkfifo", [fifo]);
        expect(child(["open", fifo])).toEqual({ regular: false });
      },
      HARD_LIMIT_MS + 5_000,
    );

    it.each(["fifo", "dir", "socket"] as const)(
      "pool: an agent that plants a %s as its state file gets capture-refused, and the pool returns",
      (kind) => {
        // A short root: macOS caps a unix socket path at 104 bytes, and its tmpdir is long.
        const short = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "mps-"));
        let out: ReturnType<typeof child>;
        try {
          out = child(["pool", join(short, "r"), kind]);
        } finally {
          rmSync(short, { recursive: true, force: true });
        }
        expect(out.disqualifiers).toEqual(["capture-refused"]);
        expect(out.counted).toBe(false);
        expect(out.error).toMatch(/^not-regular:/);
      },
      HARD_LIMIT_MS + 5_000,
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "B3: a file swapped for a FIFO between the lstat and the open (lying lstat)",
  () => {
    it(
      "capture re-checks on the fd: refused not-regular, at once",
      () => {
        const ws = join(base, "ws-swap");
        mkdirSync(ws);
        spawnSync("mkfifo", [join(ws, "sheet.csv")]);
        expect(child(["swapped-capture", ws, "sheet.csv"])).toEqual({ refused: "not-regular" });
      },
      HARD_LIMIT_MS + 5_000,
    );

    it(
      "the marker scan opens without blocking and marks the tree incomplete",
      () => {
        const dir = join(base, "scan-swap");
        mkdirSync(dir);
        spawnSync("mkfifo", [join(dir, "f")]);
        expect(child(["swapped-scan", dir]) as unknown).toEqual({ complete: false });
      },
      HARD_LIMIT_MS + 5_000,
    );
  },
);

describe("B3: capture codes and malformed isolation reports", () => {
  it("a symlinked state file is refused with the code symlink", () => {
    const ws = realpathSync(base);
    writeFileSync(join(ws, "target.csv"), "a,b\n");
    symlinkSync(join(ws, "target.csv"), join(ws, "sheet.csv"));
    let code: string | undefined;
    try {
      captureRegularFile(ws, "sheet.csv");
    } catch (e) {
      if (e instanceof CaptureRefused) code = e.code;
    }
    expect(code).toBe("symlink");
  });

  it.each([
    ["absent", undefined],
    ["a string", "false"],
    ["null", null],
  ])(
    "a report whose hostDirsHidden is %s is never counted (shared-host-dirs)",
    async (_, value) => {
      const backend = fakeBackend({
        isolation: () => ({ ...STRONG, hostDirsHidden: value as unknown as boolean }),
      });
      const report = await runPool(
        options(backend, {
          requirements: {
            network: "best-effort",
            privateTmp: "best-effort",
            hideHostDirs: "best-effort",
            display: "none",
          },
        }),
        [trial("malformed", "honest")],
      );
      expect(report.trials[0]?.disqualifiers).toContain("shared-host-dirs");
      expect(report.trials[0]?.countedVerified).toBe(false);
    },
  );
});

interface EvidenceOutcome {
  trials: Record<string, { disqualifiers: string[]; counted: boolean; error: string | null }>;
  rejected: string | null;
}

function evidenceChild(site: string, kind: string): EvidenceOutcome {
  const short = mkdtempSync(join(tmpdir(), "mpe-"));
  try {
    const r = spawnSync(TSX, [CHILD, "evidence", join(short, "r"), site, kind], {
      encoding: "utf8",
      timeout: HARD_LIMIT_MS,
      killSignal: "SIGKILL",
    });
    if (r.error || r.status !== 0)
      throw new Error(
        `child did not finish (status ${String(r.status)}, signal ${String(r.signal)}): ${r.stderr}`,
      );
    return JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as EvidenceOutcome;
  } finally {
    rmSync(short, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")(
  "B1: harness writes (marker, fixture, MCP config, evidence, pool report): fail closed, never hang",
  () => {
    // Each case runs the real pool in a child under a hard KILL limit, with an attacker
    // trial and an honest sibling. A blocking write would freeze the child's event loop
    // (every trial, timeout and watchdog with it) and be killed: a test failure.
    const trialSites = [
      ["marker", []],
      ["fixture", []],
      ["mcp", []],
      ["agent-output", ["own-marker-missing"]],
      ["record", []],
    ] as const;
    it.each(
      trialSites.flatMap(([site, extra]) => [
        [site, "fifo", "exists", extra],
        [site, "file", "exists", extra],
      ]),
    )(
      "%s: a planted %s is refused (%s), the trial is not counted, the honest sibling is",
      (site, kind, code, extra) => {
        const out = evidenceChild(site, kind);
        expect(out.rejected).toBeNull();
        expect(out.trials.attacker?.disqualifiers).toEqual(["evidence-refused", ...extra].sort());
        expect(out.trials.attacker?.counted).toBe(false);
        expect(out.trials.attacker?.error).toMatch(new RegExp(`^${code}:`));
        expect(out.trials.honest).toEqual({ disqualifiers: [], counted: true, error: null });
      },
      HARD_LIMIT_MS + 5_000,
    );

    it.each([
      ["marker", "outside-dir: trial workspace is outside its root", []],
      ["mcp", "outside-dir: trial home is outside its root", []],
      ["agent-output", "outside-dir: target dir was swapped", ["own-marker-missing"]],
    ] as const)(
      "%s: a target dir swapped for a symlink is refused, never written through",
      (site, message, extra) => {
        const out = evidenceChild(site, "dirlink");
        expect(out.trials.attacker?.disqualifiers).toEqual(["evidence-refused", ...extra].sort());
        expect(out.trials.attacker?.counted).toBe(false);
        expect(out.trials.attacker?.error?.startsWith(message)).toBe(true);
        expect(out.trials.honest?.counted).toBe(true);
      },
      HARD_LIMIT_MS + 5_000,
    );

    it(
      "record: a refused record.json withholds the count even though the gate verified",
      () => {
        // The attacker saved honestly, so only the refused record write can withhold it.
        const out = evidenceChild("record", "fifo");
        expect(out.trials.attacker?.disqualifiers).toEqual(["evidence-refused"]);
        expect(out.trials.attacker?.counted).toBe(false);
      },
      HARD_LIMIT_MS + 5_000,
    );

    it.each([
      ["fifo", "not-regular"],
      ["dirlink", "outside-dir"],
    ] as const)(
      "pool-report.json: a planted %s rejects the whole run (%s), at once",
      (kind, code) => {
        expect(evidenceChild("pool-report", kind)).toEqual({ trials: {}, rejected: code });
      },
      HARD_LIMIT_MS + 5_000,
    );

    it(
      "pool-report.json from an earlier run (a regular file) is replaced, not refused",
      () => {
        const out = evidenceChild("pool-report", "file");
        expect(out.rejected).toBeNull();
        expect(out.trials.honest?.counted).toBe(true);
      },
      HARD_LIMIT_MS + 5_000,
    );
  },
);

describe("writeHarnessFile", () => {
  it("creates a fresh 0600 regular file and refuses a second write", async () => {
    const dir = realpathSync(base);
    await writeHarnessFile(dir, "f.txt", "one");
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("one");
    expect(lstatSync(join(dir, "f.txt")).mode & 0o777).toBe(0o600);
    await expect(writeHarnessFile(dir, "f.txt", "two")).rejects.toMatchObject({
      name: "HarnessWriteRefused",
      code: "exists",
    });
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("one");
  });

  it("refuses a symlink at the target without writing through it", async () => {
    const dir = realpathSync(base);
    writeFileSync(join(dir, "victim"), "victim");
    symlinkSync(join(dir, "victim"), join(dir, "link"));
    await expect(writeHarnessFile(dir, "link", "x")).rejects.toMatchObject({ code: "exists" });
    expect(readFileSync(join(dir, "victim"), "utf8")).toBe("victim");
  });

  it("refuses a dir that is not its own realpath, and a name with a slash", async () => {
    const dir = realpathSync(base);
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "alias"));
    await expect(writeHarnessFile(join(dir, "alias"), "f", "x")).rejects.toMatchObject({
      code: "outside-dir",
    });
    await expect(writeHarnessFile(dir, "real/f", "x")).rejects.toMatchObject({
      code: "outside-dir",
    });
    expect(existsSync(join(dir, "real", "f"))).toBe(false);
  });

  it("gives up on a write that outlasts its hard timeout, with a code", async () => {
    const dir = realpathSync(base);
    await expect(
      writeHarnessFile(dir, "big", Buffer.alloc(128 * 1024 * 1024, 1), 1),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("countedVerified (the one count rule)", () => {
  const gate = (over: Partial<GateResult>): GateResult =>
    ({ verdict: "verified", accepted: true, ...over }) as GateResult;
  it("needs verified AND accepted AND no disqualifier", () => {
    expect(countedVerified(gate({}), [])).toBe(true);
    expect(countedVerified(gate({ accepted: false }), [])).toBe(false);
    expect(countedVerified(gate({ accepted: undefined as unknown as boolean }), [])).toBe(false);
    expect(countedVerified(gate({ verdict: "refuted" as GateResult["verdict"] }), [])).toBe(false);
    expect(countedVerified(gate({}), ["shared-host-dirs"])).toBe(false);
    expect(countedVerified(null, [])).toBe(false);
  });
});

describe("a backend that leaves other trials' roots writable is never counted", () => {
  it("best-effort lets the trial run, the gate may say verified, but it is not counted", async () => {
    const backend = fakeBackend({ isolation: () => ({ ...STRONG, hostDirsHidden: false }) });
    const report = await runPool(
      options(backend, {
        requirements: {
          network: "best-effort",
          privateTmp: "best-effort",
          hideHostDirs: "best-effort",
          display: "none",
        },
      }),
      [trial("weak-honest", "honest")],
    );
    const t = report.trials[0];
    expect(t?.gate?.verdict).toBe("verified");
    expect(t?.disqualifiers).toEqual(["shared-host-dirs"]);
    expect(t?.countedVerified).toBe(false);
    expect(report.verifiedCount).toBe(0);
  });

  it("strict requirements still refuse it before anything is sealed", async () => {
    const backend = fakeBackend({ isolation: () => ({ ...STRONG, hostDirsHidden: false }) });
    const report = await runPool(options(backend), [trial("strict-weak", "honest")]);
    expect(report.trials[0]?.disqualifiers).toEqual(["isolation"]);
    expect(report.trials[0]?.gate).toBeNull();
  });
});
