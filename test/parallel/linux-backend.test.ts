/**
 * Track L — the Linux disposable-desktop backend, against the real kernel.
 *
 * Linux only. The namespace suite needs unprivileged user namespaces and skips without
 * them, EXCEPT under MYCO_PARALLEL_REQUIRED=1 (the `safe parallelism` CI job), where it
 * runs and fails, so it can never pass there by skipping. The plain-mode suite runs on
 * any Linux. Xvfb cases skip without Xvfb unless required.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { HOST_ENV_ALLOWLIST, linuxBackend, NS_DISPLAY } from "../../src/parallel/linux-backend.ts";
import { MARKER_ENV, runPool, type TrialSpec } from "../../src/parallel/pool.ts";
import { CALC_ORACLE_SOURCES, L_TASK_ID, lTaskRegistry } from "../../src/parallel/throughput.ts";

const REQUIRED = process.env.MYCO_PARALLEL_REQUIRED === "1";
const LINUX = process.platform === "linux";
const NS = LINUX && (await linuxBackend({ mode: "ns" }).probe()).available;
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

describe.skipIf(!LINUX || (!NS && !REQUIRED))("linux-ns desktop (namespaces)", () => {
  const backend = linuxBackend({ mode: "ns" });

  it("reports and meets strict isolation", async () => {
    const d = await backend.create(spec("iso"));
    try {
      expect(d.isolation).toMatchObject({
        backend: "linux-ns",
        network: "netns",
        tmp: "mount-ns",
        hostDirsHidden: true,
        processes: "pid-ns",
      });
    } finally {
      await d.destroy();
    }
  });

  it("has loopback only: no route out and no host interface", async () => {
    const d = await backend.create(spec("net"));
    try {
      const r = await d.exec("sh", ["-c", "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '"]);
      expect(r.stdout.trim().split("\n")).toEqual(["lo"]);
    } finally {
      await d.destroy();
    }
  });

  it("passes no host env var except the allowlist (no host secret reaches a trial)", async () => {
    process.env.MYCO_L_CANARY_TOKEN = "canary-value";
    const d = await backend.create(spec("env"));
    try {
      const r = await d.exec("sh", ["-c", "env | cut -d= -f1 | sort"]);
      const names = r.stdout.trim().split("\n");
      expect(names).not.toContain("MYCO_L_CANARY_TOKEN");
      const allowed = new Set<string>([
        ...HOST_ENV_ALLOWLIST,
        "HOME",
        "TMPDIR",
        "LC_ALL",
        "PWD",
        "SHLVL",
        "_",
        "OLDPWD",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_RUNTIME_DIR",
      ]);
      expect(names.filter((n) => !allowed.has(n))).toEqual([]);
    } finally {
      delete process.env.MYCO_L_CANARY_TOKEN;
      await d.destroy();
    }
  });

  it("gives each trial a private /tmp: same name in two trials, neither on the host", async () => {
    const a = await backend.create(spec("tmp-a"));
    const b = await backend.create(spec("tmp-b"));
    try {
      await a.exec("sh", ["-c", "echo A > /tmp/myco-l-same-name"]);
      await b.exec("sh", ["-c", "echo B > /tmp/myco-l-same-name"]);
      expect((await a.exec("cat", ["/tmp/myco-l-same-name"])).stdout.trim()).toBe("A");
      expect((await b.exec("cat", ["/tmp/myco-l-same-name"])).stdout.trim()).toBe("B");
      expect(existsSync("/tmp/myco-l-same-name")).toBe(false);
    } finally {
      await a.destroy();
      await b.destroy();
    }
  });

  it("hides other trials' roots (and the run root): the sibling path does not exist inside", async () => {
    const a = await backend.create(spec("hide-a"));
    const b = await backend.create(spec("hide-b"));
    writeFileSync(join(b.paths.workspace, "b-secret.txt"), "B");
    try {
      const ls = await a.exec("sh", [
        "-c",
        `ls "$1"; echo x > "$1/planted.txt"`,
        "sh",
        b.paths.workspace,
      ]);
      expect(ls.code).not.toBe(0);
      expect(readdirSync(b.paths.workspace)).toEqual(["b-secret.txt"]);
      const own = await a.exec("sh", ["-c", "ls -A ..; ls -A"]);
      expect(own.code).toBe(0);
    } finally {
      await a.destroy();
      await b.destroy();
    }
  });

  it("pool: an operator --hide dir (e.g. the operator's home) is invisible inside every desktop", async () => {
    const secretDir = join(base, "operator-home");
    mkdirSync(secretDir);
    writeFileSync(join(secretDir, "canary.txt"), "operator-only");
    let seen = "";
    const report = await runPool(
      {
        backend,
        caps: POOL_CAPS,
        requirements: STRICT_REQUIREMENTS,
        runRoot: join(base, "run-hide"),
        extraHide: [secretDir],
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
      },
      [
        {
          runId: "hide-1",
          taskId: L_TASK_ID,
          agent: agent("peek", async (ctx) => {
            const r = await ctx.desktop.exec("sh", [
              "-c",
              `cat "$1"/canary.txt; ls -A "$1"`,
              "sh",
              secretDir,
            ]);
            seen = r.stdout;
            return scriptedFileAgent("honest").run(ctx);
          }),
        },
      ],
    );
    expect(seen.trim()).toBe("");
    expect(report.trials[0]?.countedVerified).toBe(true);
  });

  it("hides the run root even when it is not under /tmp (the hide mounts, not the /tmp tmpfs)", async () => {
    // node_modules is git-ignored and never under /tmp.
    const outside = mkdtempSync(join(process.cwd(), "node_modules", ".myco-l-hide-"));
    try {
      const mk = (id: string) => {
        const root = join(outside, "trials", id);
        mkdirSync(root, { recursive: true });
        return { ...spec(id), root, hide: [outside] };
      };
      const a = await backend.create(mk("o-a"));
      const b = await backend.create(mk("o-b"));
      try {
        const r = await a.exec("sh", ["-c", 'ls -A "$1"', "sh", join(outside, "trials")]);
        expect(r.stdout.trim().split("\n")).toEqual(["o-a"]);
      } finally {
        await a.destroy();
        await b.destroy();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("destroy kills every process, background ones included, and removes the root", async () => {
    const d = await backend.create(spec("kill"));
    await d.exec("sh", ["-c", "(sleep 4242 &) ; (setsid sleep 4243 &) ; true"]);
    const before = spawnSync("pgrep", ["-f", "sleep 424[23]"], { encoding: "utf8" }).stdout.trim();
    expect(before.split("\n").length).toBeGreaterThanOrEqual(2);
    const report = await d.destroy();
    expect(report).toEqual({ processesGone: true, rootRemoved: true });
    expect(existsSync(d.paths.root)).toBe(false);
    const after = spawnSync("pgrep", ["-f", "sleep 424[23]"], { encoding: "utf8" });
    expect(after.stdout.trim()).toBe("");
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

  it.skipIf(!XVFB && !REQUIRED)("runs a private Xvfb per trial: both use :99 at once", async () => {
    const xvfbPids = () =>
      new Set(
        spawnSync("pgrep", ["-x", "Xvfb"], { encoding: "utf8" })
          .stdout.trim()
          .split("\n")
          .filter(Boolean),
      );
    const before = xvfbPids();
    const a = await backend.create(spec("x-a", { display: "xvfb" }));
    const b = await backend.create(spec("x-b", { display: "xvfb" }));
    const ours = [...xvfbPids()].filter((p) => !before.has(p));
    expect(ours).toHaveLength(2);
    try {
      for (const d of [a, b]) {
        expect(d.isolation.display).toEqual({ kind: "xvfb", id: NS_DISPLAY });
        const r = await d.exec("sh", [
          "-c",
          'echo "$DISPLAY"; test -S /tmp/.X11-unix/X99 && echo socket',
        ]);
        expect(r.stdout.trim().split("\n")).toEqual([NS_DISPLAY, "socket"]);
      }
    } finally {
      await a.destroy();
      await b.destroy();
    }
    const left = xvfbPids();
    expect(ours.filter((p) => left.has(p))).toEqual([]);
  });

  it("pool: a cross-trial write fails under namespaces, nothing is contaminated, both verify", async () => {
    let victimWs = "";
    const report = await runPool(
      {
        backend,
        caps: POOL_CAPS,
        requirements: STRICT_REQUIREMENTS,
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
    expect(by.leaker?.disqualifiers).toEqual([]);
    expect(by.victim?.disqualifiers).toEqual([]);
    expect(by.victim?.foreignMarkers).toEqual([]);
    expect(report.verifiedCount).toBe(2);
    expect(report.contaminatedCount).toBe(0);
  });

  it("pool: N trials in parallel, every verdict correct, every desktop gone", async () => {
    const behaviours = ["honest", "skips-save", "wrong-row", "honest"] as const;
    const report = await runPool(
      {
        backend,
        caps: { ...POOL_CAPS, maxConcurrent: 4, cpuBudget: 4 },
        requirements: STRICT_REQUIREMENTS,
        runRoot: join(base, "run4"),
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
      },
      behaviours.map((b, i) => ({
        runId: `p-${i}`,
        taskId: L_TASK_ID,
        agent: scriptedFileAgent(b),
      })),
    );
    expect(report.trials.map((t) => t.gate?.verdict)).toEqual([
      "verified",
      "refuted",
      "refuted",
      "verified",
    ]);
    expect(report.trials.every((t) => t.disqualifiers.length === 0)).toBe(true);
    expect(report.peakConcurrent).toBe(4);
    expect(readdirSync(join(base, "run4", "trials"))).toEqual([]);
  });
});

describe.skipIf(!LINUX)("linux-plain desktop (no namespaces)", () => {
  const backend = linuxBackend({ mode: "plain" });

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

  it("positive control: without namespaces the same cross-trial write lands, and the pool catches it", async () => {
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
    expect(report.verifiedCount).toBe(0);
  });

  it("process-group teardown kills background processes too", async () => {
    const root = join(base, "trials", "pg");
    mkdirSync(root, { recursive: true });
    const d = await backend.create({ ...spec("pg"), root });
    await d.exec("sh", ["-c", "(sleep 4244 &) ; true"]);
    expect(await d.destroy()).toEqual({ processesGone: true, rootRemoved: true });
    expect(spawnSync("pgrep", ["-f", "sleep 4244"], { encoding: "utf8" }).stdout.trim()).toBe("");
  });
});
