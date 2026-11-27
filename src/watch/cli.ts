/**
 * `myco watch` CLI (TIF-265 follow-up, scope add A). `scripts/myco-watch.ts` is a thin shell
 * over `main`; `bin/myco watch …` calls it.
 *
 *   myco watch --run <runId> [--task <id>] --decision-log <file> [--frames <dir> | --sealed-capture <vaultRoot>]
 *   myco watch --pilot <runDir | A/B stageRoot>     (follow a pilot run; see run-dir.ts)
 *   myco watch --demo todo-items|calc-multi-step [--out <dir>]
 *
 * Every run/task the page may show is named here by the operator. The server binds
 * 127.0.0.1 by default and refuses any non-loopback `--host` unless `--allow-non-loopback`
 * is given. Outside `--demo` this command writes no file.
 */
import type { Writable } from "node:stream";
import { isSafeId } from "../gate/api.ts";
import { type DemoFamily, startWatchDemo } from "./demo.ts";
import { directoryFrameSource } from "./frames.ts";
import { pilotRunSource } from "./run-dir.ts";
import { hostNeedles } from "./sanitize-frame.ts";
import { startWatchServer, WatchBindError, type WatchServer } from "./server.ts";

export const EXIT_USAGE = 3;
export const DEFAULT_PORT = 8740;

export const USAGE = `usage:
  myco watch --run <runId> [--run <runId> ...] [--task <id> ...]
             [--decision-log <file>] [--frames <dir> | --sealed-capture <vaultRoot>]
             [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--allow-non-loopback]
  myco watch --pilot <runDir> [--run <runId> ... --decision-log <file> ...] [--host …] [--port …]
  myco watch --demo todo-items|calc-multi-step [--out <dir>] [--host …] [--port …]

  --run <id>               a run to show (repeatable); events for any other run are not shown
  --task <id>              a task id the page may show (repeatable); others show as blank
  --decision-log <file>    the gate's decision log (myco-gate --audit), read-only, tailed live
  --frames <dir>           frames from <dir>/<runId>/*.png (PNG only; re-encoded from pixels,
                           metadata dropped; other image types are never served)
  --sealed-capture <dir>   frames from the vault: <dir>/<runId>/captured/**.png (PNG only;
                           captured/persisted and everything outside captured/ is never read)
  --pilot <runDir>         follow an R1 pilot run directory, or an A/B stage root (on/, off/),
                           as it runs: attempts, the agent's actions (counts and closed tool
                           names), gate calls, verdicts, the heartbeat. Read-only; only the
                           run's progress, heartbeat, attempt-ledger, grade and transcript
                           files are read, never the vault or the oracle's inputs
  --host <addr>            bind address (default 127.0.0.1); non-loopback is refused unless
  --allow-non-loopback     is given (the stream is unauthenticated: think before using it)
  --port <n>               port (default ${DEFAULT_PORT}; 0 picks a free port)
  --demo <family>          run the mock gate demo (no VM, no model) and watch it live
  --out <dir>              demo output directory (default: a new temp directory)

read-only: every route is GET; the view never calls the gate, the vault, an oracle or the agent.
exit: 0 on Ctrl-C, ${EXIT_USAGE} usage or bind refused
`;

const VALUE_FLAGS = new Set([
  "--run",
  "--task",
  "--decision-log",
  "--frames",
  "--sealed-capture",
  "--host",
  "--port",
  "--demo",
  "--out",
  "--pilot",
]);
const REPEATABLE = new Set(["--run", "--task"]);
const BOOL_FLAGS = new Set(["--allow-non-loopback"]);

export interface ParsedWatchArgs {
  readonly runs: string[];
  readonly tasks: string[];
  readonly decisionLog?: string;
  readonly frames?: string;
  readonly sealedCapture?: string;
  readonly host: string;
  readonly port: number;
  readonly allowNonLoopback: boolean;
  readonly demo?: DemoFamily;
  readonly out?: string;
  readonly pilot?: string;
}

export class WatchUsageError extends Error {}

export function parseWatchArgs(argv: readonly string[]): ParsedWatchArgs {
  const single = new Map<string, string>();
  const multi = new Map<string, string[]>([
    ["--run", []],
    ["--task", []],
  ]);
  let allowNonLoopback = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    if (BOOL_FLAGS.has(flag)) {
      allowNonLoopback = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new WatchUsageError(`unknown option ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new WatchUsageError(`${flag} needs a value`);
    i += 1;
    if (REPEATABLE.has(flag)) multi.get(flag)?.push(value);
    else if (single.has(flag)) throw new WatchUsageError(`${flag} given twice`);
    else single.set(flag, value);
  }
  const runs = multi.get("--run") ?? [];
  const tasks = multi.get("--task") ?? [];
  for (const id of [...runs, ...tasks])
    if (!isSafeId(id)) throw new WatchUsageError(`not a safe id: ${JSON.stringify(id)}`);
  const portText = single.get("--port") ?? String(DEFAULT_PORT);
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535 || port === 8765)
    throw new WatchUsageError(`--port must be 0-65535 (and not 8765, the guest port)`);
  const demo = single.get("--demo");
  if (demo !== undefined && demo !== "todo-items" && demo !== "calc-multi-step")
    throw new WatchUsageError("--demo must be todo-items or calc-multi-step");
  if (single.has("--frames") && single.has("--sealed-capture"))
    throw new WatchUsageError("give --frames or --sealed-capture, not both");
  if (demo !== undefined) {
    for (const flag of ["--decision-log", "--frames", "--sealed-capture", "--pilot"])
      if (single.has(flag)) throw new WatchUsageError(`${flag} does not go with --demo`);
    if (runs.length > 0 || tasks.length > 0)
      throw new WatchUsageError("--run/--task do not go with --demo (the demo names its runs)");
  } else if (runs.length === 0 && !single.has("--pilot")) {
    throw new WatchUsageError(
      "--run is required, or --pilot <runDir> (the page shows only runs you name)",
    );
  }
  const opt = (flag: string) => single.get(flag);
  return {
    runs,
    tasks,
    host: opt("--host") ?? "127.0.0.1",
    port,
    allowNonLoopback,
    ...(opt("--decision-log") === undefined ? {} : { decisionLog: opt("--decision-log") }),
    ...(opt("--frames") === undefined ? {} : { frames: opt("--frames") }),
    ...(opt("--sealed-capture") === undefined ? {} : { sealedCapture: opt("--sealed-capture") }),
    ...(demo === undefined ? {} : { demo }),
    ...(opt("--out") === undefined ? {} : { out: opt("--out") }),
    ...(opt("--pilot") === undefined ? {} : { pilot: opt("--pilot") }),
  } as ParsedWatchArgs;
}

export interface Started {
  readonly server: WatchServer;
  readonly done?: Promise<unknown>;
}

/** Start what the arguments ask for. Throws `WatchUsageError` / `WatchBindError`. */
export async function startFromArgs(args: ParsedWatchArgs, stdout: Writable): Promise<Started> {
  const bind = { host: args.host, port: args.port, allowNonLoopback: args.allowNonLoopback };
  if (args.demo !== undefined) {
    const demo = await startWatchDemo({
      ...bind,
      family: args.demo,
      ...(args.out === undefined ? {} : { outDir: args.out }),
    });
    stdout.write(`myco watch (demo ${args.demo}, mock, no VM): ${demo.server.url}\n`);
    stdout.write(`demo output (operator only, never served): ${demo.outDir}\n`);
    const done = demo.done.then(
      (report) => stdout.write(`demo finished: ${report.ok ? "PASS" : "FAIL"} (Ctrl-C to stop)\n`),
      (error: unknown) => stdout.write(`demo failed: ${String(error)}\n`),
    );
    return { server: demo.server, done };
  }
  const runSet = new Set(args.runs);
  const frames =
    args.frames !== undefined
      ? directoryFrameSource(args.frames, "per-run", runSet)
      : args.sealedCapture !== undefined
        ? directoryFrameSource(args.sealedCapture, "sealed", runSet)
        : undefined;
  const server = await startWatchServer({
    ...bind,
    runs: args.runs,
    tasks: args.tasks,
    ...(args.decisionLog === undefined ? {} : { decisionLog: args.decisionLog }),
    ...(frames === undefined ? {} : { frames }),
    ...(args.pilot === undefined
      ? {}
      : { pilot: pilotRunSource(args.pilot, { needles: hostNeedles() }) }),
  });
  // The run directory's path is the operator's own input: never echoed, never served.
  stdout.write(
    `myco watch (read-only${args.pilot === undefined ? "" : ", pilot run"}): ${server.url}\n`,
  );
  return { server };
}

export async function main(
  argv: readonly string[],
  io: { readonly stdout: Writable; readonly stderr: Writable },
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write(USAGE);
    return argv.length === 0 ? EXIT_USAGE : 0;
  }
  let started: Started;
  try {
    started = await startFromArgs(parseWatchArgs(argv), io.stdout);
  } catch (error) {
    if (error instanceof WatchUsageError || error instanceof WatchBindError) {
      io.stderr.write(`myco watch: ${error.message}\n`);
      return EXIT_USAGE;
    }
    io.stderr.write(`myco watch: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await started.server.close();
  return 0;
}
