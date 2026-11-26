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
 * Guarantees, each pinned by test/init/init.test.ts:
 *   - Default (project) mode reads and writes only inside the project directory. It refuses
 *     a project directory that is your home directory, or inside ~/.claude, ~/.codex or
 *     $CODEX_HOME (it only resolves those paths, never reads them), and it never follows a
 *     symlink: a `.mcp.json`, `.codex` or `.codex/config.toml` that is a link is a conflict.
 *   - The user's home configs are read or written only with `--global`; `--global` alone
 *     prints the exact diff and writes nothing; `--global --yes` writes, after backing up
 *     every changed file. A home config that is a symlink is written through to the file
 *     it names (the link is kept) and that file is backed up; the plan says so.
 *   - Every change is one splice of the original text: the `myco-gate` entry (JSON) or the
 *     marked `myco-gate` block (TOML). Every other byte is kept. The diff prints exactly that
 *     splice. The result is parsed again (JSON.parse, a TOML parser) and must equal the
 *     original document plus the entry; anything else (unparsable input, a `myco-gate`
 *     defined elsewhere, a result that would not parse) is a conflict, and a run with any
 *     conflict writes nothing at all.
 *   - Diffs print only the spliced bytes, never any other part of a config (a config can
 *     hold another server's `env` values); a TOML parse error is reported by position only.
 *   - No secret is read, written or printed: the written entry has no `env`, the process
 *     environment is never enumerated (the CLI passes in only the five names below), and
 *     every child process gets an environment of `PATH` alone.
 *   - Idempotent: a second run reports every file unchanged and writes nothing.
 *   - The Windows VM path is out of scope: init starts only soffice, Python and the gate.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseTomlText } from "smol-toml";
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

/** What `lstat` says is at a path (a symlink is reported as such, never followed). */
export type PathKind = "missing" | "file" | "dir" | "symlink" | "other";

/** The file operations init uses; tests wrap the real one to record every path touched. */
export interface SetupFs {
  /** Whether a path exists, following links (used only for this checkout's launcher). */
  exists(path: string): boolean;
  kind(path: string): PathKind;
  /** The canonical path, every link resolved; throws if it does not resolve. */
  realpath(path: string): string;
  /** Read a regular file; refuses (throws) if the last component is a symlink. */
  readText(path: string): string;
  /** Permission bits of an existing file. */
  mode(path: string): number;
  mkdirp(path: string): void;
  /** Copy to a new file; false (and nothing written) if anything, even a dangling link, is at `to`. */
  copyExclusive(from: string, to: string): boolean;
  /** Write via a new temp file (never an existing one) in the same directory and a rename. */
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
(Codex). Only the "${SERVER_KEY}" entry is added or replaced, as one splice; every other
byte is kept. A file that cannot be merged is a conflict, and then nothing is written.
Refuses a project that is HOME or inside ~/.claude, ~/.codex or $CODEX_HOME, and never
follows a symlink in the project. No file gets an env table, key or token.

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
// Merging. Every change is a single splice of the original text: `remove` (the bytes at
// `offset`) is replaced by `insert`, and every other byte of the file is kept as it was.
// The diff prints exactly that splice, so it is exactly what will change. After splicing,
// the result is parsed again and compared with the expected document; any difference is a
// conflict and nothing is written (fail closed).

export type PlanAction = "create" | "update" | "unchanged" | "conflict";

export interface Splice {
  readonly offset: number;
  readonly remove: string;
  readonly insert: string;
}

export interface FilePlan {
  readonly label: string;
  /** The config path the client reads. */
  readonly path: string;
  /** Where init reads and writes: `path`, or (--global only) the file a symlink at `path` names. */
  readonly writePath: string;
  readonly action: PlanAction;
  readonly splice?: Splice;
  /** The whole planned file (create/update only). */
  readonly content?: string;
  readonly reason?: string;
  readonly note?: string;
}

interface MergeResult {
  readonly action: PlanAction;
  readonly splice?: Splice;
  readonly content?: string;
  readonly reason?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A canonical form for comparing parsed documents: key order is ignored, value types are
 * kept apart (1 vs "1", a date vs its string), and null-prototype tables compare as objects.
 */
export function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return ["a", v.map(walk)];
    if (v instanceof Date) return ["d", v.constructor.name, String(v)];
    if (typeof v === "object" && v !== null)
      return [
        "o",
        Object.keys(v)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      ];
    return [typeof v, String(v)];
  };
  return JSON.stringify(walk(value));
}

function applySplice(text: string, s: Splice): string {
  return text.slice(0, s.offset) + s.insert + text.slice(s.offset + s.remove.length);
}

const conflict = (reason: string): MergeResult => ({ action: "conflict", reason });

// --- JSON -------------------------------------------------------------------

interface JsonMember {
  readonly key: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface JsonObjectSpan {
  readonly open: number;
  readonly close: number;
  readonly members: readonly JsonMember[];
}

const JSON_WS = new Set([" ", "\t", "\n", "\r"]);

function skipWs(t: string, i: number): number {
  let j = i;
  while (j < t.length && JSON_WS.has(t[j] as string)) j++;
  return j;
}

function scanString(t: string, i: number): number {
  let j = i + 1;
  while (j < t.length) {
    const c = t[j];
    if (c === "\\") j += 2;
    else if (c === '"') return j + 1;
    else j++;
  }
  throw new Error("unterminated string");
}

function scanValue(t: string, i: number): number {
  const c = t[i];
  if (c === '"') return scanString(t, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    while (j < t.length) {
      const ch = t[j];
      if (ch === '"') {
        j = scanString(t, j);
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    throw new Error("unterminated container");
  }
  let j = i;
  while (j < t.length && !JSON_WS.has(t[j] as string) && !",}]".includes(t[j] as string)) j++;
  return j;
}

/** Member spans of the object opening at `open`. The text has already passed JSON.parse. */
function scanObject(t: string, open: number): JsonObjectSpan {
  const members: JsonMember[] = [];
  let i = skipWs(t, open + 1);
  if (t[i] === "}") return { open, close: i, members };
  for (;;) {
    const keyStart = i;
    const keyEnd = scanString(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd)) as string;
    const valueStart = skipWs(t, skipWs(t, keyEnd) + 1);
    const valueEnd = scanValue(t, valueStart);
    members.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = skipWs(t, valueEnd);
    if (t[i] === ",") {
      i = skipWs(t, i + 1);
      continue;
    }
    return { open, close: i, members };
  }
}

/** The leading whitespace of the line holding `pos`. */
function lineLead(t: string, pos: number): string {
  const start = t.lastIndexOf("\n", pos - 1) + 1;
  let end = start;
  while (end < pos && (t[end] === " " || t[end] === "\t")) end++;
  return t.slice(start, end);
}

/** True when the object's members sit on their own lines (pretty-printed). */
function isMultiLine(t: string, obj: JsonObjectSpan): boolean {
  const first = obj.members[0];
  return first === undefined || t.lastIndexOf("\n", first.keyStart - 1) > obj.open;
}

interface JsonStyle {
  /** One level of indentation, or null for a compact (single-line) file. */
  readonly unit: string | null;
  /** What separates a key from its value, copied from the file (`": "`, `":"`). */
  readonly sep: string;
}

function jsonStyle(t: string, top: JsonObjectSpan): JsonStyle {
  const first = top.members[0];
  const sep = first === undefined ? ": " : t.slice(first.keyEnd, first.valueStart);
  if (!isMultiLine(t, top)) return { unit: null, sep };
  if (first === undefined) return { unit: "  ", sep };
  const unit = lineLead(t, first.keyStart).slice(lineLead(t, top.open).length);
  return { unit: unit === "" ? "  " : unit, sep };
}

function serialize(value: unknown, style: JsonStyle, indent: string): string {
  if (style.unit === null) return JSON.stringify(value);
  return JSON.stringify(value, null, style.unit).replaceAll("\n", `\n${indent}`);
}

function insertMember(
  t: string,
  obj: JsonObjectSpan,
  key: string,
  value: unknown,
  style: JsonStyle,
): Splice {
  const k = JSON.stringify(key);
  const closeIndent = lineLead(t, obj.open);
  const last = obj.members[obj.members.length - 1];
  if (style.unit === null || !isMultiLine(t, obj)) {
    const compact: JsonStyle = { unit: null, sep: style.sep };
    if (last === undefined)
      return {
        offset: obj.open + 1,
        remove: t.slice(obj.open + 1, obj.close),
        insert: `${k}${compact.sep}${serialize(value, compact, "")}`,
      };
    // Copy the separator between members when there are two; else a bare comma.
    const [a, b] = obj.members;
    const between = a !== undefined && b !== undefined ? t.slice(a.valueEnd, b.keyStart) : ",";
    return {
      offset: last.valueEnd,
      remove: "",
      insert: `${between}${k}${compact.sep}${serialize(value, compact, "")}`,
    };
  }
  if (last === undefined) {
    const indent = closeIndent + style.unit;
    return {
      offset: obj.open + 1,
      remove: t.slice(obj.open + 1, obj.close),
      insert: `\n${indent}${k}${style.sep}${serialize(value, style, indent)}\n${closeIndent}`,
    };
  }
  const indent = lineLead(t, last.keyStart);
  return {
    offset: last.valueEnd,
    remove: "",
    insert: `,\n${indent}${k}${style.sep}${serialize(value, style, indent)}`,
  };
}

const OWNED_JSON_KEYS = new Set(["type", "command", "args"]);

export function mergeJson(existing: string | null, entry: Record<string, unknown>): MergeResult {
  if (existing === null) {
    const content = `${JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2)}\n`;
    return { action: "create", splice: { offset: 0, remove: "", insert: content }, content };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return conflict("not valid JSON; left unchanged");
  }
  if (!isPlainObject(parsed)) return conflict("top level is not a JSON object; left unchanged");
  const servers = parsed.mcpServers;
  if (servers !== undefined && !isPlainObject(servers))
    return conflict('"mcpServers" is not an object; left unchanged');
  const current = servers?.[SERVER_KEY];
  if (current !== undefined) {
    if (!isPlainObject(current))
      return conflict(`mcpServers["${SERVER_KEY}"] is not an object; left unchanged`);
    const foreign = Object.keys(current).filter((k) => !OWNED_JSON_KEYS.has(k));
    if (foreign.length > 0)
      return conflict(
        `mcpServers["${SERVER_KEY}"] has keys init does not manage (${foreign.join(", ")}); left unchanged`,
      );
    if (canonical(current) === canonical(entry)) return { action: "unchanged" };
  }

  const top = scanObject(existing, skipWs(existing, 0));
  const style = jsonStyle(existing, top);
  const serverMembers = top.members.filter((m) => m.key === "mcpServers");
  if (serverMembers.length > 1) return conflict('"mcpServers" is defined twice; left unchanged');
  let splice: Splice;
  const serverMember = serverMembers[0];
  if (serverMember === undefined) {
    splice = insertMember(existing, top, "mcpServers", { [SERVER_KEY]: entry }, style);
  } else {
    const obj = scanObject(existing, serverMember.valueStart);
    const owned = obj.members.filter((m) => m.key === SERVER_KEY);
    if (owned.length > 1) return conflict(`"${SERVER_KEY}" is defined twice; left unchanged`);
    const own = owned[0];
    if (own === undefined) splice = insertMember(existing, obj, SERVER_KEY, entry, style);
    else {
      const multi = style.unit !== null && isMultiLine(existing, obj);
      splice = {
        offset: own.valueStart,
        remove: existing.slice(own.valueStart, own.valueEnd),
        insert: serialize(
          entry,
          multi ? style : { unit: null, sep: style.sep },
          lineLead(existing, own.keyStart),
        ),
      };
    }
  }
  const content = applySplice(existing, splice);
  const expected = { ...parsed, mcpServers: { ...(servers ?? {}), [SERVER_KEY]: entry } };
  let after: unknown;
  try {
    after = JSON.parse(content);
  } catch {
    return conflict("could not add the entry without changing other content; left unchanged");
  }
  if (canonical(after) !== canonical(expected))
    return conflict("could not add the entry without changing other content; left unchanged");
  return { action: "update", splice, content };
}

// --- TOML -------------------------------------------------------------------

function parseToml(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; where: string } {
  try {
    return { ok: true, value: parseTomlText(text) as Record<string, unknown> };
  } catch (error) {
    // Only the position: a parser message quotes the offending lines, which may hold a secret.
    const e = error as { line?: unknown; column?: unknown };
    return {
      ok: false,
      where:
        typeof e.line === "number"
          ? `line ${e.line}, column ${String(e.column)}`
          : "unknown position",
    };
  }
}

function withOwnServer(doc: Record<string, unknown>, entry: unknown): Record<string, unknown> {
  const servers = doc.mcp_servers;
  return {
    ...doc,
    mcp_servers: { ...(isPlainObject(servers) ? servers : {}), [SERVER_KEY]: entry },
  };
}

/** True when `doc` is exactly `{ mcp_servers: { myco-gate: { command: string, args: string[] } } }`. */
function isOwnBlockDoc(doc: Record<string, unknown>): boolean {
  if (Object.keys(doc).join() !== "mcp_servers" || !isPlainObject(doc.mcp_servers)) return false;
  const servers = doc.mcp_servers;
  if (Object.keys(servers).join() !== SERVER_KEY) return false;
  const own = servers[SERVER_KEY];
  return (
    isPlainObject(own) &&
    Object.keys(own).sort().join() === "args,command" &&
    typeof own.command === "string" &&
    Array.isArray(own.args) &&
    own.args.every((a) => typeof a === "string")
  );
}

export function mergeToml(existing: string | null, block: string, entry: LaunchLine): MergeResult {
  const want = { command: entry.command, args: [...entry.args] };
  if (existing === null) {
    const content = `${block}\n`;
    const check = parseToml(content);
    if (!check.ok || canonical(check.value) !== canonical(withOwnServer({}, want)))
      return conflict("internal error: the myco-gate block is not valid TOML");
    return { action: "create", splice: { offset: 0, remove: "", insert: content }, content };
  }
  const whole = parseToml(existing);
  if (!whole.ok) return conflict(`not valid TOML (${whole.where}); left unchanged`);

  const begins = existing.split(TOML_BEGIN).length - 1;
  const ends = existing.split(TOML_END).length - 1;
  let outside = existing;
  let splice: Splice;
  if (begins !== 0 || ends !== 0) {
    const start = existing.indexOf(TOML_BEGIN);
    const stopAt = existing.indexOf(TOML_END);
    if (begins !== 1 || ends !== 1 || stopAt < start)
      return conflict("damaged myco-gate markers; left unchanged");
    const stop = stopAt + TOML_END.length;
    const before = existing.slice(start, stop);
    const own = parseToml(before);
    if (!own.ok || !isOwnBlockDoc(own.value))
      return conflict("the marked myco-gate block was edited by hand; left unchanged");
    outside = existing.slice(0, start) + existing.slice(stop);
    if (before === block) splice = { offset: start, remove: before, insert: before };
    else splice = { offset: start, remove: before, insert: block };
  } else {
    const sep =
      existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    splice = { offset: existing.length, remove: "", insert: `${sep}${block}\n` };
  }
  const rest = parseToml(outside);
  if (!rest.ok)
    return conflict(`not valid TOML without the myco-gate block (${rest.where}); left unchanged`);
  const servers = rest.value.mcp_servers;
  if (servers !== undefined && !isPlainObject(servers))
    return conflict("mcp_servers is not a table; left unchanged");
  if (isPlainObject(servers) && Object.hasOwn(servers, SERVER_KEY))
    return conflict("defines mcp_servers.myco-gate outside init's marked block; left unchanged");
  const content = applySplice(existing, splice);
  const after = parseToml(content);
  if (!after.ok || canonical(after.value) !== canonical(withOwnServer(rest.value, want)))
    return conflict(
      "adding the myco-gate block would change other settings or produce invalid TOML; left unchanged",
    );
  if (splice.remove === splice.insert) return { action: "unchanged" };
  return { action: "update", splice, content };
}

// --- rendering ----------------------------------------------------------------

function prefixed(text: string, mark: string): string {
  return text
    .split("\n")
    .map((line) => `    ${mark} ${line}`)
    .join("\n");
}

function position(text: string, offset: number): string {
  const line = text.slice(0, offset).split("\n").length;
  const column = offset - text.lastIndexOf("\n", offset - 1);
  return `line ${line}, column ${column}`;
}

/**
 * The plan for one file, and its exact diff: the splice, which is the only change. Nothing
 * else of the file is printed (a config can hold another server's `env` values).
 */
export function renderPlan(plan: FilePlan, original: string | null = null): string {
  let text = `  ${plan.label}: ${plan.path}\n`;
  if (plan.note !== undefined) text += `    note: ${plan.note}\n`;
  text += `    ${plan.action}${plan.reason ? ` (${plan.reason})` : ""}`;
  const s = plan.splice;
  if (s === undefined || plan.action === "unchanged" || plan.action === "conflict")
    return `${text}\n`;
  if (plan.action === "create") return `${text}, new file:\n${prefixed(s.insert, "+")}\n`;
  const where = original === null ? `byte ${s.offset}` : position(original, s.offset);
  const head =
    s.remove === ""
      ? `, inserting ${s.insert.length} characters at ${where}`
      : `, replacing ${s.remove.length} characters at ${where} with ${s.insert.length}`;
  return `${text}${head}; every other byte of the file is kept:\n${s.remove === "" ? "" : `${prefixed(s.remove, "-")}\n`}${prefixed(s.insert, "+")}\n`;
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
// Where init may read and write.

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Copies `path` to the first free backup name; anything already there (even a dangling link) is skipped. */
function backup(fs: SetupFs, path: string, now: Date): string {
  const base = `${path}.myco-backup-${stamp(now)}`;
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    if (fs.kind(candidate) !== "missing") continue;
    if (fs.copyExclusive(path, candidate)) return candidate;
  }
  throw new Error(`no free backup name next to ${path}`);
}

/** True when `child` is `parent` or inside it. */
function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolves every link in the longest existing prefix of `path`. Only metadata is read. */
function resolveLoose(fs: SetupFs, path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    if (fs.kind(head) !== "missing") {
      try {
        return join(fs.realpath(head), ...tail);
      } catch {
        return join(head, ...tail); // a dangling link: compare it as written
      }
    }
    const up = dirname(head);
    if (up === head) return join(head, ...tail);
    tail.unshift(basename(head));
    head = up;
  }
}

interface HomeLayout {
  readonly home: string;
  readonly claudeJson: string;
  readonly codexHome: string;
  readonly codexToml: string;
  /** User-level config directories project mode must stay out of. */
  readonly configDirs: readonly string[];
}

function homeLayout(env: InitEnv): HomeLayout {
  const home = env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home))
    throw new InitUsageError(
      "HOME must be set to an absolute path (init uses it to keep out of your user-level configs)",
    );
  const codexHome =
    env.CODEX_HOME !== undefined && env.CODEX_HOME !== "" ? env.CODEX_HOME : join(home, ".codex");
  if (!isAbsolute(codexHome)) throw new InitUsageError("CODEX_HOME must be an absolute path");
  return {
    home,
    claudeJson: join(home, ".claude.json"),
    codexHome,
    codexToml: join(codexHome, "config.toml"),
    configDirs: [join(home, ".claude"), join(home, ".codex"), codexHome],
  };
}

/**
 * Project mode's guard: the canonical project directory, or a usage error when writing
 * `<project>/.mcp.json` and `<project>/.codex/config.toml` would touch a user-level config.
 * It resolves HOME and the config directories (metadata only); it never reads them.
 */
export function guardProjectDir(fs: SetupFs, projectDir: string, layout: HomeLayout): string {
  const kind = fs.kind(projectDir);
  if (kind === "missing")
    throw new InitUsageError(`project directory ${projectDir} does not exist`);
  const real = fs.realpath(projectDir);
  if (fs.kind(real) !== "dir") throw new InitUsageError(`${projectDir} is not a directory`);
  const home = resolveLoose(fs, layout.home);
  const why =
    real === home
      ? "is your home directory, where .codex/config.toml is the user-level Codex config"
      : layout.configDirs
            .map((d) => resolveLoose(fs, d))
            .some((d) => isWithin(real, d) || isWithin(join(real, ".codex"), d))
        ? "is (or holds) a user-level config directory (~/.claude, ~/.codex or $CODEX_HOME)"
        : undefined;
  if (why !== undefined)
    throw new InitUsageError(
      `refusing project directory ${projectDir}: it ${why}. Run init from your project, or use --global to change user-level configs (with a dry run first)`,
    );
  return real;
}

interface Target {
  readonly path: string;
  readonly writePath: string;
  readonly exists: boolean;
  readonly note?: string;
  readonly conflict?: string;
}

/** Project mode: a target and the directories under the project must not be links. */
function projectTarget(fs: SetupFs, root: string, parts: readonly string[]): Target {
  let at = root;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const kind = fs.kind(at);
    const last = i === parts.length - 1;
    if (kind === "missing")
      return { path: join(root, ...parts), writePath: join(root, ...parts), exists: false };
    if (kind === "symlink")
      return {
        path: join(root, ...parts),
        writePath: join(root, ...parts),
        exists: true,
        conflict: `${join(...parts.slice(0, i + 1))} is a symlink; project mode never follows a link out of the project; left unchanged`,
      };
    if (last ? kind !== "file" : kind !== "dir")
      return {
        path: join(root, ...parts),
        writePath: join(root, ...parts),
        exists: true,
        conflict: `${join(...parts.slice(0, i + 1))} is not a regular ${last ? "file" : "directory"}; left unchanged`,
      };
  }
  return { path: at, writePath: at, exists: true };
}

/** --global: a home config that is a link is written through to the file it names. */
function globalTarget(fs: SetupFs, path: string): Target {
  const kind = fs.kind(path);
  if (kind === "missing") return { path, writePath: path, exists: false };
  if (kind === "file") return { path, writePath: path, exists: true };
  if (kind !== "symlink")
    return { path, writePath: path, exists: true, conflict: "not a regular file; left unchanged" };
  let real: string;
  try {
    real = fs.realpath(path);
  } catch {
    return { path, writePath: path, exists: true, conflict: "a dangling symlink; left unchanged" };
  }
  if (fs.kind(real) !== "file")
    return {
      path,
      writePath: path,
      exists: true,
      conflict: "a symlink to something other than a regular file; left unchanged",
    };
  return {
    path,
    writePath: real,
    exists: true,
    note: `a symlink to ${real}: init writes through to that file (the link is kept) and backs it up next to it`,
  };
}

export const VM_NOTE = [
  "Windows VM path: not touched by `myco init`.",
  "  It has a single owner and runs under a lock; it is set up separately:",
  "  see docs/product/quickstart.md (live path) and docs/eval-runbook.md.",
].join("\n");

function planFile(
  fs: SetupFs,
  label: string,
  target: Target,
  merge: (existing: string | null) => MergeResult,
): { plan: FilePlan; original: string | null } {
  const base = {
    label,
    path: target.path,
    writePath: target.writePath,
    ...(target.note === undefined ? {} : { note: target.note }),
  };
  if (target.conflict !== undefined)
    return { plan: { ...base, action: "conflict", reason: target.conflict }, original: null };
  const original = target.exists ? fs.readText(target.writePath) : null;
  return { plan: { ...base, ...merge(original) }, original };
}

export function runInit(options: InitOptions, deps: InitDeps): number {
  const out = deps.stdout;
  const { fs } = deps;
  const writes = !options.dryRun && (!options.global || options.yes);
  const mode = options.global ? "global (user-level configs)" : "project";
  out(`myco init: ${mode} mode${writes ? "" : ", DRY RUN (nothing will be written)"}\n`);
  if (!options.global) out(`  project: ${options.projectDir}\n`);

  // Checked before anything starts: where init would write.
  const layout = homeLayout(deps.env);
  const projectRoot = options.global ? null : guardProjectDir(fs, options.projectDir, layout);

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
  const [claudeTarget, codexTarget] =
    projectRoot === null
      ? [globalTarget(fs, layout.claudeJson), globalTarget(fs, layout.codexToml)]
      : [
          projectTarget(fs, projectRoot, [".mcp.json"]),
          projectTarget(fs, projectRoot, [".codex", "config.toml"]),
        ];
  out(`\n[4/4] MCP client configs${writes ? "" : " (planned)"}\n`);
  const planned = [
    planFile(fs, "Claude Code", claudeTarget as Target, (t) => mergeJson(t, claudeEntry(line))),
    planFile(fs, "Codex", codexTarget as Target, (t) => mergeToml(t, codexBlock(line), line)),
  ];
  for (const { plan, original } of planned) out(renderPlan(plan, original));
  const plans = planned.map((p) => p.plan);
  const conflicted = plans.some((p) => p.action === "conflict");
  const changing = plans.filter((p) => p.content !== undefined);

  if (conflicted) {
    ok = false;
    out(
      "\n  Nothing was written: resolve the conflict above (no file is changed while one remains).\n",
    );
  } else if (writes) {
    for (const plan of changing) {
      const content = plan.content as string;
      let fileMode: number | undefined;
      if (plan.action === "update") {
        const saved = backup(fs, plan.writePath, deps.now());
        fileMode = fs.mode(plan.writePath);
        out(`  backed up ${basename(plan.writePath)} to ${saved}\n`);
      } else fs.mkdirp(dirname(plan.writePath));
      fs.writeAtomic(plan.writePath, content, fileMode);
      out(
        `  wrote ${plan.writePath}${plan.writePath === plan.path ? "" : ` (through ${plan.path})`}\n`,
      );
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
        "The written .mcp.json holds absolute paths of this machine; do not commit it.",
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
    if (options !== "help") {
      const layout = homeLayout(deps.env);
      if (!options.global) guardProjectDir(deps.fs, options.projectDir, layout);
    }
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

/**
 * The directory `myco init` was run from. pnpm runs the `myco` script from the package root
 * and passes the caller's directory as INIT_CWD; any other INIT_CWD (inherited from an outer
 * npm or pnpm script) is ignored, so `bin/myco init` always means the current directory.
 */
export function initCwd(
  env: {
    readonly INIT_CWD?: string | undefined;
    readonly npm_lifecycle_event?: string | undefined;
    readonly npm_package_name?: string | undefined;
  },
  processCwd: string,
): string {
  const viaOwnScript = env.npm_lifecycle_event === "myco" && env.npm_package_name === "@myco/core";
  return viaOwnScript && env.INIT_CWD !== undefined && isAbsolute(env.INIT_CWD)
    ? env.INIT_CWD
    : processCwd;
}
