/**
 * The DONE gate hook for OSWorld's standard Claude runner (gap items 4 and 7 of the lead's
 * 13:55Z harness ruling). MOCK, plumbing only: a scripted fake agent, fake environment and
 * fake gate (test/benchmark/osworld_gate_hook_check.py records; every assertion is here).
 *
 * Claims proved:
 *  - the action layer and the observation path are byte-identical across the three arms;
 *    only DONE handling differs (a refused DONE becomes upstream's own WAIT);
 *  - the gate is called with taskId, runId and claim only, and only on DONE, and only in
 *    arm gate-before-done; arms no-gate and self-check bypass it by configuration;
 *  - the agent gets the verdict and reason codes only, never the gate's prose or corrections;
 *  - it fails closed on every malformed or missing reply;
 *  - with MYCO_UPSTREAM_OSWORLD set (the upstream CI job), the same holds through OSWorld's
 *    REAL loop (lib_run_single.run_single_example at the pin), and the score that loop's
 *    env.evaluate() returned is what upstream writes to result.txt and what Myco's R1 grader
 *    reads.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GATE_API_VERSION } from "../../src/gate/api.ts";
import { GATE_TOOL } from "../../src/gate/mcp-server.ts";
import { OSWORLD_HARNESS, OSWORLD_PIN } from "../../src/benchmark/upstream/pins.ts";
import { gradeR1ExampleDir, type HarnessStamp } from "../../src/benchmark/upstream/r1-grade.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const HOOK_DIR = join(ROOT, "src/gate-hooks/osworld");
const OSW = process.env.MYCO_UPSTREAM_OSWORLD ?? "";
const REQUIRED = process.env.MYCO_UPSTREAM_REQUIRED === "1";
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const work = mkdtempSync(join(tmpdir(), "myco-gate-hook-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Run = {
  arm: string;
  envActions: string[];
  agentObs: string[];
  gateRequests: Record<string, unknown>[];
  decisions: { verdict: string; accepted: boolean; reasonCodes: string[] }[];
  feedback: string[];
  suffix: string;
  evaluations: number;
  resultTxt?: string;
  resultDir?: string;
  scores?: number[];
};
type Arms = Record<"no-gate" | "gate-before-done" | "self-check", Run>;

function runChecks(): Record<string, unknown> {
  const done = spawnSync(
    "python3",
    ["-I", join(ROOT, "test/benchmark/osworld_gate_hook_check.py"), HOOK_DIR, work, OSW],
    { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
  );
  if (done.status !== 0) throw new Error(`check script failed: ${done.stderr}`);
  return JSON.parse(readFileSync(join(work, "report.json"), "utf8"));
}

const WAIT = '{"action_type": "WAIT"}'; // Python json.dumps(sort_keys=True) spacing
const isDone = (a: string) => JSON.parse(a).action_type === "DONE";

it("python3 is present where CI runs this suite (the hook tests must not skip there)", () => {
  if (process.env.CI) expect(hasPython).toBe(true);
});

describe.runIf(hasPython)("OSWorld DONE gate hook (MOCK, fakes only)", () => {
  const report = runChecks();
  const accept = report.accept as Arms;
  const refuse = report.refuse as Arms;

  it("speaks the gate's own API: tool name, version and claim limit match src/gate", () => {
    const c = report.constants as Record<string, unknown>;
    expect(c.tool).toBe(GATE_TOOL);
    expect(c.api).toBe(GATE_API_VERSION);
    expect(c.arms).toEqual(["no-gate", "gate-before-done", "self-check"]);
    expect(report.longClaimLength).toBe(c.claimLimit);
    expect(report.nonStringClaim).toEqual({ taskId: "t", runId: "r", claim: "" });
  });

  it("when the gate accepts, the action layer and observation path are byte-identical across all three arms", () => {
    const base = accept["no-gate"];
    expect(base.envActions.length).toBe(4);
    for (const arm of ["gate-before-done", "self-check"] as const) {
      expect(accept[arm].envActions).toEqual(base.envActions);
      expect(accept[arm].agentObs).toEqual(base.agentObs);
      expect(accept[arm].evaluations).toBe(1);
    }
  });

  it("calls the gate only in arm gate-before-done, only on DONE, with taskId, runId and claim only", () => {
    expect(accept["no-gate"].gateRequests).toEqual([]);
    expect(accept["self-check"].gateRequests).toEqual([]);
    const reqs = accept["gate-before-done"].gateRequests;
    expect(reqs).toHaveLength(1);
    expect(Object.keys(reqs[0] as object).sort()).toEqual(["claim", "runId", "taskId"]);
    expect(reqs[0]).toMatchObject({ taskId: "task-1", runId: "run-1" });
    expect(refuse["gate-before-done"].gateRequests).toHaveLength(2);
  });

  it("a refused DONE becomes upstream's WAIT; every other action reaches the environment exactly as the agent emitted it", () => {
    const gated = refuse["gate-before-done"].envActions;
    const plain = refuse["no-gate"].envActions;
    // Up to the first DONE the arms are identical; there the no-gate episode ends.
    const firstDone = plain.findIndex(isDone);
    expect(firstDone).toBe(2);
    expect(plain).toHaveLength(3);
    expect(gated.slice(0, firstDone)).toEqual(plain.slice(0, firstDone));
    expect(gated[firstDone]).toBe(WAIT);
    // After the refusal the agent's own actions run unchanged, and the accepted DONE ends it.
    expect(gated.slice(firstDone + 1).map((a) => JSON.parse(a).command ?? "DONE")).toEqual([
      "pyautogui.hotkey('ctrl', 's')\n",
      "DONE",
    ]);
    // The agent saw the environment's own observations, one per turn.
    expect(refuse["gate-before-done"].agentObs).toEqual(
      [0, 1, 2, 3, 4].map((i) => Buffer.from(`screen-${i}`).toString("hex")),
    );
    expect(refuse["gate-before-done"].decisions.map((d) => d.accepted)).toEqual([false, true]);
  });

  it("drops the rest of a batch after a refused DONE (upstream would have ended the episode there)", () => {
    const b = report.batchRefused as Run;
    expect(b.envActions.map((a) => JSON.parse(a).command ?? JSON.parse(a).action_type)).toEqual([
      "pyautogui.click(10, 20)\n",
      "WAIT",
      "DONE",
    ]);
  });

  it("tells the agent the verdict and reason codes only: no gate prose, no corrections", () => {
    const fb = refuse["gate-before-done"].feedback;
    expect(fb).toHaveLength(1);
    expect(fb[0]).toContain("ORACLE_FAIL, TARGET_MISMATCH");
    expect(fb[0]).toContain("verdict refuted");
    expect(fb[0]).not.toMatch(/42|Sheet1|expected|target-value|requested/);
    expect(refuse["no-gate"].feedback).toEqual([]);
    expect(refuse["self-check"].feedback).toEqual([]);
  });

  it("fails closed: unreachable gate, malformed reply, accepted without verified, verified without accepted, wrong API", () => {
    const fc = report.failClosed as Record<string, Run>;
    expect(Object.keys(fc)).toHaveLength(7);
    for (const [name, run] of Object.entries(fc)) {
      expect(run.envActions[0], name).toBe(WAIT);
      expect(run.decisions[0]?.accepted, name).toBe(false);
    }
    expect(fc.raises?.decisions[0]?.reasonCodes).toEqual(["GATE_UNAVAILABLE"]);
    expect(fc.notADict?.decisions[0]?.reasonCodes).toEqual(["GATE_REPLY_MALFORMED"]);
  });

  it("keeps the runner's step budget: refusals use turns, and an exhausted budget ends with no DONE accepted", () => {
    const b = report.budgetExhausted as Run;
    expect(b.envActions).toEqual([WAIT, WAIT, WAIT]);
    expect(b.evaluations).toBe(1);
    expect(b.decisions.every((d) => !d.accepted)).toBe(true);
  });

  it("self-check is a prompt suffix only (upstream's own system_prompt_suffix), set once even on a reused agent", () => {
    const text = (report.constants as { selfCheck: string }).selfCheck;
    expect(accept["self-check"].suffix).toBe(text);
    expect(accept["no-gate"].suffix).toBe("");
    expect(accept["gate-before-done"].suffix).toBe("");
    expect(report.selfCheckRewrapSuffix).toBe(text);
    const prereg = JSON.parse(
      readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.json"), "utf8"),
    );
    expect(prereg.arms[2].promptSuffix).toBe(text);
  });

  it("arms are chosen by configuration only; a gate cannot be attached to arms no-gate or self-check", () => {
    expect(report.config).toEqual({
      noGateWithGate: "arm no-gate takes no gate",
      selfCheckWithGate: "arm self-check takes no gate",
      gateArmWithoutGate: "arm gate-before-done needs a gate, a task id and a run id",
      unknownArm: "unknown arm: 'hcu-shell'",
      wrapGateArmWithoutCmd: "arm gate-before-done needs the gate server command",
    });
  });

  it("the stdio client sends one tools/call to myco_gate_check with this trial's ids, and fails closed when the server is missing", () => {
    const s = report.stdio as {
      argv: string[];
      reply: Record<string, unknown>;
      serverSaw: { method?: string; params?: { name?: string; arguments?: object } }[];
      unreachable: string;
    };
    expect(s.argv.slice(1)).toEqual(["--task", "task-9", "--run", "run-9"]);
    const calls = s.serverSaw.filter((m) => m.method === "tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params?.name).toBe(GATE_TOOL);
    expect(calls[0]?.params?.arguments).toEqual({ taskId: "task-9", runId: "run-9", claim: "done" });
    expect(s.reply.verdict).toBe("verified");
    expect(s.unreachable).toBe("GATE_UNAVAILABLE");
  });

  describe.runIf(Boolean(OSW) || REQUIRED)("through OSWorld's real loop at the pin", () => {
    const up = report.upstream as { accept: Arms; refuse: Arms; failScore: Run } | undefined;
    const stamp: HarnessStamp = {
      repo: OSWORLD_HARNESS.repo,
      commit: OSWORLD_PIN.commit,
      files: {
        ...OSWORLD_HARNESS.files,
        [OSWORLD_HARNESS.agentRunner]: OSWORLD_HARNESS.patchedAgentRunnerSha256,
      },
    };

    it("ran (MYCO_UPSTREAM_OSWORLD points at a checkout at the pin)", () => {
      expect(up).toBeDefined();
    });

    it("lib_run_single.run_single_example hands env.step byte-identical actions in all three arms when the gate accepts", () => {
      const a = up?.accept as Arms;
      expect(a["gate-before-done"].envActions).toEqual(a["no-gate"].envActions);
      expect(a["self-check"].envActions).toEqual(a["no-gate"].envActions);
      expect(a["self-check"].agentObs).toEqual(a["no-gate"].agentObs);
    });

    it("the real loop runs the refused DONE as WAIT and continues to the accepted DONE", () => {
      const r = up?.refuse as Arms;
      expect(r["gate-before-done"].envActions).toEqual(refuse["gate-before-done"].envActions);
      expect(r["no-gate"].envActions).toEqual(refuse["no-gate"].envActions);
    });

    it("env.evaluate() runs once after the loop; upstream writes its score to result.txt; Myco's R1 grader reads exactly that", () => {
      const pass = (up?.accept as Arms)["no-gate"];
      expect(pass.evaluations).toBe(1);
      expect(pass.scores).toEqual([1]);
      expect(pass.resultTxt).toBe("1.0\n");
      expect(gradeR1ExampleDir(pass.resultDir as string, "accept-no-gate", stamp)).toMatchObject({
        status: "pass",
        upstreamScore: 1,
        lastAction: "DONE",
      });
      const fail = up?.failScore as Run;
      expect(fail.resultTxt).toBe("0.0\n");
      expect(gradeR1ExampleDir(fail.resultDir as string, "fail-score", stamp)).toMatchObject({
        status: "fail",
        upstreamScore: 0,
      });
    });
  });
});
