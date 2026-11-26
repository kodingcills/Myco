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
 */

import { closeSync, fstatSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import type { ScriptedDesktopAgent } from "../../src/parallel/agents.ts";
import { claimFor } from "../../src/parallel/agents.ts";
import { STRICT_REQUIREMENTS } from "../../src/parallel/backend.ts";
import {
  CaptureRefused,
  captureRegularFile,
  openNoBlock,
  runPool,
} from "../../src/parallel/pool.ts";
import { CALC_ORACLE_SOURCES, L_TASK_ID, lTaskRegistry } from "../../src/parallel/throughput.ts";
import { fakeBackend } from "./fake-backend.ts";

const [mode, a, b] = process.argv.slice(2);

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
  throw new Error(`unknown mode ${String(mode)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(2);
  },
);
