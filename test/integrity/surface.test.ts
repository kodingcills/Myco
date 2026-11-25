/**
 * TIF-266 — the agent tool-surface audit, and drift checks that keep its catalog in step
 * with the real MCP server and guest agent.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditToolSurface,
  MYCO_AGENT_OPS,
  MYCO_RT_MCP_TOOLS,
  type ToolClass,
} from "../../src/integrity/surface.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/** Stand-in for TIF-265's gate server until it lands (stubbed locally; see the PR). */
const GATE: Readonly<Record<string, Readonly<Record<string, ToolClass>>>> = {
  "myco-gate": { verdict: { reach: "gate", note: "TIF-265 verdict tool, takes a run id" } },
};

/** The tools a gated M2 run grants Claude Code. */
const GATED_ARM = [
  "mcp__myco-rt__create",
  "mcp__myco-rt__observe",
  "mcp__myco-rt__act",
  "mcp__myco-rt__read_file",
  "mcp__myco-rt__write_file",
  "mcp__myco-rt__launch_process",
  "mcp__myco-rt__kill_process",
  "mcp__myco-rt__relaunch_process",
  "mcp__myco-rt__reset",
  "mcp__myco-rt__destroy",
  "mcp__myco-gate__verdict",
  "TodoWrite",
];

describe("tool-surface audit", () => {
  it("passes the gated arm's tool list, with no host roots", () => {
    const audit = auditToolSurface(GATED_ARM, { extraServers: GATE });
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.hostRoots).toEqual([]);
  });

  it.each([
    "Bash",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Glob",
    "Grep",
    "Task",
    "Agent",
    "WebFetch",
    "mcp__myco-rt__evidence",
    "mcp__myco-rt__not_a_tool",
    "mcp__unknown-server__anything",
    "SomeNewBuiltin",
    "mcp__myco-gate__verdict",
  ])("rejects %s", (tool) => {
    // Without the extraServers registration, even the gate tool is unknown: fail closed.
    const audit = auditToolSurface([...GATED_ARM.filter((t) => !t.includes("gate")), tool]);
    expect(audit.ok).toBe(false);
    expect(audit.violations.map((v) => v.tool)).toEqual([tool]);
  });

  it("a host-reaching surface makes the vault impossible to place", () => {
    const audit = auditToolSurface([...GATED_ARM, "Bash"], { extraServers: GATE });
    expect(audit.hostRoots).toEqual(["/"]);
    const dir = mkdtempSync(join(tmpdir(), "myco-tif266-surface-"));
    try {
      expect(
        () =>
          new VerdictVault({
            root: join(dir, "v"),
            key: newVaultKey(),
            agentRoots: audit.hostRoots,
          }),
      ).toThrow(/reachable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("catalog drift", () => {
  it("classifies exactly the tools myco-rt-mcp serves", () => {
    const src = readFileSync(join(ROOT, "runtime/crates/myco-rt-mcp/src/main.rs"), "utf8");
    const start = src.indexOf("fn tool_defs()");
    const end = src.indexOf("\nimpl Server", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const served = [...src.slice(start, end).matchAll(/"name":\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(served.length).toBeGreaterThan(0);
    expect([...served].sort()).toEqual(Object.keys(MYCO_RT_MCP_TOOLS).sort());
  });

  it("classifies exactly the ops the Windows guest agent registers", () => {
    const src = readFileSync(join(ROOT, "agent/myco_agent/ops.py"), "utf8");
    const ops = [...src.matchAll(/@op\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(ops.length).toBeGreaterThan(0);
    expect([...ops].sort()).toEqual(Object.keys(MYCO_AGENT_OPS).sort());
  });
});
