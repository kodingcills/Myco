/**
 * `myco verify` (spec #589 §3.1, build PR V1 subset; issue #666): an operator CLI, never an
 * agent tool. No MCP server exposes it.
 *
 *   myco verify <runId> --task <taskId> --mock-evidence <evidenceRoot>
 *               [--tasks <file> [--no-builtin]] [--decision-log <file>]
 *               [--identity-file <file>] [--user-file <file>] [--json]
 *
 * Exit codes: 0 verified, 1 refuted, 2 uncertain, 3 usage (as `myco-gate check`). The run id
 * and task come from the operator and must be safe ids. Reads only; writes no file. The vault
 * source (`--vault`), the recording source (`--recording`), transcripts and `--out` bundles are
 * not in this build: each is a usage error (exit 3), never a silent fallback.
 */
import type { Writable } from "node:stream";
import { isSafeId } from "../gate/api.ts";
import { buildRegistry, type TaskEntry } from "../gate/gate.ts";
import { builtinTasks, loadTasksFile } from "../gate/tasks.ts";
import { guardWithHost, readIdentityLines } from "../proof/identity.ts";
import { readRegular } from "../watch/frames.ts";
import { exitCodeFor, verifyRun } from "./verify.ts";

export const EXIT_USAGE = 3;

export const VERIFY_USAGE = `usage:
  myco verify <runId> --task <taskId> --mock-evidence <evidenceRoot>
              [--tasks <file> [--no-builtin]] [--decision-log <file>]
              [--identity-file <file>] [--user-file <file>] [--json]

Re-verifies a recorded run from its captured data with the gate's own code (read-only).
--mock-evidence results are always trust "mock", simulated: never evidence.
--decision-log is the audit log of the one gate bound to this run; every line is this run's
call. Not in this build: --vault, --recording, --transcript, --out.
exit: 0 verified, 1 refuted, 2 uncertain, ${EXIT_USAGE} usage
`;

const VALUE_FLAGS = [
  "--task",
  "--mock-evidence",
  "--tasks",
  "--decision-log",
  "--identity-file",
  "--user-file",
];
const BOOL_FLAGS = ["--no-builtin", "--json"];
/** Sources and outputs the spec names that this build does not have: usage errors. */
const NOT_IN_THIS_BUILD = ["--vault", "--recording", "--transcript", "--client", "--out"];

class UsageError extends Error {}

export async function verifyMain(
  argv: readonly string[],
  io: { readonly stdout: Writable; readonly stderr: Writable },
): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write(VERIFY_USAGE);
    return argv.length === 0 ? EXIT_USAGE : 0;
  }
  try {
    const values = new Map<string, string>();
    const flags = new Set<string>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i] as string;
      if (NOT_IN_THIS_BUILD.includes(arg)) throw new UsageError(`${arg} is not in this build`);
      if (BOOL_FLAGS.includes(arg)) {
        flags.add(arg);
        continue;
      }
      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }
      if (!VALUE_FLAGS.includes(arg)) throw new UsageError(`unknown option ${arg}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw new UsageError(`${arg} needs a value`);
      if (values.has(arg)) throw new UsageError(`${arg} given twice`);
      values.set(arg, value);
      i += 1;
    }
    const [runId, ...extra] = positional;
    const taskId = values.get("--task");
    const evidenceRoot = values.get("--mock-evidence");
    if (runId === undefined || extra.length > 0) throw new UsageError("give exactly one <runId>");
    if (taskId === undefined) throw new UsageError("--task is required");
    if (!isSafeId(runId) || !isSafeId(taskId))
      throw new UsageError("<runId> and --task must be safe ids");
    if (evidenceRoot === undefined)
      throw new UsageError("give exactly one source: --mock-evidence");
    const entries: TaskEntry[] = flags.has("--no-builtin") ? [] : builtinTasks();
    const tasksFile = values.get("--tasks");
    if (tasksFile !== undefined) entries.push(...loadTasksFile(tasksFile));
    if (entries.length === 0)
      throw new UsageError("no tasks registered (--no-builtin without --tasks)");
    const logPath = values.get("--decision-log");
    let decisionLog: Uint8Array | undefined;
    if (logPath !== undefined) {
      const bytes = readRegular(logPath);
      if (bytes === null) throw new UsageError("--decision-log is not a readable regular file");
      decisionLog = bytes;
    }
    const guard = guardWithHost({
      names: [
        ...readIdentityLines(values.get("--identity-file")),
        ...readIdentityLines(values.get("--user-file")),
      ],
      homes: [],
    });
    const result = await verifyRun({
      runId,
      taskId,
      tasks: buildRegistry(entries),
      evidenceRoot,
      ...(decisionLog === undefined ? {} : { decisionLog }),
      guard,
    });
    io.stdout.write(
      flags.has("--json")
        ? `${JSON.stringify(result)}\n`
        : `${result.verdict} (mock, not evidence): ${[...result.reasonCodes, ...result.verifyCodes].join(", ")}\n`,
    );
    return exitCodeFor(result);
  } catch (error) {
    // Codes and fixed text only: never a path or a value from the inputs.
    io.stderr.write(
      error instanceof UsageError
        ? `myco verify: ${error.message}\n${VERIFY_USAGE}`
        : "myco verify: the operator's task file or registry was refused\n",
    );
    return EXIT_USAGE;
  }
}
