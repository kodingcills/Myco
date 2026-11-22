import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credulous, fileOnly, honestReread } from "../../src/foundry/baseline/arms/index.ts";
import {
  armRegistry,
  baselineArmTable,
  baselineStatusMarkdown,
  economicsLine,
} from "../../src/foundry/baseline/registry.ts";
import type { Fault } from "../../src/foundry/faults/index.ts";
import { baselineReport, metrics } from "../../src/foundry/grader/baseline-report.ts";
import { runArm } from "../../src/foundry/grader/baseline-runner.ts";
import {
  commitment,
  fixtureHash,
  generateHiddenFixtures,
  publicFixtureHash,
} from "../../src/foundry/hidden-split/index.ts";
import { summarise } from "../../src/foundry/oracles/blind.ts";
import { scoreReport } from "../../src/foundry/oracles/report.ts";
import { findTask, TODO_TASKS, taskFixture } from "../../src/foundry/tasks/bank.ts";

const faults: Fault[] = [
  "stale-ui",
  "interrupted-write",
  "partial-persistence",
  "crash-mid-save",
  "permission-denied",
];
const options = {
  faults: faults.map((fault) => ({ fault, version: 1, seed: 1 })),
  seeds: [1, 2, 3],
  hiddenSplitVersion: 1,
  commitmentRoot: "a".repeat(64),
};
const task = TODO_TASKS[3]!;
describe("baseline", () => {
  it("records credulous false successes and never verifies faulted runs", () => {
    const rows = runArm(credulous, [task], options);
    expect(
      rows.filter((r) => r.faultClass !== null).every((r) => r.result.verdict !== "verified"),
    ).toBe(true);
    expect(rows.some((r) => r.result.falseSuccess)).toBe(true);
    expect(rows.some((r) => r.ledger?.oracle === "ground-truth:false")).toBe(true);
  });
  it("reports permission denial honestly", () => {
    const rows = runArm(honestReread, [task], { ...options, faults: [options.faults[4]!] });
    expect(
      rows
        .filter((r) => r.faultClass)
        .every(
          (r) => !r.selfReport.claimsSuccess && r.selfReport.text.includes("permission denied"),
        ),
    ).toBe(true);
  });
  it.each(faults.filter((fault) => fault !== "permission-denied"))(
    "repairs %s after rereading across all three seeds",
    (fault) => {
      const schedule = { ...options, faults: [{ fault, version: 1, seed: 1 }] };
      const recovered = runArm(honestReread, [task], schedule).filter(
        (row) => row.faultClass === fault,
      );
      const credulousRows = runArm(credulous, [task], schedule).filter(
        (row) => row.faultClass === fault,
      );
      expect(
        recovered.map((row) => [row.seed, row.result.verdict, row.recoveryEvent?.type]),
      ).toEqual([1, 2, 3].map((seed) => [seed, "verified", "recovery"]));
      expect(credulousRows.map((row) => [row.result.verdict, row.recoveryEvent])).toEqual(
        [1, 2, 3].map(() => [
          fault === "interrupted-write" || fault === "crash-mid-save" ? "uncertain" : "refuted",
          null,
        ]),
      );
    },
  );
  it("does not credit an unchanged resave or a resave without a GUI reread", () => {
    const resave = (reread: boolean) => ({
      ...credulous,
      run(
        job: Parameters<typeof credulous.run>[0],
        env: Parameters<typeof credulous.run>[1],
        budget: number,
      ) {
        const claim = credulous.run(job, env, budget);
        env.press("launch");
        if (reread) env.screen();
        env.click("save");
        return claim;
      },
    });
    for (const [job, reread] of [
      [task, false],
      [TODO_TASKS[2]!, true],
    ] as const) {
      const rows = runArm(resave(reread), [job], {
        ...options,
        seeds: [1, 3, 5],
        faults: [{ fault: "partial-persistence", version: 1, seed: 1 }],
      });
      expect(
        rows.filter((row) => row.faultClass).map((row) => [row.result.verdict, row.recoveryEvent]),
      ).toEqual([1, 3, 5].map(() => ["verified", null]));
    }
  });
  it("changes false-success accounting without changing the verdict when the claim is flipped", () => {
    const flipped = {
      ...credulous,
      run(...args: Parameters<typeof credulous.run>) {
        const claim = credulous.run(...args);
        return { ...claim, claimsSuccess: !claim.claimsSuccess };
      },
    };
    const schedule = { ...options, faults: [options.faults[0]!] };
    const [original, changed] = [credulous, flipped].map((arm) => runArm(arm, [task], schedule));
    expect(changed?.map((row) => [row.result.verdict, row.result.traceGuard])).toEqual(
      original?.map((row) => [row.result.verdict, row.result.traceGuard]),
    );
    expect(original?.filter((row) => row.result.falseSuccess)).toHaveLength(3);
    expect(changed?.filter((row) => row.result.falseSuccess)).toHaveLength(0);
  });
  it("hashes the actual public fixture and intent for every row, including controls", () => {
    const fixture = taskFixture(task);
    const rows = runArm(credulous, [task], options);
    expect(new Set(rows.map((row) => row.fixtureHash))).toEqual(
      new Set([publicFixtureHash(fixture, task.intent)]),
    );
    const changed = runArm(credulous, [task], {
      ...options,
      taskSource: { resolve: () => ({ fixture: { ...fixture, version: fixture.version + 1 } }) },
    });
    expect(changed[0]?.fixtureHash).toMatch(/^[a-f0-9]{64}$/);
    expect(changed[0]?.fixtureHash).not.toBe(rows[0]?.fixtureHash);
  });
  it("records the direct write as a guard refusal", () => {
    const rows = runArm(fileOnly, [task], options);
    expect(
      rows.every(
        (r) => r.result.traceGuard.status === "file-io-shortcut" && r.result.verdict === "refuted",
      ),
    ).toBe(true);
  });
  it("keeps the window closed and ignores save attempts before launch", () => {
    const neverLaunch = {
      ...credulous,
      run(
        job: Parameters<typeof credulous.run>[0],
        env: Parameters<typeof credulous.run>[1],
        budget: number,
      ) {
        expect(env.screen().reachable).toBe(false);
        return credulous.run(job, { ...env, press() {} }, budget);
      },
    };
    const rows = runArm(neverLaunch, [task], { ...options, faults: [] });
    expect(rows.map((row) => row.result.verdict)).toEqual(["uncertain", "uncertain", "uncertain"]);
  });
  it("denies zero-false-success claims for scheduled faults that never armed", () => {
    const trusted = commitment([]);
    const noSave = {
      ...credulous,
      run() {
        return { claimsSuccess: false, text: "no save attempted" };
      },
    };
    const rows = runArm(noSave, [task], {
      ...options,
      faults: [options.faults[0]!],
      commitmentRoot: trusted.rootHash,
      seeds: Array.from({ length: 30 }, (_, seed) => seed),
    });
    expect(rows.filter((row) => row.faultClass && !row.faultEvent && !row.ledger)).toHaveLength(30);
    const report = baselineReport(rows, true, trusted).arms[0]!;
    expect(report.metrics.recovery).toBe("unknown");
    expect(report.score.unarmed).toBe(30);
    expect(report.score.breakdown).toEqual({});
    expect(report.score.claims.canClaimZeroFalseSuccess).toEqual({
      allowed: false,
      reasons: ["Scheduled faults went unarmed", "Fewer than 30 corrupted trials"],
      exactUpper95: null,
    });
  });
  it("compares only matching trial schedules and rejects duplicate trials", () => {
    const trusted = commitment([]);
    const schedule = { ...options, commitmentRoot: trusted.rootHash };
    const a = runArm(credulous, [task], schedule);
    const b = runArm(honestReread, [task], schedule);
    expect(baselineReport([...a, ...b.toReversed()], true, trusted).arms).toHaveLength(2);
    expect(() => baselineReport([...a, ...b.slice(1)], true, trusted)).toThrow(
      /identical trial schedules/,
    );
    for (const changes of [{ promptHash: "0".repeat(64) }, { budget: 200 }]) {
      expect(() =>
        baselineReport([...a, ...b.map((row) => ({ ...row, ...changes }))], true, trusted),
      ).toThrow(/identical trial schedules/);
    }
    expect(() => baselineReport([...a, a[0]!], true, trusted)).toThrow(/Duplicate baseline trials/);
  });
  it("keeps unknown measurements separate and rejects mixed versions", () => {
    expect(metrics([]).completion.rate).toBe("unknown");
    expect(metrics([]).setup.steps).toBe("unknown");
    const rows = runArm(credulous, [task], options);
    expect(() =>
      baselineReport([rows[0]!, { ...rows[0]!, hiddenSplitVersion: 2 }], true, commitment([])),
    ).toThrow(/Mixed versions or commitments/);
    expect(
      metrics(rows.map((r) => ({ ...r, result: { ...r.result, verdict: "uncertain" as const } })))
        .completion.rate,
    ).toBe("unknown");
  });
  it("uses claims logic and rejects incompatible versions", () => {
    const trusted = commitment([]);
    const rows = runArm(credulous, [task], {
      ...options,
      hiddenSplitVersion: trusted.hiddenSplitVersion,
      commitmentRoot: trusted.rootHash,
    });
    const report = baselineReport(rows, true, trusted);
    expect(report.arms[0]!.score.claims.canClaimReliability.allowed).toBe(false);
    expect(report.arms[0]!.score.claims.canClaimReliability.reasons).toContain(
      "Normal trials must use the hidden split",
    );
    expect(rows.filter((r) => r.faultClass === null)).toHaveLength(3);
    expect(
      rows.filter((r) => r.faultClass === null).every((r) => r.result.faultVersion === 0),
    ).toBe(true);
    for (const key of ["fixtureVersion", "oracleVersion", "faultVersion"] as const) {
      const first = rows.find((r) => r.faultClass !== null)!;
      expect(() =>
        baselineReport(
          [first, { ...first, result: { ...first.result, [key]: 99 } }],
          true,
          trusted,
        ),
      ).toThrow(/Mixed versions or commitments/);
    }
    expect(() =>
      baselineReport([{ ...rows[0]!, commitmentRoot: "b".repeat(64) }], true, trusted),
    ).toThrow(/Mixed or invalid hidden split/);
    expect(report.couldNotRun).toHaveLength(5);
    expect(report.escalations).toHaveLength(5);
  });
  it("records torn stores as uncertain and keeps unmeasured metrics unknown", () => {
    const rows = runArm(credulous, [task], options);
    expect(
      rows
        .filter((r) => r.faultClass === "interrupted-write")
        .every((r) => r.result.verdict === "uncertain"),
    ).toBe(true);
    const m = metrics([]);
    expect(m.setup).toEqual({
      steps: "unknown",
      wallClock: "unknown",
      manualInterventions: "unknown",
    });
    // No rows means no arm, so the declared cost is unregistered rather than guessed.
    expect(m.economics).toEqual({
      tokens: "unknown",
      cost: "unknown",
      declared: "unregistered",
      plannerName: "unknown",
    });
    expect(m.recovery).toBe("unknown");
    expect(m.repeatability.spread).toBe("unknown");
  });
  it("states each arm's declared marginal cost, or why it is blocked", () => {
    // EF-005 acceptance: the economics column states the marginal cost OR
    // "blocked: account required" — never a blanket "unknown" that hides the difference
    // between an arm nobody has run and an arm nobody may run.
    const free = metrics(runArm(credulous, [task], options));
    expect(free.economics.declared).toBe("unregistered");

    const registered = armRegistry.map((arm) => economicsLine(arm.economics));
    // The planner is a paid API key, so no live arm may claim $0 marginal.
    expect(registered.some((line) => line.startsWith("$0 marginal"))).toBe(false);
    expect(registered.some((line) => line.startsWith("unmeasured (driver is MIT and free"))).toBe(
      true,
    );
    expect(registered.some((line) => line.startsWith("blocked: account required"))).toBe(true);
    // Sai is blocked on access AND environment; an account alone would not make it comparable.
    const sai = armRegistry.find((arm) => arm.id === "simular-sai")!;
    expect(economicsLine(sai.economics)).toContain("not our fixture host");
    // Every arm states something; none falls through to a bare "unknown".
    expect(registered.every((line) => line.length > 0 && line !== "unknown")).toBe(true);
  });

  it("runs committed synthetic hidden fixtures and derives claim eligibility", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-synthetic-"));
    try {
      const path = join(dir, "seed");
      writeFileSync(path, new Uint8Array(32).fill(42));
      const hidden = generateHiddenFixtures(readFileSync(path), 9);
      const trusted = commitment(hidden);
      const tasks = hidden.map((h, i) => ({
        taskId: `synthetic-${i}`,
        fixtureId: h.fixture.fixtureId,
        intent: h.intent,
        prompt: "synthetic task",
        minimumGuiActs: 1,
      }));
      const source = {
        resolve(t: typeof task) {
          const h = hidden.find((entry) => entry.fixture.fixtureId === t.fixtureId)!;
          return { fixture: h.fixture, committedFault: h.fault };
        },
      };
      const rows = runArm(credulous, tasks, {
        ...options,
        faults: [],
        hiddenSplitVersion: trusted.hiddenSplitVersion,
        commitmentRoot: trusted.rootHash,
        taskSource: source,
      });
      expect(rows).toHaveLength(108);
      expect(rows.every((r) => trusted.perFixtureHash.includes(r.fixtureHash))).toBe(true);
      expect(new Set(rows.map((r) => r.fixtureHash)).size).toBe(36);
      expect(rows.map((row) => row.fixtureHash)).toEqual(
        hidden.flatMap((entry) => [1, 2, 3].map(() => fixtureHash(entry))),
      );
      expect(
        baselineReport(rows, true, trusted).arms[0]!.score.claims.canClaimReliability.allowed,
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("requires distinct seeds and verifies unfaulted policies", () => {
    expect(() => runArm(credulous, [task], { ...options, seeds: [1, 1, 2] })).toThrow(
      /three distinct seeds/,
    );
    for (const arm of [credulous, honestReread]) {
      expect(
        runArm(arm, TODO_TASKS, { ...options, faults: [] })
          .filter((r) => r.faultClass === null)
          .map((r) => r.result.verdict),
      ).toEqual(Array.from({ length: 12 }, () => "verified"));
    }
  });
  it("enforces scorer version boundaries and computes metrics", () => {
    const trusted = commitment([]);
    const rows = runArm(credulous, [task], { ...options, commitmentRoot: trusted.rootHash });
    const faulted = rows.find((r) => r.faultClass !== null)!;
    expect(() => summarise([faulted.result, { ...faulted.result, faultVersion: 2 }])).toThrow(
      /version triple/,
    );
    expect(() => summarise([faulted.result, { ...faulted.result, faultVersion: 0 }])).toThrow(
      /version triple/,
    );
    expect(() =>
      scoreReport(
        [faulted, { ...faulted, result: { ...faulted.result, faultVersion: 2 } }],
        true,
        trusted,
        { allowUnfaulted: true },
      ),
    ).toThrow(/version triple/);
    expect(() => scoreReport(rows, true, trusted)).toThrow(/version triple/);
    expect(
      scoreReport(rows, true, trusted, { allowUnfaulted: true }).summary.version.faultVersions,
    ).toEqual([0, 1]);
    const base = faulted;
    const sample = [0, 1, 2].map((seed) => ({
      ...base,
      seed,
      faultClass: "stale-ui" as const,
      recovered: seed === 0,
      result: {
        ...base.result,
        verdict: seed === 0 ? ("verified" as const) : ("refuted" as const),
      },
    }));
    const m = metrics(sample);
    expect(m.recovery).toBeCloseTo(1 / 3);
    expect(m.repeatability.spread).toBe(1);
    expect(m.completion.interval![0]).toBeCloseTo(0.06149, 4);
    expect(m.completion.interval![1]).toBeCloseTo(0.79235, 4);
  });
  it("refuses a fixture whose store path the model harness does not hardcode", () => {
    // The simulation reads and writes "store.json" in relaunch, injectFault, recoverSave and
    // the oracle. A fixture designating another path must be refused up front, not fail deep
    // inside a JSON parse or, worse, grade against a companion file it never designated.
    const task = findTask("ef-t01-add-four-items")!;
    const base = taskFixture(task);
    if (base.initialState.kind !== "myco-todo") throw new Error("expected a myco-todo fixture");
    const moved = {
      ...base,
      initialState: { ...base.initialState, storePath: "store.v2.json" },
    };
    expect(() =>
      runArm(credulous, [task], {
        faults: [],
        seeds: [1, 2, 3],
        hiddenSplitVersion: 1,
        commitmentRoot: "r",
        taskSource: { resolve: () => ({ fixture: moved }) },
      }),
    ).toThrow(/hardcodes store\.json/);
  });

  it("names the live path when asked to simulate an app it cannot", () => {
    // A Writer or Calc task is not an error to hide: the message has to say where it goes
    // instead, or the next agent reads "Unsupported fixture" and re-implements the harness.
    const writerTask = {
      taskId: "ef-t05-writer-total",
      fixtureId: "ef-writer-autocorrect-v1",
      prompt: "set the total",
      intent: { kind: "writer.set-cell" as const, table: "Invoice", cell: "B3", value: "1" },
      minimumGuiActs: 3,
    };
    expect(() =>
      runArm(credulous, [writerTask], {
        faults: [],
        seeds: [1, 2, 3],
        hiddenSplitVersion: 1,
        commitmentRoot: "r",
      }),
    ).toThrow(/needs a live transport \(see baseline\/executor\.ts\)/);
  });

  it("documents every blocked arm and planner", () => {
    expect(armRegistry.every((a) => a.blocker && a.plannerName)).toBe(true);
    // The doc also carries prose sections the registry cannot know about, so pin the
    // generated arm table rather than the whole file.
    const doc = readFileSync("docs/foundry/baseline-status.md", "utf8");
    expect(doc).toContain(baselineArmTable());
    expect(doc.startsWith(baselineStatusMarkdown().split("## Live arms")[0]!)).toBe(true);
  });
});
