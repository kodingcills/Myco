/**
 * TIF-274 prerequisite (#470 F2): the launch audit reads the agent's real argv and MCP
 * server environment, and fails closed on anything it cannot classify.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentLaunchPlan,
  auditAgentLaunch,
  grantedToolsFromArgv,
  mcpConfigJson,
  parseAgentArgv,
} from "../../src/integrity/launch.ts";
import { rtSessionIdFor, type ToolClass } from "../../src/integrity/surface.ts";

const GATE: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  "myco-gate": { myco_gate_check: { reach: "gate", note: "gate" } },
};
const RUN = "trial-7";
const SERVERS: AgentLaunchPlan["mcpServers"] = {
  "myco-rt": { command: "myco-rt-mcp", args: [], env: { MYCO_RT_SESSION_ID: rtSessionIdFor(RUN) } },
  "myco-gate": { command: "myco-gate", args: ["mcp"], env: {} },
};
const TOOLS = "mcp__myco-rt__create,mcp__myco-rt__act,mcp__myco-gate__myco_gate_check,TodoWrite";
/** The plan's MCP config path: the only `--mcp-config` value the audit accepts. */
const MCP_PATH = "/run/myco/trial-7/mcp.json";
/** The locked MCP flags a gated launch carries (#497 D1). */
const MCP_LOCK = ["--strict-mcp-config", "--mcp-config", MCP_PATH];

/** Audit `argv` with no built-in tools (`--tools ""`), as a locked gated launch has. */
function audit(argv: string[], servers: AgentLaunchPlan["mcpServers"] = SERVERS) {
  return auditRaw(["--tools", "", ...argv], servers);
}

/** Audit `argv` with the locked MCP flags only (no `--tools`). */
function auditRaw(argv: string[], servers: AgentLaunchPlan["mcpServers"] = SERVERS) {
  return auditBare([...MCP_LOCK, ...argv], servers);
}

/** Audit `argv` exactly as given, against a plan whose config path is `mcpConfigPath`. */
function auditBare(
  argv: string[],
  servers: AgentLaunchPlan["mcpServers"] = SERVERS,
  mcpConfigPath = MCP_PATH,
) {
  return auditAgentLaunch(
    { argv, mcpServers: servers, mcpConfigPath },
    { runId: RUN, extraServers: GATE },
  );
}

describe("grantedToolsFromArgv", () => {
  it.each([
    [["--allowedTools", TOOLS]],
    [["--allowed-tools", TOOLS]],
    [[`--allowedTools=${TOOLS}`]],
    [["--allowedTools", ...TOOLS.split(",")]],
    [["--allowedTools", TOOLS.replaceAll(",", " ")]],
  ])("reads every spelling of the allowed-tools flag: %j", (argv) => {
    const { granted, violations } = grantedToolsFromArgv(["-p", "prompt", ...argv]);
    expect(violations).toEqual([]);
    expect(granted).toEqual(TOOLS.split(","));
  });

  it("collects repeated flags", () => {
    const { granted } = grantedToolsFromArgv(["--allowedTools", "Bash", "--allowedTools", "Read"]);
    expect(granted).toEqual(["Bash", "Read"]);
  });
});

describe("auditAgentLaunch", () => {
  it("passes the gated plan, pinned from the server's real env", () => {
    const a = audit([
      "-p",
      "do it",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.violations).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.mycoRtSessionPinned).toBe(true);
    expect(a.hostRoots).toEqual([]);
  });

  it.each([["Bash"], ["Read"], ["WebFetch"], ["mcp__myco-rt__evidence"], ["mcp__myco-rt__nope"]])(
    "a granted %s fails",
    (tool) => {
      const a = audit(["--allowedTools", `${TOOLS},${tool}`]);
      expect(a.ok).toBe(false);
      expect(a.violations.map((v) => v.tool)).toEqual([tool]);
    },
  );

  it.each([
    [["--dangerously-skip-permissions"]],
    [["--allow-dangerously-skip-permissions"]],
    [["--permission-mode", "bypassPermissions"]],
    [["--permission-mode", "acceptEdits"]],
    [["--permission-mode=bypassPermissions"]],
    [["--add-dir", "/"]],
    [["--some-future-flag"]],
    [["--model"]],
  ])("a widening or unknown flag fails closed: %j", (flags) => {
    const a = audit(["--allowedTools", TOOLS, ...flags]);
    expect(a.ok).toBe(false);
    expect(a.hostRoots).toEqual(["/"]);
  });

  it("an MCP server the audit cannot classify fails", () => {
    const a = audit(["--allowedTools", TOOLS], {
      ...SERVERS,
      "host-files": { command: "x", args: [], env: {} },
    });
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.tool)).toEqual(["mcp__host-files"]);
  });

  it("a granted tool on a server the plan does not start fails", () => {
    const { "myco-gate": _gate, ...noGate } = SERVERS;
    const a = audit(["--allowedTools", TOOLS], noGate);
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.tool)).toEqual(["mcp__myco-gate__myco_gate_check"]);
  });

  it.each([
    ["missing", {}],
    ["empty (#470 N3)", { MYCO_RT_SESSION_ID: "" }],
    ["another trial's", { MYCO_RT_SESSION_ID: rtSessionIdFor("trial-6") }],
    ["the bare run id", { MYCO_RT_SESSION_ID: RUN }],
  ])("a %s pin leaves create rejected", (_, env) => {
    const a = audit(["--allowedTools", TOOLS], {
      ...SERVERS,
      "myco-rt": { command: "myco-rt-mcp", args: [], env },
    });
    expect(a.mycoRtSessionPinned).toBe(false);
    expect(a.violations.map((v) => v.tool)).toEqual(["mcp__myco-rt__create"]);
  });
});

// #484 F1: Claude Code's --allowedTools, --disallowedTools, --tools, --mcp-config and
// --add-dir are variadic (`<x...>` in `claude --help`). The audit must read every value
// the CLI reads, so none passes as a positional entry (the prompt) or as a separate flag.
describe("variadic launch flags are parsed the way Claude Code parses them (#484 F1)", () => {
  it("several values after one --disallowedTools are all denied", () => {
    const p = parseAgentArgv(["--disallowedTools", "Read", "Glob", "-p", "prompt"]);
    expect(p.violations).toEqual([]);
    expect(p.disallowed).toEqual(["Read", "Glob"]);
    // So a launch that enables them and denies both, in one flag, has no built-in left.
    const a = auditRaw([
      "--tools",
      "Read,Glob",
      "--disallowedTools",
      "Read",
      "Glob",
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.violations).toEqual([]);
    expect(a.effective).not.toContain("Glob");
  });

  it("a second --mcp-config value is a config, not the prompt, and is refused", () => {
    const argv = ["--mcp-config", MCP_PATH, "extra.json", "--allowedTools", TOOLS];
    expect(parseAgentArgv(argv).mcpConfigs).toEqual([MCP_PATH, "extra.json"]);
    const a = auditBare(["--tools", "", "--strict-mcp-config", ...argv]);
    expect(a.ok).toBe(false);
    expect([...new Set(a.violations.map((v) => v.tool))]).toEqual(["--mcp-config"]);
    expect(a.hostRoots).toEqual(["/"]);
  });

  it("one --mcp-config value, the plan's path, passes", () => {
    const a = auditBare([
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      MCP_PATH,
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.violations).toEqual([]);
  });

  it("several values after one --tools are all enabled built-ins", () => {
    const p = parseAgentArgv(["--tools", "TodoWrite", "Read", "-p"]);
    expect(p.builtins).toEqual(["TodoWrite", "Read"]);
    const a = auditRaw(["--tools", "TodoWrite", "Read", "--allowedTools", TOOLS]);
    expect(a.violations.map((v) => v.tool)).toEqual(["Read"]);
  });

  it("every value after one --add-dir is consumed, and the flag is refused", () => {
    const p = parseAgentArgv(["--add-dir", "/a", "/b", "--allowedTools", "TodoWrite"]);
    expect(p.violations.map((v) => v.tool)).toEqual(["--add-dir"]);
    expect(p.granted).toEqual(["TodoWrite"]);
  });

  it.each([
    ["--disallowedTools", ["--disallowedTools", "--dangerously-skip-permissions"]],
    ["--mcp-config", ["--mcp-config", "--allowedTools", "Bash"]],
    ["--tools", ["--tools", "-x"]],
    ["--allowedTools", ["--allowedTools", "--verbose"]],
    ["--model", ["--model", "--allowedTools"]],
  ])("a %s value that looks like a flag fails closed and grants nothing", (flag, argv) => {
    const p = parseAgentArgv(argv);
    expect(p.violations.some((v) => v.tool === flag && /looks like a flag/.test(v.detail))).toBe(
      true,
    );
    // Read as the CLI reads it: the flag-like entry is the value, so it never acts as a flag.
    expect(p.granted).not.toContain("Bash");
    expect(audit(argv).ok).toBe(false);
  });

  it("a lone '-' is a value, as in Claude Code", () => {
    const p = parseAgentArgv(["--mcp-config", "-"]);
    expect(p.violations).toEqual([]);
    expect(p.mcpConfigs).toEqual(["-"]);
  });

  it("a variadic flag given twice adds to its values", () => {
    expect(
      parseAgentArgv(["--disallowedTools", "Read", "--disallowedTools", "Glob"]).disallowed,
    ).toEqual(["Read", "Glob"]);
    expect(parseAgentArgv(["--tools", "", "--tools", "Read"]).builtins).toEqual(["Read"]);
    // Even the plan's own path, given twice, is two configs and is refused.
    const twice = auditBare([
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      MCP_PATH,
      "--mcp-config",
      MCP_PATH,
      "--allowedTools",
      TOOLS,
    ]);
    expect(twice.violations.map((v) => v.tool)).toEqual(["--mcp-config"]);
    expect(twice.violations[0]?.detail).toMatch(/^2 MCP configs/);
    const tools = auditRaw(["--tools", "", "--tools", "Read", "--allowedTools", TOOLS]);
    expect(tools.violations.map((v) => v.tool)).toEqual(["Read"]);
  });

  it("the equals form carries exactly one value; the next entry is positional", () => {
    // `--disallowedTools=Read Glob`: Claude Code denies Read only; Glob is the prompt.
    const p = parseAgentArgv(["--disallowedTools=Read", "Glob"]);
    expect(p.disallowed).toEqual(["Read"]);
    const a = auditRaw([
      "--tools",
      "Read,Glob",
      "--disallowedTools=Read",
      "Glob",
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.violations.map((v) => v.tool)).toEqual(["Glob"]);
    // `--mcp-config=plan.json extra.json`: one config; extra.json is the prompt.
    expect(parseAgentArgv(["--mcp-config=plan.json", "extra.json"]).mcpConfigs).toEqual([
      "plan.json",
    ]);
    expect(
      auditBare([
        "--tools",
        "",
        "--strict-mcp-config",
        `--mcp-config=${MCP_PATH}`,
        "extra.json",
        "--allowedTools",
        TOOLS,
      ]).ok,
    ).toBe(true);
    // `--tools=` is no built-ins.
    expect(parseAgentArgv(["--tools="]).builtins).toEqual([]);
  });

  it.each([["--disallowedTools"], ["--tools"], ["--mcp-config"], ["--model"]])(
    "%s at the end, without a value, fails closed",
    (flag) => {
      expect(parseAgentArgv([flag]).violations.map((v) => v.detail)).toEqual([
        "flag without a value",
      ]);
    },
  );

  it("everything after `--` is refused, not read as flags or the prompt", () => {
    const p = parseAgentArgv(["--allowedTools", "TodoWrite", "--", "--allowedTools", "Bash"]);
    expect(p.violations.map((v) => v.tool)).toEqual(["--"]);
    expect(p.granted).toEqual(["TodoWrite"]);
  });
});

// #484 F2: the built-in tools are set by --tools, separately from --allowedTools. The
// effective surface (built-ins --tools enables + granted MCP tools - whole-tool denies) must
// not exceed the audited grant.
describe("the launch audit covers the full tool surface, built-ins included (#484 F2)", () => {
  it("--tools absent (CLI default: every built-in) is refused", () => {
    const a = auditRaw(["-p", "x", "--permission-mode", "dontAsk", "--allowedTools", TOOLS]);
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.tool)).toEqual(["--tools"]);
    expect(a.effective).toBe("unbounded");
    expect(a.hostRoots).toEqual(["/"]);
  });

  it.each([[["--tools", "default"]], [["--tools", "", "default"]], [["--tools=default"]]])(
    "--tools naming the default set is refused: %j",
    (flags) => {
      const a = auditRaw([...flags, "--allowedTools", TOOLS]);
      expect(a.violations.map((v) => v.tool)).toEqual(["--tools"]);
      expect(a.effective).toBe("unbounded");
    },
  );

  it('--tools "" (no built-ins) passes, and the surface is the granted MCP tools', () => {
    const a = auditRaw(["--tools", "", "--allowedTools", TOOLS]);
    expect(a.violations).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.effective).toEqual(TOOLS.split(",").filter((t) => t.startsWith("mcp__")));
  });

  it("a granted agent-local built-in enabled by --tools passes", () => {
    const a = auditRaw(["--tools", "TodoWrite", "--allowedTools", TOOLS]);
    expect(a.violations).toEqual([]);
    expect(a.effective).toContain("TodoWrite");
  });

  it.each([["Read"], ["Glob"], ["Grep"], ["Bash"], ["WebFetch"], ["SomeNewTool"]])(
    "a built-in %s enabled by --tools but not granted exceeds the grant and is refused",
    (tool) => {
      const a = auditRaw(["--tools", tool, "--allowedTools", TOOLS]);
      expect(a.ok).toBe(false);
      expect(a.violations.map((v) => v.tool)).toEqual([tool]);
      expect(a.violations[0]?.detail).toMatch(/exceeds/);
    },
  );

  it("a host-reaching built-in both enabled and granted is refused by the surface audit", () => {
    const a = auditRaw(["--tools", "Read", "--allowedTools", `${TOOLS},Read`]);
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => [v.tool, v.reach])).toEqual([["Read", "host-fs"]]);
  });

  it("a built-in enabled and then denied whole is not in the effective surface", () => {
    const a = auditRaw(["--tools", "Read", "--disallowedTools", "Read", "--allowedTools", TOOLS]);
    expect(a.violations).toEqual([]);
    expect(a.effective).not.toContain("Read");
  });

  it("a deny rule with a specifier does not remove the whole built-in", () => {
    const a = auditRaw([
      "--tools",
      "Bash",
      "--disallowedTools",
      "Bash(rm:*)",
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.violations.map((v) => v.tool)).toEqual(["Bash"]);
  });

  it("a denied MCP tool leaves the effective surface", () => {
    const a = auditRaw([
      "--tools",
      "",
      "--disallowedTools",
      "mcp__myco-rt__act",
      "mcp__myco-gate",
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.violations).toEqual([]);
    expect(a.effective).toEqual(["mcp__myco-rt__create"]);
  });
});

// #497 D1: the MCP servers the agent can load must be exactly plan.mcpServers. The audit
// requires --strict-mcp-config (no user / project / local servers) and exactly one
// --mcp-config, equal to the plan's mcpConfigPath; the transport writes mcpConfigJson(plan)
// there. Inline JSON and every other path are refused.
describe("the MCP config is pinned to the launch plan (#497 D1)", () => {
  const EVIL = JSON.stringify({ mcpServers: { evil: { command: "bash", args: ["-c", "id"] } } });
  /** A locked launch with `mcp` in place of the MCP flags. */
  const launch = (mcp: string[]) => ["--tools", "", ...mcp, "--allowedTools", TOOLS];
  const mcpTools = (a: ReturnType<typeof auditBare>) => a.violations.map((v) => v.tool);

  it("the locked launch passes", () => {
    const a = auditBare(launch(MCP_LOCK));
    expect(a.violations).toEqual([]);
    expect(a.ok).toBe(true);
  });

  it("verifier probe 1: --strict-mcp-config plus an inline JSON config is refused", () => {
    const a = auditBare(launch(["--strict-mcp-config", "--mcp-config", EVIL]));
    expect(a.ok).toBe(false);
    expect(mcpTools(a)).toEqual(["--mcp-config"]);
    expect(a.violations[0]?.detail).toMatch(/inline JSON/);
    expect(a.hostRoots).toEqual(["/"]);
  });

  it("inline JSON as a second value, after the plan's path, is refused", () => {
    const a = auditBare(launch(["--strict-mcp-config", "--mcp-config", MCP_PATH, EVIL]));
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.detail)).toEqual([
      "2 MCP configs: exactly one, the plan's mcpConfigPath, must load",
      "inline JSON MCP config: only the plan's mcpConfigPath may load",
    ]);
  });

  it("inline JSON in the equals form, or with leading space, is refused", () => {
    expect(auditBare(launch(["--strict-mcp-config", `--mcp-config=${EVIL}`])).ok).toBe(false);
    expect(auditBare(launch(["--strict-mcp-config", "--mcp-config", ` ${EVIL}`])).ok).toBe(false);
  });

  it.each([
    ["verifier probe 2: another absolute path", "/tmp/other.json"],
    ["a relative path", "mcp.json"],
    ["a ./ relative path", "./mcp.json"],
    ["a relative path that resolves elsewhere", "../trial-6/mcp.json"],
    ["a path with ..", "/run/myco/trial-7/../trial-7/mcp.json"],
    ["a path with a doubled slash", "/run/myco/trial-7//mcp.json"],
    ["a trailing slash", `${MCP_PATH}/`],
    ["a different case", MCP_PATH.toUpperCase()],
    ["an empty value", ""],
  ])("%s is refused", (_, value) => {
    const a = auditBare(launch(["--strict-mcp-config", "--mcp-config", value]));
    expect(a.ok).toBe(false);
    expect(mcpTools(a)).toEqual(["--mcp-config"]);
    expect(a.violations[0]?.detail).toMatch(/not the plan's mcpConfigPath|inline JSON/);
  });

  it("a symlink to the plan's file is refused: the audit compares the path itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-mcp-"));
    try {
      const real = join(dir, "mcp.json");
      writeFileSync(real, "{}");
      const link = join(dir, "link.json");
      symlinkSync(real, link);
      expect(realpathSync(link)).toBe(realpathSync(real));
      const a = auditBare(
        launch(["--strict-mcp-config", "--mcp-config", link]),
        SERVERS,
        realpathSync(real),
      );
      expect(a.ok).toBe(false);
      expect(mcpTools(a)).toEqual(["--mcp-config"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("verifier probe 3: no --strict-mcp-config (user/project/local servers load) is refused", () => {
    const a = auditBare(launch(["--mcp-config", MCP_PATH]));
    expect(a.ok).toBe(false);
    expect(mcpTools(a)).toEqual(["--strict-mcp-config"]);
    expect(a.violations[0]?.detail).toMatch(/user, project and local/);
  });

  it("no --mcp-config at all is refused: exactly one must load", () => {
    const a = auditBare(launch(["--strict-mcp-config"]));
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.detail)).toEqual([
      "0 MCP configs: exactly one, the plan's mcpConfigPath, must load",
    ]);
  });

  it("the equals form of the plan's path passes", () => {
    expect(
      auditBare(launch(["--strict-mcp-config", `--mcp-config=${MCP_PATH}`])).violations,
    ).toEqual([]);
  });

  it.each([
    ["a relative path", "mcp.json"],
    ["a path with ..", "/run/myco/x/../mcp.json"],
    ["an empty path", ""],
    ["inline JSON", "{}"],
  ])("a plan whose mcpConfigPath is %s is refused even when the argv matches it", (_, path) => {
    const a = auditBare(launch(["--strict-mcp-config", "--mcp-config", path]), SERVERS, path);
    expect(a.ok).toBe(false);
    expect(a.violations.some((v) => /not an absolute, normalised path/.test(v.detail))).toBe(true);
  });

  it("mcpConfigJson writes exactly the plan's servers", () => {
    const plan: AgentLaunchPlan = { argv: [], mcpServers: SERVERS, mcpConfigPath: MCP_PATH };
    const parsed = JSON.parse(mcpConfigJson(plan)) as unknown;
    expect(parsed).toEqual({ mcpServers: SERVERS });
  });
});

// #497 nit 2: a boolean flag takes no value. The equals form is refused (Claude Code rejects
// it as an unknown option), and `--strict-mcp-config=…` does not count as the lock.
describe("boolean flags in the equals form are refused (#497 nit 2)", () => {
  it.each([["--strict-mcp-config=true"], ["--strict-mcp-config="], ["--print=x"], ["--verbose=1"]])(
    "%s fails closed",
    (flag) => {
      const p = parseAgentArgv([flag]);
      expect(p.violations.map((v) => [v.tool, v.detail])).toEqual([
        [flag.slice(0, flag.indexOf("=")), "unrecognised agent flag: fail closed"],
      ]);
      expect(p.strictMcpConfig).toBe(false);
    },
  );

  it("--strict-mcp-config=true in place of the bare flag leaves the lock missing", () => {
    const a = auditBare([
      "--tools",
      "",
      "--strict-mcp-config=true",
      "--mcp-config",
      MCP_PATH,
      "--allowedTools",
      TOOLS,
    ]);
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.tool).sort()).toEqual([
      "--strict-mcp-config",
      "--strict-mcp-config",
    ]);
  });
});

describe("launch audit nits (#497 nits 1 and 4)", () => {
  it.each([["default"], ["manual"]])(
    "--permission-mode %s is refused (not a 2.1.332 safe mode)",
    (mode) => {
      const a = audit(["--permission-mode", mode, "--allowedTools", TOOLS]);
      expect(a.violations.map((v) => v.tool)).toEqual(["--permission-mode"]);
    },
  );

  it("effective lists no granted tool whose server the plan does not start", () => {
    const a = audit(["--allowedTools", `${TOOLS},mcp__evil__run`]);
    expect(a.ok).toBe(false);
    expect(a.effective).not.toContain("mcp__evil__run");
  });

  it("effective lists no flag-like --tools value", () => {
    const a = auditRaw(["--tools", "--allowedTools", TOOLS]);
    expect(a.ok).toBe(false);
    expect(a.effective).not.toContain("--allowedTools");
  });
});
