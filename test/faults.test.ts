import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvalConfig, type EvalSummary, runEvaluation } from "../src/core/eval.ts";
import { FakeSpreadsheetApp } from "../src/fake/app.ts";
import { delayedSave, focusChange, invalidTarget, killApp } from "../src/fake/faults.ts";
import { cellVerifier, setCellFamily } from "../src/fake/tasks.ts";
import {
  type ArmedTrial,
  armFaults,
  DelayedSaveInjector,
  FocusChangeInjector,
  InMemoryKillSwitch,
  InvalidTargetInjector,
  KillAppInjector,
} from "../src/faults/index.ts";
import {
  auditTrial,
  deriveGroundTruth,
  type FaultInjectorV2,
  type FaultSchedule,
} from "../src/faults/types.ts";

let dir: string;

function freshFile(name: string): string {
  dir = mkdtempSync(join(tmpdir(), `myco-faults-${name}-`));
  const p = join(dir, "sheet.csv");
  writeFileSync(p, ",\n,\n,\n,\n");
  return p;
}

beforeEach(() => {
  dir = "";
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Runs one trial with the given armed injectors; returns everything audited. */
interface TrialRun {
  summary: EvalSummary;
  armed: ArmedTrial;
  schedule: FaultSchedule;
  app: FakeSpreadsheetApp;
}

async function runFaultTrial(
  name: string,
  injectors: FaultInjectorV2[],
  options: { rows?: number; cols?: number } = {},
): Promise<TrialRun> {
  const file = freshFile(name);
  const app = new FakeSpreadsheetApp({
    filePath: file,
    rows: options.rows ?? 8,
    cols: options.cols ?? 4,
  });
  const armed = armFaults(0, app, injectors);
  const config: EvalConfig = {
    adapterFor: () => armed.adapter,
    verifier: cellVerifier,
    family: setCellFamily,
    faults: [armed.injector],
    trials: 1,
    filePathFor: () => file,
  };
  const summary = await runEvaluation(config);
  return { summary, armed, schedule: armed.schedule, app };
}

describe("kill-app injector", () => {
  it("kills the app via the in-memory KillSwitch at the parameterized step", async () => {
    const killSwitch = new InMemoryKillSwitch(
      new FakeSpreadsheetApp({ filePath: freshFile("ks") }),
    );
    const file = freshFile("killstep");
    const app = new FakeSpreadsheetApp({ filePath: file });
    const realKillSwitch = new InMemoryKillSwitch(app);
    const injector = new KillAppInjector({ at: 1, killSwitch: realKillSwitch });
    const armed = armFaults(0, app, [injector]);
    await runEvaluation({
      adapterFor: () => armed.adapter,
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [armed.injector],
      trials: 1,
      filePathFor: () => file,
    });
    expect(injector.killed).toContain("step 1");
    expect(realKillSwitch.alive).toBe(false);
    expect(realKillSwitch.killedFor).toHaveLength(1);
    expect(killSwitch.alive).toBe(true); // unused switch untouched
  });

  it("kills before save by default and the trial never yields verified", async () => {
    const run = await runFaultTrial("killdefault", [new KillAppInjector()]);
    expect(run.summary.falseSuccesses).toBe(0);
    expect(run.summary.results[0]?.verdict?.status).not.toBe("verified");
    expect(run.summary.results[0]?.programCompleted).toBe(false);
  });

  it("does not create a false detection when firing after a completed save", async () => {
    const run = await runFaultTrial("killafter", [new KillAppInjector({ at: "after-save" })]);
    const result = run.summary.results[0];
    // edit persisted before the kill: verdict stays verified, ground truth satisfiable
    expect(result?.verdict?.status).toBe("verified");
    const audit = auditTrial(run.schedule, result?.verdict);
    expect(audit.groundTruth.intentSatisfiable).toBe(true);
    expect(audit.falseSuccess).toBe(false);
  });

  it("never hangs the harness when the app dies mid-run (bounded)", async () => {
    const start = Date.now();
    const run = await runFaultTrial("killbound", [new KillAppInjector({ at: 0 })]);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(run.summary.results[0]?.verdict?.status).not.toBe("verified");
  });
});

describe("invalid-target injector", () => {
  it.each(["nonexistent-row", "nonexistent-column", "stale-ref"] as const)(
    "mode %s produces a guard failure and never verified",
    async (mode) => {
      const run = await runFaultTrial(`invtarget-${mode}`, [new InvalidTargetInjector({ mode })]);
      const result = run.summary.results[0];
      expect(result?.verdict?.status).not.toBe("verified");
      expect(run.summary.falseSuccesses).toBe(0);
      expect(result?.programCompleted).toBe(false);
    },
  );

  it("rewrites the target cell outside the grid for row/column modes", async () => {
    const injector = new InvalidTargetInjector({ mode: "nonexistent-column" });
    const ctx = {
      adapter: {} as never,
      taskParams: { cell: "B2" },
      trialIndex: 0,
    };
    injector.setup(ctx);
    expect(String(ctx.taskParams.cell)).toBe("ZZZ92");
    expect(injector.newCell).toBe("ZZZ92");
    expect(injector.rewroteParams).toBe(true);
  });
});

describe("delayed-save injector", () => {
  it("mild: live app shows the edit but the persisted file lags — caught by persisted-state check", async () => {
    const run = await runFaultTrial("delaymild", [
      new DelayedSaveInjector({ severity: "mild", delayMs: 60_000 }),
    ]);
    const result = run.summary.results[0];
    expect(result?.verdict?.status).not.toBe("verified");
    expect(run.summary.falseSuccesses).toBe(0);
    expect(run.app.isSavePending()).toBe(true);
    // the edit WAS delivered live — this is the OpenAdapt shape
    const persisted = readFileSync(join(dir, "sheet.csv"), "utf8");
    expect(persisted).not.toContain("v0");
  });

  it("severe: save silently dropped via dropSave", async () => {
    const run = await runFaultTrial("delaysevere", [
      new DelayedSaveInjector({ severity: "severe" }),
    ]);
    const result = run.summary.results[0];
    expect(result?.verdict?.status).not.toBe("verified");
    expect(run.summary.falseSuccesses).toBe(0);
    expect(run.app.isSavePending()).toBe(false);
  });
});

describe("focus-change injector", () => {
  it("steals focus mid-typing so the save precondition breaks", async () => {
    const injector = new FocusChangeInjector({ at: 1 });
    const run = await runFaultTrial("focus", [injector]);
    const result = run.summary.results[0];
    expect(injector.fired).toBe(true);
    expect(result?.programCompleted).toBe(false);
    expect(result?.verdict?.status).not.toBe("verified");
    expect(run.summary.falseSuccesses).toBe(0);
  });

  it("steals to a parameterized target before save", async () => {
    const injector = new FocusChangeInjector({ at: "before-save", stealerId: "menu:file" });
    const run = await runFaultTrial("focusbs", [injector]);
    expect(run.summary.results[0]?.verdict?.status).not.toBe("verified");
    expect(run.summary.falseSuccesses).toBe(0);
  });
});

describe("sweep: 4 classes × several fault points — 0 false successes", () => {
  it("no corrupted trial yields verified", async () => {
    const injectorsPerTrial: FaultInjectorV2[][] = [
      [new KillAppInjector({ at: 0 })],
      [new KillAppInjector({ at: 1 })],
      [new KillAppInjector({ at: "before-save" })],
      [new InvalidTargetInjector({ mode: "nonexistent-row" })],
      [new InvalidTargetInjector({ mode: "nonexistent-column" })],
      [new InvalidTargetInjector({ mode: "stale-ref" })],
      [new DelayedSaveInjector({ severity: "mild", delayMs: 60_000 })],
      [new DelayedSaveInjector({ severity: "severe" })],
      [new FocusChangeInjector({ at: 0 })],
      [new FocusChangeInjector({ at: 1 })],
      [new FocusChangeInjector({ at: "before-save" })],
    ];
    for (const [i, injectors] of injectorsPerTrial.entries()) {
      const run = await runFaultTrial(`sweep${i}`, injectors);
      const result = run.summary.results[0];
      expect(
        result?.falseSuccess,
        `trial ${i} (${result?.fault}) must not be a false success`,
      ).toBe(false);
      expect(result?.verdict?.status, `trial ${i} (${result?.fault}) must not verify`).not.toBe(
        "verified",
      );
      // schedule-derived ground truth agrees the intent is unsatisfiable
      const gt = deriveGroundTruth(run.schedule);
      expect(gt.intentSatisfiable, `trial ${i} ground truth must be unsatisfiable`).toBe(false);
      // the class's own expectation rule holds against that ground truth
      for (const inj of injectors) {
        expect(inj.assertExpectation(gt).holds, `trial ${i} ${inj.name} expectation`).toBe(true);
      }
    }
  });

  it("a lying verifier against corrupted trials is flagged by schedule-derived ground truth", async () => {
    const run = await runFaultTrial("liar", [new KillAppInjector()]);
    const result = run.summary.results[0];
    const lyingVerdict = { status: "verified" as const, reasons: ["trust me"] };
    const audit = auditTrial(run.schedule, lyingVerdict);
    expect(audit.falseSuccess).toBe(true);
    expect(audit.groundTruth.causes).toHaveLength(1);
    expect(result?.verdict?.status).not.toBe("verified");
  });
});
describe("composition", () => {
  it("kill-app@before-save + delayed-save@before-save fire together without interference", async () => {
    const kill = new KillAppInjector({ at: "before-save" });
    const delay = new DelayedSaveInjector({ severity: "mild", delayMs: 60_000 });
    const run = await runFaultTrial("compose", [kill, delay]);
    const result = run.summary.results[0];
    expect(result?.fault).toBe("kill-app@before-save+delayed-save:mild");
    expect(run.schedule.entries).toHaveLength(2);
    expect(run.schedule.entries.map((e) => e.faultClass).sort()).toEqual([
      "delayed-save",
      "kill-app",
    ]);
    // both faults fired: the kill went through the shared seam, and the save
    // delay was armed even though the app then died
    expect(kill.killed).toContain("before-save");
    expect(delay.applied).toBe(true);
    expect(result?.verdict?.status).not.toBe("verified");
    expect(result?.falseSuccess).toBe(false);
  });

  it("a step-1 fault aborts the program before the save point: the later fault's point is never reached, and the schedule still records both", async () => {
    const kill = new KillAppInjector({ at: 1 });
    const delay = new DelayedSaveInjector({ severity: "mild", delayMs: 60_000 });
    const run = await runFaultTrial("composecausal", [kill, delay]);
    const result = run.summary.results[0];
    expect(kill.killed).toContain("step 1");
    // causal, not interference: the program died before the save dispatched,
    // so the before-save fault point was never reached
    expect(delay.applied).toBe(false);
    expect(run.schedule.entries).toHaveLength(2);
    expect(result?.verdict?.status).not.toBe("verified");
    expect(result?.falseSuccess).toBe(false);
  });

  it("delayed-save@before-save + focus-change@step-1 compose: focus aborts first, delay point unreached, both recorded", async () => {
    const delay = new DelayedSaveInjector({ severity: "severe" });
    const focus = new FocusChangeInjector({ at: 1 });
    const run = await runFaultTrial("compose2", [delay, focus]);
    const result = run.summary.results[0];
    expect(run.schedule.entries).toHaveLength(2);
    expect(focus.fired).toBe(true);
    expect(result?.verdict?.status).not.toBe("verified");
    expect(result?.falseSuccess).toBe(false);
  });
});

describe("ground truth derivable from schedule alone", () => {
  it("derives satisfiability and causes without touching guest state", () => {
    const schedule: FaultSchedule = {
      trialIndex: 7,
      entries: [
        {
          injector: "kill-app@before-save",
          faultClass: "kill-app",
          params: { at: "before-save" },
          at: "before-save",
        },
        {
          injector: "delayed-save:severe",
          faultClass: "delayed-save",
          params: {},
          at: "before-save",
        },
      ],
    };
    const gt = deriveGroundTruth(schedule);
    expect(gt.intentSatisfiable).toBe(false);
    expect(gt.causes.map((c) => c.faultClass).sort()).toEqual(["delayed-save", "kill-app"]);
    for (const cause of gt.causes) {
      expect(cause.meaning.length).toBeGreaterThan(0);
    }
  });

  it("empty schedule (clean trial) is satisfiable", () => {
    const gt = deriveGroundTruth({ trialIndex: 0, entries: [] });
    expect(gt.intentSatisfiable).toBe(true);
    expect(gt.causes).toHaveLength(0);
  });

  it("after-save kill alone does not mark the intent unsatisfiable", () => {
    const gt = deriveGroundTruth({
      trialIndex: 0,
      entries: [
        { injector: "kill-app@after-save", faultClass: "kill-app", params: {}, at: "after-save" },
      ],
    });
    expect(gt.intentSatisfiable).toBe(true);
  });
});

describe("KillSwitch seam", () => {
  it("InMemoryKillSwitch is idempotent and records reasons", () => {
    const app = new FakeSpreadsheetApp({ filePath: freshFile("ksidem") });
    const ks = new InMemoryKillSwitch(app);
    ks.kill("first");
    ks.kill("second");
    expect(ks.alive).toBe(false);
    expect(ks.killedFor).toEqual(["first"]);
  });
});

describe("compatibility layer (src/fake/faults.ts)", () => {
  it("still powers the M1-001 corrupted-trial tests through the new suite", async () => {
    const file = freshFile("compat");
    const summary = await runEvaluation({
      adapterFor: () => new FakeSpreadsheetApp({ filePath: file }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [killApp(), delayedSave(), focusChange(), invalidTarget(), { name: "none" }],
      trials: 5,
      filePathFor: () => file,
    });
    expect(summary.falseSuccesses).toBe(0);
    expect(summary.results[4]?.verdict?.status).toBe("verified");
    for (const r of summary.results.slice(0, 4)) {
      expect(r.falseSuccess).toBe(false);
    }
  });
});
