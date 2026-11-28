/**
 * Track L — L-infra (capability-spec §L stage 1): the zero-contamination run, its analysis,
 * and the committed result.
 *
 * - The task set: fc-v1's 90 satisfiable tasks, checked against the committed bundle.
 * - The analysis: every guardrail that rows can show flips `meets` on its own.
 * - A real run on `linux-plain` (Linux only) with the hermetic file agent: 0 events over 270
 *   trials, the positive control detected, and a level the host's caps refuse recorded, not
 *   forced.
 * - The committed result (docs/product/l-infra/linux-plain-v1) recomputes byte for byte from
 *   its committed rows, and meets.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedFileAgent } from "../../src/parallel/agents.ts";
import { requirementsFor } from "../../src/parallel/cli.ts";
import {
  FC_V1_BUNDLE,
  L_INFRA_ROW_SCHEMA,
  L_INFRA_RUN_SCHEMA,
  LInfraRefused,
  type LInfraRow,
  type LInfraRun,
  loadSatisfiableTasks,
  runLInfra,
} from "../../src/parallel/l-infra.ts";
import {
  analyzeLInfra,
  MIN_TRIALS,
  RESULT_FILE,
  ROWS_FILE,
  RUN_FILE,
  recomputeLInfra,
  resultFileOf,
  serializeResult,
  serializeRows,
  serializeRun,
} from "../../src/parallel/l-infra-analysis.ts";
import { mainAnalyze, parseRunArgs, provenanceFromEnv } from "../../src/parallel/l-infra-cli.ts";
import { linuxBackend } from "../../src/parallel/linux-backend.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const COMMITTED = join(ROOT, "docs", "product", "l-infra", "linux-plain-v1");
const SET = loadSatisfiableTasks();

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mli-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("the task set: fc-v1's satisfiable tasks, checked against the bundle", () => {
  it("has the 90 satisfiable tasks, the manifest hash, and fixture hashes", () => {
    expect(SET.version).toBe("fc-v1");
    expect(SET.tasks).toHaveLength(90);
    expect(new Set(SET.tasks.map((t) => t.taskId)).size).toBe(90);
    expect(SET.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SET.tasks.every((t) => /^[0-9a-f]{64}$/.test(t.fixtureSha256))).toBe(true);
  });

  it("refuses a bundle whose tasks.jsonl the manifest does not pin", () => {
    cpSync(FC_V1_BUNDLE, join(base, "b"), { recursive: true });
    const p = join(base, "b", "tasks.jsonl");
    writeFileSync(p, `${readFileSync(p, "utf8")}\n`);
    expect(() => loadSatisfiableTasks(join(base, "b"))).toThrow(LInfraRefused);
    expect(() => loadSatisfiableTasks(join(base, "b"))).toThrow(/does not match the manifest/);
  });

  it("refuses a bundle whose committed fixture differs from its task's hash", () => {
    cpSync(FC_V1_BUNDLE, join(base, "b"), { recursive: true });
    const first = SET.tasks[0];
    const line = readFileSync(join(FC_V1_BUNDLE, "tasks.jsonl"), "utf8").split("\n")[0] ?? "";
    const file = (JSON.parse(line) as { fixtureFile: string }).fixtureFile;
    writeFileSync(join(base, "b", file), "id,name\n");
    expect(() => loadSatisfiableTasks(join(base, "b"))).toThrow(
      new RegExp(`${first?.taskId}: committed fixture hash differs`),
    );
  });
});

// ---------------------------------------------------------------------------------------
// the analysis
// ---------------------------------------------------------------------------------------

const ISO = {
  backend: "linux-plain",
  kind: "process",
  privateRoot: true,
  hostDirsHidden: false,
  tmp: "env",
  network: "shared",
  processes: "process-group",
  display: { kind: "none" },
} as unknown as LInfraRow["isolation"];

function row(n: number, taskId: string, over: Partial<LInfraRow> = {}): LInfraRow {
  const t = SET.tasks.find((x) => x.taskId === taskId);
  return {
    schema: L_INFRA_ROW_SCHEMA,
    kind: "trial",
    n,
    runId: `li-n${n}-${taskId}`,
    taskId,
    fixtureSha256: t?.fixtureSha256 ?? "",
    agent: "scripted-file:honest",
    simulated: true,
    role: "trial",
    verdict: "verified",
    disqualifiers: ["shared-host-dirs"],
    foreignMarkers: [],
    ownMarkerSeen: true,
    teardown: { processesGone: true, rootRemoved: true },
    isolation: ISO,
    startOffsetMs: 0,
    elapsedMs: 10,
    ...over,
  };
}

function control(): LInfraRow[] {
  const id = SET.tasks[0]?.taskId ?? "";
  return [
    row(2, id, {
      kind: "control",
      role: "leaker",
      runId: "li-control-leaker",
      disqualifiers: ["shared-host-dirs", "leaked"],
    }),
    row(2, id, {
      kind: "control",
      role: "victim",
      runId: "li-control-victim",
      disqualifiers: ["shared-host-dirs", "contaminated"],
      foreignMarkers: ["li-control-leaker"],
    }),
  ];
}

function goodRun(levels: readonly number[] = [1, 2, 4]): { run: LInfraRun; rows: LInfraRow[] } {
  const rows = levels.flatMap((n) => SET.tasks.map((t) => row(n, t.taskId)));
  rows.push(...control());
  const run: LInfraRun = {
    schema: L_INFRA_RUN_SCHEMA,
    simulated: true,
    evidence: false,
    costEstimate: null,
    backend: "linux-plain",
    agent: "scripted-file:honest/none",
    display: "none",
    requirements: requirementsFor({ weak: true, display: "none" }),
    host: { cpus: 4, memoryMb: 16000, platform: "linux" },
    taskSet: {
      version: SET.version,
      manifestSha256: SET.manifestSha256,
      tasksSha256: SET.tasksSha256,
      satisfiable: SET.tasks.length,
    },
    levelsPlanned: [1, 2, 4, 8],
    levels: [1, 2, 4, 8].map((n) =>
      levels.includes(n)
        ? { n, admitted: true, problems: [], wallMs: 1000, peakConcurrent: n }
        : { n, admitted: false, problems: ["cpu"], wallMs: null, peakConcurrent: null },
    ),
    control: { n: 2, ran: true, problems: [] },
    provenance: { commit: null, runUrl: null, workflow: null },
    startedAt: "2026-11-27T00:00:00.000Z",
  };
  return { run, rows };
}

/** Replace the row of `taskId` at `n` with an edited copy. */
function edit(rows: LInfraRow[], n: number, taskId: string, over: Partial<LInfraRow>): LInfraRow[] {
  return rows.map((r) =>
    r.kind === "trial" && r.n === n && r.taskId === taskId ? { ...r, ...over } : r,
  );
}

const T = SET.tasks[5]?.taskId ?? "";

describe("analyzeLInfra: every guardrail flips meets on its own", () => {
  it("a clean run over 1, 2, 4 meets, with N = 8 listed as a deviation (not as specified)", () => {
    const { run, rows } = goodRun();
    const r = analyzeLInfra(run, rows, SET);
    expect(r.failures).toEqual([]);
    expect(r.meets).toBe(true);
    expect(r.meetsAsSpecified).toBe(false);
    expect(r.deviations).toEqual(["N=8 not admitted on this host: cpu"]);
    expect(r.trials).toBe(270);
    expect(r.contaminationEvents).toBe(0);
    expect(r.contaminationRateUpper95).toBeCloseTo(3 / 270, 6);
    expect(r.countedVerified).toBe(0);
    expect(r.positiveControl.detected).toBe(true);
    expect(r.simulated).toBe(true);
    expect(r.evidence).toBe(false);
  });

  it("all four levels admitted meets as specified", () => {
    const { run, rows } = goodRun([1, 2, 4, 8]);
    const r = analyzeLInfra(run, rows, SET);
    expect(r.meetsAsSpecified).toBe(true);
    expect(r.trials).toBe(360);
  });

  const breaks: [string, (g: { run: LInfraRun; rows: LInfraRow[] }) => LInfraRow[], RegExp][] = [
    [
      "a foreign canary in a trial",
      (g) => edit(g.rows, 2, T, { foreignMarkers: ["li-n2-x"] }),
      /1 contamination event/,
    ],
    [
      "a contaminated disqualifier alone",
      (g) => edit(g.rows, 4, T, { disqualifiers: ["shared-host-dirs", "contaminated"] }),
      /1 contamination event/,
    ],
    [
      "a leaked disqualifier alone",
      (g) => edit(g.rows, 1, T, { disqualifiers: ["shared-host-dirs", "leaked"] }),
      /1 contamination event/,
    ],
    ["own canary not seen", (g) => edit(g.rows, 1, T, { ownMarkerSeen: false }), /1 unscanned/],
    [
      "an incomplete scan",
      (g) => edit(g.rows, 2, T, { disqualifiers: ["shared-host-dirs", "scan-incomplete"] }),
      /1 unscanned/,
    ],
    [
      "a process left after teardown",
      (g) => edit(g.rows, 4, T, { teardown: { processesGone: false, rootRemoved: true } }),
      /1 teardown failure/,
    ],
    ["no teardown report", (g) => edit(g.rows, 4, T, { teardown: null }), /1 teardown failure/],
    [
      "a fixture hash that is not the task's",
      (g) => edit(g.rows, 1, T, { fixtureSha256: "0".repeat(64) }),
      /fixture hash mismatch/,
    ],
    [
      "a duplicate run id (case-folded)",
      (g) => edit(g.rows, 2, T, { runId: `LI-N1-${T.toUpperCase()}` }),
      /duplicate run id/,
    ],
    [
      "a task missing at a level",
      (g) => g.rows.filter((r) => !(r.n === 4 && r.taskId === T && r.kind === "trial")),
      /N=4: 1 task\(s\) missing/,
    ],
    [
      "an unexpected verdict",
      (g) => edit(g.rows, 1, T, { verdict: "refuted" }),
      /1 unexpected outcome/,
    ],
    [
      "a blocking disqualifier",
      (g) => edit(g.rows, 1, T, { disqualifiers: ["shared-host-dirs", "agent-error"] }),
      /1 unexpected outcome/,
    ],
    [
      "the control not detected",
      (g) =>
        g.rows.map((r) =>
          r.role === "victim"
            ? { ...r, foreignMarkers: [], disqualifiers: ["shared-host-dirs"] }
            : r,
        ),
      /positive control/,
    ],
    ["rows at a level that was not admitted", (g) => [...g.rows, row(8, T)], /not admitted/],
  ];
  it.each(breaks)("%s", (_name, mutate, failure) => {
    const g = goodRun();
    const r = analyzeLInfra(g.run, mutate(g), SET);
    expect(r.meets).toBe(false);
    expect(r.failures.join("; ")).toMatch(failure);
  });

  it(`fewer than ${MIN_TRIALS} trials does not meet`, () => {
    const g = goodRun([1, 2]);
    const r = analyzeLInfra(g.run, g.rows, SET);
    expect(r.trials).toBe(180);
    expect(r.meets).toBe(false);
    expect(r.failures).toContain(`180 trial(s), fewer than ${MIN_TRIALS}`);
  });

  it("a run whose task set is not the committed bundle does not meet", () => {
    const g = goodRun();
    const run = { ...g.run, taskSet: { ...g.run.taskSet, tasksSha256: "f".repeat(64) } };
    expect(analyzeLInfra(run, g.rows, SET).failures).toContain(
      "run.json: task set does not match the committed bundle",
    );
  });

  it("a row that claims not to be simulated does not meet", () => {
    const g = goodRun();
    const rows = g.rows.map((r, i) =>
      i === 0 ? ({ ...r, simulated: false } as unknown as LInfraRow) : r,
    );
    expect(analyzeLInfra(g.run, rows, SET).meets).toBe(false);
  });

  it("the control's events never count as L-infra events", () => {
    const g = goodRun();
    expect(analyzeLInfra(g.run, g.rows, SET).contaminationEvents).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// a real run (Linux, linux-plain, the hermetic file agent)
// ---------------------------------------------------------------------------------------

const CAPS = {
  memoryMbPerTrial: 512,
  cpusPerTrial: 1,
  cpuSecondsPerTrial: 60,
  trialTimeoutMs: 60_000,
};

describe.skipIf(process.platform !== "linux")("a real L-infra run on linux-plain", () => {
  it("270 trials at N = 1, 2, 4: 0 contamination events, every trial scanned, the control detected", async () => {
    const { run, rows } = await runLInfra({
      backend: linuxBackend(),
      requirements: requirementsFor({ weak: true, display: "none" }),
      runRoot: join(base, "pool"),
      levels: [1, 2, 4],
      agent: () => scriptedFileAgent("honest"),
      agentLabel: "scripted-file:honest/none",
      caps: CAPS,
    });
    const r = analyzeLInfra(run, rows, SET);
    expect(r.failures).toEqual([]);
    expect(r.meets).toBe(true);
    expect(r.trials).toBe(270);
    expect(r.contaminationEvents).toBe(0);
    expect(r.positiveControl).toEqual({
      ran: true,
      victimContaminated: true,
      leakerLeaked: true,
      detected: true,
    });
    // linux-plain never counts a trial.
    expect(r.countedVerified).toBe(0);
    for (const row of rows) expect(row.disqualifiers).toContain("shared-host-dirs");
    expect(run.levels.map((l) => l.peakConcurrent)).toEqual([1, 2, 4]);
  }, 240_000);

  it("a level the host's caps refuse is recorded as not admitted, never forced", async () => {
    const over = availableParallelism() + 1;
    const { run, rows } = await runLInfra({
      backend: linuxBackend(),
      requirements: requirementsFor({ weak: true, display: "none" }),
      runRoot: join(base, "pool"),
      levels: [over],
      taskSet: { ...SET, tasks: SET.tasks.slice(0, 2) },
      agent: () => scriptedFileAgent("honest"),
      agentLabel: "scripted-file:honest/none",
      caps: CAPS,
    });
    expect(run.levels).toEqual([
      {
        n: over,
        admitted: false,
        problems: [
          `maxConcurrent × cpusPerTrial = ${over} exceeds cpuBudget ${availableParallelism()}`,
        ],
        wallMs: null,
        peakConcurrent: null,
      },
    ]);
    expect(rows.filter((r) => r.kind === "trial")).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------
// the CLI
// ---------------------------------------------------------------------------------------

/** A meeting run's three files, as `myco-l-infra` writes them. */
function synthetic(dir: string): void {
  const g = goodRun();
  const runText = serializeRun(g.run);
  const rowsText = serializeRows(g.rows);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RUN_FILE), runText);
  writeFileSync(join(dir, ROWS_FILE), rowsText);
  writeFileSync(join(dir, RESULT_FILE), serializeResult(resultFileOf(runText, rowsText, SET)));
}

describe("the CLI", () => {
  it("myco-l-infra needs --allow-weak-isolation", () => {
    expect(() => parseRunArgs([])).toThrow(/--allow-weak-isolation is required/);
    expect(parseRunArgs(["--allow-weak-isolation", "--levels", "1,2"])).toMatchObject({
      levels: [1, 2],
      agent: "file",
    });
    expect(() => parseRunArgs(["--allow-weak-isolation", "--levels", "0"])).toThrow();
  });

  it("CI provenance comes from the runner's variables, null locally", () => {
    expect(
      provenanceFromEnv({
        GITHUB_SHA: "a".repeat(40),
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW: "CI",
        GITHUB_JOB: "safe-parallelism",
      }),
    ).toEqual({
      commit: "a".repeat(40),
      runUrl: "https://github.com/o/r/actions/runs/42/attempts/1",
      workflow: "CI / safe-parallelism",
    });
    expect(provenanceFromEnv({})).toEqual({ commit: null, runUrl: null, workflow: null });
  });

  it("myco-l-infra-analyze --check refuses a result.json that is not the recomputation", () => {
    synthetic(join(base, "c"));
    const lines: string[] = [];
    expect(mainAnalyze([join(base, "c"), "--check"], (t) => lines.push(t))).toBe(0);
    const p = join(base, "c", RESULT_FILE);
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace('"contaminationEvents": 0', '"contaminationEvents": 1'),
    );
    expect(mainAnalyze([join(base, "c"), "--check"], (t) => lines.push(t))).toBe(1);
    expect(lines.join("\n")).toMatch(/MISMATCH/);
  });

  it("myco-l-infra-analyze refuses rows edited after the fact (the result no longer matches)", () => {
    synthetic(join(base, "c"));
    const p = join(base, "c", ROWS_FILE);
    const text = readFileSync(p, "utf8");
    writeFileSync(p, text.replace('"foreignMarkers":[]', '"foreignMarkers":["li-n1-x"]'));
    expect(mainAnalyze([join(base, "c"), "--check"], () => {})).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------
// the committed result
// ---------------------------------------------------------------------------------------

// TEMPORARY (first push only, before CI has produced the result): removed in the commit that
// adds the committed result, after which this block never skips.
describe.skipIf(!existsSync(COMMITTED))(
  "the committed L-infra result (docs/product/l-infra/linux-plain-v1)",
  () => {
    it("exists", () => {
      for (const f of [RUN_FILE, ROWS_FILE, RESULT_FILE])
        expect(existsSync(join(COMMITTED, f)), f).toBe(true);
    });

    it("recomputes byte for byte from its committed run.json and rows.jsonl", () => {
      const recomputed = recomputeLInfra(COMMITTED, SET);
      expect(readFileSync(join(COMMITTED, RESULT_FILE), "utf8")).toBe(serializeResult(recomputed));
    });

    it("meets: 0 contamination events over at least 200 real-Calc trials, control detected", () => {
      const r = recomputeLInfra(COMMITTED, SET);
      expect(r.failures).toEqual([]);
      expect(r.meets).toBe(true);
      expect(r.trials).toBeGreaterThanOrEqual(MIN_TRIALS);
      expect(r.contaminationEvents).toBe(0);
      expect(r.unscanned).toBe(0);
      expect(r.positiveControl.detected).toBe(true);
      expect(r.backend).toBe("linux-plain");
      expect(r.agent).toBe("calc-actuator:honest/xvfb");
      expect(r.simulated).toBe(true);
      expect(r.evidence).toBe(false);
      expect(r.countedVerified).toBe(0);
    });

    it("came from public CI on this repo, at a named commit", () => {
      const r = recomputeLInfra(COMMITTED, SET);
      expect(r.provenance.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(r.provenance.runUrl).toMatch(
        /^https:\/\/github\.com\/kodingcills\/Myco\/actions\/runs\/\d+\/attempts\/\d+$/,
      );
      expect(r.provenance.workflow).toMatch(/\/ safe-parallelism$/);
    });
  },
);
