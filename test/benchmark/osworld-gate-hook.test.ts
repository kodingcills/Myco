/**
 * The DONE gate hook for OSWorld's standard Claude runner (gap items 4 and 7 of the lead's
 * 13:55Z harness ruling). MOCK, plumbing only: a scripted fake agent, fake environment and
 * fake gate (test/benchmark/osworld_gate_hook_check.py records; every assertion is here).
 *
 * Claims proved:
 *  - the action layer and the observation path are byte-identical across the arms; only DONE
 *    handling differs (a refused DONE becomes upstream's own WAIT);
 *  - the gate is called with taskId, runId and claim only, and only on DONE, and only in
 *    arm gate-before-done; the other arms bypass it by configuration;
 *  - the agent gets the verdict and reason codes only, never the gate's prose or corrections;
 *  - it fails closed on every malformed or missing reply;
 *  - lead ruling 18:11Z, B1: the primary self-check arm dumps the real saved content on the
 *    first DONE with one fixed command through the controller's run_bash_script, hands it back
 *    on the WAIT turn with a fixed, oracle-free re-verify message, and lets the MODEL judge:
 *    its next DONE goes through. "Nothing saved" is never a refusal, so a config-graded task
 *    (ef9d12bd) passes a correct DONE. One dump call per episode; the same step budget and the
 *    same per-call time allowance as the gate;
 *  - lead ruling 18:11Z, B2: the hook gets a narrow ControllerHandle that the runner patch
 *    builds without closing over the environment. Nothing reachable from it is the
 *    environment, the task config or the cache dir; the verifier's W2c2 and W2b2 attacks fail
 *    against it (and succeed against the round-2 getter). During a self-check turn, host
 *    reads, environment, provider and controller attribute reads, and guest reads next to the
 *    home (inotify, independent of the script's text or hash) are all recorded and must be
 *    empty;
 *  - the round-2 fixed-probe rules survive only as the labelled ablation self-check-rules;
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

type Tripwires = { hostEvents: string[]; touched: string[]; guestEvents: string[] };
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
  score?: number;
  probe: { scripts: string[]; timeouts: number[]; callTurns: (number | null)[] };
  tripwires: Tripwires;
  resultTxt?: string;
  resultDir?: string;
  scores?: number[];
};
type ArmId = "no-gate" | "gate-before-done" | "self-check" | "self-check-rules";
type Arms = Record<ArmId, Run>;
/** The self-check commands run for real only on Linux (GNU find, bash 5, python3, as in the guest). */
const LINUX = process.platform === "linux";
const CLEAN: Tripwires = { hostEvents: [], touched: [], guestEvents: [] };

function runChecks(): Record<string, unknown> {
  const done = spawnSync(
    "python3",
    ["-I", join(ROOT, "test/benchmark/osworld_gate_hook_check.py"), HOOK_DIR, work, OSW],
    { encoding: "utf8", timeout: 240_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
  );
  if (done.status !== 0) throw new Error(`check script failed: ${done.stderr}`);
  return JSON.parse(readFileSync(join(work, "report.json"), "utf8"));
}

const WAIT = '{"action_type": "WAIT"}'; // Python json.dumps(sort_keys=True) spacing
const kind = (a: string) => JSON.parse(a).command ?? JSON.parse(a).action_type;
const isDone = (a: string) => JSON.parse(a).action_type === "DONE";
const prereg = JSON.parse(
  readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.json"), "utf8"),
);
/** The dump between the message's <dump> markers. */
const dumpOf = (r: Run) => (r.feedback[0] ?? "").split("<dump>\n")[1]?.split("\n</dump>")[0] ?? "";

it("python3 is present where CI runs this suite (the hook tests must not skip there)", () => {
  if (process.env.CI) expect(hasPython).toBe(true);
});

describe.runIf(hasPython)("OSWorld DONE gate hook (MOCK, fakes only)", () => {
  const report = runChecks();
  const accept = report.accept as Arms;
  const refuse = report.refuse as Arms;
  const c = report.constants as {
    arms: string[];
    ablations: string[];
    runnerArms: string[];
    tool: string;
    api: string;
    claimLimit: number;
    linux: boolean;
    dump: string;
    dumpSha256: string;
    reverify: string;
    reverifyUnavailable: string;
    dumpLimit: number;
    probe: string;
    probeSha256: string;
    selfCheckCodes: string[];
    checkTimeout: number;
    gateClientTimeout: number;
    controllerMargin: number;
    retryTimes: number;
    retryInterval: number;
    selfCheckFeedback: string;
    hasSuffix: boolean;
    guestWatch: boolean;
  };

  it("speaks the gate's own API: tool name, version and claim limit match src/gate", () => {
    expect(c.tool).toBe(GATE_TOOL);
    expect(c.api).toBe(GATE_API_VERSION);
    expect(c.arms).toEqual(["no-gate", "gate-before-done", "self-check"]);
    expect(c.ablations).toEqual(["self-check-rules"]);
    expect(c.runnerArms).toEqual([...c.arms, ...c.ablations]);
    expect(report.longClaimLength).toBe(c.claimLimit);
    expect(report.nonStringClaim).toEqual({ taskId: "t", runId: "r", claim: "" });
  });

  it("runs the self-check scenarios wherever CI runs Linux (they must not skip there)", () => {
    expect(c.linux).toBe(LINUX);
    if (LINUX) {
      expect(Object.keys(accept)).toEqual(c.runnerArms);
      expect(c.guestWatch).toBe(true);
    }
  });

  it("the action layer and observation path are byte-identical across the arms; the primary self-check differs only by its one re-verify WAIT before the agent's DONE", () => {
    const base = accept["no-gate"];
    expect(base.envActions.map(kind)).toEqual([
      "pyautogui.click(10, 20)\n",
      "pyautogui.typewrite('42')\n",
      "pyautogui.hotkey('ctrl', 's')\n",
      "DONE",
    ]);
    expect(accept["gate-before-done"].envActions).toEqual(base.envActions);
    expect(accept["gate-before-done"].agentObs).toEqual(base.agentObs);
    if (LINUX) {
      expect(accept["self-check-rules"].envActions).toEqual(base.envActions);
      const s = accept["self-check"];
      expect(s.envActions).toEqual([...base.envActions.slice(0, 3), WAIT, base.envActions[3]]);
      expect(s.agentObs.slice(0, base.agentObs.length)).toEqual(base.agentObs);
    }
    for (const arm of Object.keys(accept) as ArmId[]) expect(accept[arm].evaluations, arm).toBe(1);
  });

  it("calls the gate only in arm gate-before-done, only on DONE, with taskId, runId and claim only", () => {
    for (const arm of Object.keys(accept) as ArmId[])
      if (arm !== "gate-before-done") expect(accept[arm].gateRequests, arm).toEqual([]);
    const reqs = accept["gate-before-done"].gateRequests;
    expect(reqs).toHaveLength(1);
    expect(Object.keys(reqs[0] as object).sort()).toEqual(["claim", "runId", "taskId"]);
    expect(reqs[0]).toMatchObject({ taskId: "task-1", runId: "run-1" });
    expect(refuse["gate-before-done"].gateRequests).toHaveLength(2);
  });

  it("a refused DONE becomes upstream's WAIT; every other action reaches the environment exactly as the agent emitted it", () => {
    const gated = refuse["gate-before-done"].envActions;
    const plain = refuse["no-gate"].envActions;
    const firstDone = plain.findIndex(isDone);
    expect(firstDone).toBe(2);
    expect(plain).toHaveLength(3);
    expect(gated.slice(0, firstDone)).toEqual(plain.slice(0, firstDone));
    expect(gated[firstDone]).toBe(WAIT);
    expect(gated.slice(firstDone + 1).map(kind)).toEqual([
      "pyautogui.hotkey('ctrl', 's')\n",
      "DONE",
    ]);
    expect(refuse["gate-before-done"].agentObs).toEqual(
      [0, 1, 2, 3, 4].map((i) => Buffer.from(`screen-${i}`).toString("hex")),
    );
    expect(refuse["gate-before-done"].decisions.map((d) => d.accepted)).toEqual([false, true]);
  });

  it("drops the rest of a batch after a refused DONE (upstream would have ended the episode there)", () => {
    expect((report.batchRefused as Run).envActions.map(kind)).toEqual([
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

  it("fails closed: unreachable gate, malformed reply, accepted without verified, verified without accepted, wrong API, and `accepted` anything but exactly true (N4)", () => {
    const fc = report.failClosed as Record<string, Run>;
    expect(Object.keys(fc)).toHaveLength(9);
    for (const [name, run] of Object.entries(fc)) {
      expect(run.envActions[0], name).toBe(WAIT);
      expect(run.decisions[0]?.accepted, name).toBe(false);
    }
    expect(fc.raises?.decisions[0]?.reasonCodes).toEqual(["GATE_UNAVAILABLE"]);
    expect(fc.notADict?.decisions[0]?.reasonCodes).toEqual(["GATE_REPLY_MALFORMED"]);
    // N4: a truthy `accepted` (1, "true") with a verified verdict is still refused.
    for (const name of ["acceptedOne", "acceptedString"])
      expect(fc[name]?.decisions[0], name).toEqual({
        verdict: "verified",
        accepted: false,
        reasonCodes: ["ORACLE_PASS"],
      });
  });

  it("keeps the runner's step budget: refusals use turns, and an exhausted budget ends with no DONE accepted", () => {
    const b = report.budgetExhausted as Run;
    expect(b.envActions).toEqual([WAIT, WAIT, WAIT]);
    expect(b.evaluations).toBe(1);
    expect(b.decisions.every((d) => !d.accepted)).toBe(true);
  });

  it("no arm changes the prompt: every arm runs upstream's prompt (the prompt-suffix variant is a pre-registered ablation, not implemented)", () => {
    expect(c.hasSuffix).toBe(false);
    for (const arm of Object.keys(accept) as ArmId[]) expect(accept[arm].suffix, arm).toBe("");
    for (const a of prereg.arms) expect(a.promptSuffix, a.id).toBeNull();
  });

  it("arms are chosen by configuration only: a gate only for gate-before-done, a ControllerHandle only for the self-check arms", () => {
    expect(report.config).toEqual({
      noGateWithGate: "arm no-gate takes no gate",
      selfCheckWithGate: "arm self-check takes no gate",
      gateArmWithoutGate: "arm gate-before-done needs a gate, a task id and a run id",
      unknownArm: "unknown arm: 'hcu-shell'",
      wrapGateArmWithoutCmd: "arm gate-before-done needs the gate server command",
      selfCheckWithoutController: "arm self-check needs a ControllerHandle",
      rulesWithLambda: "arm self-check-rules needs a ControllerHandle",
      noGateWithController: "arm no-gate takes no controller",
      gateArmWithController: "arm gate-before-done takes no controller",
      handleWithoutClass:
        "a controller handle needs the provider's address getter and the controller class",
    });
    // The runner patch hands every arm the same handle; wrap_agent keeps it for the self-check arms.
    expect(report.wrapController).toEqual({
      "no-gate": false,
      "gate-before-done": false,
      "self-check": true,
      "self-check-rules": true,
    });
    // DesktopEnv's own address parse ("<host>:<server>:..." or a bare host on port 5000).
    expect(report.parseAddress).toEqual([
      ["127.0.0.1", 5011],
      ["10.0.0.5", 5000],
      ["[2001:db8::1]", 5000],
    ]);
  });

  it("B2 (18:11Z): the runner patch hands wrap_agent a ControllerHandle built from the provider's address getter, the image reference and the controller class; nothing in it closes over env, the task config or the cache dir", () => {
    const patch = readFileSync(join(HOOK_DIR, "run_multienv_claude.gate.patch"), "utf8");
    const call = patch.slice(patch.indexOf("+                        myco_wrap_agent("));
    const added = call
      .split("\n")
      .filter((l) => l.startsWith("+"))
      .join("\n");
    expect(added).toContain(
      "controller=MycoControllerHandle(\n+                                env.provider.get_ip_address, env.path_to_vm, MycoPythonController)),",
    );
    expect(added).not.toMatch(/lambda|functools|partial|\bdef\b/);
    expect(added).not.toMatch(
      /\bexample\b(?!_id)|task_config|evaluate|cache_dir|\benv\b(?!\.provider\.get_ip_address\b|\.path_to_vm\b)/,
    );
    expect(patch).toContain(
      "+from desktop_env.controllers.python import PythonController as MycoPythonController",
    );
  });

  it("B2 (18:11Z): the patch-built handle reaches nothing of the environment, exposes only run_bash_script, and the verifier's W2c2 and W2b2 attacks fail against it (they succeed against the round-2 getter)", () => {
    const r = report.closureRoute as Record<string, unknown>;
    expect(r.handleType).toBe("ControllerHandle");
    expect(r.publicAttributes).toEqual(["run_bash_script"]);
    expect(r.hasClosure).toBe(false);
    expect(r.hasDict).toBe(false);
    expect(r.handleReaches).toEqual([]);
    // Bite: the round-2 route reached the environment and its ground truth.
    expect(r.oldGetterReaches).toEqual(["cacheDir", "env", "taskConfig"]);
    expect(r.w2c2).toEqual({
      handle: "blocked: AttributeError",
      oldGetter: "reached evaluator config: compare_table",
    });
    expect(r.w2b2).toEqual({ handle: "blocked: AttributeError", oldGetter: "reached score: 1.0" });
    expect(r.lambdaRefused).toBe("arm self-check needs a ControllerHandle");
  });

  describe.runIf(LINUX)(
    "18:11Z B1: the primary self-check arm, the model re-verifies against a dump of the saved content",
    () => {
      const dumps = (report.dump ?? {}) as Record<string, Run>;
      const cg = (report.configGraded ?? {}) as Record<
        "self-check" | "self-check-rules" | "no-gate",
        Run
      >;
      const many = (report.manyDones ?? {}) as Record<"self-check" | "self-check-rules", Run>;
      const primaryRuns = (): [string, Run][] => [
        ...Object.entries(dumps),
        ["accept", accept["self-check"]],
        ["refuse", refuse["self-check"]],
        ["budget", report.selfCheckBudget as Run],
        ["batch", report.selfCheckBatch as Run],
        ["configGraded", cg["self-check"]],
        ["manyDones", many["self-check"]],
      ];
      const sc = prereg.arms[2].selfCheck;

      it("the first DONE becomes upstream's WAIT exactly where the gate arm's refusal does; the model's next DONE goes through", () => {
        const s = refuse["self-check"];
        expect(s.envActions).toEqual(refuse["gate-before-done"].envActions);
        expect(s.agentObs).toEqual(refuse["gate-before-done"].agentObs);
        expect(s.decisions).toEqual([
          { selfCheck: "reverify", accepted: false, reasonCodes: [] },
          { selfCheck: "model-finished", accepted: true, reasonCodes: [] },
        ]);
        expect(s.gateRequests).toEqual([]);
        expect(s.evaluations).toBe(1);
        // Batches: the rest of a batch after the re-verify DONE is dropped, as in the gate arm.
        expect((report.selfCheckBatch as Run).envActions.map(kind)).toEqual([
          "pyautogui.click(10, 20)\n",
          "WAIT",
          "pyautogui.hotkey('ctrl', 's')\n",
          "DONE",
        ]);
      });

      it("the re-verify message is fixed and oracle-free, and carries the dump and nothing else", () => {
        expect(c.reverify).toBe(
          "Self-check: before your DONE is accepted, re-verify your work against the task using this dump of the saved state. It lists the document files under your home directory that were saved during this episode, with their cell values or text, or says that none were saved. Check every requirement of the task against it and against the screen. If anything is wrong or missing, fix it. When you are satisfied the task is complete, finish again. This re-check happens once per task.",
        );
        expect(sc.message).toBe(c.reverify);
        for (const [name, r] of primaryRuns()) {
          // The budget run's re-verify DONE is on the last step: no turn is left to receive it.
          if (r.decisions[0]?.selfCheck !== "reverify" || name === "budget") continue;
          expect(r.feedback, name).toHaveLength(1);
          expect(r.feedback[0], name).toBe(`${c.reverify}\n\n<dump>\n${dumpOf(r)}\n</dump>`);
          expect(r.feedback[0], name).not.toMatch(/ORACLE|verdict|gold|result\.txt|expected/i);
        }
      });

      it("the dump hands back the real saved content: cells by reference with formulas, text, slides, or that nothing was saved", () => {
        const d = (k: string) => dumpOf(dumps[k] as Run);
        const head = (path: string) =>
          new RegExp(`^=== ${path.replace(/[.]/g, "\\.")} \\(\\d+ bytes, saved \\d+ s after the episode started\\) ===$`, "m");
        expect(d("xlsx")).toMatch(head("~/Desktop/report.xlsx"));
        expect(d("xlsx")).toContain("[sheet Sheet1]\nA1=Total\nB2=42\nB3=42 (formula =SUM(B2))");
        expect(d("xlsx")).toMatch(head("~/Desktop/notes.csv"));
        expect(d("xlsx")).toContain("a,b\n1,2");
        // The input workbook predates the episode: never listed.
        expect(d("xlsx")).not.toContain("input.xlsx");
        const notSaved =
          "NOT SAVED: no document file under the home directory was saved during this episode.";
        expect(d("notSaved")).toBe(notSaved);
        // Hidden directories, lock files, links (here one to the gold file) and files deeper
        // than 4 levels are never read.
        expect(d("hiddenAndDeep")).toBe(notSaved);
        expect(d("ods")).toContain("[sheet Data]\nB3=7\nC3=42 (formula of:=[.B3]*6)");
        expect(d("odt")).toContain("Heading\nBody line");
        expect(d("odp")).toContain("[slide page1]\nSlide title");
        expect(d("docx")).toContain("Dear team,\nThanks.");
        expect(d("pptx")).toContain("[slide 1]\nFirst\n[slide 2]\nSecond");
        expect(d("pdf")).toContain("(binary .pdf file, content not dumped)");
        expect(d("unreadable")).toContain("(could not read: BadZipFile)");
        expect(d("big")).toMatch(/\n\[truncated\]$/);
        for (const [k, r] of Object.entries(dumps)) expect(dumpOf(r).length, k).toBeLessThanOrEqual(c.dumpLimit + 200);
      });

      it("nothing saved is never a refusal: a config-graded task (ef9d12bd, graded from the accessibility tree; or from ~/.config/libreoffice) passes a correct DONE; the rules ablation never does", () => {
        const s = cg["self-check"];
        expect(s.envActions.map(kind)).toEqual(["pyautogui.click(10, 20)\n", "WAIT", "DONE"]);
        expect(s.evaluations).toBe(1);
        expect(s.score).toBe(1);
        expect(dumpOf(s)).toBe(
          "NOT SAVED: no document file under the home directory was saved during this episode.",
        );
        expect(s.decisions.map((x) => x.accepted)).toEqual([false, true]);
        // The no-gate arm, for reference, and the labelled ablation that refuses every DONE.
        expect(cg["no-gate"].envActions.map(kind)).toEqual(["pyautogui.click(10, 20)\n", "DONE"]);
        expect(cg["self-check-rules"].envActions.map(kind)).toEqual([
          "pyautogui.click(10, 20)\n",
          "WAIT",
          "WAIT",
          "WAIT",
        ]);
        expect(cg["self-check-rules"].decisions.every((x) => !x.accepted)).toBe(true);
      });

      it("fails closed: a controller that raises, returns nothing, exits non-zero or cuts the output short still gets the re-verify turn (no DONE passes unchecked), with the dump marked unavailable", () => {
        expect(c.reverifyUnavailable).toBe(
          `${c.reverify}\n\n<dump>\n(the dump is unavailable: DUMP_UNAVAILABLE)\n</dump>`,
        );
        for (const mode of ["raises", "none", "exit1", "noEnd"]) {
          const r = dumps[`unavailable-${mode}`] as Run;
          expect(r.envActions.map(kind), mode).toEqual(["WAIT", "DONE"]);
          expect(r.decisions[0], mode).toEqual({
            selfCheck: "reverify",
            accepted: false,
            reasonCodes: ["DUMP_UNAVAILABLE"],
          });
          expect(r.feedback, mode).toEqual([c.reverifyUnavailable]);
        }
      });

      it("N2: exactly one dump call per episode, on the first DONE; none on later DONEs or other turns; each call gets the gate's time allowance", () => {
        expect(refuse["self-check"].probe.callTurns).toEqual([3]);
        expect(accept["self-check"].probe.callTurns).toEqual([3]);
        expect(many["self-check"].envActions.map(kind)).toEqual([
          "WAIT",
          "pyautogui.click(10, 20)\n",
          "DONE",
        ]);
        expect(many["self-check"].probe.callTurns).toEqual([1]);
        for (const [name, r] of primaryRuns()) {
          const dones = r.decisions.length;
          expect(r.probe.scripts.length, name).toBe(dones > 0 ? 1 : 0);
          for (const t of r.probe.timeouts) expect(t + c.controllerMargin, name).toBe(c.checkTimeout);
        }
        expect(c.gateClientTimeout).toBe(c.checkTimeout);
        // Upstream's retries, as the pre-registered budget text states them.
        expect([c.retryTimes, c.retryInterval]).toEqual([3, 5]);
        const worst = c.retryTimes * (c.checkTimeout + c.retryInterval);
        expect(worst).toBe(375);
        expect(sc.budgetParity).toContain(
          `retry_times ${c.retryTimes}, retry_interval ${c.retryInterval} s`,
        );
        expect(sc.budgetParity).toContain(`at most ${worst} s`);
        expect(sc.budgetParity).toContain("exactly one run_bash_script call per episode");
      });

      it("budget parity: a refused DONE uses its turn, the dump costs no extra model turn, and the agent's step budget is untouched", () => {
        const b = report.selfCheckBudget as Run;
        expect(b.envActions.map(kind)).toEqual([
          "pyautogui.click(10, 20)\n",
          "pyautogui.click(10, 20)\n",
          "WAIT",
        ]);
        expect(b.agentPredicts).toBe(3);
        expect(b.evaluations).toBe(1);
        expect(b.decisions.every((d) => !d.accepted)).toBe(true);
        // One model turn per runner step in every run: the dump never asks the model.
        const turns: Record<string, number> = { accept: 4, refuse: 5, budget: 3, batch: 3 };
        for (const [name, r] of primaryRuns()) {
          expect(r.agentPredicts, name).toBe(turns[name] ?? r.envActions.length);
          expect(r.agentMaxSteps, name).toBe(10);
        }
      });

      it("what reaches the controller is the pinned dump command, with only the elapsed seconds filled in", () => {
        const sent = primaryRuns().flatMap(([, r]) => r.probe.scripts);
        expect(sent.length).toBeGreaterThan(15);
        for (const s of sent)
          expect(s.replace(/^elapsed=\d+$/m, "elapsed=__ELAPSED__")).toBe(c.dump);
        expect(createHash("sha256").update(c.dump).digest("hex")).toBe(c.dumpSha256);
        expect(sc.dumpSha256).toBe(c.dumpSha256);
        const slow = report.selfCheckSlowClock as { scripts: string[] };
        expect(slow.scripts[0]).toMatch(/^elapsed=3601$/m);
      });

      it("the dump reads only the guest home directory: no absolute path, no parent hop, nothing that names ground truth, no hidden directory, link or other mount", () => {
        const body = c.dump.replace(/^#!\/bin\/bash\n/, "");
        expect(body).not.toMatch(/(^|[\s"'=(<])\//m);
        expect(body).not.toMatch(/\.\.|dirname|pardir/);
        expect(body).not.toMatch(
          /result|gold|cache|evaluation_examples|desktop_env|cloud|expected|oracle|fixture|myco|score|\/tmp|curl|wget|https?:|urllib|socket|requests|environ/i,
        );
        expect(body).toMatch(/^exec python3 -I - "\$\{HOME:\?\}" "\$elapsed" <<'DUMP'$/m);
        expect(body).toMatch(/^home, elapsed = sys\.argv\[1\], int\(sys\.argv\[2\]\)$/m);
        expect([...body.matchAll(/os\.walk\((\w+)\)/g)].map((m) => m[1])).toEqual(["home"]);
        expect(body).toContain('not x.startswith(".")');
        expect(body).toContain("os.path.islink");
        expect(body).toContain("os.path.ismount");
        expect([...body.matchAll(/open\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['p, "rb"']);
      });

      it("never touches the environment, the evaluator, gold, the task config or the score file: no host read or launch, no env, provider or controller attribute but the two the handle uses, no guest read next to the home", () => {
        const ground = report.ground as { gold: string; score: string; taskConfig: string };
        for (const [name, r] of primaryRuns()) {
          expect(r.tripwires, name).toEqual(CLEAN);
          for (const s of r.probe.scripts)
            for (const p of Object.values(ground)) expect(s, name).not.toContain(p);
        }
        // The host and object tripwires bite.
        const bite = report.tripwireBite as { hostEvents: string[]; touched: string[] };
        expect(bite.hostEvents).toEqual([
          `open ${ground.gold}`,
          `open ${ground.score}`,
          `open ${ground.taskConfig}`,
        ]);
        expect(bite.touched).toEqual(
          expect.arrayContaining([
            "env.evaluate",
            "env.score",
            "env.task_config",
            "provider.container",
          ]),
        );
      });

      it("N1: the guest-side tripwire catches a read of ground truth next to the home without relying on the pinned hash (the verifier's W3 line, a listing, a config read, a glob)", () => {
        const ground = report.ground as { gold: string; score: string; taskConfig: string };
        const g = report.guestBite as Record<string, string[]>;
        expect(g.w3).toEqual(expect.arrayContaining([ground.score]));
        expect(g.configRead).toEqual(expect.arrayContaining([ground.taskConfig]));
        expect(g.goldGlob).toEqual(expect.arrayContaining([ground.gold]));
        expect(g.listSiblings?.length).toBeGreaterThan(0);
      });
    },
  );

  describe.runIf(LINUX)(
    "ABLATION self-check-rules (the round-2 fixed probe; never the headline baseline)",
    () => {
      const cases = (report.rules ?? {}) as Record<string, Run>;
      const ablation = (prereg.ablations ?? []).find(
        (a: { id: string }) => a.id === "self-check-rules",
      );
      const rulesRuns = (): [string, Run][] => [
        ...Object.entries(cases),
        ["accept", accept["self-check-rules"]],
        ["refuse", refuse["self-check-rules"]],
        ["budget", report.rulesBudget as Run],
        ["manyDones", (report.manyDones as Record<string, Run>)["self-check-rules"] as Run],
      ];

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
        for (const [k, r] of Object.entries(cases))
          expect(kind(r.envActions[0] as string), k).toBe(
            r.decisions[0]?.accepted === true ? "DONE" : "WAIT",
          );
        expect(c.selfCheckCodes).toEqual(ablation.codes);
        expect(refuse["self-check-rules"].feedback).toEqual([
          c.selfCheckFeedback.replace("CODE_A, CODE_B", "SAVED_FILE_MISSING, NOTHING_SAVED"),
        ]);
      });

      it("one probe call per DONE, each with the gate's time allowance; fails closed", () => {
        const m = (report.manyDones as Record<string, Run>)["self-check-rules"] as Run;
        expect(m.probe.callTurns).toEqual([1, 2, 3, 4]);
        for (const [name, r] of rulesRuns()) {
          expect(r.probe.scripts.length, name).toBe(r.decisions.length);
          for (const t of r.probe.timeouts) expect(t + c.controllerMargin, name).toBe(c.checkTimeout);
          expect(r.tripwires, name).toEqual(CLEAN);
        }
        for (const mode of ["raises", "none", "exit1", "noEnd"])
          expect((cases[`unavailable-${mode}`] as Run).envActions[0], mode).toBe(WAIT);
      });

      it("what reaches the controller is the pinned probe, with only the elapsed seconds and the instruction's file names filled in", () => {
        const normal = (s: string) =>
          s
            .replace(/^elapsed=\d+$/m, "elapsed=__ELAPSED__")
            .replace(/^names=\(.*\)$/m, "names=(__NAMES__)");
        const sent = rulesRuns().flatMap(([, r]) => r.probe.scripts);
        expect(sent.length).toBeGreaterThan(20);
        for (const s of sent) expect(normal(s)).toBe(c.probe);
        expect(createHash("sha256").update(c.probe).digest("hex")).toBe(c.probeSha256);
        expect(ablation.probeSha256).toBe(c.probeSha256);
        expect(refuse["self-check-rules"].probe.scripts[0]).toMatch(/^names=\(report\.xlsx\)$/m);
      });

      it("the probe reads only the guest home directory: no absolute path, no parent hop, no hidden directory, nothing that names ground truth", () => {
        const body = c.probe.replace(/^#!\/bin\/bash\n/, "").replaceAll("2>/dev/null", "");
        expect(body).not.toMatch(/(^|[\s"'=(<])\//m);
        expect(body).not.toMatch(/\.\.\//);
        expect(body).not.toMatch(
          /result|gold|cache|evaluation_examples|desktop_env|cloud|expected|oracle|fixture|myco|score|\/tmp|curl|wget|https?:/i,
        );
        expect(body).toMatch(/root="\$\{HOME:\?\}"/);
        expect([...body.matchAll(/find (\S+)/g)].map((m) => m[1])).toEqual(['"$root"', '"$root"']);
        expect(body.match(/-not -path '\*\/\.\*'/g)).toHaveLength(2);
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
    expect(calls[0]?.params?.arguments).toEqual({ taskId: "task-9", runId: "run-9", claim: "done" });
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

  it("the real stdio transport fails closed: a server that exits without replying, replies with a non-object result, or a result with no structuredContent (N4) never accepts DONE", () => {
    type Entry = {
      client: string | null;
      clientReturned: unknown;
      actions: string[];
      decisions: { verdict: string; accepted: boolean; reasonCodes: string[] }[];
    };
    const fc = report.stdioFailClosed as Record<
      "silent" | "nonObject" | "noStructuredContent",
      Entry
    >;
    expect(fc.silent.client).toBe("GATE_NO_REPLY");
    expect(fc.nonObject.client).toBe("GATE_REPLY_MALFORMED");
    for (const name of ["silent", "nonObject"] as const)
      expect(fc[name].decisions, name).toEqual([
        { verdict: "uncertain", accepted: false, reasonCodes: ["GATE_UNAVAILABLE"] },
      ]);
    expect(fc.noStructuredContent.client).toBeNull();
    expect(fc.noStructuredContent.decisions).toEqual([
      { verdict: "uncertain", accepted: false, reasonCodes: ["GATE_REPLY_MALFORMED"] },
    ]);
    for (const [name, e] of Object.entries(fc)) {
      expect(e.clientReturned, name).toBeNull();
      expect(e.actions, name).toEqual(["WAIT"]);
    }
  });

  describe.runIf(Boolean(OSW) || REQUIRED)("through OSWorld's real loop at the pin", () => {
    const up = (report.upstream ?? {}) as {
      accept: Arms;
      refuse: Arms;
      failScore: Run;
      configGraded?: Run;
      controllerSource: Record<string, boolean>;
    };
    const stamp: HarnessStamp = pinnedStamp();

    it("ran (MYCO_UPSTREAM_OSWORLD points at a checkout at the pin)", () => {
      expect(report.upstream).toBeDefined();
    });

    it("lib_run_single.run_single_example hands env.step byte-identical actions in every arm (the primary self-check adds only its re-verify WAIT)", () => {
      const a = up.accept;
      expect(a["gate-before-done"].envActions).toEqual(a["no-gate"].envActions);
      if (LINUX) {
        expect(a["self-check-rules"].envActions).toEqual(a["no-gate"].envActions);
        expect(a["self-check"].envActions).toEqual([
          ...a["no-gate"].envActions.slice(0, 3),
          WAIT,
          a["no-gate"].envActions[3],
        ]);
      }
    });

    it("the real loop runs the refused or re-verify DONE as WAIT and continues to the accepted DONE", () => {
      const r = up.refuse;
      expect(r["gate-before-done"].envActions).toEqual(refuse["gate-before-done"].envActions);
      expect(r["no-gate"].envActions).toEqual(refuse["no-gate"].envActions);
      if (LINUX) {
        expect(r["self-check"].envActions).toEqual(r["gate-before-done"].envActions);
        expect(r["self-check-rules"].envActions).toEqual(r["gate-before-done"].envActions);
        for (const arm of ["self-check", "self-check-rules"] as const)
          expect(r[arm].tripwires, arm).toEqual(CLEAN);
      }
    });

    it.runIf(LINUX)(
      "a config-graded task passes a correct DONE through the real loop in the primary self-check arm, and Myco's R1 grader reads the pass",
      () => {
        const g = up.configGraded as Run;
        expect(g.envActions.map(kind)).toEqual(["pyautogui.click(10, 20)\n", "WAIT", "DONE"]);
        expect(g.resultTxt).toBe("1.0\n");
        expect(gradeR1ExampleDir(g.resultDir as string, "config-graded", stamp)).toMatchObject({
          status: "pass",
          upstreamScore: 1,
          lastAction: "DONE",
        });
        expect(g.tripwires).toEqual(CLEAN);
      },
    );

    it("upstream's controller at the pin retries as the budget text says, and builds its address as the handle does", () => {
      expect(up.controllerSource).toEqual({
        retryTimes: true,
        retryInterval: true,
        httpMargin: true,
        retriesInRunBash: true,
        readTimeoutReturns: true,
        httpServerFromAddress: true,
        envParse: true,
        providerAddress: true,
        defaultPort: true,
      });
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
