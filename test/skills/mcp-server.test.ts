/**
 * Track M acceptance 3: retrieval through a read-only MCP tool scoped by task family,
 * separate from myco.gate/v1; retrieved skills are advice, never evidence. Also: the launch
 * audit refuses a plan granting the skills tool unless the operator classifies it (fail
 * closed), and the gate's own server is unchanged (one tool, the same three inputs).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATE_REQUEST_SCHEMA } from "../../src/gate/api.ts";
import { GATE_SERVER_CLASS } from "../../src/gate/gated-trial.ts";
import { GATE_TOOL, toolDefinitions } from "../../src/gate/mcp-server.ts";
import { auditAgentLaunch } from "../../src/integrity/launch.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { admit } from "../../src/skills/admission.ts";
import { taskFeatures } from "../../src/skills/arm.ts";
import {
  handleSkillsLine,
  SKILLS_SERVER_CLASS,
  SKILLS_SERVER_NAME,
  SKILLS_TOOL,
  serveSkillsStdio,
} from "../../src/skills/mcp-server.ts";
import { SkillStore, STORE_FILE } from "../../src/skills/store.ts";
import { candidateFrom, docWith, forbiddenFor, gatedRun, plan, NONE_TASK as T } from "./helpers.ts";

let base: string;
let store: SkillStore;
let skillId: string;
beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "myco-skills-mcp-"));
  const vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
  store = SkillStore.open(join(base, "store"));
  const run = await gatedRun(vault, base, T, "seed-0", docWith(T, T.intent.newValue));
  const added = store.add(admit(candidateFrom(T, "seed-0", run), forbiddenFor(T)));
  if (!added.stored) throw new Error(added.code);
  skillId = added.skillId;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const call = (opts: Parameters<typeof handleSkillsLine>[0], args: unknown, name = SKILLS_TOOL) =>
  JSON.parse(
    handleSkillsLine(
      opts,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    ) as string,
  );
const args = () => ({ taskFamily: T.family, features: taskFeatures(T) });

describe("myco-skills MCP server", () => {
  it("lists exactly one read-only tool, not the gate's", () => {
    const r = JSON.parse(
      handleSkillsLine(
        { store, taskFamily: T.family },
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      ) as string,
    );
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual([SKILLS_TOOL]);
    expect(r.result.tools[0].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(SKILLS_TOOL).not.toBe(GATE_TOOL);
    expect(SKILLS_SERVER_NAME).not.toBe("myco-gate");
  });

  it("serves advice labelled advisory, never evidence, with digest-only provenance", () => {
    const r = call({ store, taskFamily: T.family }, args());
    expect(r.result.isError).toBe(false);
    const body = r.result.structuredContent;
    expect(body).toMatchObject({ apiVersion: "myco.skills/v1", advisory: true, evidence: false });
    expect(body.skills.map((s: { skillId: string }) => s.skillId)).toEqual([skillId]);
    expect(Object.keys(body.skills[0].provenance).sort()).toEqual(
      ["gradeSha256", "ledgerEntrySha256", "runId", "simulated", "verdictSha256"].sort(),
    );
  });

  it("is scoped: another family is SCOPE_MISMATCH and serves nothing", () => {
    const r = call({ store, taskFamily: T.family }, { taskFamily: "todo-add" });
    expect(r.result.isError).toBe(true);
    expect(r.result.structuredContent).toMatchObject({ skills: [], codes: ["SCOPE_MISMATCH"] });
  });

  it("refuses unknown fields and malformed input with codes only", () => {
    for (const [a, code] of [
      [{ ...args(), path: "/etc/passwd" }, "UNKNOWN_FIELD"],
      [{ ...args(), expected: "x" }, "UNKNOWN_FIELD"],
      [{ taskFamily: "Bad Family" }, "INVALID_REQUEST"],
      [{ ...args(), features: ["ok", "NOT OK"] }, "INVALID_REQUEST"],
      [{ ...args(), limit: 99 }, "INVALID_REQUEST"],
      ["string", "INVALID_REQUEST"],
    ] as const) {
      const r = call({ store, taskFamily: T.family }, a);
      expect(r.result.structuredContent.codes, JSON.stringify(a)).toEqual([code]);
      expect(r.result.content[0].text).not.toContain("passwd");
    }
  });

  it("fails closed when the store did not open: STORE_UNAVAILABLE, no skills", () => {
    writeFileSync(join(base, "store", STORE_FILE), "tampered\n");
    let opened: SkillStore | null = null;
    try {
      opened = SkillStore.open(join(base, "store"));
    } catch {
      opened = null;
    }
    const r = call({ store: opened, taskFamily: T.family }, args());
    expect(r.result.structuredContent).toMatchObject({ skills: [], codes: ["STORE_UNAVAILABLE"] });
  });

  it("never serves a revoked or quarantined skill", () => {
    store.recordUse(skillId, "warm-1", "refuted");
    expect(call({ store, taskFamily: T.family }, args()).result.structuredContent.skills).toEqual(
      [],
    );
  });

  it("has no gate tool: calling myco_gate_check here is an unknown tool", () => {
    const r = call({ store, taskFamily: T.family }, { taskId: T.taskId, runId: "r" }, GATE_TOOL);
    expect(r.error).toMatchObject({ code: -32602 });
  });

  it("speaks the same JSON-RPC rules over stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c) => chunks.push(String(c)));
    const done = serveSkillsStdio({ store, taskFamily: T.family }, input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    input.write("not json\n");
    input.write('[{"jsonrpc":"2.0","id":2,"method":"ping"}]\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{"jsonrpc":"2.0","id":3,"method":"nope"}\n');
    input.end();
    await done;
    const replies = chunks
      .join("")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(replies.map((r) => r.error?.code ?? "ok")).toEqual(["ok", -32700, -32600, -32601]);
    expect(replies[0].result.serverInfo.name).toBe(SKILLS_SERVER_NAME);
    expect(replies[0].result.instructions).toMatch(/never evidence/);
  });
});

describe("the gate is unchanged and separate", () => {
  it("myco.gate/v1 still takes only apiVersion/taskId/runId/claim", () => {
    expect(Object.keys(GATE_REQUEST_SCHEMA.properties).sort()).toEqual(
      ["apiVersion", "claim", "runId", "taskId"].sort(),
    );
    expect(GATE_REQUEST_SCHEMA.additionalProperties).toBe(false);
    expect(toolDefinitions().map((t) => (t as { name: string }).name)).toEqual([GATE_TOOL]);
  });

  it("the launch audit refuses the skills tool unless the operator classifies it", () => {
    const p = plan(base);
    const granted = {
      ...p,
      argv: [
        ...p.argv.slice(0, -1),
        `mcp__myco-gate__${GATE_TOOL},mcp__${SKILLS_SERVER_NAME}__${SKILLS_TOOL}`,
      ],
      mcpServers: {
        ...p.mcpServers,
        [SKILLS_SERVER_NAME]: { command: "myco-skills", args: ["mcp"], env: {} },
      },
    };
    // As runGatedTrial audits today (gate class only): refused, fail closed.
    const refused = auditAgentLaunch(granted, { runId: "r1", extraServers: GATE_SERVER_CLASS });
    expect(refused.ok).toBe(false);
    // Every violation is the unclassified skills server or its tool; nothing else changed.
    expect(refused.violations.length).toBeGreaterThan(0);
    for (const v of refused.violations) expect(v.tool).toMatch(/^mcp__myco-skills/);
    // With the skills class, it is agent-local and passes.
    expect(
      auditAgentLaunch(granted, {
        runId: "r1",
        extraServers: { ...GATE_SERVER_CLASS, ...SKILLS_SERVER_CLASS },
      }).ok,
    ).toBe(true);
  });
});
