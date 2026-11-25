/**
 * `myco-gate` CLI (TIF-265). `scripts/myco-gate.ts` is a thin shell over `main`.
 *
 * Every input is a flag; no TTY is read. The operator flags (`--evidence-root`, `--tasks`,
 * `--audit`) configure the gate; only `check`'s `--task`, `--run` and `--claim` are the
 * request, and they go through the same parser an MCP call goes through.
 */
import { appendFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { GateResult } from "./api.ts";
import { renderDemo, runMockDemo } from "./demo.ts";
import { buildRegistry, createGate, fileEvidenceReader, type TaskEntry } from "./gate.ts";
import { serveStdio } from "./mcp-server.ts";
import { builtinTasks, loadTasksFile } from "./tasks.ts";

export const EXIT_VERIFIED = 0;
export const EXIT_REFUTED = 1;
export const EXIT_UNCERTAIN = 2;
export const EXIT_USAGE = 3;

export const USAGE = `usage:
  myco-gate check --evidence-root <dir> --task <id> --run <id> [--claim <text>] [options]
  myco-gate mcp   --evidence-root <dir> --task <id> --run <id> [options]
  myco-gate demo  --transport mock [--out <dir>] [--json]

operator options (check, mcp):
  --evidence-root <dir>  persisted state is read from <dir>/<runId>/<task stateFile>
  --task <id> --run <id> the assignment: the one task and run this gate serves (mcp: the
                         agent's trial; any other task or run is ASSIGNMENT_MISMATCH)
  --tasks <file>         extra tasks: { "tasks": [ { id, family, stateFile, spec } ] }
  --no-builtin           do not register the built-in myco-run tasks (df-s01, df-s02)
  --audit <file>         append every decision as one JSON line (fails closed if unwritable)
  --json                 check: print the GateResult as JSON

exit (check): 0 verified, 1 refuted, 2 uncertain, 3 usage
exit (mcp):   0 when stdin closes, 3 usage
exit (demo):  0 when every scenario behaves as expected, 1 otherwise, 3 usage
`;

export interface Io {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

type Flags = Map<string, string | true>;

const VALUE_FLAGS = new Set([
  "--evidence-root",
  "--tasks",
  "--audit",
  "--task",
  "--run",
  "--claim",
  "--out",
  "--transport",
]);
const BOOL_FLAGS = new Set(["--json", "--no-builtin"]);

function parseFlags(argv: readonly string[]): Flags | string {
  const flags: Flags = new Map();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index] ?? "";
    if (BOOL_FLAGS.has(flag)) flags.set(flag, true);
    else if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return `${flag} needs a value`;
      flags.set(flag, value);
      index += 1;
    } else return `unknown option ${flag}`;
  }
  return flags;
}

function str(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function operatorGate(flags: Flags) {
  const task = str(flags, "--task");
  const run = str(flags, "--run");
  if (task === undefined || run === undefined)
    throw new UsageError("--task and --run are required (the gate serves one assigned run)");
  const root = str(flags, "--evidence-root");
  if (root === undefined) throw new UsageError("--evidence-root is required");
  const entries: TaskEntry[] = flags.has("--no-builtin") ? [] : builtinTasks();
  const tasksFile = str(flags, "--tasks");
  if (tasksFile !== undefined) entries.push(...loadTasksFile(tasksFile));
  if (entries.length === 0)
    throw new UsageError("no tasks registered (--no-builtin without --tasks)");
  const audit = str(flags, "--audit");
  return createGate({
    tasks: buildRegistry(entries),
    reader: fileEvidenceReader(root),
    assignment: { taskId: task, runId: run },
    ...(audit === undefined
      ? {}
      : {
          onDecision: (result: GateResult) => appendFileSync(audit, `${JSON.stringify(result)}\n`),
        }),
  });
}

class UsageError extends Error {}

function exitFor(result: GateResult): number {
  return result.verdict === "verified"
    ? EXIT_VERIFIED
    : result.verdict === "refuted"
      ? EXIT_REFUTED
      : EXIT_UNCERTAIN;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    rest.includes("--help")
  ) {
    io.stdout.write(USAGE);
    return command === undefined ? EXIT_USAGE : 0;
  }
  const flags = parseFlags(rest);
  if (typeof flags === "string") {
    io.stderr.write(`myco-gate: ${flags}\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    switch (command) {
      case "check": {
        // The operator's own call: the request is the assignment.
        const gate = operatorGate(flags);
        const task = str(flags, "--task") as string;
        const run = str(flags, "--run") as string;
        const claim = str(flags, "--claim");
        const result = await gate.check({
          taskId: task,
          runId: run,
          ...(claim === undefined ? {} : { claim }),
        });
        io.stdout.write(
          flags.has("--json")
            ? `${JSON.stringify(result, null, 2)}\n`
            : `${result.verdict}${result.accepted ? " (accepted)" : " (not accepted)"}: ${result.reasonCodes.join(", ")}\n${result.reasons.map((r) => `  - ${r}\n`).join("")}`,
        );
        return exitFor(result);
      }
      case "mcp": {
        const gate = operatorGate(flags);
        await serveStdio(gate, io.stdin, io.stdout);
        return 0;
      }
      case "demo": {
        if (str(flags, "--transport") !== "mock") {
          throw new UsageError("demo needs --transport mock (the live path is M2-12)");
        }
        const out = str(flags, "--out");
        const report = await runMockDemo(out === undefined ? {} : { outDir: out });
        io.stdout.write(
          flags.has("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderDemo(report),
        );
        return report.ok ? 0 : 1;
      }
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (
      error instanceof UsageError ||
      (error instanceof Error && /^invalid gate (task registry|assignment)/.test(error.message))
    ) {
      io.stderr.write(`myco-gate: ${error.message}\n`);
      return EXIT_USAGE;
    }
    io.stderr.write(`myco-gate: ${String(error)}\n`);
    return EXIT_USAGE;
  }
}
