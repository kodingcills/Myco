/**
 * `myco-run` — the developer entry point for one Direction A task (MVD-001).
 *
 *   pnpm myco-run --transport mock --task df-s01 --out /tmp/myco-run
 *   pnpm myco-run --transport live --task df-s01 --out /tmp/myco-run \
 *     --gate-passed --host-lock /tmp/myco-host.lock
 *
 * Contract (the same one a non-interactive agent environment relies on, and the
 * one `test/discovery/myco-run.test.ts` pins):
 *   - no TTY is read and no prompt is printed; every input is a flag;
 *   - stdout carries the summary, or with `--json` exactly one JSON object;
 *     stderr carries errors and preflight refusals;
 *   - the exit code is the outcome, decided only by `exitCodeFor`, so a verdict
 *     never reaches exit 0 while its artifacts fail validation.
 *
 * The live path needs two things the mock path does not: the Coordinator's GO for
 * this host window (`--gate-passed`) and the shared host lock. Both are flags
 * rather than environment variables so a caller sees them in its own command log;
 * `scripts/s0-live.sh` reads the same two gates from the environment and its
 * launcher sets them.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EXIT_ABORTED,
  EXIT_INVALID_ARTIFACTS,
  EXIT_USAGE,
  exitCodeFor,
  type RunTransport,
  runTaskOnce,
} from "../src/discovery/myco-run.ts";
import { renderArtifactCheck, validateRunDir } from "../src/discovery/run-artifacts.ts";
import { openLiveTransport } from "../src/discovery/run-live.ts";
import { renderRunSummary, summarize } from "../src/discovery/run-summary.ts";
import { RUN_TASK_IDS, runTask } from "../src/discovery/run-tasks.ts";

const ROOT = resolve(import.meta.dirname, "..");

const USAGE = `usage: pnpm myco-run --transport <mock|live> --task <id> --out <dir> [options]

  --task <id>        one of: ${RUN_TASK_IDS.join(", ")}
  --out <dir>        artifact root; the run is written to <dir>/<task>
  --transport mock   contract double, no guest (default)
  --transport live   runtime MCP + guest; requires the gate flags below
  --json             print one JSON object instead of the prose summary
  --session-id <id>  live only: explicit runtime session id
  --host-lock <p>    live only: host lock file (default $TMPDIR/myco-host.lock)
  --gate-passed      live only: the Coordinator's GO for this window
  --validate-only    validate the artifacts already in <out>/<task>; run nothing
  --help             this text

exit: 0 verdict (verified or refuted) with valid artifacts, 1 aborted,
      2 verdict but invalid artifacts, 3 usage error
`;

interface Args {
  readonly transport: RunTransport;
  readonly task: string;
  readonly out: string;
  readonly json: boolean;
  readonly sessionId: string | undefined;
  readonly hostLock: string;
  readonly gatePassed: boolean;
  readonly validateOnly: boolean;
}

type Parsed = { readonly ok: true; readonly args: Args } | { readonly error: string };

function parse(argv: readonly string[]): Parsed {
  let transport: RunTransport = "mock";
  let task: string | undefined;
  let out: string | undefined;
  let json = false;
  let sessionId: string | undefined;
  let hostLock = join(tmpdir(), "myco-host.lock");
  let gatePassed = false;
  let validateOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const next = argv[index + 1];
    const value = (): string | undefined => {
      if (next === undefined || next.startsWith("--")) return undefined;
      index += 1;
      return next;
    };
    switch (flag) {
      case "--transport": {
        const chosen = value();
        if (chosen !== "mock" && chosen !== "live") {
          return {
            error: `--transport needs "mock" or "live", got ${String(chosen ?? "(nothing)")}`,
          };
        }
        transport = chosen;
        break;
      }
      case "--task": {
        const chosen = value();
        if (chosen === undefined) return { error: "--task needs a value" };
        task = chosen;
        break;
      }
      case "--out": {
        const chosen = value();
        if (chosen === undefined) return { error: "--out needs a value" };
        out = chosen;
        break;
      }
      case "--session-id": {
        const chosen = value();
        if (chosen === undefined) return { error: "--session-id needs a value" };
        sessionId = chosen;
        break;
      }
      case "--host-lock": {
        const chosen = value();
        if (chosen === undefined) return { error: "--host-lock needs a value" };
        hostLock = chosen;
        break;
      }
      case "--gate-passed":
        gatePassed = true;
        break;
      case "--validate-only":
        validateOnly = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        return { error: `unknown option ${String(flag)}` };
    }
  }
  if (task === undefined) return { error: "--task is required" };
  if (!RUN_TASK_IDS.includes(task)) {
    return { error: `unknown task "${task}"; known: ${RUN_TASK_IDS.join(", ")}` };
  }
  if (out === undefined) return { error: "--out is required" };
  if (transport === "mock" && (gatePassed || sessionId !== undefined)) {
    return { error: "--gate-passed and --session-id only apply to --transport live" };
  }
  if (validateOnly && (gatePassed || sessionId !== undefined)) {
    return {
      error: "--validate-only runs nothing, so --gate-passed and --session-id do not apply",
    };
  }
  return {
    ok: true,
    args: { transport, task, out, json, sessionId, hostLock, gatePassed, validateOnly },
  };
}

/**
 * Take the host lock by creating its file exclusively, and leave the pid inside so
 * a later reader can tell a live owner from a stale file. A lock already present
 * means the window belongs to another run: refuse, never wait.
 */
function acquireHostLock(path: string): (() => void) | { readonly held: string } {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    let holder = "";
    try {
      holder = readFileSync(path, "utf8").trim();
    } catch {
      holder = "";
    }
    return {
      held:
        holder.length > 0
          ? `the host lock at ${path} is held by pid ${holder}`
          : `the host lock at ${path} exists (stale? remove it once you are sure no run owns it): ${String(error)}`,
    };
  }
  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);
  return () => {
    unlinkSync(path);
  };
}

/**
 * Report one finished run: summary on stdout, artifact problems on stderr, and the
 * exit code `exitCodeFor` decides. Both transports end here, so a live run cannot
 * become more permissive than a mock one by taking a different path out.
 */
function report(outcome: Awaited<ReturnType<typeof runTaskOnce>>, json: boolean): number {
  const artifacts = validateRunDir(outcome.runDir);
  const exitCode = exitCodeFor(outcome.result, artifacts);
  const summary = summarize(outcome, artifacts, exitCode);
  process.stdout.write(json ? `${JSON.stringify(summary, null, 2)}\n` : renderRunSummary(summary));
  if (!artifacts.ok) process.stderr.write(renderArtifactCheck(artifacts));
  return exitCode;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const parsed = parse(argv);
  if ("error" in parsed) {
    process.stderr.write(`myco-run: ${parsed.error}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const args = parsed.args;
  const outDir = resolve(args.out);

  // Re-check what a previous run wrote, without running anything: the exit code a
  // caller gets here is the same one the run itself would have returned.
  if (args.validateOnly) {
    const runDir = join(outDir, args.task);
    const artifacts = validateRunDir(runDir);
    // Name the task and say why a directory is missing: with several task dirs
    // under one --out, a silent "not readable" reads like the wrong dir was checked.
    const reason = existsSync(runDir)
      ? ""
      : `  note: ${runDir} does not exist; --out must be the directory an earlier run\n` +
        `        wrote ${args.task} into, not the task's own directory.\n`;
    process.stdout.write(
      renderArtifactCheck(artifacts).replace(/(\n)/, `$1  task: ${args.task}\n`),
    );
    if (reason) process.stdout.write(reason);
    return artifacts.ok ? 0 : EXIT_INVALID_ARTIFACTS;
  }

  if (args.transport === "live") {
    if (!args.gatePassed) {
      process.stderr.write(
        "myco-run: refusing the live path without the Coordinator's GO for this window.\n" +
          "A GO is given in conversation, recorded in the coordination log, then passed\n" +
          "here as --gate-passed. There is no other way to open it.\n",
      );
      return EXIT_ABORTED;
    }
    const lock = acquireHostLock(args.hostLock);
    if (typeof lock === "object") {
      process.stderr.write(`myco-run: refusing: ${lock.held}\n`);
      return EXIT_ABORTED;
    }
    try {
      const opened = await openLiveTransport({
        root: ROOT,
        gate: { coordinatorGo: true, hostLock: true },
        task: runTask(args.task),
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      });
      if (!opened.ok) {
        process.stderr.write(`myco-run: live transport refused (${opened.reasons.join("; ")})\n`);
        process.stderr.write(opened.report);
        process.stderr.write(
          "no run directory was written. The live path stops at the preflight until every\n" +
            "check has an owner who can establish it; see docs/product/quickstart.md §7.\n",
        );
        return opened.code;
      }
      try {
        return report(
          await runTaskOnce({
            task: args.task,
            transport: "live",
            outDir,
            transportImpl: opened.transport,
          }),
          args.json,
        );
      } finally {
        await opened.transport.destroy();
      }
    } finally {
      lock();
    }
  }

  return report(await runTaskOnce({ task: args.task, transport: "mock", outDir }), args.json);
}

process.exit(await main(process.argv.slice(2)));
