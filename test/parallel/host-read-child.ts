/**
 * Child process for the host-read hang tests in host-reads.test.ts (#541 R3-1).
 *
 * A blocking `open()` of a FIFO freezes the whole Node event loop, so every case runs here,
 * in a child the test kills after a hard wall-clock limit (SIGKILL). A heartbeat timer runs
 * the whole time; the child prints how many beats it saw and the longest gap between two,
 * so a stall that does not quite reach the limit still shows.
 *
 *   tsx host-read-child.ts oracle <run-root> <src-dir> <where> <index> <kind> <concurrency>
 *     Two trials on the fake backend (strong isolation, so an honest trial COUNTS): an
 *     attacker, then an honest sibling. The oracle sources are scratch copies in <src-dir>.
 *     <where>:
 *       before   - <kind> is planted at source <index> before the pool starts
 *       during   - the attacker plants it at source <index> (the operator's path) mid-run
 *       snapshot - the attacker plants it at the pool's snapshot copy <index> mid-run
 *     <kind>: fifo | zero (symlink to /dev/zero) | file (different regular bytes)
 *     Prints {"trials":{runId:{disqualifiers,counted,verdict,error}},"refused":[...]|null,
 *             "plantedKind":"fifo"|"symlink"|"file"|null, heartbeat}
 *   tsx host-read-child.ts vault-static <dir> <rel> <kind>
 *     Seals, stops and captures a run in a real vault under <dir>, replaces <rel> in the run
 *     dir with <kind> (fifo | zero), then runs checkIntegrity. Prints {"codes":[...], heartbeat}
 *   tsx host-read-child.ts vault-race <dir> <rel> <iterations>
 *     The same vault, but a `setsid` daemon swaps <rel> between its regular file and a FIFO
 *     as fast as it can (the window between the vault's lstat and its read), while
 *     checkIntegrity runs <iterations> times. Prints {"iterations":n,"codes":[...], heartbeat}
 *   tsx host-read-child.ts pool-race <run-root> <site>
 *     A serial pool: the first trial starts a `setsid` daemon that waits for the NEXT
 *     trial's vault file <site> (seal | ground-truth) and races it as above until the pool
 *     ends. Prints {"trials":{...}, heartbeat}
 */

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import type { ScriptedDesktopAgent } from "../../src/parallel/agents.ts";
import { scriptedFileAgent } from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import { PoolRefused, runPool, type TrialSpec } from "../../src/parallel/pool.ts";
import { CALC_ORACLE_SOURCES, L_TASK_ID, lTaskRegistry } from "../../src/parallel/throughput.ts";
import { fakeBackend } from "./fake-backend.ts";

const [mode, a, b, c, d, e, f] = process.argv.slice(2);

let beats = 0;
let last = Date.now();
let maxGapMs = 0;
const heart = setInterval(() => {
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - last);
  last = now;
  beats++;
}, 20);
const heartbeat = () => ({ beats, maxGapMs: Math.max(maxGapMs, Date.now() - last) });

function print(out: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ...out, heartbeat: heartbeat() })}\n`);
}

/** Replace `path` with `kind`: a FIFO, a symlink to /dev/zero, or different regular bytes. */
function plant(path: string, kind: string): void {
  rmSync(path, { force: true });
  if (kind === "fifo") {
    if (spawnSync("mkfifo", [path]).status !== 0) throw new Error("mkfifo failed");
  } else if (kind === "zero") symlinkSync("/dev/zero", path);
  else if (kind === "file") writeFileSync(path, "// replaced by the agent\n");
  else throw new Error(`unknown kind ${kind}`);
}

function plantedKind(path: string): string | null {
  const r = spawnSync("stat", ["-c", "%F", path], { encoding: "utf8" });
  const t = r.stdout.trim();
  return t === "fifo" ? "fifo" : t === "symbolic link" ? "symlink" : t ? "file" : null;
}

const CAPS = {
  memoryMbPerTrial: 64,
  cpusPerTrial: 1,
  cpuSecondsPerTrial: 60,
  trialTimeoutMs: 5_000,
  memoryBudgetMb: 1024,
  cpuBudget: 2,
};

async function pool(
  runRoot: string,
  oracleSources: readonly string[],
  trials: TrialSpec[],
  maxConcurrent: number,
): Promise<{ trials: Record<string, unknown>; refused: string[] | null }> {
  const out: Record<string, unknown> = {};
  try {
    const report = await runPool(
      {
        backend: fakeBackend(),
        caps: { ...CAPS, maxConcurrent },
        requirements: STRICT_REQUIREMENTS,
        runRoot,
        tasks: lTaskRegistry(),
        oracleSources,
      },
      trials,
    );
    for (const t of report.trials)
      out[t.runId] = {
        disqualifiers: t.disqualifiers,
        counted: t.countedVerified,
        verdict: t.gate?.verdict ?? null,
        reasons: t.gate?.reasons ?? [],
        error: t.error ?? null,
      };
    return { trials: out, refused: null };
  } catch (err) {
    if (!(err instanceof PoolRefused)) throw err;
    return { trials: out, refused: [...err.problems] };
  }
}

async function oracle(
  runRootArg: string,
  srcDir: string,
  where: string,
  index: number,
  kind: string,
  concurrency: number,
): Promise<void> {
  mkdirSync(runRootArg, { recursive: true });
  const runRoot = realpathSync(runRootArg);
  mkdirSync(srcDir, { recursive: true });
  const sources = CALC_ORACLE_SOURCES.map((s, i) => {
    const copy = join(srcDir, `${i}-${basename(s)}`);
    copyFileSync(s, copy);
    return copy;
  });
  const target = () => {
    if (where !== "snapshot") return sources[index] as string;
    const dir = readdirSync(runRoot).find((n) => n.startsWith("oracle-"));
    if (!dir) throw new Error("no snapshot dir");
    const name = readdirSync(join(runRoot, dir)).find((n) => n.startsWith(`${index}-`));
    if (!name) throw new Error("no snapshot copy");
    return join(runRoot, dir, name);
  };
  if (where === "before") plant(target(), kind);
  const honest = scriptedFileAgent("honest");
  const attacker: ScriptedDesktopAgent = {
    id: `plants-oracle-${where}-${kind}`,
    simulated: true,
    async run(ctx) {
      const done = await honest.run(ctx);
      if (where !== "before") plant(target(), kind);
      return done;
    },
  };
  const r = await pool(
    runRoot,
    sources,
    [
      { runId: "attacker", taskId: L_TASK_ID, agent: attacker },
      { runId: "honest", taskId: L_TASK_ID, agent: honest },
    ],
    concurrency,
  );
  print({ ...r, plantedKind: plantedKind(target()) });
}

/** A vault with one run sealed, stopped and captured (the honest saved file). */
function sealedRun(dir: string): { vault: VerdictVault; receipt: ReturnType<VerdictVault["seal"]> } {
  mkdirSync(dir, { recursive: true });
  const vault = new VerdictVault({ root: join(dir, "vault"), key: newVaultKey(), agentRoots: [] });
  const receipt = vault.seal("run-1", {
    groundTruth: { cell: "B2", value: 42 },
    fixtures: { "fixture.csv": Buffer.from("a,b\n1,2\n") },
    oracle: { id: "fam@1", sourceFiles: CALC_ORACLE_SOURCES },
  });
  vault.markAgentStopped("run-1");
  vault.capture("run-1", { "persisted/sheet.csv": Buffer.from("a,b\n1,42\n") });
  return { vault, receipt };
}

function codesOf(r: ReturnType<VerdictVault["checkIntegrity"]>): string[] {
  return r.ok ? ["ok"] : [...new Set(r.violations.map((v) => v.code))].sort();
}

/**
 * A `setsid` daemon (its own session, as a trial's escaped process would be) that swaps
 * `path` between its regular file and a FIFO in a tight loop. It renames, never writes
 * the regular file, so the file keeps its mode, hash and single link. Exits when `stop`
 * appears.
 */
function raceDaemon(path: string, stop: string, waitFor = false): void {
  const py = `
import os, sys, time
p, stop, wait = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
reg, fifo = p + ".reg", p + ".fifo"
while wait and not os.path.exists(p):
    if os.path.exists(stop): sys.exit(0)
    time.sleep(0.0005)
os.mkfifo(fifo)
while not os.path.exists(stop):
    try:
        os.rename(p, reg); os.rename(fifo, p)
        os.rename(p, fifo); os.rename(reg, p)
    except FileNotFoundError:
        pass
`;
  const child = spawn("setsid", ["python3", "-c", py, path, stop, waitFor ? "1" : "0"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function main(): Promise<void> {
  if (mode === "oracle")
    return oracle(
      a as string,
      b as string,
      c as string,
      Number(d),
      e as string,
      Number(f ?? "2"),
    );
  if (mode === "vault-static") {
    const { vault, receipt } = sealedRun(a as string);
    plant(join(a as string, "vault", "run-1", b as string), c as string);
    print({ codes: codesOf(vault.checkIntegrity("run-1", receipt)) });
    return;
  }
  if (mode === "vault-race") {
    const { vault, receipt } = sealedRun(a as string);
    const stop = join(a as string, "stop");
    raceDaemon(join(a as string, "vault", "run-1", b as string), stop);
    const codes = new Set<string>();
    const n = Number(c);
    // Let the daemon start swapping before the first check.
    await new Promise((r) => setTimeout(r, 300));
    try {
      for (let i = 0; i < n; i++) {
        for (const code of codesOf(vault.checkIntegrity("run-1", receipt))) codes.add(code);
        if (i % 50 === 0) await new Promise((r) => setImmediate(r));
      }
    } finally {
      writeFileSync(stop, "");
    }
    print({ iterations: n, codes: [...codes].sort() });
    return;
  }
  if (mode === "pool-race") {
    mkdirSync(a as string, { recursive: true });
    const runRoot = realpathSync(a as string);
    const stop = join(runRoot, "..", "stop-race");
    const rel = b === "seal" ? "seal.json" : "sealed/ground-truth.json";
    const honest = scriptedFileAgent("honest");
    const starter: ScriptedDesktopAgent = {
      id: "starts-race-daemon",
      simulated: true,
      async run(ctx) {
        raceDaemon(join(runRoot, "vaults", "honest", "honest", rel), stop, true);
        return honest.run(ctx);
      },
    };
    try {
      const r = await pool(
        runRoot,
        CALC_ORACLE_SOURCES,
        [
          { runId: "starter", taskId: L_TASK_ID, agent: starter },
          { runId: "honest", taskId: L_TASK_ID, agent: honest },
        ],
        1,
      );
      print(r);
    } finally {
      writeFileSync(stop, "");
    }
    return;
  }
  throw new Error(`unknown mode ${String(mode)}`);
}

main().then(
  () => {
    clearInterval(heart);
    process.exit(0);
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  },
);
