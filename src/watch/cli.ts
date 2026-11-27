/**
 * `myco watch` CLI (TIF-265 follow-up, scope add A). `scripts/myco-watch.ts` is a thin shell
 * over `main`; `bin/myco watch …` calls it.
 *
 *   myco watch --run <runId> [--task <id>] --decision-log <file> [--frames <dir> | --sealed-capture <vaultRoot>]
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
import { startWatchServer, WatchBindError, type WatchServer } from "./server.ts";

export const EXIT_USAGE = 3;
export const DEFAULT_PORT = 8740;

export const USAGE = `usage:
  myco watch --run <runId> [--run <runId> ...] [--task <id> ...]
             [--decision-log <file> | --decision-log <runId>=<file> ...]
             [--frames <dir> | --sealed-capture <vaultRoot>]
             [--host 127.0.0.1] [--port ${DEFAULT_PORT}] [--allow-non-loopback]
  myco watch --demo todo-items|calc-multi-step [--out <dir>] [--host …] [--port …]

  --run <id>               a run to show (repeatable); events for any other run are not shown
  --task <id>              a task id the page may show (repeatable); others show as blank
  --decision-log <file>    the gate's decision log (myco-gate --audit), read-only, tailed live
  --decision-log <runId>=<file>
                           one listed run's own log, the audit log of the one gate bound to
                           that run (repeatable, one per run). The replay scrubber pins a run's
                           decisions to its frames only from its own log (or from the plain
                           --decision-log when one run is listed), with the one --task given
  --frames <dir>           frames from <dir>/<runId>/*.png (PNG only; re-encoded from pixels,
                           metadata dropped; other image types are never served)
  --sealed-capture <dir>   frames from the vault: <dir>/<runId>/captured/**.png (PNG only;
                           captured/persisted and everything outside captured/ is never read)
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
]);
const REPEATABLE = new Set(["--run", "--task", "--decision-log"]);
const BOOL_FLAGS = new Set(["--allow-non-loopback"]);

export interface ParsedWatchArgs {
  readonly runs: string[];
  readonly tasks: string[];
  readonly decisionLog?: string;
  /** Per-run own logs (`--decision-log <runId>=<file>`), keyed by listed run. */
  readonly decisionLogs?: ReadonlyMap<string, string>;
  readonly frames?: string;
  readonly sealedCapture?: string;
  readonly host: string;
  readonly port: number;
  readonly allowNonLoopback: boolean;
  readonly demo?: DemoFamily;
  readonly out?: string;
}

export class WatchUsageError extends Error {}

const PER_RUN_LOG = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})=(.+)$/;

/**
 * `--decision-log` values: one plain `<file>`, or one `<runId>=<file>` per listed run (each
 * run's own log, spec #589 §1.2). The two forms do not mix; a run's own log is given once, and
 * two runs never share one path (a shared log is no trial's own log). Paths are not printed.
 */
function splitDecisionLogs(
  values: readonly string[],
  runs: ReadonlySet<string>,
): { plain: string | undefined; perRun: Map<string, string> } {
  const perRun = new Map<string, string>();
  const plain: string[] = [];
  for (const value of values) {
    const match = PER_RUN_LOG.exec(value);
    const runId = match?.[1];
    if (match === null || runId === undefined || !runs.has(runId)) {
      plain.push(value);
      continue;
    }
    if (perRun.has(runId)) throw new WatchUsageError("a run's own --decision-log is given twice");
    if ([...perRun.values()].includes(match[2] as string))
      throw new WatchUsageError("two runs name the same --decision-log (a shared log)");
    perRun.set(runId, match[2] as string);
  }
  if (plain.length > 1) throw new WatchUsageError("--decision-log given twice");
  if (plain.length > 0 && perRun.size > 0)
    throw new WatchUsageError(
      "give one --decision-log <file>, or <runId>=<file> per run, not both",
    );
  return { plain: plain[0], perRun };
}

export function parseWatchArgs(argv: readonly string[]): ParsedWatchArgs {
  const single = new Map<string, string>();
  const multi = new Map<string, string[]>([
    ["--run", []],
    ["--task", []],
    ["--decision-log", []],
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
  const logs = splitDecisionLogs(multi.get("--decision-log") ?? [], new Set(runs));
  if (demo !== undefined) {
    if (logs.plain !== undefined || logs.perRun.size > 0)
      throw new WatchUsageError("--decision-log does not go with --demo");
    for (const flag of ["--frames", "--sealed-capture"])
      if (single.has(flag)) throw new WatchUsageError(`${flag} does not go with --demo`);
    if (runs.length > 0 || tasks.length > 0)
      throw new WatchUsageError("--run/--task do not go with --demo (the demo names its runs)");
  } else if (runs.length === 0) {
    throw new WatchUsageError("--run is required (the page shows only runs you name)");
  }
  const opt = (flag: string) => single.get(flag);
  return {
    runs,
    tasks,
    host: opt("--host") ?? "127.0.0.1",
    port,
    allowNonLoopback,
    ...(logs.plain === undefined ? {} : { decisionLog: logs.plain }),
    ...(logs.perRun.size === 0 ? {} : { decisionLogs: logs.perRun }),
    ...(opt("--frames") === undefined ? {} : { frames: opt("--frames") }),
    ...(opt("--sealed-capture") === undefined ? {} : { sealedCapture: opt("--sealed-capture") }),
    ...(demo === undefined ? {} : { demo }),
    ...(opt("--out") === undefined ? {} : { out: opt("--out") }),
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
    ...(args.decisionLogs === undefined ? {} : { decisionLogs: args.decisionLogs }),
    ...(frames === undefined ? {} : { frames }),
  });
  stdout.write(`myco watch (read-only): ${server.url}\n`);
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
