/**
 * Track E: the reviewed pilot config. The committed file is the one the runner uses, it
 * cannot drift from the code, every trial's launch passes the existing launch audit, and the
 * agent gets the myco-gate MCP server plus the separate myco-hcu actuator (#732).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_SERVER_CLASS } from "../../src/gate/gated-trial.ts";
import { auditAgentLaunch, parseAgentArgv } from "../../src/integrity/launch.ts";
import { abPlanSha256, loadPrereg } from "../../src/pilot/ab.ts";
import {
  ACTUATOR_GRANTS,
  backoffS,
  checkPacing,
  configSha256,
  DEFAULT_PACING,
  GATE_GRANT,
  PILOT_STRATA,
  selectPilotTasks,
} from "../../src/pilot/config.ts";
import { trialLaunchPlan } from "../../src/pilot/launch.ts";
import { loadReviewedConfig, REVIEWED_CONFIG } from "../../src/pilot/reviewed.ts";
import { config, PUBLISHED, ROOT, tmp } from "./helpers.ts";

describe("pilot config (track E)", () => {
  it("the committed config is exactly the reviewed code's config", () => {
    const loaded = loadReviewedConfig(ROOT, PUBLISHED);
    expect(loaded).toEqual(config());
    expect(JSON.parse(readFileSync(join(ROOT, REVIEWED_CONFIG), "utf8"))).toEqual(config());
  });

  it("refuses a committed config whose launch surface drifted (only pacing may differ)", () => {
    const committed = JSON.parse(readFileSync(join(ROOT, REVIEWED_CONFIG), "utf8"));
    const dir = tmp();
    const widened = {
      ...committed,
      argvTemplate: [...committed.argvTemplate, "--allowedTools", "Bash"],
    };
    writeFileSync(join(dir, "c.json"), JSON.stringify(widened));
    expect(() => loadReviewedConfig(ROOT, PUBLISHED, {}, join(dir, "c.json"))).toThrow(/drifted/);
    const extraServer = {
      ...committed,
      childEnvAllowlist: [...committed.childEnvAllowlist, "ANTHROPIC_API_KEY"],
    };
    writeFileSync(join(dir, "d.json"), JSON.stringify(extraServer));
    expect(() => loadReviewedConfig(ROOT, PUBLISHED, {}, join(dir, "d.json"))).toThrow(/drifted/);
    const slower = { ...committed, pacing: { ...committed.pacing, interTrialDelayS: 300 } };
    writeFileSync(join(dir, "e.json"), JSON.stringify(slower));
    expect(
      loadReviewedConfig(ROOT, PUBLISHED, {}, join(dir, "e.json")).pacing.interTrialDelayS,
    ).toBe(300);
  });

  it("selects 30 trials in fc-v1's proportions, 3 of them unregistrable", () => {
    const tasks = selectPilotTasks(PUBLISHED);
    expect(tasks).toHaveLength(30);
    for (const [cls, n] of Object.entries(PILOT_STRATA))
      expect(
        tasks.filter((t) => t.faultClass === cls),
        cls,
      ).toHaveLength(n);
    expect(tasks.filter((t) => !t.satisfiable)).toHaveLength(3);
    expect(new Set(tasks.map((t) => t.taskId)).size).toBe(30);
  });

  it("every trial's launch passes the launch audit, with the actuator's action tools and the gate tool (#732)", () => {
    const c = config();
    for (const task of selectPilotTasks(PUBLISHED)) {
      const runId = `r1p-${task.taskId}-a1`;
      const plan = trialLaunchPlan(
        c,
        task,
        { runId, trialKey: runId },
        `/tmp/pilot/${runId}`,
        ROOT,
      );
      const audit = auditAgentLaunch(plan, { runId, extraServers: GATE_SERVER_CLASS });
      expect(audit.ok, JSON.stringify(audit.violations)).toBe(true);
      expect(Object.keys(plan.mcpServers)).toEqual(["myco-gate", "myco-hcu"]);
      expect(audit.granted).toEqual([...ACTUATOR_GRANTS, GATE_GRANT]);
      expect(audit.effective).toEqual([...ACTUATOR_GRANTS, GATE_GRANT]);
      const parsed = parseAgentArgv(plan.argv);
      expect(parsed.strictMcpConfig).toBe(true);
      expect(parsed.builtins).toEqual([]);
      expect(parsed.mcpConfigs).toEqual([plan.mcpConfigPath]);
      // The prompt is the task's exact instruction (R2 parity), and settings files are off.
      expect(plan.argv[plan.argv.indexOf("-p") + 1]).toBe(task.instruction);
      expect(plan.argv[plan.argv.indexOf("--setting-sources") + 1]).toBe("");
      // The gate server is bound to this trial's one task and run.
      const args = plan.mcpServers["myco-gate"]?.args ?? [];
      expect(args[args.indexOf("--task") + 1]).toBe(task.taskId);
      expect(args[args.indexOf("--run") + 1]).toBe(runId);
      expect(args).toContain("--no-builtin");
      expect(plan.mcpServers["myco-gate"]?.env).toEqual({});
    }
  });

  it("documents and validates the pacing defaults", () => {
    expect(DEFAULT_PACING).toMatchObject({ concurrency: 1, interTrialDelayS: 90 });
    expect(() => checkPacing({ ...DEFAULT_PACING, concurrency: 0 })).toThrow(/concurrency/);
    expect(() => checkPacing({ ...DEFAULT_PACING, concurrency: 4 })).toThrow(/concurrency/);
    expect(() => checkPacing({ ...DEFAULT_PACING, interTrialDelayS: -1 })).toThrow();
    expect(() => checkPacing({ ...DEFAULT_PACING, rateLimitBackoffMaxS: 10 })).toThrow();
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffS(DEFAULT_PACING, n))).toEqual([
      300, 600, 1200, 2400, 3600, 3600,
    ]);
  });

  it("#732: the new plan hashes (R1 and A/B stage 0) are the ones the runbook states", () => {
    const r1 = configSha256(config());
    const ab0 = abPlanSha256(loadPrereg(ROOT), 0, PUBLISHED);
    expect(r1).toBe("2127d5b11ad0f1aa72ae2b9b18373f85a7ef46442f46d4721e182b615343c5fc");
    expect(ab0).toBe("251b7a9f146f7f77b4cbffa125e702004717354831ff2b191983d740902454cb");
    const runbook = readFileSync(join(ROOT, "docs/benchmark/pilot-runbook.md"), "utf8");
    expect(runbook).toContain(`configSha256 ${r1}`);
    expect(runbook).toContain(`planSha256 is now ${ab0}`);
  });

  it("#733 N1/N5: the runbook records the loop-policy asymmetries under the 14:23Z ruling, with #742 and #743", () => {
    const runbook = readFileSync(join(ROOT, "docs/benchmark/pilot-runbook.md"), "utf8");
    const start = runbook.indexOf("**Recorded loop-policy asymmetries with `hcu+shell`");
    expect(start).toBeGreaterThan(-1);
    const section = runbook.slice(start, runbook.indexOf("**The gate: `myco-gate`**", start));
    expect(section).toContain("lead ruling 2026-11-27T14:23Z");
    expect(section).toContain("#742");
    for (const item of [
      "`routing-refused`",
      "Malformed actions",
      "Screenshots",
      "Gate calls",
      "The HCU command",
    ])
      expect(section).toContain(item);
    expect(runbook).toMatch(/Mid-trial HCU loss[\s\S]{0,200}#743/);
  });

  it("the config hash changes with pacing (a pacing override is a new run, never a resume)", () => {
    expect(configSha256(config())).toBe(configSha256(config()));
    expect(configSha256(config({ concurrency: 2 }))).not.toBe(configSha256(config()));
  });
});
