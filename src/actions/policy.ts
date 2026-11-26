/**
 * Track J (fastest reliable action path) - the policy seam every route goes through.
 *
 * ## The interface (track O owns the real one)
 *
 * Track O builds Myco's policy layer. It has not landed, so this module defines the small
 * interface the action router needs from it, `ActionPolicy`, and one local implementation,
 * `workspacePolicy`, that is deliberately narrower than anything O is expected to allow.
 * When O lands, its policy is adapted to `ActionPolicy` (lands with O) and replaces
 * `workspacePolicy` at the router's construction site; the router itself does not change.
 * Nothing here imports unmerged code.
 *
 * ## What the local policy allows
 *
 * Every route's request is reduced to the same facts before anything runs: the route, the
 * action kind, the paths it will read, the paths it will write, and for the shell route the
 * exact argv. The policy then:
 *
 * - **scopes every path to the trial's own workspace.** Each path is made absolute against
 *   the workspace, resolved through symlinks as the kernel resolves it (`realpath(3)` on the
 *   unnormalised spelling, so a `..` after a symlinked directory goes where the kernel goes;
 *   for a path that does not exist yet, its parent), and must lie inside the workspace's
 *   resolved root. The script route then runs the resolved operands, not the spelling. A
 *   path that leaves it, by `..`, an absolute host path, or a symlink, is denied. Writes are narrower still:
 *   only the trial document and the scratch directory.
 * - **denies by default any shell command it cannot parse safely** (`parseShellCommand`).
 *   There is no shell interpreter: a command string is tokenised into an argv by a strict
 *   reader that knows only bare words and single- or double-quoted words without escapes.
 *   Any character a shell would interpret (`| ; & $ \` < > ( ) { } * ? ~ ! # \ % ^` and
 *   control characters, including newlines) makes the whole command `unparseable`, not
 *   sanitised.
 * - **allows only listed programs, with listed flags** (`SHELL_PROGRAMS`). The read side
 *   of a coding agent's shell (`ls`, `cat`, `head`, `wc`, `sha256sum`) and one write:
 *   `soffice --headless --convert-to csv --outdir <scratch> <document>`. Every operand is a
 *   path and goes through the scoping rule above: an operand that starts with `-` is a
 *   flag, never an operand, and must be listed. For soffice the source operand must resolve
 *   to the trial document itself, and the argv the route runs carries the resolved absolute
 *   paths, never the agent's spelling (so no option, `macro:` or other URL reaches soffice).
 * - **refuses a regular file with more than one hard link.** `realpath` cannot see where
 *   a hard link's other names live, so such a file is treated as outside the workspace.
 *
 * Agent-facing results carry codes only (`PolicyCode`), never the resolved path or the
 * workspace layout.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export type RouteName = "api" | "script" | "gui";

export type PolicyCode =
  | "ALLOWED"
  | "UNPARSEABLE_COMMAND"
  | "PROGRAM_NOT_ALLOWED"
  | "FLAG_NOT_ALLOWED"
  | "OPERAND_SHAPE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "WRITE_NOT_ALLOWED"
  | "BAD_REQUEST";

/** What one route will do, reduced to the facts a policy judges. */
export interface PolicyRequest {
  readonly route: RouteName;
  readonly kind: string;
  /** Paths the route reads, absolute or relative to the workspace. */
  readonly reads: readonly string[];
  /** Paths the route writes or creates. */
  readonly writes: readonly string[];
  /** For the script route: the argv the route will execute (no shell). */
  readonly argv?: readonly string[];
  /**
   * For the script route: the agent's raw command text, instead of `argv`. The policy
   * parses it (default deny); the route executes the argv the policy returns.
   */
  readonly command?: string;
}

export type PolicyDecision =
  | {
      readonly allow: true;
      readonly code: "ALLOWED";
      /** The resolved paths the route may touch: what it must use, not its own spelling. */
      readonly reads: readonly string[];
      readonly writes: readonly string[];
      /** For the script route: the exact argv that was checked, and the only one to run. */
      readonly argv?: readonly string[];
    }
  | { readonly allow: false; readonly code: Exclude<PolicyCode, "ALLOWED"> };

/**
 * The seam to track O's policy layer. `check` must be pure with respect to its request
 * (it may read the file system to resolve paths) and must fail closed: anything it cannot
 * judge is a denial.
 */
export interface ActionPolicy {
  readonly id: string;
  check(request: PolicyRequest): PolicyDecision;
}

// ---------------------------------------------------------------------------------------
// Shell command parsing: default deny.

/** Characters any POSIX shell would interpret. Their presence makes a command unparseable. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not matched.
const SHELL_META = /[\u0000-\u001f\u007f|;&$`<>(){}*?~!#\\%^[\]]/;
const MAX_COMMAND = 1024;
const MAX_ARGS = 16;

export type ParsedCommand =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly code: "UNPARSEABLE_COMMAND" };

/**
 * Tokenise a shell command string into an argv, or refuse it.
 *
 * Accepts bare words and quoted words (`'...'` or `"..."`, no escapes, no nesting)
 * separated by spaces. Refuses, rather than interprets: every shell metacharacter, any
 * backslash, an unterminated quote, a quote glued to a bare word (`a"b"`), an empty
 * command, and commands over the size limits. A refusal is the default: there is no path
 * through which a string reaches a shell.
 */
export function parseShellCommand(command: unknown): ParsedCommand {
  const refuse = { ok: false, code: "UNPARSEABLE_COMMAND" } as const;
  if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND)
    return refuse;
  if (SHELL_META.test(command)) return refuse;
  const argv: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === " ") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) return refuse;
      const next = command[end + 1];
      if (next !== undefined && next !== " ") return refuse;
      argv.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < command.length && command[end] !== " ") {
      if (command[end] === "'" || command[end] === '"') return refuse;
      end += 1;
    }
    argv.push(command.slice(i, end));
    i = end;
  }
  if (argv.length === 0 || argv.length > MAX_ARGS) return refuse;
  return { ok: true, argv };
}

// ---------------------------------------------------------------------------------------
// Program allowlist.

interface ProgramRule {
  /** Flags allowed anywhere in the argv. */
  readonly flags: readonly string[];
  /** Exact argv shape for programs that take more than operands (soffice). */
  readonly shape?: (args: readonly string[]) => { reads: string[]; writes: string[] } | null;
  /** Operand count limits. */
  readonly minOperands: number;
  readonly maxOperands: number;
}

/**
 * The shell programs the script route may run. Read-side self-checks, plus the one
 * conversion a coding agent uses to read an `.xlsx` (output only into scratch).
 */
export const SHELL_PROGRAMS: Readonly<Record<string, ProgramRule>> = {
  ls: { flags: ["-l", "-a", "-la", "-al"], minOperands: 0, maxOperands: 4 },
  cat: { flags: [], minOperands: 1, maxOperands: 4 },
  head: { flags: ["-n"], minOperands: 1, maxOperands: 4 },
  wc: { flags: ["-l", "-c"], minOperands: 1, maxOperands: 4 },
  sha256sum: { flags: [], minOperands: 1, maxOperands: 4 },
  soffice: {
    flags: [],
    minOperands: 0,
    maxOperands: 0,
    // soffice --headless --convert-to csv --outdir OUT DOC   (exactly this shape). OUT and
    // DOC are operands: one that starts with `-` is an option soffice would act on
    // (`--accept=...` opens a UNO acceptor), so it is refused here. The policy also requires
    // DOC to resolve to the trial document and runs the resolved paths (`workspacePolicy`).
    shape: (args) =>
      args.length === 6 &&
      args[0] === "--headless" &&
      args[1] === "--convert-to" &&
      args[2] === "csv" &&
      args[3] === "--outdir" &&
      !(args[4] as string).startsWith("-") &&
      !(args[5] as string).startsWith("-")
        ? { reads: [args[5] as string], writes: [args[4] as string] }
        : null,
  },
};

export interface ShellPlan {
  readonly program: string;
  readonly args: readonly string[];
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  /** Indices into `args` of the path operands (non-soffice programs); the policy rewrites them. */
  readonly operands: readonly number[];
}

/** Map a parsed argv to what it reads and writes, or a denial code. */
export function planShellArgv(
  argv: readonly string[],
):
  | { ok: true; plan: ShellPlan }
  | { ok: false; code: "PROGRAM_NOT_ALLOWED" | "FLAG_NOT_ALLOWED" | "OPERAND_SHAPE" } {
  const [program, ...args] = argv;
  if (program === undefined || !Object.hasOwn(SHELL_PROGRAMS, program))
    return { ok: false, code: "PROGRAM_NOT_ALLOWED" };
  const rule = SHELL_PROGRAMS[program] as ProgramRule;
  if (rule.shape) {
    const io = rule.shape(args);
    return io
      ? { ok: true, plan: { program, args, reads: io.reads, writes: io.writes, operands: [] } }
      : { ok: false, code: "OPERAND_SHAPE" };
  }
  const operands: string[] = [];
  const operandIndex: number[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string;
    if (arg.startsWith("-")) {
      if (!rule.flags.includes(arg)) return { ok: false, code: "FLAG_NOT_ALLOWED" };
      if (program === "head" && arg === "-n") {
        const n = args[k + 1];
        if (n === undefined || !/^[1-9][0-9]{0,3}$/.test(n))
          return { ok: false, code: "OPERAND_SHAPE" };
        k += 1;
      }
      continue;
    }
    operands.push(arg);
    operandIndex.push(k);
  }
  if (operands.length < rule.minOperands || operands.length > rule.maxOperands)
    return { ok: false, code: "OPERAND_SHAPE" };
  // `ls` with no operand lists the working directory, which is the workspace.
  const reads = operands.length === 0 && program === "ls" ? ["."] : operands;
  return { ok: true, plan: { program, args, reads, writes: [], operands: operandIndex } };
}

// ---------------------------------------------------------------------------------------
// Workspace scoping.

export interface WorkspaceScope {
  /** The trial's own workspace root. Everything a route touches lies under it. */
  readonly workspace: string;
  /** The trial document (inside the workspace). */
  readonly document: string;
  /** Scratch directory for outputs (inside the workspace). */
  readonly scratch: string;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve `raw` against the workspace through symlinks. A path that does not exist yet
 * resolves by its parent directory (which must exist); null when neither resolves, and null
 * for a regular file with more than one hard link (its other names are invisible to
 * `realpath`, so it cannot be scoped).
 */
export function resolveScoped(raw: string, workspace: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not matched.
  if (/[\u0000-\u001f]/.test(raw)) return null;
  // No lexical normalisation: the kernel resolves `..` AFTER following a symlink, so
  // `scratch/link-to-dir/../x` names a file next to the link's TARGET, not next to the link.
  // `path.resolve` (and Node's JS `realpathSync`, which calls it) would collapse the `..`
  // first and scope a different file than the one a program opens. `existsSync` and
  // `realpathSync.native` hand the spelling to the kernel unchanged.
  const absolute = isAbsolute(raw) ? raw : `${workspace}${sep}${raw}`;
  try {
    if (existsSync(absolute)) {
      const real = realpathSync.native(absolute);
      const st = statSync(real);
      if (st.isFile() && st.nlink > 1) return null;
      return real;
    }
    const name = basename(absolute);
    if (name === "." || name === "..") return null;
    const parent = dirname(absolute);
    if (!existsSync(parent)) return null;
    return join(realpathSync.native(parent), name);
  } catch {
    return null;
  }
}

/**
 * The local, narrow policy: workspace-scoped paths, default-deny shell parsing, a program
 * allowlist. Throws at construction if the scope is not self-consistent (fail closed).
 */
export function workspacePolicy(scope: WorkspaceScope): ActionPolicy {
  if (!isAbsolute(scope.workspace)) throw new Error("workspacePolicy: workspace must be absolute");
  const root = realpathSync(scope.workspace);
  const document = resolveScoped(scope.document, root);
  const scratch = resolveScoped(scope.scratch, root);
  if (document === null || !within(document, root) || document === root)
    throw new Error("workspacePolicy: document must lie inside the workspace");
  if (scratch === null || !within(scratch, root) || scratch === root)
    throw new Error("workspacePolicy: scratch must lie inside the workspace");

  return {
    id: "myco.actions.workspace-policy/1",
    check(request) {
      if (
        typeof request !== "object" ||
        request === null ||
        !Array.isArray(request.reads) ||
        !Array.isArray(request.writes)
      )
        return { allow: false, code: "BAD_REQUEST" };
      let reads: readonly string[] = request.reads;
      let writes: readonly string[] = request.writes;
      let argv: readonly string[] | undefined;
      let soffice: ShellPlan | null = null;
      // A non-soffice program, and where its operands start in `reads`.
      let program: { plan: ShellPlan; offset: number } | null = null;
      if (request.route === "script") {
        const hasArgv = request.argv !== undefined;
        const hasCommand = request.command !== undefined;
        if (hasArgv === hasCommand) return { allow: false, code: "BAD_REQUEST" };
        if (hasCommand) {
          const parsed = parseShellCommand(request.command);
          if (!parsed.ok) return { allow: false, code: parsed.code };
          argv = parsed.argv;
        } else {
          if (!Array.isArray(request.argv) || !request.argv.every((a) => typeof a === "string"))
            return { allow: false, code: "BAD_REQUEST" };
          argv = [...request.argv];
        }
        const planned = planShellArgv(argv);
        if (!planned.ok) return { allow: false, code: planned.code };
        soffice = planned.plan.program === "soffice" ? planned.plan : null;
        if (soffice === null) program = { plan: planned.plan, offset: reads.length };
        // The argv decides what the command touches, not the caller's lists.
        reads = [...reads, ...planned.plan.reads];
        writes = [...writes, ...planned.plan.writes];
      } else if (request.argv !== undefined || request.command !== undefined) {
        // Only the script route executes a command; any other route carrying one is malformed.
        return { allow: false, code: "BAD_REQUEST" };
      }
      const resolvedReads: string[] = [];
      for (const raw of reads) {
        const path = resolveScoped(raw, root);
        if (path === null || !within(path, root))
          return { allow: false, code: "PATH_OUTSIDE_WORKSPACE" };
        resolvedReads.push(path);
      }
      const resolvedWrites: string[] = [];
      for (const raw of writes) {
        const path = resolveScoped(raw, root);
        if (path === null || !within(path, root))
          return { allow: false, code: "PATH_OUTSIDE_WORKSPACE" };
        if (path !== document && !within(path, scratch))
          return { allow: false, code: "WRITE_NOT_ALLOWED" };
        resolvedWrites.push(path);
      }
      if (program !== null) {
        // Every program runs on the resolved absolute operands the loop above scoped, never
        // the agent's spelling of them (which the kernel may resolve differently).
        const args = [...program.plan.args];
        program.plan.operands.forEach((k, j) => {
          args[k] = resolvedReads[program.offset + j] as string;
        });
        argv = [program.plan.program, ...args];
      }
      if (soffice !== null) {
        // The conversion reads the trial document and nothing else, and soffice gets the
        // resolved absolute paths: no spelling of the agent's reaches its argument parser.
        const source = resolveScoped(soffice.reads[0] as string, root);
        const outdir = resolveScoped(soffice.writes[0] as string, root);
        if (source !== document || outdir === null) return { allow: false, code: "OPERAND_SHAPE" };
        argv = ["soffice", ...soffice.args.slice(0, 4), outdir, source];
      }
      return argv === undefined
        ? { allow: true, code: "ALLOWED", reads: resolvedReads, writes: resolvedWrites }
        : { allow: true, code: "ALLOWED", reads: resolvedReads, writes: resolvedWrites, argv };
    },
  };
}
