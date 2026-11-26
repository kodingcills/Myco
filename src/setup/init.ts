/**
 * `myco init`: one-command local setup (M2 scope add, track D).
 *
 *   bin/myco init                 # project mode: checks, then writes ./.mcp.json and ./.codex/config.toml
 *   bin/myco init --dry-run       # every check and every planned change; writes nothing
 *   bin/myco init --global        # user-level preview (~/.claude.json, ~/.codex/config.toml); writes nothing
 *   bin/myco init --global --yes  # apply the previewed user-level change, with a backup of each file
 *
 * What it does, in order:
 *   1. checks this checkout can launch the gate (tsx and scripts/myco-gate.ts present);
 *   2. detects the Linux desktop path (headless LibreOffice Calc + Python-UNO, the path CI's
 *      `linux-path` job runs), or says exactly what is missing and how to install it;
 *   3. starts the gate with the exact launch line it is about to write and runs an MCP
 *      handshake: initialize, tools/list (exactly `myco_gate_check`), and one tools/call
 *      naming another task, which must come back ASSIGNMENT_MISMATCH (fail closed);
 *   4. merges a `myco-gate` server entry into the client configs, touching only that entry.
 *
 * Guarantees, each pinned by test/setup/init.test.ts:
 *   - Default mode reads and writes only inside the project directory. The user's home is
 *     never read or written unless `--global` is given; `--global` alone prints a dry-run
 *     diff and writes nothing; `--global --yes` writes, after backing up every changed file.
 *   - Only the `myco-gate` entry (JSON) or the marked `myco-gate` block (TOML) is changed.
 *     Unrelated keys survive. A config that cannot be merged safely is left alone and
 *     reported as a conflict.
 *   - Diffs print only the `myco-gate` entry, never any other part of a config (a project
 *     `.mcp.json` can hold another server's `env` values).
 *   - No secret is read, written or printed: the written entry has no `env`, the process
 *     environment is never enumerated (the CLI passes in only the five names below), and
 *     every child process gets an environment of `PATH` alone.
 *   - Idempotent: a second run reports every file unchanged and writes nothing.
 *   - The Windows VM path is out of scope: init starts only soffice, Python and the gate.
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { GATE_REQUEST_SCHEMA } from "../gate/api.ts";

/** The only environment variables `myco init` ever looks at. None of them is a secret. */
export interface InitEnv {
  readonly HOME?: string | undefined;
  readonly CODEX_HOME?: string | undefined;
  readonly PATH?: string | undefined;
  readonly MYCO_SOFFICE?: string | undefined;
  readonly MYCO_PYTHON?: string | undefined;
}

export const INIT_ENV_NAMES = [
  "HOME",
  "CODEX_HOME",
  "PATH",
  "MYCO_SOFFICE",
  "MYCO_PYTHON",
] as const;

/** Picks the five names above, and nothing else, from an environment. */
export function pickInitEnv(env: Readonly<Record<string, string | undefined>>): InitEnv {
  return {
    HOME: env.HOME,
    CODEX_HOME: env.CODEX_HOME,
    PATH: env.PATH,
    MYCO_SOFFICE: env.MYCO_SOFFICE,
    MYCO_PYTHON: env.MYCO_PYTHON,
  };
}

export interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export type Spawner = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly input?: string;
    readonly timeoutMs: number;
  },
) => SpawnResult;

/** The file operations init uses; tests wrap the real one to record every path touched. */
export interface SetupFs {
  exists(path: string): boolean;
  readText(path: string): string;
  /** Permission bits of an existing file. */
  mode(path: string): number;
  mkdirp(path: string): void;
  copy(from: string, to: string): void;
  /** Write via a temp file in the same directory and a rename. */
  writeAtomic(path: string, content: string, mode?: number): void;
}

export interface InitDeps {
  readonly fs: SetupFs;
  readonly spawn: Spawner;
  readonly env: InitEnv;
  readonly platform: NodeJS.Platform;
  readonly now: () => Date;
  readonly cwd: string;
  /** Root of this Myco checkout (holds node_modules/.bin/tsx and scripts/myco-gate.ts). */
  readonly mycoRoot: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface InitOptions {
  readonly projectDir: string;
  readonly global: boolean;
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly skipDesktop: boolean;
  readonly task: string;
  readonly run: string;
  readonly evidenceRoot: string;
}

export const EXIT_OK = 0;
export const EXIT_INCOMPLETE = 1;
export const EXIT_USAGE = 3;

export const SERVER_KEY = "myco-gate";
export const DEFAULT_TASK = "df-s01";
export const DEFAULT_RUN = "local";
export const TOML_BEGIN = "# >>> myco-gate (written by `myco init`; re-run it to update) >>>";
export const TOML_END = "# <<< myco-gate <<<";

/** Same rule the gate applies to taskId/runId (GATE_REQUEST_SCHEMA). */
const SAFE_ID = new RegExp(GATE_REQUEST_SCHEMA.properties.taskId.pattern);

/** Install line the CI `linux-path` job uses. */
export const LINUX_INSTALL =
  "sudo apt-get install -y --no-install-recommends libreoffice-calc python3-uno";

export const INIT_USAGE = `usage: myco init [options]

Checks the Linux desktop path, starts the gate once to prove it launches, and writes the
myco-gate MCP server entry for Claude Code and Codex into the project directory.

  --project <dir>        project to configure (default: the current directory)
  --task <id>            the trial's task id the gate is bound to (default: ${DEFAULT_TASK})
  --run <id>             the trial's run id (default: ${DEFAULT_RUN})
  --evidence-root <dir>  where the gate reads persisted state (default: <project>/.myco/evidence)
  --dry-run              run every check and print every planned change; write nothing
  --skip-desktop         do not check the Linux desktop path
  --global               target the user-level configs (~/.claude.json and
                         \${CODEX_HOME:-~/.codex}/config.toml) instead of the project;
                         prints a dry-run diff and writes nothing unless --yes is also given
  --yes                  with --global: apply the previewed change (each file is backed up first)
  --help                 this text

Writes (project mode): <project>/.mcp.json (Claude Code) and <project>/.codex/config.toml
(Codex). Only the "${SERVER_KEY}" entry is added or replaced; every other key is kept.
No file gets an env table, key or token.

exit: 0 done (or dry run), 1 a check failed or a config conflicted, 3 usage error
`;

export class InitUsageError extends Error {}

export function parseInitArgs(argv: readonly string[], cwd: string): InitOptions | "help" {
  let projectDir = cwd;
  let task = DEFAULT_TASK;
  let run = DEFAULT_RUN;
  let evidenceRoot: string | undefined;
  let global = false;
  let yes = false;
  let dryRun = false;
  let skipDesktop = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new InitUsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--":
        break;
      case "--help":
      case "-h":
        return "help";
      case "--project":
        projectDir = resolve(cwd, value());
        break;
      case "--task":
        task = value();
        break;
      case "--run":
        run = value();
        break;
      case "--evidence-root":
        evidenceRoot = value();
        break;
      case "--global":
        global = true;
        break;
      case "--yes":
        yes = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--skip-desktop":
        skipDesktop = true;
        break;
      default:
        throw new InitUsageError(`unknown option ${flag}`);
    }
  }
  if (yes && !global) throw new InitUsageError("--yes only confirms --global");
  if (!SAFE_ID.test(task)) throw new InitUsageError(`--task must match ${SAFE_ID.source}`);
  if (!SAFE_ID.test(run)) throw new InitUsageError(`--run must match ${SAFE_ID.source}`);
  const root =
    evidenceRoot === undefined
      ? join(projectDir, ".myco", "evidence")
      : resolve(projectDir, evidenceRoot);
  for (const [name, path] of [
    ["--project", projectDir],
    ["--evidence-root", root],
  ] as const) {
    // A control character in a path would end up verbatim in a config file.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    if (/[\u0000-\u001f\u007f]/.test(path))
      throw new InitUsageError(`${name} has a control character`);
  }
  return { projectDir, task, run, evidenceRoot: root, global, yes, dryRun, skipDesktop };
}

/** The gate launch line: the command and arguments every client config names. */
export interface LaunchLine {
  readonly command: string;
  readonly args: readonly string[];
}

export function launchLine(mycoRoot: string, options: InitOptions): LaunchLine {
  return {
    command: join(mycoRoot, "node_modules", ".bin", "tsx"),
    args: [
      join(mycoRoot, "scripts", "myco-gate.ts"),
      "mcp",
      "--evidence-root",
      options.evidenceRoot,
      "--task",
      options.task,
      "--run",
      options.run,
    ],
  };
}

/** The Claude Code `.mcp.json` entry (same shape as examples/mcp-clients/claude-code.mcp.json). */
export function claudeEntry(line: LaunchLine): Record<string, unknown> {
  return { type: "stdio", command: line.command, args: [...line.args] };
}

/** TOML basic strings accept JSON's escapes for every character JSON.stringify emits. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The Codex block (same keys as examples/mcp-clients/codex.config.md, option 2). */
export function codexBlock(line: LaunchLine): string {
  return [
    TOML_BEGIN,
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(line.command)}`,
    "args = [",
    ...line.args.map((arg) => `  ${tomlString(arg)},`),
    "]",
    TOML_END,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Merging. Each merge returns the planned file content and the before/after of the one
// entry init owns, which is all a diff ever prints.

export type PlanAction = "create" | "update" | "unchanged" | "conflict";

export interface FilePlan {
  readonly label: string;
  readonly path: string;
  readonly action: PlanAction;
  /** The owned entry before (null: absent) and after, for the diff. */
  readonly before: string | null;
  readonly after: string;
  readonly content?: string;
  readonly reason?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function planJson(
  label: string,
  path: string,
  existing: string | null,
  entry: Record<string, unknown>,
): FilePlan {
  const after = JSON.stringify(entry, null, 2);
  if (existing === null) {
    const content = `${JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2)}\n`;
    return { label, path, action: "create", before: null, after, content };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return {
      label,
      path,
      action: "conflict",
      before: null,
      after,
      reason: "not valid JSON; left unchanged",
    };
  }
  if (!isPlainObject(parsed))
    return {
      label,
      path,
      action: "conflict",
      before: null,
      after,
      reason: "top level is not a JSON object; left unchanged",
    };
  const servers = parsed.mcpServers;
  if (servers !== undefined && !isPlainObject(servers))
    return {
      label,
      path,
      action: "conflict",
      before: null,
      after,
      reason: '"mcpServers" is not an object; left unchanged',
    };
  const current = servers?.[SERVER_KEY];
  const before = current === undefined ? null : JSON.stringify(current, null, 2);
  if (before === after) return { label, path, action: "unchanged", before, after };
  const next = { ...parsed, mcpServers: { ...(servers ?? {}), [SERVER_KEY]: entry } };
  return {
    label,
    path,
    action: "update",
    before,
    after,
    content: `${JSON.stringify(next, null, 2)}\n`,
  };
}

/** A `myco-gate` definition that is not inside init's own marked block. */
const FOREIGN_CODEX_DEF = [
  /^\s*\[\s*mcp_servers\s*\.\s*("myco-gate"|'myco-gate'|myco-gate)\s*[\].]/m,
  /^\s*mcp_servers\s*\.\s*("myco-gate"|'myco-gate'|myco-gate)\s*[.=]/m,
  /^\s*mcp_servers\s*=/m,
];

export function planToml(
  label: string,
  path: string,
  existing: string | null,
  block: string,
): FilePlan {
  if (existing === null)
    return { label, path, action: "create", before: null, after: block, content: `${block}\n` };
  const begins = existing.split(TOML_BEGIN).length - 1;
  const ends = existing.split(TOML_END).length - 1;
  let outside = existing;
  let before: string | null = null;
  let start = -1;
  let stop = -1;
  if (begins !== 0 || ends !== 0) {
    start = existing.indexOf(TOML_BEGIN);
    stop = existing.indexOf(TOML_END);
    if (begins !== 1 || ends !== 1 || stop < start)
      return {
        label,
        path,
        action: "conflict",
        before: null,
        after: block,
        reason: "damaged myco-gate markers; left unchanged",
      };
    stop += TOML_END.length;
    before = existing.slice(start, stop);
    outside = existing.slice(0, start) + existing.slice(stop);
  }
  if (FOREIGN_CODEX_DEF.some((re) => re.test(outside)))
    return {
      label,
      path,
      action: "conflict",
      before,
      after: block,
      reason:
        "defines mcp_servers.myco-gate (or an inline mcp_servers table) outside init's marked block; left unchanged",
    };
  if (before === block) return { label, path, action: "unchanged", before, after: block };
  const content =
    before === null
      ? `${existing}${existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"}${block}\n`
      : existing.slice(0, start) + block + existing.slice(stop);
  return { label, path, action: "update", before, after: block, content };
}

function prefixed(text: string, mark: string): string {
  return text
    .split("\n")
    .map((line) => `    ${mark} ${line}`)
    .join("\n");
}

export function renderPlan(plan: FilePlan): string {
  const head = `  ${plan.label}: ${plan.path}\n    ${plan.action}${plan.reason ? ` (${plan.reason})` : ""}`;
  if (plan.action === "unchanged" || plan.action === "conflict") return `${head}\n`;
  const what = plan.label.includes("Codex")
    ? "the marked myco-gate block only"
    : `mcpServers["${SERVER_KEY}"] only; every other key is kept`;
  return `${head}, changing ${what}:\n${plan.before === null ? "    - (absent)" : prefixed(plan.before, "-")}\n${prefixed(plan.after, "+")}\n`;
}

// ---------------------------------------------------------------------------
// Checks.

interface CheckLine {
  readonly ok: boolean;
  readonly text: string;
}

function childEnv(env: InitEnv): Record<string, string> {
  // PATH alone: a child never inherits a key or token from the caller's environment.
  return env.PATH === undefined ? {} : { PATH: env.PATH };
}

export function checkDesktop(deps: InitDeps): { ok: boolean; lines: string[] } {
  if (deps.platform !== "linux")
    return {
      ok: true,
      lines: [
        `  skipped: the Linux desktop path runs on Linux (this is ${deps.platform}); see docs/product/linux-path.md`,
      ],
    };
  const soffice = deps.env.MYCO_SOFFICE ?? "soffice";
  const python = deps.env.MYCO_PYTHON ?? "python3";
  const env = childEnv(deps.env);
  const version = deps.spawn(soffice, ["--version"], { env, timeoutMs: 60_000 });
  const line = version.status === 0 ? (version.stdout.trim().split("\n")[0] ?? "") : "";
  const sofficeOk = /LibreOffice/.test(line);
  const uno = deps.spawn(python, ["-c", "import uno"], { env, timeoutMs: 30_000 });
  const unoOk = uno.status === 0;
  const checks: CheckLine[] = [
    {
      ok: sofficeOk,
      text: `soffice (${soffice}): ${sofficeOk ? line : "NOT FOUND: install LibreOffice Calc, or set MYCO_SOFFICE to its soffice"}`,
    },
    {
      ok: unoOk,
      text: `python-uno (${python} -c 'import uno'): ${unoOk ? "ok" : "NOT FOUND: install python3-uno, or set MYCO_PYTHON to a Python that has it"}`,
    },
  ];
  const lines = checks.map((c) => `  ${c.ok ? "ok" : "MISSING"}  ${c.text}`);
  if (sofficeOk && unoOk)
    lines.push("  attached: run `pnpm myco-linux --demo` to drive it end to end");
  else
    lines.push(
      `  to install (Debian/Ubuntu, what CI runs): ${LINUX_INSTALL}`,
      "  then re-run `myco init`, or pass --skip-desktop to configure the gate without it",
    );
  return { ok: sofficeOk && unoOk, lines };
}

/** A probe task id that is guaranteed not to be the assignment. */
function probeTask(task: string): string {
  return task === "myco-init-probe" ? "myco-init-probe-2" : "myco-init-probe";
}

export function healthCheck(
  deps: InitDeps,
  line: LaunchLine,
  options: InitOptions,
): { ok: boolean; lines: string[] } {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "myco-init", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "myco_gate_check",
        arguments: { taskId: probeTask(options.task), runId: options.run },
      },
    },
  ];
  const result = deps.spawn(line.command, line.args, {
    env: childEnv(deps.env),
    input: `${requests.map((r) => JSON.stringify(r)).join("\n")}\n`,
    timeoutMs: 60_000,
  });
  const fail = (why: string) => ({ ok: false, lines: [`  FAILED: ${why}`] });
  if (result.error !== undefined) return fail(`could not start the gate (${result.error})`);
  if (result.status !== 0) return fail(`the gate exited ${String(result.status)}`);
  const replies = new Map<number, Record<string, unknown>>();
  for (const raw of result.stdout.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const msg = JSON.parse(raw) as Record<string, unknown>;
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    } catch {
      return fail("the gate wrote a non-JSON line on its MCP channel");
    }
  }
  const init = replies.get(1)?.result as { serverInfo?: { name?: unknown } } | undefined;
  if (init?.serverInfo?.name !== "myco-gate") return fail("initialize did not answer as myco-gate");
  const tools = (replies.get(2)?.result as { tools?: { name?: unknown }[] } | undefined)?.tools;
  if (!Array.isArray(tools) || tools.length !== 1 || tools[0]?.name !== "myco_gate_check")
    return fail("tools/list did not return exactly myco_gate_check");
  const call = replies.get(3)?.result as
    | {
        isError?: unknown;
        structuredContent?: { verdict?: unknown; accepted?: unknown; reasonCodes?: unknown };
      }
    | undefined;
  const sc = call?.structuredContent;
  if (
    call?.isError !== true ||
    sc?.verdict !== "uncertain" ||
    sc.accepted !== false ||
    !Array.isArray(sc.reasonCodes) ||
    !sc.reasonCodes.includes("ASSIGNMENT_MISMATCH")
  )
    return fail(
      "a call naming another task was not refused with ASSIGNMENT_MISMATCH (the gate must fail closed)",
    );
  return {
    ok: true,
    lines: [
      `  ok  started the gate bound to ${options.task}/${options.run}; MCP handshake answered`,
      "  ok  tools/list: exactly myco_gate_check",
      "  ok  a call naming another task: uncertain / ASSIGNMENT_MISMATCH (fails closed)",
    ],
  };
}

// ---------------------------------------------------------------------------

function backupPath(fs: SetupFs, path: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  let candidate = `${path}.myco-backup-${stamp}`;
  for (let n = 1; fs.exists(candidate); n++) candidate = `${path}.myco-backup-${stamp}-${n}`;
  return candidate;
}

function targets(options: InitOptions, env: InitEnv): { claude: string; codex: string } {
  if (!options.global)
    return {
      claude: join(options.projectDir, ".mcp.json"),
      codex: join(options.projectDir, ".codex", "config.toml"),
    };
  const home = env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home))
    throw new InitUsageError("--global needs HOME set to an absolute path");
  const codexHome =
    env.CODEX_HOME !== undefined && env.CODEX_HOME !== "" ? env.CODEX_HOME : join(home, ".codex");
  if (!isAbsolute(codexHome)) throw new InitUsageError("CODEX_HOME must be an absolute path");
  return { claude: join(home, ".claude.json"), codex: join(codexHome, "config.toml") };
}

export const VM_NOTE = [
  "Windows VM path: not touched by `myco init`.",
  "  It has a single owner and runs under a lock; it is set up separately:",
  "  see docs/product/quickstart.md (live path) and docs/eval-runbook.md.",
].join("\n");

export function runInit(options: InitOptions, deps: InitDeps): number {
  const out = deps.stdout;
  const { fs } = deps;
  const writes = !options.dryRun && (!options.global || options.yes);
  const mode = options.global ? "global (user-level configs)" : "project";
  out(`myco init: ${mode} mode${writes ? "" : ", DRY RUN (nothing will be written)"}\n`);
  if (!options.global) out(`  project: ${options.projectDir}\n`);

  let ok = true;

  // 1. this checkout
  const line = launchLine(deps.mycoRoot, options);
  out("\n[1/4] gate launcher\n");
  const missing = [line.command, line.args[0] as string].filter((p) => !fs.exists(p));
  if (missing.length > 0) {
    out(
      `  MISSING  ${missing.join(", ")}\n  run \`pnpm install --frozen-lockfile\` in ${deps.mycoRoot}, then re-run \`myco init\`\n`,
    );
    out("\nNothing was written: the gate cannot start from this checkout.\n");
    return EXIT_INCOMPLETE;
  }
  out(`  ok  ${line.command}\n  ok  ${line.args[0]}\n`);

  // 2. desktop
  out("\n[2/4] Linux desktop path (headless LibreOffice Calc)\n");
  if (options.skipDesktop) out("  skipped (--skip-desktop)\n");
  else {
    const desktop = checkDesktop(deps);
    out(`${desktop.lines.join("\n")}\n`);
    if (!desktop.ok) ok = false;
  }

  // 3. gate
  out(
    "\n[3/4] gate health check (the launch line written below, with PATH as its only environment variable)\n",
  );
  const health = healthCheck(deps, line, options);
  out(`${health.lines.join("\n")}\n`);
  if (!health.ok) {
    out(
      "\nNothing was written: a config that names a gate which does not start is worse than none.\n",
    );
    return EXIT_INCOMPLETE;
  }

  // 4. configs
  const paths = targets(options, deps.env);
  out(`\n[4/4] MCP client configs${writes ? "" : " (planned)"}\n`);
  const read = (path: string): string | null => (fs.exists(path) ? fs.readText(path) : null);
  const plans = [
    planJson("Claude Code", paths.claude, read(paths.claude), claudeEntry(line)),
    planToml("Codex", paths.codex, read(paths.codex), codexBlock(line)),
  ];
  for (const plan of plans) out(renderPlan(plan));
  if (plans.some((p) => p.action === "conflict")) ok = false;

  const changing = plans.filter((p) => p.content !== undefined);
  if (writes) {
    for (const plan of changing) {
      const content = plan.content as string;
      fs.mkdirp(dirname(plan.path));
      let mode: number | undefined;
      if (plan.action === "update") {
        const backup = backupPath(fs, plan.path, deps.now());
        fs.copy(plan.path, backup);
        mode = fs.mode(plan.path);
        out(`  backed up ${basename(plan.path)} to ${backup}\n`);
      }
      fs.writeAtomic(plan.path, content, mode);
      out(`  wrote ${plan.path}\n`);
    }
    if (changing.length === 0) out("  nothing to change\n");
  } else if (changing.length > 0) {
    out(
      options.global && !options.dryRun
        ? "\n  DRY RUN: nothing written. Re-run with `--global --yes` to apply exactly the change above\n  (each changed file is backed up first).\n"
        : "\n  DRY RUN: nothing written.\n",
    );
  }

  out(`\n${VM_NOTE}\n`);
  if (!options.global)
    out(
      [
        "",
        "Note: this is a local starter config. The gate reads <evidence-root>/<run>/<stateFile>;",
        "for a gated trial the harness writes a per-trial config that points at a host-side",
        "capture the agent cannot write (docs/gate/api.md, docs/gate/clients.md §5).",
        "",
      ].join("\n"),
    );
  out(ok ? "\nmyco init: done\n" : "\nmyco init: incomplete (see MISSING / conflict above)\n");
  return ok ? EXIT_OK : EXIT_INCOMPLETE;
}

export function mainInit(argv: readonly string[], deps: InitDeps): number {
  let options: InitOptions | "help";
  try {
    options = parseInitArgs(argv, deps.cwd);
    if (options !== "help") targets(options, deps.env);
  } catch (error) {
    if (error instanceof InitUsageError) {
      deps.stderr(`myco init: ${error.message}\n\n${INIT_USAGE}`);
      return EXIT_USAGE;
    }
    throw error;
  }
  if (options === "help") {
    deps.stdout(INIT_USAGE);
    return EXIT_OK;
  }
  return runInit(options, deps);
}
