/**
 * Child process for the special-file tests in pool.test.ts (round-1 D2).
 *
 * A blocking open of a FIFO freezes the whole Node event loop: no timer, no vitest
 * timeout and no sibling trial runs again. So these cases run here, in a child the test
 * kills after a hard wall-clock limit; a regression shows up as a killed child (a test
 * failure), never as a frozen test run.
 *
 *   tsx special-file-child.ts capture <workspace-dir> <rel>
 *     prints {"refused":"<code>"} or {"bytes":<n>}
 *   tsx special-file-child.ts open <path>
 *     opens <path> the way capture and the scan do and prints {"regular":bool}: on a FIFO
 *     it must return at once (the guard against a file swapped after the lstat)
 *   tsx special-file-child.ts pool <run-root> fifo|dir|socket
 *     runs one trial on the fake backend whose agent replaces its state file with that
 *     special file, and prints {"disqualifiers":[...],"counted":bool,"error":"..."}
 *   tsx special-file-child.ts swapped-capture <workspace-dir> <rel>
 *   tsx special-file-child.ts swapped-scan <dir>
 *     round-3 B3: the same, but the pre-open lstat LIES (reports the FIFO at <rel>/<dir>
 *     as a small regular file), standing in for a swap between the lstat and the open.
 *     Prints {"refused":"<code>"} / {"bytes":n} or {"complete":bool}
 *   tsx special-file-child.ts evidence <run-root> <site> fifo|file|dirlink
 *     round-3 B1: two trials, an attacker and an honest sibling, on the fake backend. Before
 *     the harness writes <site> (marker | fixture | mcp | agent-output | record |
 *     pool-report), something is planted at that path: a FIFO, a regular file, or (dirlink)
 *     the target's dir swapped for a symlink. Prints
 *     {"trials":{runId:{disqualifiers,counted,error}},"rejected":code|null}
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import type { ScriptedDesktopAgent } from "../../src/parallel/agents.ts";
import { claimFor, scriptedFileAgent } from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import {
  CaptureRefused,
  captureRegularFile,
  HarnessWriteRefused,
  MARKER_FILE,
  openNoBlock,
  runPool,
  scanTree,
} from "../../src/parallel/pool.ts";
import { CALC_ORACLE_SOURCES, L_TASK_ID, lTaskRegistry } from "../../src/parallel/throughput.ts";
import { fakeBackend } from "./fake-backend.ts";

const [mode, a, b, c] = process.argv.slice(2);

/** Plant `kind` at `path` (whose parent exists). */
function plant(path: string, kind: string): void {
  if (kind === "fifo") {
    if (spawnSync("mkfifo", [path]).status !== 0) throw new Error("mkfifo failed");
  } else if (kind === "file") {
    writeFileSync(path, "planted\n");
  } else if (kind === "dirlink") {
    // Swap the target's dir for a symlink to a decoy dir two levels up (outside the trial's
    // root): a write must not go through it.
    const dir = dirname(path);
    const decoy = join(dirname(dirname(dir)), `${basename(dirname(dir))}-${basename(dir)}.decoy`);
    renameSync(dir, decoy);
    symlinkSync(decoy, dir);
  } else throw new Error(`unknown kind ${kind}`);
}

async function evidence(runRootArg: string, site: string, kind: string): Promise<void> {
  mkdirSync(runRootArg, { recursive: true });
  const runRoot = realpathSync(runRootArg);
  const honest = scriptedFileAgent("honest");
  const attacker: ScriptedDesktopAgent = {
    id: `plants-${site}`,
    simulated: true,
    async run(ctx) {
      const done = await honest.run(ctx);
      const ev = join(runRoot, "evidence", ctx.runId);
      if (site === "agent-output") plant(join(ev, "agent-output.txt"), kind);
      if (site === "record") plant(join(ev, "record.json"), kind);
      if (site === "pool-report") plant(join(runRoot, "pool-report.json"), kind);
      return done;
    },
  };
  const backend = fakeBackend({
    afterCreate(runId, paths) {
      if (runId !== "attacker") return;
      if (site === "marker") plant(join(paths.workspace, MARKER_FILE), kind);
      if (site === "fixture") plant(join(paths.workspace, "sheet.csv"), kind);
      if (site === "mcp") plant(join(paths.home, "mcp.json"), kind);
    },
  });
  let rejected: string | null = null;
  const trials: Record<string, unknown> = {};
  try {
    const report = await runPool(
      {
        backend,
        caps: {
          maxConcurrent: 2,
          memoryMbPerTrial: 64,
          cpusPerTrial: 1,
          cpuSecondsPerTrial: 60,
          trialTimeoutMs: 5_000,
          memoryBudgetMb: 1024,
          cpuBudget: 2,
        },
        requirements: STRICT_REQUIREMENTS,
        runRoot,
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
      },
      [
        { runId: "attacker", taskId: L_TASK_ID, agent: attacker },
        { runId: "honest", taskId: L_TASK_ID, agent: honest },
      ],
    );
    for (const t of report.trials)
      trials[t.runId] = {
        disqualifiers: t.disqualifiers,
        counted: t.countedVerified,
        error: t.error ?? null,
      };
  } catch (e) {
    if (!(e instanceof HarnessWriteRefused)) throw e;
    rejected = e.code;
  }
  process.stdout.write(`${JSON.stringify({ trials, rejected })}\n`);
}

async function main(): Promise<void> {
  if (mode === "capture") {
    try {
      const bytes = captureRegularFile(realpathSync(a as string), b as string);
      process.stdout.write(`${JSON.stringify({ bytes: bytes.length })}\n`);
    } catch (e) {
      if (!(e instanceof CaptureRefused)) throw e;
      process.stdout.write(`${JSON.stringify({ refused: e.code })}\n`);
    }
    return;
  }
  if (mode === "open") {
    const fd = openNoBlock(a as string);
    try {
      process.stdout.write(`${JSON.stringify({ regular: fstatSync(fd).isFile() })}\n`);
    } finally {
      closeSync(fd);
    }
    return;
  }
  if (mode === "pool") {
    const kind = b as "fifo" | "dir" | "socket";
    const agent: ScriptedDesktopAgent = {
      id: `plants-${kind}`,
      simulated: true,
      async run(ctx) {
        if (kind === "socket") {
          await ctx.desktop.exec("rm", ["-f", ctx.stateFile]);
          const server = createServer();
          await new Promise<void>((r) =>
            server.listen(`${ctx.desktop.paths.workspace}/${ctx.stateFile}`, r),
          );
          server.unref();
        } else {
          await ctx.desktop.exec("sh", [
            "-c",
            kind === "fifo" ? 'rm -f "$1" && mkfifo "$1"' : 'rm -f "$1" && mkdir "$1"',
            "sh",
            ctx.stateFile,
          ]);
        }
        const claim = claimFor(ctx.spec);
        return { claim, output: "" };
      },
    };
    const report = await runPool(
      {
        backend: fakeBackend(),
        caps: {
          maxConcurrent: 1,
          memoryMbPerTrial: 64,
          cpusPerTrial: 1,
          cpuSecondsPerTrial: 60,
          trialTimeoutMs: 5_000,
          memoryBudgetMb: 1024,
          cpuBudget: 1,
        },
        requirements: STRICT_REQUIREMENTS,
        runRoot: a as string,
        tasks: lTaskRegistry(),
        oracleSources: CALC_ORACLE_SOURCES,
      },
      [{ runId: `special-${kind}`, taskId: L_TASK_ID, agent }],
    );
    const t = report.trials[0];
    process.stdout.write(
      `${JSON.stringify({ disqualifiers: t?.disqualifiers, counted: t?.countedVerified, error: t?.error })}\n`,
    );
    return;
  }
  if (mode === "swapped-capture" || mode === "swapped-scan") {
    // Report every non-dir as a 10-byte regular file, as if lstat ran before the swap.
    const liar = (p: string) => {
      const st = lstatSync(p);
      if (st.isDirectory()) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
        size: 10,
        isFile: () => true,
        isFIFO: () => false,
        isSymbolicLink: () => false,
      }) as typeof st;
    };
    if (mode === "swapped-scan") {
      const r = scanTree(a as string, new Map([["x", "MYCO-L-MARK-x"]]), liar);
      process.stdout.write(`${JSON.stringify({ complete: r.complete })}\n`);
      return;
    }
    try {
      const bytes = captureRegularFile(realpathSync(a as string), b as string, liar);
      process.stdout.write(`${JSON.stringify({ bytes: bytes.length })}\n`);
    } catch (e) {
      if (!(e instanceof CaptureRefused)) throw e;
      process.stdout.write(`${JSON.stringify({ refused: e.code })}\n`);
    }
    return;
  }
  if (mode === "evidence") return evidence(a as string, b as string, c as string);
  throw new Error(`unknown mode ${String(mode)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(2);
  },
);
