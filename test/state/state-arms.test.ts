/**
 * Capability track I: the measurement arms' launch plans and their audit (no trial runs).
 *
 * - Each arm's plan passes the extended launch audit; the structured-state arm is the only
 *   one that starts `myco-state`, and it is bound to the trial.
 * - The mutations a careless or hostile harness change could make are each refused.
 * - The R1 gated harness's own audit (gate class only) refuses a plan with `myco-state`.
 * - Capability arm rows are never R1 evidence: the benchmark check refuses them.
 * - The surface classification names exactly the server's tools.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COST_BASIS, checkBenchmark } from "../../src/benchmark/check.ts";
import { GATE_SERVER_CLASS } from "../../src/gate/gated-trial.ts";
import {
  SERVER_NAME as GATE_SERVER_REAL,
  GATE_TOOL as GATE_TOOL_REAL,
} from "../../src/gate/mcp-server.ts";
import { type AgentLaunchPlan, auditAgentLaunch } from "../../src/integrity/launch.ts";
import {
  auditToolSurface,
  MCP_SERVERS,
  MYCO_STATE_ENV_KEYS,
  MYCO_STATE_MCP_TOOLS,
  STATE_SERVER_CLASS,
  stateWithheldListValid,
} from "../../src/integrity/surface.ts";
import { STATE_TOOL_NAMES, withheldListFrom } from "../../src/state/api.ts";
import {
  auditCapabilityArmLaunch,
  CAPABILITY_ARM_TOOLS,
  CAPABILITY_ARMS,
  CAPABILITY_COST_BASIS,
  type CapabilityArm,
  capabilityArmPlan,
  capabilityArmRow,
  GATE_CLASS,
  GATE_SERVER_NAME,
  GATE_TOOL,
} from "../../src/state/arms.ts";
import { STATE_ENV } from "../../src/state/cli.ts";
import { DOC_UID, linuxUnoBackend, UNO_PIPE_NAME } from "../../src/state/linux/uno.ts";
import { STATE_SERVER_NAME } from "../../src/state/server.ts";

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies are read loosely in tests
type Json = any;

const RUN = "run-cap-i-001";
const PIPE = "myco-state-0123456789abcdef-a1b2c3d4e5f6";
const CONFIG = "/srv/myco/trials/run-cap-i-001";
/** A Calc RuntimeUID, as `LiveCalc.docUid` reads it after the trial's document loaded. */
const DOC_UID_VALUE = "1";

function plan(arm: CapabilityArm): AgentLaunchPlan {
  return capabilityArmPlan({
    arm,
    runId: RUN,
    instruction: "Set record EMP-0007, column name, to REVISED and save.",
    configDir: CONFIG,
    stateServer: { command: "npx", args: ["tsx", "/opt/myco/scripts/myco-state.ts", "mcp"] },
    statePipe: PIPE,
    stateDocUid: DOC_UID_VALUE,
    withheld: ["/srv/myco/vault", CONFIG],
  });
}

function mutate(
  p: AgentLaunchPlan,
  change: (m: { argv: string[]; mcpServers: Record<string, Json> }) => void,
) {
  const m = JSON.parse(JSON.stringify(p)) as {
    argv: string[];
    mcpServers: Record<string, Json>;
    mcpConfigPath: string;
  };
  change(m);
  return m as AgentLaunchPlan;
}

function setAllowed(m: { argv: string[] }, tools: readonly string[]) {
  m.argv[m.argv.indexOf("--allowedTools") + 1] = tools.join(",");
}

describe("arm launch plans", () => {
  it.each(CAPABILITY_ARMS)("%s passes the extended launch audit", (arm) => {
    const audit = auditCapabilityArmLaunch(plan(arm), { arm, runId: RUN, trialDir: CONFIG });
    expect(audit.violations).toEqual([]);
    expect(audit.ok).toBe(true);
    expect(audit.launch.hostRoots).toEqual([]);
    expect(audit.launch.effective).toEqual([...CAPABILITY_ARM_TOOLS[arm]]);
  });

  it("only the structured-state arm starts myco-state, bound to the trial", () => {
    for (const arm of CAPABILITY_ARMS) {
      const servers = plan(arm).mcpServers;
      expect(Object.hasOwn(servers, STATE_SERVER_NAME), arm).toBe(arm === "structured-state");
    }
    const state = plan("structured-state").mcpServers[STATE_SERVER_NAME];
    expect(state?.env[STATE_ENV.runId]).toBe(RUN);
    expect(state?.env[STATE_ENV.pipe]).toBe(PIPE);
    expect(JSON.parse(state?.env[STATE_ENV.withheld] ?? "[]")).toContain(CONFIG);
  });

  it("the arms share the acting surface and differ only in the added channel", () => {
    const base = new Set(CAPABILITY_ARM_TOOLS["screenshot-only"]);
    for (const arm of CAPABILITY_ARMS)
      for (const t of base) expect(CAPABILITY_ARM_TOOLS[arm]).toContain(t);
    expect(CAPABILITY_ARM_TOOLS["structured-state"].filter((t) => !base.has(t))).toEqual(
      STATE_TOOL_NAMES.map((t) => `mcp__myco-state__${t}`),
    );
  });

  it("refuses a structured-state plan with no live session to bind to", () => {
    expect(() =>
      capabilityArmPlan({
        arm: "structured-state",
        runId: RUN,
        instruction: "x",
        configDir: CONFIG,
      }),
    ).toThrow(/pipe/);
  });
});

describe("the audit refuses each mutation (mutation table)", () => {
  const ss = "structured-state" as const;
  const cases: Array<
    [string, CapabilityArm, (m: { argv: string[]; mcpServers: Record<string, Json> }) => void]
  > = [
    [
      "state tool granted to screenshot-only",
      "screenshot-only",
      (m) =>
        setAllowed(m, [
          ...CAPABILITY_ARM_TOOLS["screenshot-only"],
          "mcp__myco-state__state_read_range",
        ]),
    ],
    [
      "myco-state server added to hcu+shell",
      "hcu+shell",
      (m) => {
        m.mcpServers[STATE_SERVER_NAME] = plan(ss).mcpServers[STATE_SERVER_NAME];
      },
    ],
    [
      "a state tool dropped (allowlist not exact)",
      ss,
      (m) => setAllowed(m, CAPABILITY_ARM_TOOLS[ss].slice(0, -1)),
    ],
    ["host Read granted", ss, (m) => setAllowed(m, [...CAPABILITY_ARM_TOOLS[ss], "Read"])],
    [
      "--strict-mcp-config removed",
      ss,
      (m) => {
        m.argv.splice(m.argv.indexOf("--strict-mcp-config"), 1);
      },
    ],
    [
      "--tools removed (default built-ins)",
      ss,
      (m) => {
        m.argv.splice(m.argv.indexOf("--tools"), 2);
      },
    ],
    [
      "state server unpinned (run id missing)",
      ss,
      (m) => {
        delete m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_RUN_ID;
      },
    ],
    [
      "state server pinned to another trial",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_RUN_ID = "run-other";
      },
    ],
    [
      "pipe that is a path",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_UNO_PIPE = "/tmp/sock";
      },
    ],
    [
      "extra env key (a secret file path)",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].env.MYCO_SECRETS_FILE = "/x";
      },
    ],
    [
      "server args carry a flag",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].args.push("--doc");
      },
    ],
    [
      "server args carry a flag before mcp (--inspect)",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].args = ["--inspect", "mcp"];
      },
    ],
    [
      "server args carry a flag mid-way (tsx --inspect x.ts mcp)",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].args = ["tsx", "--inspect", "/opt/x.ts", "mcp"];
      },
    ],
    [
      "document uid missing (PR #545 round 2, D7)",
      ss,
      (m) => {
        delete m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_DOC_UID;
      },
    ],
    [
      "document uid that is a path",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_DOC_UID =
          "/srv/myco/runs/run-other/agent/saved.csv";
      },
    ],
    [
      "withheld list missing",
      ss,
      (m) => {
        delete m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_WITHHELD;
      },
    ],
    [
      "withheld list empty",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_WITHHELD = "[]";
      },
    ],
    [
      "withheld list of non-paths",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_WITHHELD = JSON.stringify(["runs"]);
      },
    ],
    [
      "server args do not end in mcp",
      ss,
      (m) => {
        m.mcpServers[STATE_SERVER_NAME].args = ["tsx", "x.ts"];
      },
    ],
    [
      "inline MCP config",
      ss,
      (m) => {
        m.argv[m.argv.indexOf("--mcp-config") + 1] = "{}";
      },
    ],
    [
      "permission mode widened",
      ss,
      (m) => {
        m.argv[m.argv.indexOf("--permission-mode") + 1] = "bypassPermissions";
      },
    ],
  ];
  it.each(cases)("%s", (_name, arm, change) => {
    const audit = auditCapabilityArmLaunch(mutate(plan(arm), change), {
      arm,
      runId: RUN,
      trialDir: CONFIG,
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.length).toBeGreaterThan(0);
  });

  // Each binding rule refuses on its own (not only via another rule that also fires).
  const binding: Array<
    [string, (env: Record<string, string>, args: string[]) => string[], RegExp]
  > = [
    ["a flag before mcp", (_e, a) => ["--inspect", ...a], /no flags/],
    ["a flag mid-way", (_e, a) => [a[0] ?? "", "--inspect", ...a.slice(1)], /no flags/],
    [
      "no withheld list",
      (e, a) => {
        delete e.MYCO_STATE_WITHHELD;
        return a;
      },
      /MYCO_STATE_WITHHELD/,
    ],
    [
      "an empty withheld list",
      (e, a) => {
        e.MYCO_STATE_WITHHELD = "[]";
        return a;
      },
      /MYCO_STATE_WITHHELD/,
    ],
    // PR #545 round 2 (D7): the server is bound to the trial's document, not just its soffice.
    ...(["", "0", "01", "1\n", "12345678901", "7a", "file:///x.xlsx"].map((uid) => [
      `a document uid of ${JSON.stringify(uid)}`,
      (e: Record<string, string>, a: string[]) => {
        e.MYCO_STATE_DOC_UID = uid;
        return a;
      },
      /MYCO_STATE_DOC_UID/,
    ]) as Array<[string, (env: Record<string, string>, args: string[]) => string[], RegExp]>),
    [
      "no document uid",
      (e, a) => {
        delete e.MYCO_STATE_DOC_UID;
        return a;
      },
      /MYCO_STATE_DOC_UID/,
    ],
  ];
  it.each(binding)("the state binding names the rule for %s", (_name, change, detail) => {
    const p = mutate(plan(ss), (m) => {
      const server = m.mcpServers[STATE_SERVER_NAME];
      server.args = change(server.env, server.args);
    });
    const audit = auditCapabilityArmLaunch(p, { arm: ss, runId: RUN, trialDir: CONFIG });
    expect(audit.ok).toBe(false);
    // The launch audit's binding rule alone (the arm audit's coverage rule, tested below,
    // also fires when the list is missing or empty).
    expect(audit.launch.violations.map((v) => v.detail)).toEqual([expect.stringMatching(detail)]);
  });

  it("the plan builder refuses a structured-state plan with no document uid (D7)", () => {
    for (const stateDocUid of [undefined, ""])
      expect(() =>
        capabilityArmPlan({
          arm: ss,
          runId: RUN,
          instruction: "x",
          configDir: CONFIG,
          stateServer: { command: "npx", args: ["tsx", "/opt/x.ts", "mcp"] },
          statePipe: PIPE,
          stateDocUid,
          withheld: [CONFIG],
        }),
      ).toThrow(/document uid/);
  });

  it("the plan binds the server to the trial's document uid", () => {
    expect(plan(ss).mcpServers[STATE_SERVER_NAME]?.env?.MYCO_STATE_DOC_UID).toBe(DOC_UID_VALUE);
  });

  it("the plan builder refuses a structured-state plan with no withheld paths", () => {
    for (const withheld of [undefined, []])
      expect(() =>
        capabilityArmPlan({
          arm: ss,
          runId: RUN,
          instruction: "x",
          configDir: CONFIG,
          stateServer: { command: "npx", args: ["tsx", "/opt/x.ts", "mcp"] },
          statePipe: PIPE,
          stateDocUid: DOC_UID_VALUE,
          withheld,
        }),
      ).toThrow(/withheld/);
  });
});

describe("the audit and the server read the withheld list by one rule", () => {
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ["", false],
    ["{not json", false],
    ["{}", false],
    ["[]", false],
    ['"/srv/x"', false],
    ['["runs"]', false],
    ['["/ab"]', false],
    ['["/srv/x\n"]', false],
    ["[1]", false],
    [JSON.stringify(Array.from({ length: 65 }, (_, i) => `/srv/t${i}`)), false],
    ['["/srv/x"]', true],
    [JSON.stringify(["C:\\trials\\run-1", "D:/vault"]), true],
    [JSON.stringify(["\\\\srv\\share"]), true],
    [JSON.stringify(Array.from({ length: 64 }, (_, i) => `/srv/t${i}`)), true],
  ];
  it.each(cases)("%s -> %s", (raw, valid) => {
    expect(stateWithheldListValid(raw)).toBe(valid);
    expect(withheldListFrom(raw) !== null).toBe(valid);
  });
});

describe("myco-state stays out of the R1 gated harness", () => {
  it("is not a default MCP server", () => {
    expect(Object.hasOwn(MCP_SERVERS, STATE_SERVER_NAME)).toBe(false);
    expect(auditToolSurface(["mcp__myco-state__state_read_range"]).ok).toBe(false);
  });

  it("the gated harness's audit (gate class only, as runGatedTrial calls it) refuses the structured-state plan", () => {
    const audit = auditAgentLaunch(plan("structured-state"), {
      runId: RUN,
      extraServers: GATE_SERVER_CLASS,
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.map((v) => v.detail).join("\n")).toMatch(/unclassified MCP server/);
  });

  it("the gated harness's audit still accepts the screenshot-only plan unchanged", () => {
    expect(
      auditAgentLaunch(plan("screenshot-only"), { runId: RUN, extraServers: GATE_SERVER_CLASS }).ok,
    ).toBe(true);
  });
});

describe("surface classification matches the server", () => {
  it("spells the gate's server, tool and class exactly as src/gate/ does", () => {
    expect(GATE_SERVER_NAME).toBe(GATE_SERVER_REAL);
    expect(GATE_TOOL).toBe(GATE_TOOL_REAL);
    expect(GATE_CLASS).toEqual(GATE_SERVER_CLASS);
  });

  it("names exactly the server's tools, all app-state reach", () => {
    expect(Object.keys(MYCO_STATE_MCP_TOOLS).sort()).toEqual([...STATE_TOOL_NAMES].sort());
    for (const cls of Object.values(MYCO_STATE_MCP_TOOLS)) expect(cls.reach).toBe("app-state");
    expect(Object.keys(STATE_SERVER_CLASS)).toEqual([STATE_SERVER_NAME]);
  });

  it("the audit and the server accept the same document uids (D7)", () => {
    for (const uid of [
      "1",
      "7",
      "42",
      "1234567890",
      "",
      "0",
      "01",
      "1\n",
      "12345678901",
      "-1",
      "1.0",
    ]) {
      const audit = auditCapabilityArmLaunch(
        mutate(plan("structured-state"), (m) => {
          m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_DOC_UID = uid;
        }),
        { arm: "structured-state", runId: RUN, trialDir: CONFIG },
      );
      expect(audit.ok, JSON.stringify(uid)).toBe(DOC_UID.test(uid));
      const build = () => linuxUnoBackend({ pipe: PIPE, docUid: uid });
      if (DOC_UID.test(uid)) expect(build).not.toThrow();
      else expect(build, JSON.stringify(uid)).toThrow(/document uid/);
    }
  });

  it("names the same env keys and pipe shape as the server", () => {
    for (const key of Object.values(STATE_ENV)) expect(MYCO_STATE_ENV_KEYS).toContain(key);
    expect(UNO_PIPE_NAME.test(PIPE)).toBe(true);
    // The launch audit's pipe regex must agree with the server's (mutation above relies on it).
    const audit = auditCapabilityArmLaunch(
      mutate(plan("structured-state"), (m) => {
        m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_UNO_PIPE = "myco-state-short";
      }),
      { arm: "structured-state", runId: RUN, trialDir: CONFIG },
    );
    expect(UNO_PIPE_NAME.test("myco-state-short")).toBe(false);
    expect(audit.ok).toBe(false);
  });

  it("the config path is the plan's own", () => {
    expect(plan("structured-state").mcpConfigPath).toBe(join(CONFIG, "mcp.json"));
  });
});

describe("capability arm rows are never R1 evidence", () => {
  const rows = CAPABILITY_ARMS.map((arm, i) =>
    capabilityArmRow({
      arm,
      simulated: true,
      taskId: "fc-v1-t001",
      trialKey: `cap-${i}`,
      runId: `run-${i}`,
      plannerModelId: "simulated:scripted",
      gateVerdict: "verified",
      grade: "pass",
      steps: 4,
      stateToolCalls: arm === "structured-state" ? 2 : 0,
      estimatedModelUsd: null,
    }),
  );

  it("are labelled capability measurements with r1Evidence false", () => {
    for (const r of rows) {
      expect(r).toMatchObject({
        schema: "myco.capability.arm-row/1",
        evidenceClass: "capability-measurement",
        r1Evidence: false,
        capabilityTrack: "I",
      });
      expect(r.cost.estimatedModelUsd).toBeNull();
    }
    expect(CAPABILITY_COST_BASIS).toBe(COST_BASIS);
  });

  it("the benchmark check refuses them, even as plumbing", () => {
    const result = checkBenchmark(rows, [], { expectTrials: {} as never, evidence: true });
    expect(result.ok).toBe(false);
    // The schema itself refuses every row (an empty grade ledger alone would also fail).
    rows.forEach((_r, i) => {
      expect(result.errors).toContain(
        `arm row ${i}: $.schema expected const "myco.benchmark.arm-row/1", got "myco.capability.arm-row/1"`,
      );
      expect(result.errors).toContain(`arm row ${i}: $ unexpected property "r1Evidence"`);
    });
    expect(result.provenance === "evidence").toBe(false);
  });
});

describe("the withheld list must cover this trial's dir (round-2 verifier nit)", () => {
  const ss = "structured-state" as const;
  const withList = (list: unknown) =>
    mutate(plan(ss), (m) => {
      m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_WITHHELD = JSON.stringify(list);
    });
  const audit = (p: AgentLaunchPlan, trialDir: string) =>
    auditCapabilityArmLaunch(p, { arm: ss, runId: RUN, trialDir });
  const rule = "the withheld list does not cover this trial's dir";

  it("the trial dir itself, or an ancestor of it, covers it", () => {
    expect(audit(withList([CONFIG]), CONFIG).violations).toEqual([]);
    expect(audit(withList(["/srv/myco/trials/"]), CONFIG).violations).toEqual([]);
    expect(audit(withList(["/srv/myco/vault", CONFIG]), `${CONFIG}/`).violations).toEqual([]);
  });

  it.each([
    ["a well-formed list naming only other paths", ["/nope"], CONFIG],
    ["a sibling whose name is a prefix", ["/srv/myco/trials/run-cap-i-00"], CONFIG],
    ["a child of the trial dir only", [`${CONFIG}/agent`], CONFIG],
    ["a relative trial dir", [CONFIG], "srv/myco/trials/run-cap-i-001"],
    ["a non-normalized trial dir", [CONFIG], "/srv/myco/trials/x/../run-cap-i-001"],
  ])("%s: refused by exactly this rule", (_name, list, trialDir) => {
    const details = audit(withList(list), trialDir).violations.map((v) => v.detail);
    expect(details).toEqual([rule]);
  });

  it("a plan without myco-state's withheld env is refused by this rule too", () => {
    const p = mutate(plan(ss), (m) => {
      delete m.mcpServers[STATE_SERVER_NAME].env.MYCO_STATE_WITHHELD;
    });
    expect(audit(p, CONFIG).violations.map((v) => v.detail)).toContain(rule);
  });

  it("other arms do not carry the rule", () => {
    expect(
      auditCapabilityArmLaunch(plan("screenshot-only"), {
        arm: "screenshot-only",
        runId: RUN,
        trialDir: CONFIG,
      }).violations,
    ).toEqual([]);
  });
});
