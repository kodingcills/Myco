/**
 * Track E follow-up: the corrections ON/OFF A/B runner and its pre-registration
 * (`src/pilot/ab.ts`, `scripts/m2-corrections-ab-run.ts`, `docs/benchmark/corrections-ab-prereg.*`).
 * Fake transports only: no model, no `claude` process, no VM, $0.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBenchmark } from "../../src/benchmark/check.ts";
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
  armConfig,
  bundleGrader,
  checkAbPack,
  diffArmConfigs,
  evidenceRefusals,
  exportAbPack,
  type GradeFn,
  incidentStatus,
  launchPlanDiff,
  loadPrereg,
  PREREG_JSON,
  PREREG_MD,
  R1AttemptSink,
  realRunRefusals,
  runAbStage,
  stageRoot,
  stageTasks,
} from "../../src/pilot/ab.ts";
import { abDryRun } from "../../src/pilot/ab-dry-run.ts";
import { PILOT_MODEL } from "../../src/pilot/config.ts";
import { fakeDriver, virtualClock } from "../../src/pilot/dry-run.ts";
import { correctionsArgs } from "../../src/pilot/launch.ts";
import { loadLedger, PROGRESS_FILE } from "../../src/pilot/ledger.ts";
import { HarnessFault, type PilotDriver } from "../../src/pilot/runner.ts";
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
    expect(c.errors.join("; ")).toMatch(/pre-registration sha256 1{64} is not the committed/);
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

describe("real runs are gated", () => {
  it("names every unmet precondition: no GO, the xlsx gate, #546", () => {
    const r = realRunRefusals(ROOT, LOADED, 1, PUBLISHED).join("\n");
    expect(r).toMatch(/no lead GO/);
    expect(r).toMatch(
      /gate cannot read the task format: .* persist xlsx and the gate reads csv only/,
    );
    expect(r).toMatch(/#546's cold-boot guard is not merged/);
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

  it("a live driver needs the approved plan sha, and a live trial needs a recorded cold reset", {
    timeout: 60_000,
  }, async () => {
    // A transport labelled live but fake: no model is called; the runner cannot tell.
    const inner = fakeDriver();
    const live: PilotDriver = { simulated: false, transport: (ctx) => inner.transport(ctx) };
    const out = tmp("myco-ab-live-");
    await expect(
      run(out, 0, { driver: live, planner: PILOT_MODEL, liveLaunchSha256: "x" }),
    ).rejects.toThrow(/abPlanSha256/);
    const r = await run(out, 0, {
      driver: live,
      planner: PILOT_MODEL,
      liveLaunchSha256: abPlanSha256(LOADED, 0, PUBLISHED),
    });
    expect(r.status).toBe("halted");
    expect(r.reason).toMatch(/boot class is unrecorded/);
  });
});
