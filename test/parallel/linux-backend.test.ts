/**
 * Track L — the Linux disposable-desktop backend, against the real kernel.
 *
 * Linux only. The only Linux backend in this PR is `linux-plain` (strict namespace
 * isolation is not in this PR). Xvfb cases skip without Xvfb, EXCEPT under
 * MYCO_PARALLEL_REQUIRED=1 (the `safe parallelism` CI job), where they run and fail, so
 * they can never pass there by skipping.
 *
 * The cross-trial cases below are the blocking ones: on a backend that leaves other
 * trials' roots writable, a hostile trial can forge another trial's saved file without
 * leaving any marker, so the pool must never count such a trial as verified.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimFor,
  editedCsv,
  type ScriptedDesktopAgent,
  scriptedFileAgent,
} from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS, type TrialDesktopSpec } from "../../src/parallel/backend.ts";
import { HOST_ENV_ALLOWLIST, linuxBackend } from "../../src/parallel/linux-backend.ts";
import { MARKER_ENV, runPool, type TrialSpec } from "../../src/parallel/pool.ts";
import {
  CALC_ORACLE_SOURCES,
  L_TASK_ID,
  L_TASK_SPEC,
  lTaskRegistry,
} from "../../src/parallel/throughput.ts";

const REQUIRED = process.env.MYCO_PARALLEL_REQUIRED === "1";
const LINUX = process.platform === "linux";
const XVFB = LINUX && spawnSync("Xvfb", ["-help"]).error === undefined;

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "myco-l-linux-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function spec(runId: string, extra: Partial<TrialDesktopSpec> = {}): TrialDesktopSpec {
  const root = join(base, "trials", runId);
  mkdirSync(root, { recursive: true });
  return {
    runId,
    root,
    hide: [base],
    memoryMbPerTrial: 512,
    cpuSecondsPerTrial: 60,
    display: "none",
    ...extra,
  };
}

const agent = (id: string, run: ScriptedDesktopAgent["run"]): ScriptedDesktopAgent => ({
  id,
  simulated: true,
  run,
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

/** Two trials: `leaker` writes its marker into `victim`'s workspace by absolute path. */
function leakPair(getVictimWs: () => string): TrialSpec[] {
  const ready = barrier(2);
  const leaked = barrier(2);
  const save = async (ctx: Parameters<ScriptedDesktopAgent["run"]>[0]) => {
    await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
      input: editedCsv(ctx.spec, "honest"),
    });
    const claim = claimFor(ctx.spec);
    await ctx.callGate(claim);
    return { claim, output: "" };
  };
  return [
    {
      runId: "leaker",
      taskId: L_TASK_ID,
      agent: agent("leaker", async (ctx) => {
        await ready();
        const r = await ctx.desktop.exec("sh", [
          "-c",
          `printf %s "$${MARKER_ENV}" > "$1/note.txt"`,
          "sh",
          getVictimWs(),
        ]);
        await leaked();
        const out = await save(ctx);
        return { ...out, output: `write exit ${String(r.code)}` };
      }),
    },
    {
      runId: "victim",
      taskId: L_TASK_ID,
      agent: agent("victim", async (ctx) => {
        await ready();
        await leaked();
        return save(ctx);
      }),
    },
  ];
}

const POOL_CAPS = {
  maxConcurrent: 2,
  memoryMbPerTrial: 512,
  cpusPerTrial: 1,
  cpuSecondsPerTrial: 60,
  trialTimeoutMs: 30_000,
  memoryBudgetMb: 2048,
  cpuBudget: 2,
};

const WEAK = {
  network: "best-effort",
  privateTmp: "best-effort",
  hideHostDirs: "best-effort",
  display: "none",
} as const;

/** Does an X server accept connections on this unix socket right now? */
function accepts(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 2000).unref();
  });
}

describe.skipIf(!LINUX)("linux-plain desktop (no namespaces)", () => {
  const backend = linuxBackend();

  it("reports its weak isolation honestly, and strict requirements refuse it", async () => {
    const report = await runPool(
      {
        backend,
        caps: POOL_CAPS,
        requirements: STRICT_REQUIREMENTS,
        runRoot: join(base, "run"),
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
      },
      [{ runId: "plain-1", taskId: L_TASK_ID, agent: scriptedFileAgent("honest") }],
    );
    expect(report.trials[0]?.isolation).toMatchObject({
      network: "shared",
      tmp: "env",
      hostDirsHidden: false,
    });
    expect(report.trials[0]?.disqualifiers).toEqual(["isolation"]);
    expect(report.trials[0]?.gate).toBeNull();
  });

  it("the probe reports linux-plain and its weak isolation, never namespaces", async () => {
    expect(backend.id).toBe("linux-plain");
    const probe = await backend.probe();
    expect(probe.available).toBe(true);
    expect(probe.expected).toEqual({
      backend: "linux-plain",
      kind: "process",
      privateRoot: true,
      hostDirsHidden: false,
      tmp: "env",
      network: "shared",
      processes: "process-group",
    });
  });

  it("planted markers: a cross-trial write lands, both sides are disqualified, nothing counts", async () => {
    let victimWs = "";
    const report = await runPool(
      {
        backend,
        caps: POOL_CAPS,
        requirements: {
          network: "best-effort",
          privateTmp: "best-effort",
          hideHostDirs: "best-effort",
          display: "none",
        },
        runRoot: join(base, "run"),
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
        onDesktop: (runId, d) => {
          if (runId === "victim") victimWs = d.paths.workspace;
        },
      },
      leakPair(() => victimWs),
    );
    const by = Object.fromEntries(report.trials.map((t) => [t.runId, t]));
    expect(by.victim?.gate?.verdict).toBe("verified");
    expect(by.victim?.foreignMarkers).toEqual(["leaker"]);
    expect(by.victim?.disqualifiers).toContain("contaminated");
    expect(by.leaker?.disqualifiers).toContain("leaked");
    for (const t of report.trials) expect(t.disqualifiers).toContain("shared-host-dirs");
    expect(report.verifiedCount).toBe(0);
  });

  it("D1 shape: a markerless forgery of another trial's saved file never counts as verified", async () => {
    // The attacker writes the honest bytes into the victim's state file and writes no
    // marker anywhere; the victim never saves. The victim's gate reads the forged bytes
    // and says verified, so only the backend rule can withhold the count.
    let victimWs = "";
    const ready = barrier(2);
    const forged = barrier(2);
    const report = await runPool(
      {
        backend,
        caps: POOL_CAPS,
        requirements: WEAK,
        runRoot: join(base, "run"),
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
        onDesktop: (runId, d) => {
          if (runId === "victim") victimWs = d.paths.workspace;
        },
      },
      [
        {
          runId: "attacker",
          taskId: L_TASK_ID,
          agent: agent("attacker", async (ctx) => {
            await ready();
            const r = await ctx.desktop.exec(
              "sh",
              ["-c", 'cat > "$1"', "sh", join(victimWs, ctx.stateFile)],
              {
                input: editedCsv(ctx.spec, "honest"),
              },
            );
            await forged();
            await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
              input: editedCsv(ctx.spec, "honest"),
            });
            const claim = claimFor(ctx.spec);
            await ctx.callGate(claim);
            return { claim, output: `forge exit ${String(r.code)}` };
          }),
        },
        {
          runId: "victim",
          taskId: L_TASK_ID,
          agent: agent("victim", async (ctx) => {
            await ready();
            await forged();
            const claim = claimFor(ctx.spec);
            await ctx.callGate(claim);
            return { claim, output: "never saved" };
          }),
        },
      ],
    );
    const by = Object.fromEntries(report.trials.map((t) => [t.runId, t]));
    expect(by.attacker?.agent).toBe("attacker");
    // The forgery landed: the victim's gate was fooled. That is exactly why it must not count.
    expect(by.victim?.gate?.verdict).toBe("verified");
    expect(by.victim?.foreignMarkers).toEqual([]);
    expect(by.victim?.disqualifiers).toEqual(["shared-host-dirs"]);
    expect(by.victim?.countedVerified).toBe(false);
    expect(by.attacker?.countedVerified).toBe(false);
    expect(report.verifiedCount).toBe(0);
  });

  it("serial too: a setsid daemon left by trial 1 forges trial 2's file, and it never counts", async () => {
    const runRoot = join(base, "serial");
    const victimFile = join(runRoot, "trials", "s-victim", "workspace", "sheet.csv");
    const forgedCsv = editedCsv(L_TASK_SPEC, "honest");
    const payload = join(base, "forged.csv");
    writeFileSync(payload, forgedCsv);
    const report = await runPool(
      {
        backend,
        caps: { ...POOL_CAPS, maxConcurrent: 1 },
        requirements: WEAK,
        runRoot,
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
      },
      [
        {
          runId: "s-attacker",
          taskId: L_TASK_ID,
          agent: agent("s-attacker", async (ctx) => {
            // Leave the process group: destroy() cannot see this process.
            await ctx.desktop.exec("sh", [
              "-c",
              `setsid sh -c 'for i in $(seq 1 400); do if [ -d "$(dirname "$1")" ] && grep -q EMP "$1" 2>/dev/null; then cp "$2" "$1.t" && mv "$1.t" "$1"; exit 0; fi; sleep 0.025; done' sh "$1" "$2" >/dev/null 2>&1 < /dev/null &`,
              "sh",
              victimFile,
              payload,
            ]);
            const claim = claimFor(ctx.spec);
            await ctx.callGate(claim);
            return { claim, output: "" };
          }),
        },
        {
          runId: "s-victim",
          taskId: L_TASK_ID,
          agent: agent("s-victim", async (ctx) => {
            // Wait for the forgery, then claim without ever saving.
            for (let i = 0; i < 200; i++) {
              if (
                readFileSync(join(ctx.desktop.paths.workspace, ctx.stateFile), "utf8") === forgedCsv
              )
                break;
              await new Promise((r) => setTimeout(r, 25));
            }
            const claim = claimFor(ctx.spec);
            await ctx.callGate(claim);
            return { claim, output: "never saved" };
          }),
        },
      ],
    );
    const victim = report.trials.find((t) => t.runId === "s-victim");
    expect(victim?.gate?.verdict).toBe("verified");
    expect(victim?.disqualifiers).toEqual(["shared-host-dirs"]);
    expect(victim?.countedVerified).toBe(false);
    expect(report.verifiedCount).toBe(0);
  });

  it("passes no host env var except the allowlist (no host secret reaches a trial)", async () => {
    process.env.MYCO_L_CANARY = "canary-value";
    try {
      const d = await backend.create(spec("env"));
      try {
        const r = await d.exec("sh", ["-c", "env | cut -d= -f1 | sort"]);
        const names = r.stdout.trim().split("\n");
        expect(names).not.toContain("MYCO_L_CANARY");
        const allowed = new Set<string>([
          ...HOST_ENV_ALLOWLIST,
          "HOME",
          "TMPDIR",
          "LC_ALL",
          "XDG_CONFIG_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
          "XDG_RUNTIME_DIR",
          "PWD",
          "SHLVL",
          "_",
          "OLDPWD",
        ]);
        expect(names.filter((n) => !allowed.has(n))).toEqual([]);
      } finally {
        await d.destroy();
      }
    } finally {
      delete process.env.MYCO_L_CANARY;
    }
  });

  it("the memory watchdog destroys a trial over its cap", async () => {
    const d = await backend.create(spec("mem", { memoryMbPerTrial: 64 }));
    const r = await d.exec(process.execPath, [
      "-e",
      "const b = Buffer.alloc(256 * 1024 * 1024, 1); setTimeout(() => console.log(b.length), 20000)",
    ]);
    expect(d.breach()?.cap).toBe("memory");
    expect(r.code).not.toBe(0);
    expect((await d.destroy()).processesGone).toBe(true);
  }, 30_000);

  it("the CPU watchdog destroys a trial over its CPU-time cap", async () => {
    const d = await backend.create(spec("cpu", { cpuSecondsPerTrial: 1 }));
    const r = await d.exec(process.execPath, [
      "-e",
      "const t = Date.now(); while (Date.now() - t < 20000) {}",
    ]);
    expect(d.breach()?.cap).toBe("cpu");
    expect(r.code).not.toBe(0);
    await d.destroy();
  }, 30_000);

  it.skipIf(!XVFB && !REQUIRED)(
    "runs a private Xvfb per trial: distinct displays, each gone at destroy",
    async () => {
      // Checks this file's own two X servers by their sockets, never by counting every Xvfb
      // on the host (other test files start their own Xvfbs concurrently: round-1 D4).
      const a = await backend.create(spec("x-a", { display: "xvfb" }));
      const b = await backend.create(spec("x-b", { display: "xvfb" }));
      const ids = [a.isolation.display.id, b.isolation.display.id];
      let sockets: string[] = [];
      try {
        expect(a.isolation.display.kind).toBe("xvfb");
        expect(b.isolation.display.kind).toBe("xvfb");
        expect(ids[0]).toMatch(/^:\d+$/);
        expect(ids[0]).not.toBe(ids[1]);
        sockets = ids.map((id) => `/tmp/.X11-unix/X${String(id).slice(1)}`);
        for (const [i, d] of [a, b].entries()) {
          const r = await d.exec("sh", ["-c", 'echo "$DISPLAY"']);
          expect(r.stdout.trim()).toBe(ids[i]);
          expect(await accepts(sockets[i] as string)).toBe(true);
        }
      } finally {
        await a.destroy();
        await b.destroy();
      }
      for (const sock of sockets) expect(await accepts(sock)).toBe(false);
    },
  );

  it("process-group teardown kills background processes too", async () => {
    const root = join(base, "trials", "pg");
    mkdirSync(root, { recursive: true });
    const d = await backend.create({ ...spec("pg"), root });
    await d.exec("sh", ["-c", "(sleep 4244 &) ; true"]);
    expect(await d.destroy()).toEqual({ processesGone: true, rootRemoved: true });
    expect(spawnSync("pgrep", ["-f", "sleep 4244"], { encoding: "utf8" }).stdout.trim()).toBe("");
  });
});
