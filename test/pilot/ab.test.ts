/**
 * Track E follow-up: the corrections ON/OFF A/B runner and its pre-registration
 * (`src/pilot/ab.ts`, `scripts/m2-corrections-ab-run.ts`, `docs/benchmark/corrections-ab-prereg.*`).
 * Fake transports only: no model, no `claude` process, no VM, $0.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BenchmarkArmRow, checkBenchmark } from "../../src/benchmark/check.ts";
import { gradeRow } from "../../src/benchmark/grade/row.ts";
import { anchorPathFor, verifyAttemptLedger } from "../../src/m2/attempt-ledger.ts";
import { packProvenanceErrors } from "../../src/m2/provenance.ts";
import {
  AB_DRY_RUN_PLANNER,
  AbRefusal,
  type AbStage,
  abFakeDriver,
  abPlanSha256,
  abSchedule,
  ackIncident,
  analysisCommand,
  analyzeAbPack,
  armConfig,
  bundleGrader,
  checkAbPack,
  compareLaunchPlans,
  diffArmConfigs,
  evidenceRefusals,
  exportAbPack,
  fillAnalysisCommand,
  type GradeFn,
  gateMissesFromRows,
  type HookContext,
  incidentStatus,
  LEAD_GO_FILE,
  launchPlanDiff,
  leadGoProblems,
  liveAbRefusals,
  loadPrereg,
  PREREG_JSON,
  PREREG_MD,
  R1AttemptSink,
  type RecordStep,
  realRunRefusals,
  reconcileGrades,
  recordDecided,
  runAbStage,
  stageRoot,
  stageTasks,
} from "../../src/pilot/ab.ts";
import { abDryRun } from "../../src/pilot/ab-dry-run.ts";
import { configSha256, PILOT_MODEL, type PilotConfig } from "../../src/pilot/config.ts";
import { fakeDriver, virtualClock } from "../../src/pilot/dry-run.ts";
import { correctionsArgs } from "../../src/pilot/launch.ts";
import { loadLedger, PROGRESS_FILE } from "../../src/pilot/ledger.ts";
import {
  HarnessFault,
  liveExperimentRefusals,
  type PilotDriver,
  runPilot,
} from "../../src/pilot/runner.ts";
import { PUBLISHED, config as pilotCfg, ROOT, SOURCES, tmp } from "./helpers.ts";

const LOADED = loadPrereg(ROOT);
const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
const jsonl = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

function run(
  outRoot: string,
  stage: AbStage,
  extra: {
    grader?: GradeFn;
    driver?: PilotDriver;
    maxChunks?: number;
    planner?: string;
    liveLaunchSha256?: string;
    launchRealTrials?: boolean;
    crashPoint?: (step: RecordStep, trialKey: string) => void;
  } = {},
) {
  const clock = virtualClock(0);
  return runAbStage({
    repoRoot: ROOT,
    published: PUBLISHED,
    loaded: LOADED,
    stage,
    outRoot,
    driver: extra.driver ?? abFakeDriver(fakeDriver()),
    plannerModelId: extra.planner ?? AB_DRY_RUN_PLANNER,
    oracleSources: SOURCES,
    maxChunks: extra.maxChunks ?? Number.POSITIVE_INFINITY,
    sleep: clock.sleep,
    now: clock.now,
    load1m: () => 0.25,
    ...(extra.grader === undefined ? {} : { grader: extra.grader }),
    ...(extra.liveLaunchSha256 === undefined ? {} : { liveLaunchSha256: extra.liveLaunchSha256 }),
    ...(extra.launchRealTrials === undefined ? {} : { launchRealTrials: extra.launchRealTrials }),
    ...(extra.crashPoint === undefined ? {} : { crashPoint: extra.crashPoint }),
  });
}

/** The real grader, except the first trial it would pass is reported failed (a gate miss). */
function missGrader(): GradeFn & { injected: string | null } {
  const real = bundleGrader(BUNDLE);
  const fn = ((task, persisted, trialKey) => {
    const g = real(task, persisted, trialKey);
    if (fn.injected !== null || g.status !== "pass") return g;
    fn.injected = trialKey;
    return gradeRow(trialKey, task.taskId, {
      graderVersion: g.graderVersion,
      status: "fail",
      reasons: ["test: injected grader failure"],
      fixtureSha256: g.fixtureSha256,
      persistedSha256: g.persistedSha256,
      target: g.target,
      targetSatisfied: false,
      mismatches: [],
      mismatchCount: 1,
    });
  }) as GradeFn & { injected: string | null };
  fn.injected = null;
  return fn;
}

/**
 * Like `missGrader`, but deterministic across invocations: the first trial it would pass is
 * failed, and that same trial is failed again whenever it is re-graded (as a real grader on
 * the same bytes would), so a resume after a crash sees the same miss.
 */
function stickyMissGrader(): GradeFn & { injected: string | null } {
  const inner = missGrader();
  const fn = ((task, persisted, trialKey) => {
    if (inner.injected === trialKey) {
      inner.injected = null;
      const g = inner(task, persisted, trialKey);
      inner.injected = trialKey;
      return g.status === "pass" ? inner(task, persisted, trialKey) : g;
    }
    return inner(task, persisted, trialKey);
  }) as GradeFn & { injected: string | null };
  Object.defineProperty(fn, "injected", { get: () => inner.injected });
  return fn;
}

class Crash extends Error {}

/** A resume after a gate miss must not proceed: either it halts or it refuses outright. */
async function resumeOutcome(p: Promise<{ status: string; reason: string | null }>) {
  try {
    const r = await p;
    return r.status === "halted" ? `halted: ${r.reason}` : r.status;
  } catch (error) {
    if (error instanceof AbRefusal) return `refused: ${error.message}`;
    throw error;
  }
}

const ack = (root: string, id: string) => {
  const st = incidentStatus(root).find((i) => i.id === id);
  if (st === undefined) throw new Error(`no incident ${id}`);
  return ackIncident(root, id, {
    operator: "test operator",
    statement: "reviewed the record; injected test failure, no gate defect",
    incidentSha256: st.sha256,
  });
};

describe("corrections A/B pre-registration", () => {
  it("is committed in two forms, the JSON pinning the markdown's sha256", () => {
    const md = readFileSync(join(ROOT, PREREG_MD));
    expect(LOADED.markdownSha256).toBe(createHash("sha256").update(md).digest("hex"));
    expect(LOADED.prereg.markdownSha256).toBe(LOADED.markdownSha256);
    expect(LOADED.prereg.stages["0"]).toMatchObject({ taskSet: "pilot-30", pairs: 30, k: 1 });
    expect(LOADED.prereg.stages["1"]).toMatchObject({ taskSet: "fc-v1", pairs: 100, k: 1 });
    expect(LOADED.prereg.stages["1"].seed).not.toBe(LOADED.prereg.stages["0"].seed);
    expect(LOADED.prereg.analysis.command).toContain("scripts/m2-corrections-ab.ts");
    expect(LOADED.prereg.primaryMetric).toMatch(/never the gate/);
  });

  it("states the lead's fixed design verbatim", () => {
    const md = readFileSync(join(ROOT, PREREG_MD), "utf8");
    for (const line of [
      "> Lead decision (2026-11-26), recorded by the coordinator: the fixed pre-registration design for the corrections ON/OFF A/B (track E follow-up, TO FILE comment 7196317962). The pre-registration file must state this verbatim as the fixed design.",
      "> **Stage 0: non-confirmatory, plumbing only.**",
      "> - The pilot's 30 tasks per arm, paired by task.",
      "> - Purpose: prove arm byte-identity, the ledger and anchor (#518), the grader wiring, and zero gate misses.",
      "> - It makes NO effect claim, and its rows are excluded from the confirmatory test.",
      "> **Stage 1: confirmatory.**",
      "> - The full fc-v1 task set, 100 paired trials per arm. Seeds are fresh; no Stage 0 rows are reused.",
      "> - Primary test: a one-sided exact sign test on discordant pairs (grader-verified ON vs OFF), alpha = 0.05.",
      '> - A miss is recorded as "corrections not shown to help". It is not a fail.',
      "> - Report the discordant counts and the paired difference with a 95% CI, alongside the p-value.",
      "> **Fail-closed.** Any gate miss (the gate says VERIFIED, the grader fails) is an integrity incident. It halts the run and gets its own record before anything resumes.",
      "> **Pacing.** Stage 1 runs in resumable chunks, paced to leave builder and verifier headroom on Ultra. No API. Real runs wait for the integrity fixes and the lead's GO.",
    ])
      expect(md).toContain(line);
    for (const section of [
      "## Hypothesis",
      "## Primary metric",
      "## Success bar",
      "## Stages",
      "## Pacing",
      "## Stopping rule",
      "## Fail-closed: gate misses",
      "## Analysis",
    ])
      expect(md).toContain(section);
  });

  it("refuses a markdown edited after the JSON pinned it, and a reused Stage 1 seed", () => {
    const root = tmp("myco-ab-prereg-");
    mkdirSync(join(root, "docs", "benchmark"), { recursive: true });
    cpSync(join(ROOT, PREREG_MD), join(root, PREREG_MD));
    cpSync(join(ROOT, PREREG_JSON), join(root, PREREG_JSON));
    expect(() => loadPrereg(root)).not.toThrow();
    writeFileSync(join(root, PREREG_MD), `${readFileSync(join(root, PREREG_MD), "utf8")}x`);
    expect(() => loadPrereg(root)).toThrow(/markdownSha256/);
    cpSync(join(ROOT, PREREG_MD), join(root, PREREG_MD));
    const j = JSON.parse(readFileSync(join(root, PREREG_JSON), "utf8"));
    j.stages["1"].seed = j.stages["0"].seed;
    writeFileSync(join(root, PREREG_JSON), JSON.stringify(j));
    expect(() => loadPrereg(root)).toThrow(/fresh/);
  });

  it("prints its hashes from a script", () => {
    const r = spawnSync("npx", ["tsx", "scripts/m2-corrections-ab-run.ts", "prereg-hash"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      [PREREG_MD]: LOADED.markdownSha256,
      [PREREG_JSON]: LOADED.jsonSha256,
      jsonPinsMarkdown: true,
    });
  });
});

describe("identical arms apart from corrections", () => {
  const on = armConfig(LOADED, 1, "on", PUBLISHED);
  const off = armConfig(LOADED, 1, "off", PUBLISHED);

  it("the two arm configs differ only in corrections", () => {
    expect(diffArmConfigs(on, off)).toEqual([]);
    expect(on.trials).toHaveLength(100);
    expect(on.experiment).toEqual({
      name: "corrections-ab",
      stage: 1,
      preregSha256: LOADED.markdownSha256,
    });
  });

  // Mutation table: each other difference is refused, at any depth.
  const mutations: [string, (c: Record<string, unknown>) => void, RegExp][] = [
    [
      "pacing",
      (c) => ((c.pacing as Record<string, number>).interTrialDelayS = 1),
      /pacing\.interTrialDelayS/,
    ],
    [
      "retry budget",
      (c) => ((c.pacing as Record<string, number>).maxAttemptsPerTrial = 2),
      /maxAttemptsPerTrial/,
    ],
    ["model", (c) => (c.model = "claude-opus-5-5"), /at model/],
    [
      "argv",
      (c) => (c.argvTemplate = [...(c.argvTemplate as string[]), "--verbose"]),
      /argvTemplate/,
    ],
    ["trials", (c) => (c.trials = (c.trials as string[]).slice(1)), /trials/],
    [
      "experiment stage",
      (c) => ((c.experiment as Record<string, number>).stage = 0),
      /experiment\.stage/,
    ],
    [
      "prereg hash",
      (c) => ((c.experiment as Record<string, string>).preregSha256 = "0".repeat(64)),
      /preregSha256/,
    ],
    ["extra key", (c) => (c.outputCeiling = 1000), /outputCeiling/],
    ["corrections swapped", (c) => (c.corrections = "off"), /not "on"/],
  ];
  for (const [name, mutate, want] of mutations)
    it(`refuses a different ${name}`, () => {
      const changed = structuredClone(on) as unknown as Record<string, unknown>;
      mutate(changed);
      const d = diffArmConfigs(changed, off);
      expect(d.length).toBeGreaterThan(0);
      expect(d.join("; ")).toMatch(want);
    });

  it("the launch plans differ only by the ON arm's --corrections flag", () => {
    const task = PUBLISHED[0];
    if (task === undefined) throw new Error("no task");
    expect(launchPlanDiff(on, off, task, ROOT)).toEqual([]);
    expect(correctionsArgs(on)).toEqual(["--corrections", "calc-record-edit"]);
    expect(correctionsArgs(off)).toEqual([]);
    // The R1 pilot config never turns corrections on.
    expect(correctionsArgs(pilotCfg())).toEqual([]);
    const bad = { ...on, systemTemplate: `${on.systemTemplate} Be quick.` };
    expect(launchPlanDiff(bad, off, task, ROOT).join("; ")).toMatch(/argv differs/);
  });
});

describe("seeded schedule", () => {
  const ids = stageTasks(LOADED, 1, PUBLISHED);
  it("is a reproducible permutation in chunks with a seeded arm order", () => {
    const a = abSchedule("seed-aaaaaaaa", ids, 10);
    expect(abSchedule("seed-aaaaaaaa", ids, 10)).toEqual(a);
    expect(a).toHaveLength(10);
    expect(a.flatMap((c) => c.tasks).sort()).toEqual([...ids].sort());
    expect(a.flatMap((c) => c.tasks)).not.toEqual([...ids].sort());
    for (const c of a) expect([...c.armOrder].sort()).toEqual(["off", "on"]);
    expect(new Set(a.map((c) => c.armOrder[0])).size).toBe(2);
    expect(abSchedule("seed-bbbbbbbb", ids, 10)).not.toEqual(a);
  });
  it("Stage 0 is the pilot's 30, Stage 1 all 100 fc-v1 tasks", () => {
    expect(stageTasks(LOADED, 0, PUBLISHED)).toEqual([...pilotCfg().trials]);
    expect(ids).toHaveLength(100);
  });
});

describe("the SIMULATED dry run ($0)", () => {
  it("exercises both stages, pairing, the gate-miss halt and the prereg-hash check", {
    timeout: 120_000,
  }, async () => {
    const out = tmp("myco-ab-dry-");
    const r = await abDryRun(ROOT, out);
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    const names = r.steps.map((s) => s.name);
    for (const want of [
      "stage 0 run",
      "stage 1 run",
      "stage 1 pack check (prereg hash, labels, identical arms)",
      "stage 1 off arm refused as R1 evidence",
      "prereg hash mismatch refused",
      "gate miss halts the run with an incident record",
      "resume refused until acknowledged",
      "after the operator's ack the run resumes",
      "Stage 1 refused after a Stage 0 gate miss",
    ])
      expect(names).toContain(want);
    // Pairing: every task once per arm, the same tasks in both arms, fresh Stage 1 keys.
    const keys = (stage: number, arm: string) =>
      jsonl(join(out, "packs", `stage${stage}`, arm, "arm.jsonl")).map((r) => r.trialKey as string);
    const tasks = (stage: number, arm: string) =>
      jsonl(join(out, "packs", `stage${stage}`, arm, "arm.jsonl"))
        .map((r) => r.taskId as string)
        .sort();
    expect(tasks(1, "on")).toEqual(tasks(1, "off"));
    expect(tasks(1, "on")).toHaveLength(100);
    expect(tasks(0, "on")).toHaveLength(30);
    const s0 = new Set([...keys(0, "on"), ...keys(0, "off")]);
    expect([...keys(1, "on"), ...keys(1, "off")].filter((k) => s0.has(k))).toEqual([]);
    expect(existsSync(join(out, "packs", "stage1", "SIMULATED"))).toBe(true);
    expect(existsSync(join(out, "packs", "stage1", "EXPERIMENT"))).toBe(true);
    expect(existsSync(join(out, "packs", "stage1", "pack.json"))).toBe(false);
    // The ON arm really ran with corrections on, the OFF arm off.
    const gates = (arm: string) =>
      jsonl(join(out, "packs", "stage1", arm, "arm.jsonl"))
        .map((r) => (r.gate as { corrections?: string } | null)?.corrections)
        .filter((c) => c !== undefined);
    expect(new Set(gates("on"))).toEqual(new Set(["on"]));
    expect(new Set(gates("off"))).toEqual(new Set(["off"]));
  });
});

describe("gate-miss halt (fail-closed)", () => {
  it("halts on the first gate miss, records it, refuses resume until an operator ack", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-miss-");
    const grader = missGrader();
    const r = await run(out, 0, { grader });
    expect(r.status).toBe("halted");
    expect(r.reason).toMatch(/integrity incident/);
    const root = stageRoot(out, 0);
    const [inc] = incidentStatus(root);
    expect(inc).toMatchObject({ acknowledged: false, problem: "no operator ack file" });
    const rec = JSON.parse(readFileSync(inc?.path as string, "utf8"));
    expect(rec).toMatchObject({
      kind: "gate-miss",
      trialKey: grader.injected,
      gateVerdict: "verified",
      graderStatus: "fail",
    });
    // Nothing started after the miss: it is the last attempt in its arm, the other arm of
    // its chunk did not run, and no ack was written by the runner.
    const arm = rec.arm as string;
    const progress = jsonl(join(root, arm, PROGRESS_FILE));
    expect(progress.at(-1)).toMatchObject({ event: "end", trialKey: grader.injected });
    const decided = progress.filter((l) => l.event === "end").length;
    expect(decided).toBeLessThan(10);
    expect(readdirSync(join(root, "incidents")).filter((f) => f.endsWith(".ack.json"))).toEqual([]);

    await expect(run(out, 0)).rejects.toThrow(AbRefusal);
    await expect(run(out, 0)).rejects.toThrow(/unacknowledged integrity incident/);
    expect(() =>
      ackIncident(root, inc?.id as string, {
        operator: "test operator",
        statement: "reviewed the record in full",
        incidentSha256: "0".repeat(64),
      }),
    ).toThrow(/read the record first/);
    // A hand-written ack without a statement is not an ack.
    writeFileSync(
      join(root, "incidents", `${inc?.id}.ack.json`),
      JSON.stringify({
        schema: "myco.pilot.ab-incident-ack/1",
        incidentSha256: inc?.sha256,
        operator: "x",
        statement: "",
      }),
    );
    await expect(run(out, 0)).rejects.toThrow(/no statement/);
    // A hand-written ack for another version of the record (wrong sha256) is not an ack.
    writeFileSync(
      join(root, "incidents", `${inc?.id}.ack.json`),
      JSON.stringify({
        schema: "myco.pilot.ab-incident-ack/1",
        incidentSha256: "2".repeat(64),
        operator: "test operator",
        statement: "reviewed some other record entirely",
      }),
    );
    await expect(run(out, 0)).rejects.toThrow(/different incident sha256/);
    writeFileSync(
      join(root, "incidents", `${inc?.id}.ack.json`),
      JSON.stringify({
        schema: "myco.pilot.ab-incident-ack/1",
        incidentSha256: inc?.sha256,
        operator: "test operator",
        statement: "reviewed the record; injected test failure, no gate defect",
      }),
    );
    expect(await run(out, 0)).toMatchObject({ status: "complete" });
  });

  it("a crash between deciding and grading is graded on resume, and a miss there halts", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-reconcile-");
    expect(await run(out, 0, { maxChunks: 1 })).toMatchObject({ status: "paused" });
    const root = stageRoot(out, 0);
    // Drop the grade of the last graded trial, as if the runner died before grading it.
    const armWithGrades = ["on", "off"].find(
      (a) => jsonl(join(root, a, "grades.jsonl")).length > 0,
    ) as string;
    const gpath = join(root, armWithGrades, "grades.jsonl");
    const grades = jsonl(gpath);
    const victim = grades.find((g) => g.status === "pass");
    writeFileSync(
      gpath,
      grades
        .filter((g) => g !== victim)
        .map((g) => `${JSON.stringify(g)}\n`)
        .join(""),
    );
    const grader = missGrader();
    const r = await run(out, 0, { grader });
    expect(grader.injected).toBe(victim?.trialKey);
    expect(r.status).toBe("halted");
    expect(incidentStatus(root)).toHaveLength(1);
  });
});

describe("gate-miss record is crash-safe and re-derived from the rows (D1)", () => {
  const steps: RecordStep[] = ["graded", "incident", "trial-record", "grade"];
  for (const step of steps)
    it(`a crash at "${step}" of recording a gate miss leaves the run halted on resume`, {
      timeout: 60_000,
    }, async () => {
      const out = tmp(`myco-ab-crash-${step}-`);
      const grader = stickyMissGrader();
      // The runner dies at `step` while recording the injected miss.
      const crashPoint = (s: RecordStep, key: string) => {
        if (s === step && key === grader.injected) throw new Crash(`crash at ${s}`);
      };
      await expect(run(out, 0, { grader, crashPoint })).rejects.toThrow(Crash);
      const key = grader.injected as string;
      expect(key).not.toBeNull();
      const root = stageRoot(out, 0);
      // Resume (same deterministic grader): never complete, never past the miss.
      const first = await resumeOutcome(run(out, 0, { grader }));
      expect(first).toMatch(/^(halted|refused): .*integrity incident/);
      const again = await resumeOutcome(run(out, 0, { grader }));
      expect(again).toMatch(/^(halted|refused): .*integrity incident/);
      // One incident record for the trial, unacknowledged; no record duplicated.
      const inc = incidentStatus(root);
      expect(inc.map((i) => i.id)).toEqual([`incident-${key}`]);
      expect(inc[0]?.acknowledged).toBe(false);
      const arm = JSON.parse(readFileSync(inc[0]?.path as string, "utf8")).arm as string;
      const count = (f: string) =>
        jsonl(join(root, arm, f)).filter((r) => r.trialKey === key).length;
      expect(count("grades.jsonl")).toBeLessThanOrEqual(1);
      expect(count("ab-trials.jsonl")).toBeLessThanOrEqual(1);
      // Only an operator ack lets it continue; then it completes with the miss on record,
      // each record exactly once.
      ack(root, `incident-${key}`);
      expect(await run(out, 0, { grader })).toMatchObject({ status: "complete" });
      expect(count("grades.jsonl")).toBe(1);
      expect(count("ab-trials.jsonl")).toBe(1);
      expect(jsonl(join(root, arm, "grades.jsonl")).find((g) => g.trialKey === key)?.status).toBe(
        "fail",
      );
      expect(incidentStatus(root)).toHaveLength(1);
      const pack = join(out, "pack");
      const m = exportAbPack(out, 0, pack, ROOT);
      expect(m.gateMisses).toEqual([{ arm, trialKey: key, incident: `incident-${key}` }]);
      expect(checkAbPack(pack, ROOT)).toMatchObject({ ok: true });
    });

  it("an incident lost after its grade was written is re-derived on resume and halts", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-lost-");
    const grader = missGrader();
    expect((await run(out, 0, { grader })).status).toBe("halted");
    const root = stageRoot(out, 0);
    // The verifier's probe: the on-disk state of a crash between grade and incident.
    rmSync(join(root, "incidents"), { recursive: true });
    const r = await run(out, 0);
    expect(r.status).toBe("halted");
    expect(r.reason).toMatch(
      new RegExp(`integrity incident, the gate VERIFIED ${grader.injected}`),
    );
    const [inc] = incidentStatus(root);
    expect(inc).toMatchObject({ id: `incident-${grader.injected}`, acknowledged: false });
    expect(JSON.parse(readFileSync(inc?.path as string, "utf8")).rule).toMatch(
      /re-derived on resume/,
    );
    await expect(run(out, 0)).rejects.toThrow(/unacknowledged integrity incident/);
  });

  it("a malformed incident record can never be acknowledged and keeps the run halted", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-badinc-");
    const grader = missGrader();
    await run(out, 0, { grader });
    const root = stageRoot(out, 0);
    const [inc] = incidentStatus(root);
    writeFileSync(inc?.path as string, "{}\n");
    const st = incidentStatus(root)[0];
    expect(st?.problem).toMatch(/not a valid gate-miss incident record/);
    expect(() =>
      ackIncident(root, st?.id as string, {
        operator: "test operator",
        statement: "reviewed the record in full",
        incidentSha256: st?.sha256 as string,
      }),
    ).toThrow(/not a valid gate-miss incident record/);
    await expect(run(out, 0)).rejects.toThrow(/unacknowledged integrity incident/);
  });

  it("export and check-pack re-derive gate misses from the rows, never trusting a flag", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-derive-");
    const grader = missGrader();
    await run(out, 0, { grader });
    const root = stageRoot(out, 0);
    const key = grader.injected as string;
    ack(root, `incident-${key}`);
    expect(await run(out, 0)).toMatchObject({ status: "complete" });
    const good = join(out, "pack");
    expect(exportAbPack(out, 0, good, ROOT).gateMisses).toHaveLength(1);
    expect(checkAbPack(good, ROOT)).toMatchObject({ ok: true });

    // Export: a miss in the rows with its incident record gone is refused.
    const lost = tmp("myco-ab-derive-lost-");
    cpSync(out, lost, { recursive: true });
    rmSync(join(stageRoot(lost, 0), "incidents"), { recursive: true });
    expect(() => exportAbPack(lost, 0, join(lost, "pack2"), ROOT)).toThrow(
      new RegExp(`${key} is a gate miss .* no valid incident record`),
    );

    // check-pack: strip the incident and every flag naming it; the rows still show the miss.
    const strip = join(tmp("myco-ab-strip-"), "pack");
    cpSync(good, strip, { recursive: true });
    rmSync(join(strip, "incidents"), { recursive: true });
    const m = JSON.parse(readFileSync(join(strip, "ab-pack.json"), "utf8"));
    m.incidents = [];
    m.gateMisses = [];
    writeFileSync(join(strip, "ab-pack.json"), JSON.stringify(m));
    const c = checkAbPack(strip, ROOT);
    expect(c.ok).toBe(false);
    expect(c.errors.join("; ")).toMatch(
      new RegExp(`${key} is a gate miss .* no valid incident record in the pack`),
    );

    // check-pack: a grade turned from pass to fail on a VERIFIED row is a miss with no record.
    const flip = join(tmp("myco-ab-flip-"), "pack");
    cpSync(good, flip, { recursive: true });
    let flipped: string | null = null;
    for (const arm of ["on", "off"]) {
      const rows = jsonl(join(flip, arm, "arm.jsonl"));
      const gpath = join(flip, arm, "grades.jsonl");
      const grades = jsonl(gpath);
      const victim = rows.find(
        (r) =>
          (r.gate as { verdict?: string } | null)?.verdict === "verified" &&
          r.trialKey !== key &&
          grades.find((g) => g.trialKey === r.trialKey)?.status === "pass",
      );
      if (victim === undefined || flipped !== null) continue;
      flipped = victim.trialKey as string;
      writeFileSync(
        gpath,
        grades
          .map((g) => (g.trialKey === flipped ? { ...g, status: "fail" } : g))
          .map((g) => `${JSON.stringify(g)}\n`)
          .join(""),
      );
    }
    expect(flipped).not.toBeNull();
    const f = checkAbPack(flip, ROOT);
    expect(f.ok).toBe(false);
    expect(f.errors.join("; ")).toMatch(new RegExp(`${flipped} is a gate miss`));
    expect(f.errors.join("; ")).toMatch(/gateMisses is not what the rows show/);

    // check-pack: a dropped grade (a row with no grade) is refused, never read as a pass.
    const drop = join(tmp("myco-ab-drop-"), "pack");
    cpSync(good, drop, { recursive: true });
    const g0 = jsonl(join(drop, "on", "grades.jsonl"));
    writeFileSync(
      join(drop, "on", "grades.jsonl"),
      g0
        .slice(1)
        .map((g) => `${JSON.stringify(g)}\n`)
        .join(""),
    );
    expect(checkAbPack(drop, ROOT).errors.join("; ")).toMatch(
      /on: \d+ grade\(s\) for \d+ row\(s\)/,
    );

    // check-pack: a listed incident whose record differs from the manifest's sha256.
    const edit = join(tmp("myco-ab-edit-"), "pack");
    cpSync(good, edit, { recursive: true });
    const ip = join(edit, "incidents", `incident-${key}.json`);
    const rec = JSON.parse(readFileSync(ip, "utf8"));
    writeFileSync(ip, JSON.stringify({ ...rec, at: "1970-01-01T00:00:00.000Z" }));
    expect(checkAbPack(edit, ROOT).errors.join("; ")).toMatch(
      /not listed in ab-pack.json with its sha256/,
    );
  });

  it("Stage 1 needs a complete Stage 0, and is refused when Stage 0's rows show a miss", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-s1-");
    await expect(run(out, 1)).rejects.toThrow(/Stage 1 starts only after Stage 0 is complete/);
    expect(await run(out, 0, { maxChunks: 1 })).toMatchObject({ status: "paused" });
    await expect(run(out, 1)).rejects.toThrow(/Stage 1 starts only after Stage 0 is complete/);
    expect(await run(out, 0)).toMatchObject({ status: "complete" });
    // A Stage 0 grade flipped to fail on a VERIFIED row, with no incident file at all.
    const root = stageRoot(out, 0);
    let flipped = false;
    for (const arm of ["on", "off"]) {
      if (flipped) break;
      const verified = new Set(
        [...loadLedger(join(root, arm, PROGRESS_FILE)).byTask.values()]
          .flat()
          .filter((r) => r.end?.outcome === "decided" && r.end.armRow?.gate?.verdict === "verified")
          .map((r) => r.start.trialKey),
      );
      const gpath = join(root, arm, "grades.jsonl");
      const grades = jsonl(gpath);
      const victim = grades.find((g) => verified.has(g.trialKey as string) && g.status === "pass");
      if (victim === undefined) continue;
      flipped = true;
      writeFileSync(
        gpath,
        grades
          .map((g) => (g === victim ? { ...g, status: "fail" } : g))
          .map((g) => `${JSON.stringify(g)}\n`)
          .join(""),
      );
    }
    expect(flipped).toBe(true);
    expect(existsSync(join(root, "incidents"))).toBe(false);
    await expect(run(out, 1)).rejects.toThrow(/rows show 1 gate miss/);
  });
});

describe("pacing, resume, #518 ledger and anchor", () => {
  it("runs one chunk per invocation, resumes, and writes every attempt to #518's ledger", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-chunks-");
    let n = 0;
    const driver = abFakeDriver(
      fakeDriver({
        beforeAgent: () => {
          n++;
          if (n === 3) throw new HarnessFault("timeout", "fake trial timed out");
          if (n === 5) throw new HarnessFault("transport-error", "fake transport dropped");
        },
      }),
    );
    const first = await run(out, 0, { driver, maxChunks: 1 });
    expect(first).toMatchObject({ status: "paused", chunksRun: 1, chunksDone: 1, chunks: 3 });
    expect(first.reason).toMatch(/per-invocation budget/);
    writeFileSync(join(out, "PAUSE"), "");
    expect(await run(out, 0, { driver })).toMatchObject({ status: "paused" });
    expect((await run(out, 0, { driver })).reason).toMatch(/PAUSE/);
    // A changed planner is a new A/B directory, never a resume.
    await expect(run(out, 0, { planner: "simulated:other" })).rejects.toThrow(/different plan/);
    const { rmSync } = await import("node:fs");
    rmSync(join(out, "PAUSE"));
    expect(await run(out, 0, { driver })).toMatchObject({ status: "complete", chunksDone: 3 });

    const root = stageRoot(out, 0);
    for (const arm of ["on", "off"]) {
      const armDir = join(root, arm);
      const events = jsonl(join(armDir, "attempts.jsonl"));
      const v = verifyAttemptLedger(events);
      expect(v.errors).toEqual([]);
      const state = loadLedger(join(armDir, PROGRESS_FILE));
      const attempts = [...state.byTask.values()].reduce((s, l) => s + l.length, 0);
      const unclassified = jsonl(join(armDir, "attempts-unclassified.jsonl")).length;
      expect(v.head.events).toBe(2 * attempts - unclassified);
      expect(
        events.every(
          (e) => e.arm === "myco-gate" && String(e.trialKey).startsWith(`ab-s0-${arm}-`),
        ),
      ).toBe(true);
      // The host-side anchor: outside the arm directory, its last entry is the ledger head.
      const anchor = anchorPathFor(armDir);
      expect(anchor.startsWith(armDir)).toBe(false);
      expect(jsonl(anchor).at(-1)).toMatchObject({
        events: v.head.events,
        headSha256: v.head.headSha256,
      });
      const recs = jsonl(join(armDir, "ab-trials.jsonl"));
      expect(recs.length).toBe(30);
      expect(new Set(recs.map((r) => r.resetBootClass))).toEqual(new Set(["cold"]));
    }
    // The harness fault: re-run in place, the faulted attempt kept and linked, in both ledgers.
    // A timeout is ended in #518 with its class; a transport error, which #518 cannot name, is
    // recorded beside it with its exact class (never a false class in the chain).
    const all = ["on", "off"].flatMap((a) => jsonl(join(root, a, "attempts.jsonl")));
    const faulted = all.filter((e) => e.outcome === "harness-fault");
    expect(faulted).toHaveLength(1);
    expect(faulted[0]).toMatchObject({ harnessClass: "timeout" });
    const side = ["on", "off"].flatMap((a) => jsonl(join(root, a, "attempts-unclassified.jsonl")));
    expect(side).toMatchObject([{ pilotHarnessClass: "transport-error" }]);
    const progress = ["on", "off"].flatMap((a) => jsonl(join(root, a, PROGRESS_FILE)));
    for (const key of [faulted[0]?.trialKey, side[0]?.trialKey])
      expect(progress.some((l) => l.supersedes === key)).toBe(true);
    const pack = join(out, "pack");
    const m = exportAbPack(out, 0, pack, ROOT);
    const counts = Object.values(m.attemptLedgers).map((l) => l.unclassifiedFaultEnds);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("closes a crashed attempt in #518's ledger, starting it first if needed", () => {
    const dir = join(tmp("myco-ab-sink-"), "arm");
    mkdirSync(join(dir, "trials"), { recursive: true });
    const sink = new R1AttemptSink(dir);
    sink.start({ trialKey: "k1", taskId: "fc-v1-001" });
    const again = new R1AttemptSink(dir);
    again.recoverCrash({ trialKey: "k1", taskId: "fc-v1-001" });
    again.recoverCrash({ trialKey: "k2", taskId: "fc-v1-002" });
    const v = verifyAttemptLedger(jsonl(join(dir, "attempts.jsonl")));
    expect(v.errors).toEqual([]);
    // `crash` has no name in #518's vocabulary: the attempts stay open there, never with a
    // false class, and their exact class is recorded beside the ledger.
    expect(v.events.map((e) => `${e.kind}:${e.trialKey}`)).toEqual(["start:k1", "start:k2"]);
    expect(jsonl(join(dir, "attempts-unclassified.jsonl"))).toMatchObject([
      { trialKey: "k1", pilotHarnessClass: "crash" },
      { trialKey: "k2", pilotHarnessClass: "crash" },
    ]);
    // Idempotent: a second recovery writes nothing more.
    new R1AttemptSink(dir).recoverCrash({ trialKey: "k1", taskId: "fc-v1-001" });
    expect(jsonl(join(dir, "attempts-unclassified.jsonl"))).toHaveLength(2);
    // A fault #518 can name (timeout) is ended there with its own class.
    const s3 = new R1AttemptSink(dir);
    s3.start({ trialKey: "k3", taskId: "fc-v1-003" });
    s3.end("k3", { outcome: "harness-fault", harnessClass: "timeout" });
    const v3 = verifyAttemptLedger(jsonl(join(dir, "attempts.jsonl")));
    expect(v3.errors).toEqual([]);
    expect(v3.events.at(-1)).toMatchObject({
      kind: "end",
      trialKey: "k3",
      harnessClass: "timeout",
    });
    expect(existsSync(anchorPathFor(dir))).toBe(true);
    expect(dirname(anchorPathFor(dir)).startsWith(dir)).toBe(false);
  });
});

describe("experiment-only: never R1 evidence, the OFF arm included", () => {
  it("both arms are refused by the shared evidence check and the pack CLI", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-ev-");
    await run(out, 0);
    const pack = join(out, "pack");
    exportAbPack(out, 0, pack, ROOT);
    expect(checkAbPack(pack, ROOT)).toMatchObject({ ok: true });
    for (const arm of ["on", "off"] as const) {
      expect(evidenceRefusals(pack, arm).join("; ")).toMatch(/experiment-only/);
      // Forge a real planner on the OFF arm's rows: still refused, on the label alone.
      const rows: Record<string, unknown>[] = jsonl(join(pack, arm, "arm.jsonl")).map((r) => ({
        ...r,
        plannerModelId: PILOT_MODEL,
      }));
      const grades = jsonl(join(pack, arm, "grades.jsonl"));
      const opts = {
        expectTrials: { "myco-gate": rows.length },
        expectUnregistrable: {
          "myco-gate": rows.filter(
            (r) => (r.gate as { unregistrable?: boolean } | null)?.unregistrable,
          ).length,
        },
        evidence: true,
      } as const;
      const errs = checkBenchmark(rows, grades, opts).errors;
      expect(errs.some((e) => /experiment-only/.test(e))).toBe(true);
      expect(errs.some((e) => /evidence provenance/.test(e))).toBe(false);
      // Mutation: without the label the OFF arm would no longer be refused by this rule.
      const unlabelled = rows.map(({ experiment: _e, ...r }) => r);
      expect(
        checkBenchmark(unlabelled, grades, opts).errors.some((e) => /experiment-only/.test(e)),
      ).toBe(false);
      expect(packProvenanceErrors(pack, rows).join("; ")).toMatch(/EXPERIMENT marker/);
      expect(packProvenanceErrors(join(out, "elsewhere"), rows).join("; ")).toMatch(
        /labelled experiment-only/,
      );
    }
    // The M2 pack CLI (what the scorecard check runs) refuses the A/B pack.
    const cli = spawnSync("npx", ["tsx", "scripts/m2-evidence-check.ts", pack], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toMatch(/EXPERIMENT marker/);
  });

  it("a pack whose recorded prereg hash is not the committed file's is refused", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-hash-");
    await run(out, 0);
    const pack = join(out, "pack");
    exportAbPack(out, 0, pack, ROOT);
    const m = JSON.parse(readFileSync(join(pack, "ab-pack.json"), "utf8"));
    m.prereg.markdownSha256 = "1".repeat(64);
    writeFileSync(join(pack, "ab-pack.json"), JSON.stringify(m));
    const c = checkAbPack(pack, ROOT);
    expect(c.ok).toBe(false);
    expect(c.errors.join("; ")).toMatch(/pre-registration sha256 1{64} is not the repository's/);
    const cli = spawnSync(
      "npx",
      ["tsx", "scripts/m2-corrections-ab-run.ts", "analyze", "--pack", pack],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    expect(cli.status).toBe(3);
  });
});

describe("check-pack refuses each tampered pack (survivors M4, M6, M8, M9; N4)", () => {
  it("unlabelled rows, the prereg JSON sha, the SIMULATED and EXPERIMENT markers", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-tamper-");
    await run(out, 0);
    const good = join(out, "pack");
    exportAbPack(out, 0, good, ROOT);
    expect(checkAbPack(good, ROOT)).toMatchObject({ ok: true });
    const variant = (name: string, mutate: (pack: string) => void) => {
      const pack = join(tmp(`myco-ab-${name}-`), "pack");
      cpSync(good, pack, { recursive: true });
      mutate(pack);
      const c = checkAbPack(pack, ROOT);
      expect(c.ok, name).toBe(false);
      return c.errors.join("; ");
    };
    expect(
      variant("unlabelled", (p) => {
        const rows = jsonl(join(p, "off", "arm.jsonl"));
        const { experiment: _e, ...first } = rows[0] as Record<string, unknown>;
        writeFileSync(
          join(p, "off", "arm.jsonl"),
          [first, ...rows.slice(1)].map((r) => `${JSON.stringify(r)}\n`).join(""),
        );
      }),
    ).toMatch(/off: 1 row\(s\) without the experiment label/);
    expect(
      variant("jsonsha", (p) => {
        const m = JSON.parse(readFileSync(join(p, "ab-pack.json"), "utf8"));
        m.prereg.jsonSha256 = "2".repeat(64);
        writeFileSync(join(p, "ab-pack.json"), JSON.stringify(m));
      }),
    ).toMatch(/corrections-ab-prereg\.json sha256 is not the repository's/);
    expect(variant("nosim", (p) => rmSync(join(p, "SIMULATED")))).toMatch(
      /simulated pack without its SIMULATED marker/,
    );
    expect(variant("noexp", (p) => rmSync(join(p, "EXPERIMENT")))).toMatch(/no EXPERIMENT marker/);
    expect(
      variant("anacfg", (p) => {
        const f = join(p, "on", "analysis-config.json");
        writeFileSync(
          f,
          JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), retryBudget: 9 }),
        );
      }),
    ).toMatch(/on: analysis-config\.json is not derived from run-config\.json/);
    // The row marker is #547's shape: the stage, the arm and the stage's seed.
    expect(jsonl(join(good, "off", "arm.jsonl"))[0]?.experiment).toEqual({
      id: "corrections-ab",
      stage: 0,
      arm: "off",
      seed: LOADED.prereg.stages["0"].seed,
    });
    // N4: `analyze` on a pack that passes, with #547 absent, is pending: never exit 0.
    const cli = spawnSync(
      "npx",
      ["tsx", "scripts/m2-corrections-ab-run.ts", "analyze", "--pack", good],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(cli.status).toBe(existsSync(join(ROOT, "scripts/m2-corrections-ab.ts")) ? 0 : 4);
  });

  it("launch plans: extra args only as the gate's own --corrections pair (survivor M3)", () => {
    const plan = (servers: Record<string, string[]>) => ({
      argv: ["claude"],
      mcpConfigPath: "/x/mcp.json",
      mcpServers: Object.fromEntries(
        Object.entries(servers).map(([n, args]) => [n, { command: "node", args, env: {} }]),
      ),
    });
    const off = plan({ "myco-gate": ["gate.js"], other: ["o.js"] });
    expect(
      compareLaunchPlans(
        plan({ "myco-gate": ["gate.js", "--corrections", "f"], other: ["o.js"] }),
        off,
      ),
    ).toEqual([]);
    expect(
      compareLaunchPlans(
        plan({ "myco-gate": ["gate.js"], other: ["o.js", "--corrections", "f"] }),
        off,
      ).join(),
    ).toMatch(/server other's args differ/);
    expect(
      compareLaunchPlans(
        plan({ "myco-gate": ["gate.js", "--verbose", "1"], other: ["o.js"] }),
        off,
      ).join(),
    ).toMatch(/server myco-gate's args differ/);
    expect(
      compareLaunchPlans(
        plan({ "myco-gate": ["gate.js", "--corrections"], other: ["o.js"] }),
        off,
      ).join(),
    ).toMatch(/server myco-gate's args differ/);
  });
});

describe("real runs are gated", () => {
  it("names every unmet precondition: no GO, the xlsx gate (#546 has merged)", () => {
    const r = realRunRefusals(ROOT, LOADED, 1, PUBLISHED).join("\n");
    expect(r).toMatch(/no lead GO/);
    expect(r).toMatch(
      /gate cannot read the task format: .* persist xlsx and the gate reads csv only/,
    );
    // #546 merged on main (the trial-ops schema has resetBootClass): no longer a refusal.
    expect(r).not.toMatch(/#546/);
    expect(r).toMatch(/#518's attempt-event vocabulary cannot name .*rate-limit/);
  });

  it("the CLI's launch prints the plan and refuses (exit 3) without starting anything", () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_BEARER|MYCO_ANTHROPIC)/.test(k),
      ),
    );
    const sha = abPlanSha256(LOADED, 0, PUBLISHED);
    const r = spawnSync(
      "npx",
      [
        "tsx",
        "scripts/m2-corrections-ab-run.ts",
        "launch",
        "--stage",
        "0",
        "--out",
        tmp(),
        "--launch-real-trials",
        "--plan-sha256",
        sha,
      ],
      { cwd: ROOT, encoding: "utf8", env },
    );
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).planSha256).toBe(sha);
    expect(r.stderr).toMatch(/gate cannot read the task format/);
    expect(r.stderr).toMatch(/no live driver is wired/);
  });

  /** A transport labelled live but fake (no model is called), counting transports started. */
  function countingLive(): PilotDriver & { started: number } {
    const inner = fakeDriver();
    const d = {
      simulated: false,
      started: 0,
      transport: (ctx: Parameters<PilotDriver["transport"]>[0]) => {
        d.started++;
        return inner.transport(ctx);
      },
    };
    return d;
  }

  it("runAbStage refuses every live run before any trial while a precondition is unmet (D2)", async () => {
    const sha = abPlanSha256(LOADED, 0, PUBLISHED);
    const cases: [string, Parameters<typeof run>[2], RegExp][] = [
      ["no flag, no sha", {}, /--launch-real-trials/],
      ["flag, wrong sha", { launchRealTrials: true, liveLaunchSha256: "x" }, /abPlanSha256/],
      ["sha, no flag", { liveLaunchSha256: sha }, /--launch-real-trials/],
      // Explicit flag and the printed plan's sha: still refused on the real-run preconditions.
      ["flag and sha", { launchRealTrials: true, liveLaunchSha256: sha }, /no lead GO/],
      [
        "fault injection on a live run",
        { launchRealTrials: true, liveLaunchSha256: sha, crashPoint: () => {} },
        /simulated runs only/,
      ],
    ];
    for (const [name, extra, want] of cases) {
      const live = countingLive();
      const out = tmp("myco-ab-live-");
      const p = run(out, 0, { ...extra, driver: live, planner: PILOT_MODEL });
      await expect(p, name).rejects.toThrow(AbRefusal);
      await expect(p, name).rejects.toThrow(want);
      await expect(p, name).rejects.toThrow(/no trial started/);
      expect(live.started, name).toBe(0);
      expect(existsSync(stageRoot(out, 0)), name).toBe(false);
    }
    // Every refusal names each unmet real-run precondition, Stage 0 included.
    const all = liveAbRefusals({
      repoRoot: ROOT,
      loaded: LOADED,
      stage: 0,
      published: PUBLISHED,
      launchRealTrials: true,
      liveLaunchSha256: sha,
    }).join("\n");
    expect(all).toMatch(/no lead GO/);
    expect(all).toMatch(/#518's attempt-event vocabulary/);
    expect(all).not.toMatch(/abPlanSha256|--launch-real-trials/);
  });

  it("runPilot itself refuses a live A/B arm config even with its own sha256 (defense in depth)", async () => {
    const clock = virtualClock(0);
    for (const arm of ["on", "off"] as const) {
      const cfg = armConfig(LOADED, 0, arm, PUBLISHED);
      const live = countingLive();
      const out = tmp("myco-ab-direct-");
      await expect(
        runPilot({
          config: cfg,
          published: PUBLISHED,
          outDir: out,
          repoRoot: ROOT,
          oracleSources: SOURCES,
          driver: live,
          plannerModelId: PILOT_MODEL,
          sleep: clock.sleep,
          now: clock.now,
          liveLaunchSha256: configSha256(cfg),
        }),
      ).rejects.toThrow(/refusing a live corrections A\/B trial: .*no lead GO/);
      expect(live.started).toBe(0);
      expect(existsSync(join(out, PROGRESS_FILE))).toBe(false);
    }
    // Corrections without an experiment, or a forged experiment, is refused too.
    const base = armConfig(LOADED, 0, "on", PUBLISHED);
    const { experiment: _e, ...noExp } = base;
    expect(liveExperimentRefusals(noExp, ROOT, PUBLISHED).join()).toMatch(/needs its experiment/);
    expect(
      liveExperimentRefusals(
        {
          ...base,
          experiment: { ...base.experiment, preregSha256: "0".repeat(64) },
        } as PilotConfig,
        ROOT,
        PUBLISHED,
      ).join(),
    ).toMatch(/another pre-registration/);
    expect(
      liveExperimentRefusals(
        { ...base, experiment: { name: "other", stage: 0, preregSha256: LOADED.markdownSha256 } },
        ROOT,
        PUBLISHED,
      ).join(),
    ).toMatch(/unknown experiment/);
  });

  it("realRunRefusals refuses an uncommitted pre-registration", () => {
    const root = tmp("myco-ab-uncommitted-");
    mkdirSync(join(root, "docs", "benchmark"), { recursive: true });
    cpSync(join(ROOT, PREREG_MD), join(root, PREREG_MD));
    cpSync(join(ROOT, PREREG_JSON), join(root, PREREG_JSON));
    const r = realRunRefusals(root, LOADED, 0, PUBLISHED).join("\n");
    expect(r).toMatch(
      /pre-registration: docs\/benchmark\/corrections-ab-prereg\.md is not committed/,
    );
    expect(realRunRefusals(ROOT, LOADED, 0, PUBLISHED).join("\n")).not.toMatch(/pre-registration:/);
  });

  it("a live trial needs a recorded cold reset (recordDecided's boot-class halt)", () => {
    const armDir = join(tmp("myco-ab-boot-"), "stage0", "on");
    mkdirSync(armDir, { recursive: true });
    const task = PUBLISHED.find((t) => t.taskId === stageTasks(LOADED, 0, PUBLISHED)[0]);
    if (task === undefined) throw new Error("no task");
    const grader: GradeFn = (t, _p, key) =>
      gradeRow(key, t.taskId, {
        graderVersion: "test",
        status: "fail",
        reasons: ["test"],
        fixtureSha256: t.fixtureSha256,
        persistedSha256: null,
        target: null,
        targetSatisfied: false,
        mismatches: [],
        mismatchCount: 0,
      } as unknown as Parameters<typeof gradeRow>[2]);
    const ctx = (live: boolean): HookContext => ({
      stageRoot: dirname(armDir),
      armDir,
      stage: 0,
      arm: "on",
      grader,
      live,
      now: () => 0,
      load1m: () => 0,
    });
    const armRow = {
      accepted: false,
      persistedSha256: null,
      gate: { called: true, verdict: "refuted" },
    };
    const decided = (key: string, resetBootClass: "cold" | "fast" | null) => ({
      task,
      trialKey: key,
      armRow: armRow as unknown as BenchmarkArmRow,
      persisted: null,
      resetBootClass,
    });
    expect(recordDecided(ctx(true), decided("k-null", null))).toMatch(/boot class is unrecorded/);
    expect(recordDecided(ctx(true), decided("k-fast", "fast"))).toMatch(/boot class is fast/);
    expect(recordDecided(ctx(true), decided("k-cold", "cold"))).toBeNull();
    expect(recordDecided(ctx(false), decided("k-sim", null))).toBeNull();
  });
});

describe("round 3: the pre-registered analysis command is the one run (D3)", () => {
  const template = LOADED.prereg.analysis.command;
  const declared = LOADED.markdownSha256;

  it("filled in for a pack, equals analysisCommand for both stages", () => {
    for (const pack of ["packs/ab-stage1", "/abs/packs/ab-stage1", "rel/pack/"])
      for (const stage of [0, 1] as const) {
        const filled = fillAnalysisCommand(template, {
          stage,
          pack,
          stage0Pack: "packs/ab-stage0",
          declared,
        });
        // analysisArgs reads the declared hash from the pack; none exists here, so swap it in.
        const run = analysisCommand(pack, stage, "packs/ab-stage0").replace(
          "<ab-pack.json prereg.markdownSha256>",
          declared,
        );
        expect(filled).toBe(run);
      }
    expect(template).toContain("--on-config <pack>/on/analysis-config.json");
    // Round 2's command (#547 refuses run-config.json) would no longer match.
    const stale = template.replaceAll("analysis-config.json", "run-config.json");
    expect(fillAnalysisCommand(stale, { stage: 0, pack: "p", stage0Pack: "s", declared })).not.toBe(
      analysisCommand("p", 0).replace("<ab-pack.json prereg.markdownSha256>", declared),
    );
  });

  it("the markdown states the same command as the JSON, and #547's row marker", () => {
    const md = readFileSync(join(ROOT, PREREG_MD), "utf8");
    const block = /## Analysis[\s\S]*?```\n([\s\S]*?)```/.exec(md)?.[1] ?? "";
    expect(block.replace(/\\\n\s*/g, "").trim()).toBe(template);
    expect(md).toContain('`experiment: {id: "corrections-ab", stage, arm, seed}`');
    expect(md).not.toMatch(/corrections-ab\/stage-<N>/);
  });

  it("analyze refuses when the pre-registered command is not the one it would run", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-cmd-");
    await run(out, 0);
    const pack = join(out, "pack");
    exportAbPack(out, 0, pack, ROOT);
    // A root whose committed JSON pins a different command (the pack re-pointed at it, so the
    // hash checks pass and only the command check can refuse).
    const root = tmp("myco-ab-cmd-root-");
    mkdirSync(join(root, "docs", "benchmark"), { recursive: true });
    cpSync(join(ROOT, PREREG_MD), join(root, PREREG_MD));
    const pj = JSON.parse(readFileSync(join(ROOT, PREREG_JSON), "utf8"));
    pj.analysis.command = pj.analysis.command.replaceAll("analysis-config.json", "run-config.json");
    writeFileSync(join(root, PREREG_JSON), `${JSON.stringify(pj, null, 2)}\n`);
    const m = JSON.parse(readFileSync(join(pack, "ab-pack.json"), "utf8"));
    m.prereg.jsonSha256 = createHash("sha256")
      .update(readFileSync(join(root, PREREG_JSON)))
      .digest("hex");
    writeFileSync(join(pack, "ab-pack.json"), JSON.stringify(m));
    expect(checkAbPack(pack, root).ok).toBe(true);
    const a = analyzeAbPack(pack, root);
    expect(a.status).toBe("refused");
    expect(a.errors.join(" ")).toMatch(/pre-registered analysis command .* is not the command/);
    // The committed pre-registration's command is the one run: #547 analyses Stage 0.
    const real = JSON.parse(readFileSync(join(pack, "ab-pack.json"), "utf8"));
    real.prereg.jsonSha256 = createHash("sha256")
      .update(readFileSync(join(ROOT, PREREG_JSON)))
      .digest("hex");
    writeFileSync(join(pack, "ab-pack.json"), JSON.stringify(real));
    expect(analyzeAbPack(pack, ROOT)).toMatchObject({ status: "analysed", exitCode: 0 });
  });
});

describe("round 3: the lead's GO file (survivor M-G, N2)", () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
      cwd,
      encoding: "utf8",
    });
  const repo = (go: string | null) => {
    const root = tmp("myco-ab-go-");
    mkdirSync(join(root, "docs", "benchmark"), { recursive: true });
    cpSync(join(ROOT, PREREG_MD), join(root, PREREG_MD));
    cpSync(join(ROOT, PREREG_JSON), join(root, PREREG_JSON));
    if (go !== null) writeFileSync(join(root, LEAD_GO_FILE), go);
    git(root, "init", "-q");
    git(root, "add", "-A");
    expect(git(root, "commit", "-q", "-m", "t").status).toBe(0);
    return root;
  };
  const go = (stages: unknown, sha = LOADED.markdownSha256) =>
    JSON.stringify({ preregSha256: sha, stages });

  it("a GO for Stage 0 approves Stage 0 only, never Stage 1", () => {
    const root = repo(go([0]));
    expect(leadGoProblems(root, LOADED, 0)).toEqual([]);
    expect(leadGoProblems(root, LOADED, 1).join()).toMatch(/does not approve Stage 1/);
    expect(realRunRefusals(root, LOADED, 1, PUBLISHED).join()).toMatch(/does not approve Stage 1/);
    expect(realRunRefusals(root, LOADED, 0, PUBLISHED).join()).not.toMatch(
      /lead GO|corrections-ab-go/,
    );
    expect(leadGoProblems(repo(go([0, 1])), LOADED, 1)).toEqual([]);
  });

  it("refuses a GO naming another pre-registration, a malformed GO, and an edited GO", () => {
    expect(leadGoProblems(repo(go([0, 1], "2".repeat(64))), LOADED, 0).join()).toMatch(
      /names another pre-registration/,
    );
    expect(leadGoProblems(repo(go("0")), LOADED, 0).join()).toMatch(/does not approve Stage 0/);
    expect(leadGoProblems(repo("not json"), LOADED, 0).join()).toMatch(/not a JSON object/);
    const edited = repo(go([0]));
    writeFileSync(join(edited, LEAD_GO_FILE), go([0, 1]));
    expect(leadGoProblems(edited, LOADED, 1).join()).toMatch(/differs from the committed copy/);
    const untracked = repo(null);
    writeFileSync(join(untracked, LEAD_GO_FILE), go([0]));
    expect(leadGoProblems(untracked, LOADED, 0).join()).toMatch(/is not committed/);
    expect(leadGoProblems(repo(null), LOADED, 0).join()).toMatch(/no lead GO/);
  });
});

describe("round 3: incident and ack guards (survivors M-A, M-B, M-E, M-H)", () => {
  const task = PUBLISHED.find((t) => t.taskId === stageTasks(LOADED, 0, PUBLISHED)[0]);
  if (task === undefined) throw new Error("no task");
  const failGrader: GradeFn = (t, _p, key) =>
    gradeRow(key, t.taskId, {
      graderVersion: "test",
      status: "fail",
      reasons: ["test"],
      fixtureSha256: t.fixtureSha256,
      persistedSha256: null,
      target: null,
      targetSatisfied: false,
      mismatches: [],
      mismatchCount: 0,
    } as unknown as Parameters<typeof gradeRow>[2]);
  const unit = (prefix: string, live = false) => {
    const armDir = join(tmp(prefix), "stage0", "on");
    mkdirSync(armDir, { recursive: true });
    const ctx: HookContext = {
      stageRoot: dirname(armDir),
      armDir,
      stage: 0,
      arm: "on",
      grader: failGrader,
      live,
      now: () => 0,
      load1m: () => 0,
    };
    return ctx;
  };
  const verified = (key: string) => ({
    task,
    trialKey: key,
    armRow: {
      accepted: true,
      persistedSha256: null,
      gate: { called: true, verdict: "verified" },
    } as unknown as BenchmarkArmRow,
    persisted: null,
    resetBootClass: "cold" as const,
  });

  it("M-A: a non-record file at the incident path halts the trial and is never acknowledged", () => {
    const ctx = unit("myco-ab-ma-");
    const dir = join(ctx.stageRoot, "incidents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "incident-k1.json"), "not a record\n");
    expect(recordDecided(ctx, verified("k1"))).toMatch(/HALTED: integrity incident/);
    expect(readFileSync(join(dir, "incident-k1.json"), "utf8")).toBe("not a record\n");
    expect(incidentStatus(ctx.stageRoot)[0]?.acknowledged).toBe(false);
  });

  it("M-B: a gate-verified row with no grade at all is a gate miss", () => {
    const rows = [
      { trialKey: "a", gate: { verdict: "verified" } },
      { trialKey: "b", gate: { verdict: "verified" } },
      { trialKey: "c", gate: { verdict: "refuted" } },
    ];
    expect(gateMissesFromRows(rows, new Map([["a", { status: "pass" }]]))).toEqual(["b"]);
  });

  it("M-E: a hand-written ack without an operator or statement is not an ack", () => {
    const ctx = unit("myco-ab-me-");
    expect(recordDecided(ctx, verified("k2"))).toMatch(/HALTED/);
    const [inc] = incidentStatus(ctx.stageRoot);
    if (inc === undefined) throw new Error("no incident");
    const ackPath = join(ctx.stageRoot, "incidents", `${inc.id}.ack.json`);
    const base = {
      schema: "myco.pilot.ab-incident-ack/1",
      incidentSha256: inc.sha256,
      statement: "reviewed the record in full",
      operator: "an operator",
    };
    for (const [patch, why] of [
      [{ operator: undefined }, /names no operator/],
      [{ operator: "  " }, /names no operator/],
      [{ statement: "ok" }, /no statement/],
      [{ incidentSha256: "3".repeat(64) }, /different incident sha256/],
      [{ schema: "x" }, /ack schema/],
    ] as const) {
      writeFileSync(ackPath, JSON.stringify({ ...base, ...patch }));
      const st = incidentStatus(ctx.stageRoot)[0];
      expect(st?.acknowledged).toBe(false);
      expect(st?.problem).toMatch(why);
    }
    writeFileSync(ackPath, JSON.stringify(base));
    expect(incidentStatus(ctx.stageRoot)[0]?.acknowledged).toBe(true);
  });

  it("M-H: a trial re-recorded after a crash has no boot class, so a live resume halts", {
    timeout: 60_000,
  }, async () => {
    const out = tmp("myco-ab-mh-");
    let crashed: string | null = null;
    const crashPoint = (s: RecordStep, key: string) => {
      if (s === "graded" && crashed === null) {
        crashed = key;
        throw new Crash("crash at graded");
      }
    };
    await expect(run(out, 0, { crashPoint })).rejects.toThrow(Crash);
    const root = stageRoot(out, 0);
    const arm = (["on", "off"] as const).find(
      (a) => loadLedger(join(root, a, PROGRESS_FILE)).byTask.size > 0,
    );
    if (arm === undefined) throw new Error("no arm ran");
    const ctx = (live: boolean): HookContext => ({
      stageRoot: root,
      armDir: join(root, arm),
      stage: 0,
      arm,
      grader: bundleGrader(BUNDLE),
      live,
      now: () => 0,
      load1m: () => 0,
    });
    expect(reconcileGrades(ctx(true), PUBLISHED)).toMatch(
      new RegExp(`${crashed}'s reset boot class is unrecorded`),
    );
    const rec = jsonl(join(root, arm, "ab-trials.jsonl")).find((r) => r.trialKey === crashed);
    expect(rec?.resetBootClass).toBeNull();
  });
});
