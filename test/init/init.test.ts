/**
 * `myco init` (M2 scope add, track D): one-command setup.
 *
 * Every test runs against a temp HOME and a temp project dir. The acceptance bar it pins:
 *   - default mode reads and writes only inside the project (HOME is byte-for-byte unchanged);
 *   - `--dry-run` writes nothing; a second run changes nothing (idempotent);
 *   - `--global` alone prints the dry-run diff and writes nothing; `--global --yes` writes,
 *     after backing up each changed file, and unrelated keys of a planted ~/.claude.json survive;
 *   - a planted fake secret marker (in the environment, in HOME credential files and in other
 *     config keys) never reaches output, a child process's environment or a new config entry;
 *   - the gate health check fails closed and a failed check writes nothing;
 *   - the desktop check names exactly what is missing;
 *   - the Windows VM path is never touched (only soffice, Python and the gate are started).
 *
 * The last block runs the real CLI (bin/myco init) end to end: real filesystem, real gate.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claudeEntry,
  codexBlock,
  EXIT_INCOMPLETE,
  EXIT_OK,
  EXIT_USAGE,
  INIT_ENV_NAMES,
  type InitDeps,
  type InitEnv,
  LINUX_INSTALL,
  launchLine,
  mainInit,
  parseInitArgs,
  pickInitEnv,
  planJson,
  planToml,
  type SetupFs,
  type Spawner,
  type SpawnResult,
  TOML_BEGIN,
  TOML_END,
} from "../../src/setup/init.ts";
import { nodeSetupFs } from "../../src/setup/node-io.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
const TSX = join(REPO, "node_modules", ".bin", "tsx");
// Assembled so that this file never carries a key-shaped literal.
const MARKER = ["MYCO", "FAKE", "SECRET", "d3adb33f", "7c1e"].join("-");

// ---------------------------------------------------------------------------
// Harness

interface Recorded {
  op: string;
  path: string;
}

function recordingFs(log: Recorded[]): SetupFs {
  const rec =
    <A extends unknown[], R>(op: string, fn: (path: string, ...rest: A) => R) =>
    (path: string, ...rest: A): R => {
      log.push({ op, path });
      return fn(path, ...rest);
    };
  return {
    exists: rec("exists", nodeSetupFs.exists),
    readText: rec("readText", nodeSetupFs.readText),
    mode: rec("mode", nodeSetupFs.mode),
    mkdirp: rec("mkdirp", nodeSetupFs.mkdirp),
    copy: (from, to) => {
      log.push({ op: "copy-from", path: from }, { op: "copy-to", path: to });
      nodeSetupFs.copy(from, to);
    },
    writeAtomic: rec("writeAtomic", nodeSetupFs.writeAtomic),
  };
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  input?: string;
}

/** Canned replies of a healthy gate to init's four requests. */
function gateReplies(callResult: unknown): string {
  return [
    { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "myco-gate", version: "0.1.0" } } },
    { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "myco_gate_check" }] } },
    { jsonrpc: "2.0", id: 3, result: callResult },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
}

const MISMATCH = {
  isError: true,
  structuredContent: {
    verdict: "uncertain",
    accepted: false,
    reasonCodes: ["ASSIGNMENT_MISMATCH"],
  },
};

interface FakeSpawnOptions {
  soffice?: boolean;
  uno?: boolean;
  gate?: SpawnResult;
}

function fakeSpawner(calls: SpawnCall[], opts: FakeSpawnOptions = {}): Spawner {
  return (command, args, options) => {
    calls.push({
      command,
      args,
      env: options.env,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (command === "soffice")
      return opts.soffice === false
        ? { status: null, stdout: "", stderr: "", error: "spawnSync soffice ENOENT" }
        : { status: 0, stdout: "LibreOffice 24.2.7.2 420(Build:2)\n", stderr: "" };
    if (command === "python3")
      return { status: opts.uno === false ? 1 : 0, stdout: "", stderr: "" };
    if (command === TSX)
      return opts.gate ?? { status: 0, stdout: gateReplies(MISMATCH), stderr: "" };
    throw new Error(`unexpected spawn: ${command}`);
  };
}

interface Sandbox {
  home: string;
  project: string;
  log: Recorded[];
  calls: SpawnCall[];
  out: string[];
  err: string[];
}

let sb: Sandbox;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "myco-init-test-"));
  const home = join(base, "home");
  const project = join(base, "project");
  mkdirSync(home);
  mkdirSync(project);
  sb = { home, project, log: [], calls: [], out: [], err: [] };
});

function deps(
  over: Partial<InitDeps> & { spawnOpts?: FakeSpawnOptions; env?: InitEnv } = {},
): InitDeps {
  return {
    fs: recordingFs(sb.log),
    spawn: fakeSpawner(sb.calls, over.spawnOpts),
    env: over.env ?? { HOME: sb.home, PATH: "/usr/bin:/bin" },
    platform: "linux",
    now: () => new Date("2026-11-26T12:34:56.789Z"),
    cwd: sb.project,
    mycoRoot: REPO,
    stdout: (t) => sb.out.push(t),
    stderr: (t) => sb.err.push(t),
    ...over,
  };
}

function run(argv: string[], over: Parameters<typeof deps>[0] = {}): number {
  return mainInit(argv, deps(over));
}

/** Every file under `dir` with its bytes and mtime. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else files[relative(dir, p)] = `${st.mtimeMs}:${readFileSync(p, "base64")}`;
    }
  };
  walk(dir);
  return files;
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

const writeOps = new Set(["mkdirp", "writeAtomic", "copy-to"]);
const output = () => sb.out.join("") + sb.err.join("");

/** A planted ~/.claude.json with unrelated keys, another MCP server, and a marker value. */
function plantClaudeJson(): Record<string, unknown> {
  const original = {
    numStartups: 42,
    theme: "dark",
    primaryApiKey: MARKER,
    projects: { "/some/project": { allowedTools: ["Bash"], history: [{ display: "hi" }] } },
    mcpServers: { other: { command: "other-server", args: ["--x"], env: { OTHER_TOKEN: MARKER } } },
  };
  writeFileSync(join(sb.home, ".claude.json"), `${JSON.stringify(original, null, 2)}\n`, {
    mode: 0o600,
  });
  return original;
}

const CODEX_ORIGINAL = `model = "o-something"

[profiles.work]
approval_policy = "never"

[mcp_servers.other]
command = "other-server"
env = { OTHER_TOKEN = "${MARKER}" }
`;

function plantHomeSecrets(): void {
  mkdirSync(join(sb.home, ".claude"), { recursive: true });
  mkdirSync(join(sb.home, ".codex"), { recursive: true });
  writeFileSync(join(sb.home, ".claude", ".credentials.json"), JSON.stringify({ token: MARKER }));
  writeFileSync(
    join(sb.home, ".claude", "settings.json"),
    JSON.stringify({ apiKeyHelper: MARKER }),
  );
  writeFileSync(join(sb.home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: MARKER }));
  writeFileSync(join(sb.home, ".codex", "config.toml"), CODEX_ORIGINAL);
  writeFileSync(join(sb.home, ".netrc"), `machine example.com password ${MARKER}\n`);
}

/** The environment a careless CLI would forward: secrets next to the five names init reads. */
function markedProcessEnv(): Record<string, string> {
  return {
    HOME: sb.home,
    PATH: "/usr/bin:/bin",
    ANTHROPIC_API_KEY: MARKER,
    OPENAI_API_KEY: MARKER,
    GITHUB_TOKEN: MARKER,
    MYCO_FAKE_SECRET: MARKER,
  };
}

// ---------------------------------------------------------------------------

describe("argument parsing", () => {
  it("defaults to the project dir, df-s01/local and <project>/.myco/evidence", () => {
    const o = parseInitArgs([], "/p");
    expect(o).toMatchObject({
      projectDir: "/p",
      task: "df-s01",
      run: "local",
      evidenceRoot: "/p/.myco/evidence",
      global: false,
      yes: false,
      dryRun: false,
    });
  });

  it("--yes without --global is a usage error (it only confirms --global)", () => {
    expect(run(["--yes"])).toBe(EXIT_USAGE);
    expect(output()).toContain("--yes only confirms --global");
    expect(sb.log.filter((r) => writeOps.has(r.op))).toEqual([]);
  });

  it("rejects ids the gate would reject, control characters, and unknown flags", () => {
    expect(run(["--task", "../x"])).toBe(EXIT_USAGE);
    expect(run(["--run", "a b"])).toBe(EXIT_USAGE);
    expect(run(["--evidence-root", "/x\ny"])).toBe(EXIT_USAGE);
    expect(run(["--bogus"])).toBe(EXIT_USAGE);
    expect(run(["--global"], { env: { PATH: "/bin" } })).toBe(EXIT_USAGE); // no HOME
    expect(sb.calls).toEqual([]);
  });

  it("pickInitEnv takes exactly the five non-secret names", () => {
    const picked = pickInitEnv(markedProcessEnv());
    expect(Object.keys(picked).sort()).toEqual([...INIT_ENV_NAMES].sort());
    expect(JSON.stringify(picked)).not.toContain(MARKER);
  });
});

describe("JSON merge (Claude Code)", () => {
  const entry = claudeEntry({ command: "/r/tsx", args: ["/r/g.ts", "mcp"] });

  it("creates a file holding only the myco-gate entry", () => {
    const plan = planJson("Claude Code", "/x", null, entry);
    expect(plan.action).toBe("create");
    expect(JSON.parse(plan.content as string)).toEqual({ mcpServers: { "myco-gate": entry } });
    expect(plan.content).not.toContain('"env"');
  });

  it("adds the entry and keeps every unrelated key and server", () => {
    const existing = { a: 1, mcpServers: { other: { command: "o", env: { K: "v" } } }, z: [1] };
    const plan = planJson("Claude Code", "/x", JSON.stringify(existing), entry);
    expect(plan.action).toBe("update");
    expect(JSON.parse(plan.content as string)).toEqual({
      ...existing,
      mcpServers: { ...existing.mcpServers, "myco-gate": entry },
    });
    // The diff carries only the owned entry.
    expect(`${plan.before}${plan.after}`).not.toContain('"K"');
  });

  it("is unchanged when the entry is already there, whatever the formatting", () => {
    const text = JSON.stringify({ mcpServers: { "myco-gate": entry } });
    expect(planJson("Claude Code", "/x", text, entry)).toMatchObject({ action: "unchanged" });
    expect(planJson("Claude Code", "/x", text, entry).content).toBeUndefined();
  });

  it("leaves an unparseable or oddly shaped file alone (conflict)", () => {
    for (const text of ["{nope", "[]", '{"mcpServers": 3}']) {
      const plan = planJson("Claude Code", "/x", text, entry);
      expect(plan.action).toBe("conflict");
      expect(plan.content).toBeUndefined();
    }
  });
});

describe("TOML merge (Codex)", () => {
  const block = codexBlock({ command: "/r/tsx", args: ["/r/g.ts", "mcp", 'q"uote'] });

  it("creates the marked block", () => {
    const plan = planToml("Codex", "/x", null, block);
    expect(plan).toMatchObject({ action: "create", content: `${block}\n` });
    expect(block).toContain('"q\\"uote"');
  });

  it("appends to a file with unrelated tables and keeps them byte for byte", () => {
    const plan = planToml("Codex", "/x", CODEX_ORIGINAL, block);
    expect(plan.action).toBe("update");
    expect((plan.content as string).startsWith(CODEX_ORIGINAL)).toBe(true);
    expect(plan.content).toContain(block);
    expect(plan.before).toBeNull();
  });

  it("replaces only its own marked block, and is unchanged when it matches", () => {
    const old = codexBlock({ command: "/old/tsx", args: [] });
    const text = `a = 1\n\n${old}\n\n[z]\nb = 2\n`;
    const plan = planToml("Codex", "/x", text, block);
    expect(plan).toMatchObject({ action: "update", before: old });
    expect(plan.content).toBe(`a = 1\n\n${block}\n\n[z]\nb = 2\n`);
    expect(planToml("Codex", "/x", plan.content as string, block).action).toBe("unchanged");
  });

  it("refuses a myco-gate defined outside its block, an inline mcp_servers, or damaged markers", () => {
    for (const text of [
      '[mcp_servers.myco-gate]\ncommand = "x"\n',
      '[mcp_servers."myco-gate".env]\nA = "b"\n',
      'mcp_servers.myco-gate.command = "x"\n',
      'mcp_servers = { other = { command = "o" } }\n',
      `${TOML_BEGIN}\n[mcp_servers.myco-gate]\n`,
      `${TOML_END}\n${TOML_BEGIN}\n`,
      `${block}\n${block}\n`,
    ]) {
      const plan = planToml("Codex", "/x", text, block);
      expect(plan.action, text).toBe("conflict");
      expect(plan.content).toBeUndefined();
    }
  });
});

describe("project mode (default)", () => {
  it("writes .mcp.json and .codex/config.toml inside the project only; HOME is untouched", () => {
    plantClaudeJson();
    plantHomeSecrets();
    const homeBefore = snapshot(sb.home);
    expect(run([])).toBe(EXIT_OK);

    expect(snapshot(sb.home)).toEqual(homeBefore);
    // Every path init touched (read, stat or write) is in the project or this checkout.
    for (const r of sb.log)
      expect(within(r.path, sb.project) || within(r.path, REPO), `${r.op} ${r.path}`).toBe(true);
    for (const r of sb.log.filter((x) => writeOps.has(x.op)))
      expect(within(r.path, sb.project), `${r.op} ${r.path}`).toBe(true);

    const line = launchLine(REPO, parseInitArgs([], sb.project) as never);
    expect(JSON.parse(readFileSync(join(sb.project, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { "myco-gate": claudeEntry(line) },
    });
    expect(readFileSync(join(sb.project, ".codex", "config.toml"), "utf8")).toBe(
      `${codexBlock(line)}\n`,
    );
    expect(output()).toContain("Windows VM path: not touched");
  });

  it("--dry-run runs the checks, prints the plan and writes nothing", () => {
    expect(run(["--dry-run"])).toBe(EXIT_OK);
    expect(readdirSync(sb.project)).toEqual([]);
    expect(sb.log.filter((r) => writeOps.has(r.op))).toEqual([]);
    expect(output()).toContain("DRY RUN");
    expect(output()).toContain('+   "type": "stdio"');
    expect(sb.calls.map((c) => c.command)).toContain(TSX);
  });

  it("is idempotent: the second run reports unchanged and writes nothing", () => {
    writeFileSync(
      join(sb.project, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "o" } } }),
    );
    expect(run([])).toBe(EXIT_OK);
    const first = snapshot(sb.project);
    sb.log.length = 0;
    sb.out.length = 0;
    expect(run([])).toBe(EXIT_OK);
    expect(snapshot(sb.project)).toEqual(first);
    expect(sb.log.filter((r) => writeOps.has(r.op))).toEqual([]);
    expect(output().match(/ {4}unchanged/g)).toHaveLength(2);
    expect(output()).toContain("nothing to change");
  });

  it("backs up an existing project file before changing it, and keeps other servers", () => {
    const original = JSON.stringify({ mcpServers: { other: { command: "o" } }, extra: true });
    writeFileSync(join(sb.project, ".mcp.json"), original);
    expect(run([])).toBe(EXIT_OK);
    const backup = join(sb.project, ".mcp.json.myco-backup-20261126T123456Z");
    expect(readFileSync(backup, "utf8")).toBe(original);
    const merged = JSON.parse(readFileSync(join(sb.project, ".mcp.json"), "utf8"));
    expect(merged.extra).toBe(true);
    expect(merged.mcpServers.other).toEqual({ command: "o" });
    expect(merged.mcpServers["myco-gate"].type).toBe("stdio");
  });

  it("a conflicting config is left alone and the run is incomplete", () => {
    writeFileSync(join(sb.project, ".mcp.json"), "{not json");
    expect(run([])).toBe(EXIT_INCOMPLETE);
    expect(readFileSync(join(sb.project, ".mcp.json"), "utf8")).toBe("{not json");
    expect(output()).toContain("conflict");
  });
});

describe("--global", () => {
  it("without --yes prints the dry-run diff and writes nothing anywhere", () => {
    plantClaudeJson();
    plantHomeSecrets();
    const homeBefore = snapshot(sb.home);
    expect(run(["--global"])).toBe(EXIT_OK);
    expect(snapshot(sb.home)).toEqual(homeBefore);
    expect(readdirSync(sb.project)).toEqual([]);
    expect(sb.log.filter((r) => writeOps.has(r.op))).toEqual([]);
    const text = output();
    expect(text).toContain("DRY RUN");
    expect(text).toContain("--global --yes");
    expect(text).toContain(join(sb.home, ".claude.json"));
    expect(text).toContain('mcpServers["myco-gate"] only');
    expect(text).toContain(`+ ${TOML_BEGIN}`);
  });

  it("with --yes writes, backs up each file first, and keeps every unrelated key", () => {
    const original = plantClaudeJson();
    plantHomeSecrets();
    const claudeBytes = readFileSync(join(sb.home, ".claude.json"), "utf8");
    expect(run(["--global", "--yes"])).toBe(EXIT_OK);

    const claudePath = join(sb.home, ".claude.json");
    const merged = JSON.parse(readFileSync(claudePath, "utf8"));
    const { "myco-gate": added, ...otherServers } = merged.mcpServers;
    expect({ ...merged, mcpServers: otherServers }).toEqual(original);
    expect(added).toMatchObject({ type: "stdio", command: TSX });
    expect(statSync(claudePath).mode & 0o777).toBe(0o600); // mode kept
    expect(readFileSync(`${claudePath}.myco-backup-20261126T123456Z`, "utf8")).toBe(claudeBytes);

    const codexPath = join(sb.home, ".codex", "config.toml");
    const codex = readFileSync(codexPath, "utf8");
    expect(codex.startsWith(CODEX_ORIGINAL)).toBe(true);
    expect(codex).toContain("[mcp_servers.myco-gate]");
    expect(readFileSync(`${codexPath}.myco-backup-20261126T123456Z`, "utf8")).toBe(CODEX_ORIGINAL);

    // Only the two target files and their backups were written; nothing in the project.
    const written = sb.log
      .filter((r) => r.op === "writeAtomic" || r.op === "copy-to")
      .map((r) => r.path);
    expect(written.sort()).toEqual(
      [
        claudePath,
        codexPath,
        `${claudePath}.myco-backup-20261126T123456Z`,
        `${codexPath}.myco-backup-20261126T123456Z`,
      ].sort(),
    );
    expect(readdirSync(sb.project)).toEqual([]);

    // Idempotent: a second confirmed run changes nothing and makes no new backup.
    const after = snapshot(sb.home);
    expect(run(["--global", "--yes"])).toBe(EXIT_OK);
    expect(snapshot(sb.home)).toEqual(after);
  });

  it("honours CODEX_HOME for the Codex target", () => {
    const codexHome = join(sb.home, "elsewhere");
    expect(
      run(["--global", "--yes"], { env: { HOME: sb.home, CODEX_HOME: codexHome, PATH: "/bin" } }),
    ).toBe(EXIT_OK);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain(TOML_BEGIN);
  });

  it("a second backup on the same second never replaces the first", () => {
    const p = join(sb.home, ".claude.json");
    writeFileSync(p, "{}");
    writeFileSync(`${p}.myco-backup-20261126T123456Z`, "earlier");
    expect(run(["--global", "--yes"])).toBe(EXIT_OK);
    expect(readFileSync(`${p}.myco-backup-20261126T123456Z`, "utf8")).toBe("earlier");
    expect(readFileSync(`${p}.myco-backup-20261126T123456Z-1`, "utf8")).toBe("{}");
  });
});

describe("secrets: a planted marker never leaks", () => {
  function markerFree(): void {
    expect(output()).not.toContain(MARKER);
    for (const c of sb.calls) {
      expect(Object.keys(c.env)).toEqual(["PATH"]);
      expect(JSON.stringify(c)).not.toContain(MARKER);
    }
  }

  it("project mode, global dry run and global apply", () => {
    plantClaudeJson();
    plantHomeSecrets();
    // Another server's env value in the project's own .mcp.json.
    const projectMcp = { mcpServers: { other: { command: "o", env: { TOKEN: MARKER } } } };
    writeFileSync(join(sb.project, ".mcp.json"), JSON.stringify(projectMcp));
    const env = pickInitEnv(markedProcessEnv());

    const credentialFiles = [
      join(sb.home, ".claude", ".credentials.json"),
      join(sb.home, ".claude", "settings.json"),
      join(sb.home, ".codex", "auth.json"),
      join(sb.home, ".netrc"),
    ];
    const countIn = (p: string) => readFileSync(p, "utf8").split(MARKER).length - 1;
    const before = new Map(
      [
        join(sb.project, ".mcp.json"),
        join(sb.home, ".claude.json"),
        join(sb.home, ".codex", "config.toml"),
      ].map((p) => [p, countIn(p)]),
    );

    for (const argv of [[], ["--global"], ["--global", "--yes"]]) {
      expect(run(argv, { env })).toBe(EXIT_OK);
      markerFree();
    }

    // Init never opened a credential file.
    for (const f of credentialFiles) expect(sb.log.some((r) => r.path === f)).toBe(false);
    // New files carry no marker; changed files carry exactly the occurrences they had.
    expect(readFileSync(join(sb.project, ".codex", "config.toml"), "utf8")).not.toContain(MARKER);
    for (const [p, n] of before) expect(countIn(p), p).toBe(n);
    for (const p of [join(sb.project, ".mcp.json"), join(sb.home, ".claude.json")]) {
      const entry = JSON.parse(readFileSync(p, "utf8")).mcpServers["myco-gate"];
      expect(JSON.stringify(entry)).not.toContain(MARKER);
      expect(entry.env).toBeUndefined();
    }
  });
});

describe("gate health check (fails closed)", () => {
  const cases: [string, SpawnResult][] = [
    ["the gate cannot start", { status: null, stdout: "", stderr: "", error: "ENOENT" }],
    ["the gate exits non-zero", { status: 3, stdout: "", stderr: "usage" }],
    ["noise on the MCP channel", { status: 0, stdout: "hello\n", stderr: "" }],
    [
      "another task is verified (not bound to the trial)",
      {
        status: 0,
        stdout: gateReplies({
          isError: false,
          structuredContent: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"] },
        }),
        stderr: "",
      },
    ],
    [
      "uncertain but not ASSIGNMENT_MISMATCH",
      {
        status: 0,
        stdout: gateReplies({
          isError: true,
          structuredContent: {
            verdict: "uncertain",
            accepted: false,
            reasonCodes: ["INVALID_REQUEST"],
          },
        }),
        stderr: "",
      },
    ],
    [
      "a second tool is listed",
      {
        status: 0,
        stdout: gateReplies(MISMATCH).replace(
          '[{"name":"myco_gate_check"}]',
          '[{"name":"myco_gate_check"},{"name":"read_file"}]',
        ),
        stderr: "",
      },
    ],
  ];
  for (const [name, gate] of cases)
    it(`writes nothing when ${name}`, () => {
      expect(run([], { spawnOpts: { gate } })).toBe(EXIT_INCOMPLETE);
      expect(readdirSync(sb.project)).toEqual([]);
      expect(sb.log.filter((r) => writeOps.has(r.op))).toEqual([]);
      expect(output()).toContain("FAILED");
      expect(output()).toContain("Nothing was written");
    });

  it("probes with a task other than the assignment, and the trial's own run", () => {
    expect(run(["--task", "myco-init-probe", "--run", "r9"])).toBe(EXIT_OK);
    const gateCall = sb.calls.find((c) => c.command === TSX);
    const call = (gateCall?.input ?? "").split("\n").map((l) => (l ? JSON.parse(l) : null))[3];
    expect(call.params.arguments).toEqual({ taskId: "myco-init-probe-2", runId: "r9" });
    expect(gateCall?.args).toEqual(
      launchLine(
        REPO,
        parseInitArgs(["--task", "myco-init-probe", "--run", "r9"], sb.project) as never,
      ).args,
    );
  });
});

describe("Linux desktop path", () => {
  it("says exactly what is missing and how to install it; configs are still written", () => {
    expect(run([], { spawnOpts: { soffice: false, uno: false } })).toBe(EXIT_INCOMPLETE);
    const text = output();
    expect(text).toContain("MISSING  soffice (soffice): NOT FOUND");
    expect(text).toContain("MISSING  python-uno (python3 -c 'import uno'): NOT FOUND");
    expect(text).toContain(LINUX_INSTALL);
    expect(text).toContain("--skip-desktop");
    expect(readFileSync(join(sb.project, ".mcp.json"), "utf8")).toContain("myco-gate");
  });

  it("only python-uno missing is still incomplete", () => {
    expect(run([], { spawnOpts: { uno: false } })).toBe(EXIT_INCOMPLETE);
    expect(output()).toContain("ok  soffice (soffice): LibreOffice 24.2.7.2");
  });

  it("attaches when both are present, honouring MYCO_SOFFICE and MYCO_PYTHON", () => {
    const seen: string[] = [];
    const spawn: Spawner = (command, args, options) => {
      seen.push(command);
      return fakeSpawner(sb.calls)(
        command === "/opt/lo/soffice" ? "soffice" : command === "/opt/py" ? "python3" : command,
        args,
        options,
      );
    };
    expect(
      run([], {
        spawn,
        env: {
          HOME: sb.home,
          PATH: "/bin",
          MYCO_SOFFICE: "/opt/lo/soffice",
          MYCO_PYTHON: "/opt/py",
        },
      }),
    ).toBe(EXIT_OK);
    expect(seen.slice(0, 2)).toEqual(["/opt/lo/soffice", "/opt/py"]);
    expect(output()).toContain("attached: run `pnpm myco-linux --demo`");
  });

  it("is skipped off Linux and with --skip-desktop", () => {
    expect(run([], { platform: "darwin" })).toBe(EXIT_OK);
    expect(output()).toContain("skipped: the Linux desktop path runs on Linux (this is darwin)");
    sb.calls.length = 0;
    expect(run(["--skip-desktop"])).toBe(EXIT_OK);
    expect(sb.calls.map((c) => c.command)).toEqual([TSX]);
  });

  it("names the missing launcher and writes nothing when this checkout is not installed", () => {
    expect(run([], { mycoRoot: join(sb.project, "no-such-checkout") })).toBe(EXIT_INCOMPLETE);
    expect(output()).toContain("pnpm install --frozen-lockfile");
    expect(sb.calls).toEqual([]);
    expect(readdirSync(sb.project)).toEqual([]);
  });
});

describe("Windows VM path is out of scope", () => {
  it("starts only soffice, Python and the gate", () => {
    run([]);
    run(["--global", "--yes"]);
    expect(new Set(sb.calls.map((c) => c.command))).toEqual(new Set(["soffice", "python3", TSX]));
  });

  it("the init sources name no VM lock, emulator, guest port or guest shell", () => {
    for (const file of ["src/setup/init.ts", "src/setup/node-io.ts", "scripts/myco-init.ts"]) {
      const text = readFileSync(join(REPO, file), "utf8");
      expect(text, file).not.toMatch(/qemu|\butm\b|vm[.-]lock|myco-win11|8765|\bssh\b|vm-session/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The real CLI: real filesystem, real gate, real environment scrubbing.

describe("bin/myco init end to end", () => {
  function cli(args: string[], extraEnv: Record<string, string> = {}) {
    const r = spawnSync(join(REPO, "bin", "myco"), ["init", "--skip-desktop", ...args], {
      cwd: sb.project,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sb.home, ...extraEnv },
      timeout: 60_000,
    });
    return { status: r.status, text: `${r.stdout}${r.stderr}` };
  }

  it("writes a working project config, then changes nothing on a second run", () => {
    plantClaudeJson();
    plantHomeSecrets();
    const homeBefore = snapshot(sb.home);
    const secrets = { ANTHROPIC_API_KEY: MARKER, MYCO_FAKE_SECRET: MARKER };

    const first = cli([], secrets);
    expect(first.status, first.text).toBe(0);
    expect(first.text).toContain("a call naming another task: uncertain / ASSIGNMENT_MISMATCH");
    expect(first.text).not.toContain(MARKER);
    const after = snapshot(sb.project);
    expect(Object.keys(after).sort()).toEqual([".codex/config.toml", ".mcp.json"]);
    for (const v of Object.values(after))
      expect(Buffer.from(v.split(":")[1] ?? "", "base64").toString()).not.toContain(MARKER);

    const second = cli([], secrets);
    expect(second.status, second.text).toBe(0);
    expect(second.text.match(/ {4}unchanged/g)).toHaveLength(2);
    expect(snapshot(sb.project)).toEqual(after);
    expect(snapshot(sb.home)).toEqual(homeBefore);

    // The written config launches the gate: the same line, answered by a real server.
    const entry = JSON.parse(readFileSync(join(sb.project, ".mcp.json"), "utf8")).mcpServers[
      "myco-gate"
    ];
    const served = spawnSync(entry.command, entry.args, {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      timeout: 60_000,
    });
    expect(served.status).toBe(0);
    expect(
      JSON.parse(served.stdout.trim()).result.tools.map((t: { name: string }) => t.name),
    ).toEqual(["myco_gate_check"]);
  }, 120_000);

  it("--global without --yes writes nothing; with --yes it writes a backup", () => {
    plantClaudeJson();
    const homeBefore = snapshot(sb.home);
    const dry = cli(["--global"]);
    expect(dry.status, dry.text).toBe(0);
    expect(dry.text).toContain("DRY RUN");
    expect(dry.text).not.toContain(MARKER);
    expect(snapshot(sb.home)).toEqual(homeBefore);

    const applied = cli(["--global", "--yes"]);
    expect(applied.status, applied.text).toBe(0);
    expect(readdirSync(sb.home).some((n) => n.startsWith(".claude.json.myco-backup-"))).toBe(true);
    const merged = JSON.parse(readFileSync(join(sb.home, ".claude.json"), "utf8"));
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.other.command).toBe("other-server");
    expect(readdirSync(sb.project)).toEqual([]);
  }, 120_000);
});
