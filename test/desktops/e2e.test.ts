/**
 * Track U $0 end-to-end test: no model, no VM, no network, no API call.
 *
 * A scripted agent (test/fixtures/desktops/scripted-agent.mjs) runs in N disposable desktops
 * on the local-process backend, four at a time. For each trial the harness captures the
 * persisted bytes, hands them to the REAL gate (`createGate`, bound to that trial) through
 * the trial's evidence location, and to the REAL independent grader (`grade`), then exports
 * the dataset. The planner is a script, so every row is simulated and labelled so; none of
 * this is evidence of agent capability.
 *
 * The gate and grader are composed here, in the test, on purpose: src/desktops and
 * src/dataset import neither (test/desktops/import-boundary.test.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { datasetManifestSchema, datasetRecordSchema } from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { type ColumnType, GRADER_VERSION, grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { type ExportCandidate, ExportRefused, exportDataset } from "../../src/dataset/export.ts";
import { scanForLeaks } from "../../src/dataset/hygiene.ts";
import { type FleetOutcome, type FleetTrial, runFleet } from "../../src/desktops/fleet.ts";
import { LocalProcessBackend } from "../../src/desktops/local-process.ts";
import { parseTranscript } from "../../src/desktops/transcript.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";

const AGENT = resolve(import.meta.dirname, "..", "fixtures", "desktops", "scripted-agent.mjs");
const IMAGE = "myco-linux-desktop/1";
const COLUMN_TYPES: Record<string, ColumnType> = Object.fromEntries(
  FIXTURE_COLUMNS.map((c) => [c.name, c.type]),
);
const NOW = () => new Date("2026-11-26T16:00:00.000Z");

type Mode =
  | "honest"
  | "slow-honest"
  | "no-edit"
  | "wrong-row"
  | "no-claim"
  | "snoop"
  | "leak"
  | "crash";

interface TrialPlan {
  readonly i: number;
  readonly mode: Mode;
  readonly marker?: string;
}

function intentOf(i: number) {
  return {
    seed: `u-e2e-${i}`,
    rowKey: "EMP-0003",
    column: i % 2 === 0 ? "qty" : "name",
    newValue: i % 2 === 0 ? String(500 + i) : `REVISED-U${i}`,
  };
}

function instructionOf(i: number): string {
  const t = intentOf(i);
  return `Set record ${t.rowKey}, column ${t.column}, to "${t.newValue}", and save the sheet as doc.csv.`;
}

function trialOf(plan: TrialPlan): FleetTrial {
  const t = intentOf(plan.i);
  const fixture = generateFixture(t.seed).csv;
  return {
    trialKey: `u-task-${plan.i}/run-${plan.i}`,
    taskId: `u-task-${plan.i}`,
    runId: `run-${plan.i}`,
    image: IMAGE,
    seed: [
      { path: "fixture.csv", bytes: Buffer.from(fixture) },
      {
        path: "task.json",
        bytes: Buffer.from(
          JSON.stringify({
            rowKey: t.rowKey,
            column: t.column,
            newValue: t.newValue,
            mode: plan.mode,
            marker: plan.marker,
          }),
        ),
      },
    ],
    argv: [process.execPath, AGENT],
    capturePath: "doc.csv",
    canary: `canary-${plan.i}-${"q".repeat(12)}-${plan.mode}`,
    timeoutMs: 20_000,
  };
}

/** The harness side of one trial: real gate, real grader, then an export candidate. */
async function candidateOf(
  plan: TrialPlan,
  outcome: FleetOutcome,
  evidenceRoot: string,
): Promise<ExportCandidate> {
  const t = intentOf(plan.i);
  const fixtureCsv = Buffer.from(generateFixture(t.seed).csv);
  // The harness, never the agent, writes the captured bytes to the run's evidence location.
  if (outcome.capture !== null) {
    mkdirSync(join(evidenceRoot, outcome.runId), { recursive: true });
    writeFileSync(join(evidenceRoot, outcome.runId, "doc.csv"), outcome.capture.bytes);
  }
  const gate = createGate({
    tasks: buildRegistry([
      {
        id: outcome.taskId,
        family: "calc-record-edit",
        stateFile: "doc.csv",
        spec: { fixtureSeed: t.seed, rowKey: t.rowKey, column: t.column, newValue: t.newValue },
      },
    ]),
    reader: fileEvidenceReader(evidenceRoot),
    assignment: { taskId: outcome.taskId, runId: outcome.runId },
    now: NOW,
  });
  const claimText = parseTranscript(outcome.run?.stdout ?? "");
  const transcript = claimText.ok ? claimText : { steps: [], claim: { done: false, text: "" } };
  const gateResult = await gate.check({
    taskId: outcome.taskId,
    runId: outcome.runId,
    claim: transcript.claim.text,
  });
  const gradeResult = grade({
    fixtureCsv,
    fixtureSha256: sha256(fixtureCsv),
    persisted: outcome.capture === null ? null : { format: "csv", bytes: outcome.capture.bytes },
    intent: { rowKey: t.rowKey, column: t.column, newValue: t.newValue },
    columnTypes: COLUMN_TYPES,
  });
  return {
    trialKey: outcome.trialKey,
    taskId: outcome.taskId,
    runId: outcome.runId,
    family: "calc-record-edit",
    instruction: instructionOf(plan.i),
    fixtureSha256: sha256(fixtureCsv),
    steps: transcript.steps,
    claim: transcript.claim,
    gate: { source: "myco-gate", result: gateResult },
    grade: gradeResult,
    persisted:
      outcome.capture === null
        ? null
        : { path: outcome.capture.path, format: "csv", bytes: outcome.capture.bytes },
    provenance: {
      backend: outcome.backend,
      isolation: outcome.isolation,
      networkEnforced: outcome.networkEnforced,
      image: outcome.image,
      plannerModelId: null,
      simulated: true,
      harness: "test-desktops-e2e/1",
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
    },
  };
}

async function runBatch(plans: readonly TrialPlan[], concurrency: number) {
  const base = mkdtempSync(join(tmpdir(), "myco-u-e2e-"));
  const backend = new LocalProcessBackend({ baseDir: join(base, "desktops") });
  const trials = plans.map(trialOf);
  const fleet = await runFleet(backend, trials, { concurrency, now: NOW });
  const evidenceRoot = join(base, "evidence");
  mkdirSync(evidenceRoot);
  const candidates: ExportCandidate[] = [];
  for (const [k, plan] of plans.entries()) {
    candidates.push(await candidateOf(plan, fleet.outcomes[k]!, evidenceRoot));
  }
  return { base, fleet, candidates };
}

const MIXED: TrialPlan[] = [
  { i: 1, mode: "honest" },
  { i: 2, mode: "honest" },
  { i: 3, mode: "no-edit" },
  { i: 4, mode: "wrong-row" },
  { i: 5, mode: "no-claim" },
  { i: 6, mode: "crash" },
  { i: 7, mode: "honest" },
  { i: 8, mode: "honest" },
];

describe("track U end-to-end: fleet -> real gate + real grader -> dataset ($0)", () => {
  it("runs 8 trials 4 at a time, clean, and exports positives and labelled negatives only", async () => {
    const { base, fleet, candidates } = await runBatch(MIXED, 4);
    expect(fleet.clean).toBe(true);
    expect(fleet.contamination).toEqual([]);
    expect(fleet.maxConcurrent).toBeLessThanOrEqual(4);
    expect(fleet.maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(fleet.outcomes.map((o) => o.error)).toEqual(Array(8).fill(null));
    // Every desktop is gone after the batch.
    expect(fleet.outcomes.every((o) => o.isolation === "process" && !o.networkEnforced)).toBe(true);

    // The real gate and the real grader agree on every gradable trial.
    const byMode = new Map(MIXED.map((p, k) => [p.mode + p.i, candidates[k]!]));
    expect(byMode.get("honest1")!.gate!.result.verdict).toBe("verified");
    expect(byMode.get("honest1")!.grade!.status).toBe("pass");
    expect(byMode.get("no-edit3")!.gate!.result.verdict).toBe("refuted");
    expect(byMode.get("no-edit3")!.grade!.status).toBe("fail");
    expect(byMode.get("wrong-row4")!.gate!.result.verdict).toBe("refuted");
    expect(byMode.get("crash6")!.gate!.result.verdict).toBe("uncertain");
    expect(byMode.get("crash6")!.grade!.status).toBe("ungradable");

    const outDir = join(base, "dataset");
    const result = exportDataset(candidates, { outDir, includeNegatives: true, now: NOW });
    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(validateSchema(manifest, datasetManifestSchema)).toEqual([]);
    expect(manifest.evidence).toBe(false);
    expect(manifest.counts).toEqual({
      candidates: 8,
      records: 6,
      positive: 4,
      negative: 2,
      simulated: 6,
      excluded: { MISSING_CAPTURE: 1, NOT_CLAIMED: 1 },
    });
    expect(result.excluded).toEqual([
      { trialKey: "u-task-5/run-5", code: "NOT_CLAIMED" },
      { trialKey: "u-task-6/run-6", code: "MISSING_CAPTURE" },
    ]);

    const jsonl = readFileSync(join(outDir, "records.jsonl"), "utf8");
    expect(sha256(Buffer.from(jsonl))).toBe(manifest.files["records.jsonl"]);
    expect(sha256(readFileSync(join(outDir, "schema.json")))).toBe(manifest.files["schema.json"]);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    for (const [k, line] of lines.entries()) {
      const record = JSON.parse(line);
      expect(validateSchema(record, datasetRecordSchema)).toEqual([]);
      expect(sha256(Buffer.from(line))).toBe(manifest.records[k].sha256);
      expect(record.provenance.simulated).toBe(true);
      expect(record.provenance.plannerModelId).toBeNull();
      expect(record.grade.graderVersion).toBe(GRADER_VERSION);
      if (record.label === "positive") {
        expect(record.verdict).toMatchObject({ verdict: "verified", accepted: true });
        expect(record.grade.status).toBe("pass");
        expect(record.claim.done).toBe(true);
      } else {
        expect(record.verdict).toMatchObject({ verdict: "refuted", accepted: false });
        expect(record.grade.status).toBe("fail");
      }
      expect(record.steps.length).toBeGreaterThanOrEqual(2);
      // Codes only: the gate's human-readable reasons are never exported.
      expect(Object.keys(record.verdict).sort()).toEqual(
        ["accepted", "apiVersion", "reasonCodes", "source", "verdict"].sort(),
      );
    }
    // No host path anywhere in what was written: not the temp base, not the desktop roots.
    const written = [jsonl, readFileSync(join(outDir, "manifest.json"), "utf8")].join("\n");
    expect(written).not.toContain(base);
    expect(written).not.toContain(tmpdir());
    expect(scanForLeaks(written)).toEqual([]);
  }, 60_000);

  it("without includeNegatives, refuted runs are excluded, never exported as positives", async () => {
    const { base, candidates } = await runBatch(MIXED.slice(0, 4), 4);
    const result = exportDataset(candidates, { outDir: join(base, "ds"), now: NOW });
    expect(result.manifest.counts).toMatchObject({
      records: 2,
      positive: 2,
      negative: 0,
      excluded: { NEGATIVES_NOT_REQUESTED: 2 },
    });
  }, 60_000);

  it("a snooping agent is caught by the canary scan: the batch is not clean", async () => {
    // The slow neighbour stays alive for ~1.5 s, and the snooper waits until it can see a
    // sibling desktop, so the read is deterministic. Process isolation does not stop the
    // read (docs/product/linux-scale.md §5); the canary scan must report it.
    const { fleet } = await runBatch(
      [
        { i: 21, mode: "slow-honest" },
        { i: 22, mode: "snoop" },
      ],
      2,
    );
    expect(fleet.clean).toBe(false);
    expect(fleet.contamination).toContainEqual({
      trialKey: "u-task-22/run-22",
      canaryOf: "u-task-21/run-21",
      where: "capture",
    });
    // A clean batch of the same shape is clean.
    const control = await runBatch(
      [
        { i: 23, mode: "slow-honest" },
        { i: 24, mode: "honest" },
      ],
      2,
    );
    expect(control.fleet.clean).toBe(true);
  }, 60_000);

  it("planted markers in an agent's observations refuse the whole export (no partial write)", async () => {
    const markers = [
      ["/", "home", "/", "alice-u", "/", "notes.txt"].join(""),
      ["sk", "-ant-", "u".repeat(4), "planted", "9".repeat(8)].join(""),
      ["C:", "\\", "Users", "\\", "bob"].join(""),
      "zz-planted-operator-marker",
    ];
    for (const [k, marker] of markers.entries()) {
      const { base, candidates } = await runBatch(
        [
          { i: 30 + k * 2, mode: "honest" },
          { i: 31 + k * 2, mode: "leak", marker },
        ],
        2,
      );
      const outDir = join(base, "ds");
      let refused: unknown;
      try {
        exportDataset(candidates, {
          outDir,
          now: NOW,
          hygiene: { forbiddenStrings: ["zz-planted-operator-marker"] },
        });
      } catch (e) {
        refused = e;
      }
      expect(refused, marker).toBeInstanceOf(ExportRefused);
      expect((refused as ExportRefused).code).toBe("LEAK");
      expect((refused as Error).message).not.toContain(marker);
      expect(existsSync(outDir)).toBe(false);
    }
  }, 120_000);
});
