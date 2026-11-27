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
 *  - N3 (lead ruling 15:26Z): arm self-check re-checks the end state on DONE with the pinned
 *    probe through the controller's run_bash_script only, and a found problem (or a probe that
 *    cannot run) turns DONE into WAIT plus a fixed codes-only message exactly where the gate
 *    arm's refusal does, on the same step budget and the same per-check time allowance; it
 *    never touches the environment, the evaluator, gold files or the score file (host audit
 *    hook and tripwires at runtime; the probe text statically);
 *  - with MYCO_UPSTREAM_OSWORLD set (the upstream CI job), the same holds through OSWorld's
 *    REAL loop (lib_run_single.run_single_example at the pin), and the score that loop's
 *    env.evaluate() returned is what upstream writes to result.txt and what Myco's R1 grader
 *    reads.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { gradeR1ExampleDir, type HarnessStamp } from "../../src/benchmark/upstream/r1-grade.ts";
import { GATE_API_VERSION } from "../../src/gate/api.ts";
import { GATE_TOOL } from "../../src/gate/mcp-server.ts";
import { pinnedStamp } from "./upstream-fixture.ts";

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
  decisions: { verdict?: string; selfCheck?: string; accepted: boolean; reasonCodes: string[] }[];
  feedback: string[];
  suffix: string;
  evaluations: number;
  agentPredicts: number;
  agentMaxSteps: number;
  probe: { scripts: string[]; timeouts: number[] };
  tripwires: { hostEvents: string[]; touched: string[] };
  resultTxt?: string;
  resultDir?: string;
  scores?: number[];
};
type Arms = Record<"no-gate" | "gate-before-done" | "self-check", Run>;
/** The self-check probe runs for real only on Linux (GNU find, bash 5, as in the guest). */
const LINUX = process.platform === "linux";

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

  it("runs the self-check scenarios wherever CI runs Linux (they must not skip there)", () => {
    expect((report.constants as { linux: boolean }).linux).toBe(LINUX);
    if (LINUX) expect(Object.keys(accept)).toEqual(["no-gate", "gate-before-done", "self-check"]);
  });

  it("when the gate accepts and the self-check finds no problem, the action layer and observation path are byte-identical across all three arms", () => {
    const base = accept["no-gate"];
    expect(base.envActions.length).toBe(4);
    for (const arm of LINUX
      ? (["gate-before-done", "self-check"] as const)
      : (["gate-before-done"] as const)) {
      expect(accept[arm].envActions).toEqual(base.envActions);
      expect(accept[arm].agentObs).toEqual(base.agentObs);
      expect(accept[arm].evaluations).toBe(1);
    }
  });

  it("calls the gate only in arm gate-before-done, only on DONE, with taskId, runId and claim only", () => {
    expect(accept["no-gate"].gateRequests).toEqual([]);
    if (LINUX) expect(accept["self-check"].gateRequests).toEqual([]);
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

  it("no arm changes the prompt: the prompt-suffix self-check is gone (N3 ruling), every arm runs upstream's prompt", () => {
    const c = report.constants as { hasSuffix: boolean };
    expect(c.hasSuffix).toBe(false);
    for (const arm of Object.keys(accept) as (keyof Arms)[])
      expect(accept[arm].suffix, arm).toBe("");
    const prereg = JSON.parse(
      readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.json"), "utf8"),
    );
    for (const a of prereg.arms) expect(a.promptSuffix, a.id).toBeNull();
  });

  it("arms are chosen by configuration only: a gate only for gate-before-done, the controller only for self-check", () => {
    expect(report.config).toEqual({
      noGateWithGate: "arm no-gate takes no gate",
      selfCheckWithGate: "arm self-check takes no gate",
      gateArmWithoutGate: "arm gate-before-done needs a gate, a task id and a run id",
      unknownArm: "unknown arm: 'hcu-shell'",
      wrapGateArmWithoutCmd: "arm gate-before-done needs the gate server command",
      selfCheckWithoutController: "arm self-check needs the controller",
      noGateWithController: "arm no-gate takes no controller",
      gateArmWithController: "arm gate-before-done takes no controller",
    });
    // The runner patch hands every arm the same getter; wrap_agent keeps it for self-check only.
    expect(report.wrapController).toEqual({
      "no-gate": false,
      "gate-before-done": false,
      "self-check": true,
    });
  });

  it("the runner patch hands wrap_agent a controller getter and nothing else of the environment (never the task config)", () => {
    const patch = readFileSync(join(HOOK_DIR, "run_multienv_claude.gate.patch"), "utf8");
    const call = patch.slice(patch.indexOf("+                        myco_wrap_agent("));
    const added = call
      .split("\n")
      .filter((l) => l.startsWith("+"))
      .join("\n");
    expect(added).toContain("controller=lambda: env.controller),");
    expect(added).not.toMatch(
      /\bexample\b(?!_id)|task_config|evaluate|cache_dir|\benv\b(?!\.controller)/,
    );
  });

  describe.runIf(LINUX)(
    "N3: the self-check arm (lead ruling 15:26Z), the stronger honest baseline",
    () => {
      const c = report.constants as {
        probe: string;
        probeSha256: string;
        selfCheckCodes: string[];
        checkTimeout: number;
        gateClientTimeout: number;
        controllerMargin: number;
        selfCheckFeedback: string;
      };
      const cases = (report.selfCheck ?? {}) as Record<string, Run>;
      const prereg = JSON.parse(
        readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.json"), "utf8"),
      );
      const allSelfCheckRuns = (): [string, Run][] => [
        ...Object.entries(cases),
        ["accept", accept["self-check"]],
        ["refuse", refuse["self-check"]],
        ["budget", report.selfCheckBudget as Run],
        ["batch", report.selfCheckBatch as Run],
      ];
      const actionsOf = (r: Run) =>
        r.envActions.map((a) => JSON.parse(a).command ?? JSON.parse(a).action_type);

      it("a found problem turns DONE into upstream's WAIT exactly where the gate arm's refusal does, then the agent's own actions run and the next clean DONE ends it", () => {
        const s = refuse["self-check"];
        expect(s.envActions).toEqual(refuse["gate-before-done"].envActions);
        expect(s.agentObs).toEqual(refuse["gate-before-done"].agentObs);
        expect(s.decisions).toEqual([
          {
            selfCheck: "problem",
            accepted: false,
            reasonCodes: ["SAVED_FILE_MISSING", "NOTHING_SAVED"],
          },
          { selfCheck: "ok", accepted: true, reasonCodes: [] },
        ]);
        expect(s.gateRequests).toEqual([]);
        expect(s.evaluations).toBe(1);
        expect(accept["self-check"].decisions).toEqual([
          { selfCheck: "ok", accepted: true, reasonCodes: [] },
        ]);
        // Batches: the rest of a batch after a refused DONE is dropped, as in the gate arm.
        expect(actionsOf(report.selfCheckBatch as Run)).toEqual([
          "pyautogui.click(10, 20)\n",
          "WAIT",
          "pyautogui.hotkey('ctrl', 's')\n",
          "DONE",
        ]);
      });

      it("the continue message is fixed and oracle-free: the probe's codes and nothing else", () => {
        expect(c.selfCheckFeedback).toBe(
          "Self-check: your DONE was not accepted. A re-check of the saved files in your home directory found a problem (codes CODE_A, CODE_B). Continue working; when you believe the task is done, finish again.",
        );
        expect(refuse["self-check"].feedback).toEqual([
          c.selfCheckFeedback.replace("CODE_A, CODE_B", "SAVED_FILE_MISSING, NOTHING_SAVED"),
        ]);
      });

      it("the probe's pre-registered rules, run for real under bash against prepared guest homes", () => {
        const codes = Object.fromEntries(
          Object.entries(cases).map(([k, r]) => [k, r.decisions[0]?.reasonCodes]),
        );
        expect(codes).toEqual({
          ok: [],
          missing: ["SAVED_FILE_MISSING", "NOTHING_SAVED"],
          formatBad: ["SAVED_FILE_FORMAT_MISMATCH"],
          notSaved: ["NOTHING_SAVED"],
          hiddenIgnored: ["SAVED_FILE_MISSING", "NOTHING_SAVED"],
          tooDeep: ["SAVED_FILE_MISSING", "NOTHING_SAVED"],
          odsOk: [],
          // Documented limit: the probe checks the container type, not the ODF mimetype value.
          odtAsOds: [],
          docxAsText: ["SAVED_FILE_FORMAT_MISMATCH"],
          pdfOk: [],
          pdfBad: ["SAVED_FILE_FORMAT_MISMATCH"],
          csvOk: [],
          "unavailable-raises": ["RECHECK_UNAVAILABLE"],
          "unavailable-none": ["RECHECK_UNAVAILABLE"],
          "unavailable-exit1": ["RECHECK_UNAVAILABLE"],
          "unavailable-noEnd": ["RECHECK_UNAVAILABLE"],
        });
        for (const [k, r] of Object.entries(cases)) {
          const passed = r.decisions[0]?.accepted === true;
          expect(actionsOf(r)[0], k).toBe(passed ? "DONE" : "WAIT");
        }
        expect(c.selfCheckCodes).toEqual(prereg.arms[2].selfCheck.codes);
      });

      it("fails closed: a controller that raises, returns nothing, exits non-zero or cuts the output short never lets DONE through", () => {
        for (const mode of ["raises", "none", "exit1", "noEnd"]) {
          const r = cases[`unavailable-${mode}`] as Run;
          expect(r.envActions[0], mode).toBe(WAIT);
          expect(
            r.decisions.every((d) => !d.accepted),
            mode,
          ).toBe(true);
        }
      });

      it("budget parity: a refused DONE uses its turn, the check costs no extra model turn, the agent's step budget is untouched, and one check gets the gate's time allowance", () => {
        const sb = report.selfCheckBudget as Run;
        const gb = report.budgetExhausted as Run;
        expect(sb.envActions).toEqual([WAIT, WAIT, WAIT]);
        expect(sb.envActions).toEqual(gb.envActions);
        expect(sb.agentPredicts).toBe(3);
        expect(sb.evaluations).toBe(1);
        // One model turn per runner step in every run: the probe never asks the model. The cases
        // are one action per turn; the scripted scenarios have 3 or 5 turns.
        const turns: Record<string, number> = { accept: 3, refuse: 5, budget: 3, batch: 3 };
        for (const [name, r] of allSelfCheckRuns()) {
          expect(r.agentPredicts, name).toBe(turns[name] ?? r.envActions.length);
          expect(r.agentMaxSteps, name).toBe(10);
          for (const t of r.probe.timeouts)
            expect(t + c.controllerMargin, name).toBe(c.checkTimeout);
        }
        expect(c.gateClientTimeout).toBe(c.checkTimeout);
      });

      it("what reaches the controller is the pinned probe, with only the elapsed seconds and the instruction's file names filled in", () => {
        const normal = (s: string) =>
          s
            .replace(/^elapsed=\d+$/m, "elapsed=__ELAPSED__")
            .replace(/^names=\(.*\)$/m, "names=(__NAMES__)");
        const sent = allSelfCheckRuns().flatMap(([, r]) => r.probe.scripts);
        expect(sent.length).toBeGreaterThan(20);
        for (const s of sent) expect(normal(s)).toBe(c.probe);
        expect(createHash("sha256").update(c.probe).digest("hex")).toBe(c.probeSha256);
        expect(prereg.arms[2].selfCheck.probeSha256).toBe(c.probeSha256);
        expect(refuse["self-check"].probe.scripts[0]).toMatch(/^names=\(report\.xlsx\)$/m);
        const slow = report.selfCheckSlowClock as { scripts: string[] };
        expect(slow.scripts[0]).toMatch(/^elapsed=3601$/m);
      });

      it("the probe reads only the guest home directory: no absolute path, no parent hop, no hidden directory, nothing that names ground truth", () => {
        const body = c.probe.replace(/^#!\/bin\/bash\n/, "").replaceAll("2>/dev/null", "");
        expect(body).not.toMatch(/(^|[\s"'=(<])\//m);
        expect(body).not.toMatch(/\.\.\//);
        expect(body).not.toMatch(
          /result|gold|cache|evaluation_examples|desktop_env|cloud|expected|oracle|fixture|myco|score|\/tmp|curl|wget|https?:/i,
        );
        expect(body).toMatch(/root="\$\{HOME:\?\}"/);
        const finds = [...body.matchAll(/find (\S+)/g)].map((m) => m[1]);
        expect(finds).toEqual(['"$root"', '"$root"']);
        expect(body.match(/-not -path '\*\/\.\*'/g)).toHaveLength(2);
      });

      it("never touches the environment, the evaluator, gold files or the score file: no host read, launch or connect, no env or controller attribute but run_bash_script", () => {
        const ground = report.ground as { gold: string; score: string };
        for (const [name, r] of allSelfCheckRuns()) {
          expect(r.tripwires, name).toEqual({ hostEvents: [], touched: [] });
          for (const s of r.probe.scripts) {
            expect(s, name).not.toContain(ground.gold);
            expect(s, name).not.toContain(ground.score);
          }
        }
        // The tripwires bite: planted reads of the gold and score files and a planted evaluator
        // call inside a guarded call are all recorded.
        const bite = report.tripwireBite as { hostEvents: string[]; touched: string[] };
        expect(bite.hostEvents).toEqual([`open ${ground.gold}`, `open ${ground.score}`]);
        expect(bite.touched).toEqual(["agent.env.evaluate"]);
      });

      it("reads only file names the instruction itself mentions (3 of the 117 tasks name one)", () => {
        expect(report.taskSetNamed).toEqual({ tasks: 117, withNames: 3 });
        expect(report.namedFiles).toEqual({
          [report.instruction as string]: ["report.xlsx"],
          "Open /home/user/Desktop/Q3 data.xlsx and save a copy as Q3_summary.ODS in ~/Documents.":
            ["data.xlsx", "Q3_summary.ODS"],
          "Convert notes.docx to PDF (notes.pdf); keep notes.docx unchanged.": [
            "notes.docx",
            "notes.pdf",
          ],
          "Sum column B. No file name here, just 3.5 and v1.2 numbers.": [],
          "Rename draft.txt; then x.y.z.csv, a-b_c.pptx and 'quoted.odt'.": [
            "draft.txt",
            "x.y.z.csv",
            "a-b_c.pptx",
            "quoted.odt",
          ],
          [`Many: ${Array.from({ length: 12 }, (_, i) => `f${i}.txt`).join(" ")}`]: Array.from(
            { length: 10 },
            (_, i) => `f${i}.txt`,
          ),
          null: [],
        });
      });
    },
  );

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
    expect(calls[0]?.params?.arguments).toEqual({
      taskId: "task-9",
      runId: "run-9",
      claim: "done",
    });
    expect(s.reply.verdict).toBe("verified");
    expect(s.unreachable).toBe("GATE_UNAVAILABLE");
  });

  it("the runId wrap_agent is given is the runId DoneGate sends on the agent's DONE (the gate is bound to one trial)", () => {
    const w = (report.stdio as { throughWrap: Record<string, unknown> }).throughWrap as {
      actions: string[];
      decisions: { accepted: boolean }[];
      calls: Record<string, unknown>[];
    };
    expect(w.calls).toEqual([
      { taskId: "task-7", runId: "run-7", claim: "I have finished the task." },
    ]);
    expect(w.decisions.map((d) => d.accepted)).toEqual([true]);
    expect(w.actions).toEqual(["DONE"]);
  });

  it("the real stdio transport fails closed: a server that exits without replying, or replies with a non-object result, never accepts DONE", () => {
    type Entry = {
      client: string | null;
      clientReturned: unknown;
      actions: string[];
      decisions: { verdict: string; accepted: boolean; reasonCodes: string[] }[];
    };
    const fc = report.stdioFailClosed as Record<"silent" | "nonObject", Entry>;
    expect(fc.silent.client).toBe("GATE_NO_REPLY");
    expect(fc.nonObject.client).toBe("GATE_REPLY_MALFORMED");
    for (const [name, e] of Object.entries(fc)) {
      expect(e.clientReturned, name).toBeNull();
      expect(e.actions, name).toEqual(["WAIT"]);
      expect(e.decisions, name).toEqual([
        { verdict: "uncertain", accepted: false, reasonCodes: ["GATE_UNAVAILABLE"] },
      ]);
    }
  });

  describe.runIf(Boolean(OSW) || REQUIRED)("through OSWorld's real loop at the pin", () => {
    const up = (report.upstream ?? {}) as { accept: Arms; refuse: Arms; failScore: Run };
    const stamp: HarnessStamp = pinnedStamp();

    it("ran (MYCO_UPSTREAM_OSWORLD points at a checkout at the pin)", () => {
      expect(report.upstream).toBeDefined();
    });

    it("lib_run_single.run_single_example hands env.step byte-identical actions in all three arms when the gate accepts", () => {
      const a = up.accept;
      expect(a["gate-before-done"].envActions).toEqual(a["no-gate"].envActions);
      if (LINUX) {
        expect(a["self-check"].envActions).toEqual(a["no-gate"].envActions);
        expect(a["self-check"].agentObs).toEqual(a["no-gate"].agentObs);
      }
    });

    it("the real loop runs the refused DONE (gate refusal or self-check problem) as WAIT and continues to the accepted DONE", () => {
      const r = up.refuse;
      expect(r["gate-before-done"].envActions).toEqual(refuse["gate-before-done"].envActions);
      expect(r["no-gate"].envActions).toEqual(refuse["no-gate"].envActions);
      // N3: the self-check arm's found problem is a WAIT at the same place in the real loop.
      if (LINUX) {
        expect(r["self-check"].envActions).toEqual(r["gate-before-done"].envActions);
        expect(r["self-check"].tripwires).toEqual({ hostEvents: [], touched: [] });
      }
    });

    it("env.evaluate() runs once after the loop; upstream writes its score to result.txt; Myco's R1 grader reads exactly that", () => {
      const pass = up.accept["no-gate"];
      expect(pass.evaluations).toBe(1);
      expect(pass.scores).toEqual([1]);
      expect(pass.resultTxt).toBe("1.0\n");
      expect(gradeR1ExampleDir(pass.resultDir as string, "accept-no-gate", stamp)).toMatchObject({
        status: "pass",
        upstreamScore: 1,
        lastAction: "DONE",
      });
      const fail = up.failScore;
      expect(fail.resultTxt).toBe("0.0\n");
      expect(gradeR1ExampleDir(fail.resultDir as string, "fail-score", stamp)).toMatchObject({
        status: "fail",
        upstreamScore: 0,
      });
    });
  });
});
