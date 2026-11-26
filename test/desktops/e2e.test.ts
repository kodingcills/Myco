/**
 * Track U $0 end-to-end test: no model, no VM, no network, no API call.
 *
 * A scripted agent (test/fixtures/desktops/scripted-agent.mjs) runs in N disposable desktops
 * on the local-process backend, four at a time. For each trial the harness captures the
 * persisted bytes, hands them to the REAL gate (`createGate`, bound to that trial) through
 * the trial's evidence location, and to the REAL independent grader (`grade`), drafts the
 * trial's canonical `myco.episode/1` record (the interim writer, src/dataset/episode.ts),
 * then exports the dataset as a container over those episodes. The planner is a script, so
 * every episode is simulated and labelled so; none of this is evidence of agent capability.
 *
 * The gate and grader are composed here, in the test, on purpose: src/desktops and
 * src/dataset import neither (test/desktops/import-boundary.test.ts).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { datasetManifestSchema, datasetRecordSchema } from "../../schemas/dataset-export.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { type ColumnType, GRADER_VERSION, grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { draftEpisode, episodeMirrorSchema } from "../../src/dataset/episode.ts";
import { type ExportCandidate, ExportRefused, exportDataset } from "../../src/dataset/export.ts";
import { forbiddenStringsFromFiles, leaksIn, scanForLeaks } from "../../src/dataset/hygiene.ts";
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
  | "leak-action"
  | "read-vault"
  | "crash";

interface TrialPlan {
  readonly i: number;
  readonly mode: Mode;
  readonly marker?: string;
  /** Planted into the seeded fixture (last record's last cell). */
  readonly fixtureMarker?: string;
  /** A host file outside the desktop the `read-vault` agent reads. */
  readonly vaultPath?: string;
}

/** The seeded fixture, with `fixtureMarker` planted into it when the plan asks. */
function seededFixture(plan: TrialPlan): string {
  const csv = generateFixture(intentOf(plan.i).seed).csv;
  if (plan.fixtureMarker === undefined) return csv;
  const lines = csv.trimEnd().split("\n");
  lines[lines.length - 1] = lines[lines.length - 1]!.replace(/,[^,]*$/, `,${plan.fixtureMarker}`);
  return `${lines.join("\n")}\n`;
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
  const fixture = seededFixture(plan);
  return {
    trialKey: `u-task-${plan.i}:run-${plan.i}`,
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
            vaultPath: plan.vaultPath,
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

/** The harness side of one trial: real gate, real grader, the episode, an export candidate. */
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
  const parsed = parseTranscript(outcome.run?.stdout ?? "");
  if (!parsed.ok) throw new Error(`transcript malformed at line ${parsed.line}`);
  const gateResult = await gate.check({
    taskId: outcome.taskId,
    runId: outcome.runId,
    claim: parsed.claimText,
  });
  const gradeResult = grade({
    fixtureCsv,
    fixtureSha256: sha256(fixtureCsv),
    persisted: outcome.capture === null ? null : { format: "csv", bytes: outcome.capture.bytes },
    intent: { rowKey: t.rowKey, column: t.column, newValue: t.newValue },
    columnTypes: COLUMN_TYPES,
  });
  const instruction = instructionOf(plan.i);
  const episode = draftEpisode({
    outcome: gateResult.verdict,
    simulated: true,
    task: {
      id: outcome.taskId,
      family: "calc-record-edit",
      taskSetVersion: null,
      faultClass: null,
      instruction,
      instructionSha256: sha256(Buffer.from(instruction)),
      fixtureSha256: sha256(fixtureCsv),
    },
    actions: parsed.actions,
    observations: parsed.observations,
    withheld: parsed.withheld,
    agentClaim: parsed.agentClaim,
    gate: {
      verdict: gateResult.verdict,
      accepted: gateResult.accepted,
      reasonCodes: [...gateResult.reasonCodes],
      oracle: null,
    },
    groundTruth: {
      source: "independent-grader",
      graderVersion: gradeResult.graderVersion,
      status: gradeResult.status,
      targetSatisfied: gradeResult.targetSatisfied,
      mismatchCount: gradeResult.mismatchCount,
      fixtureSha256: gradeResult.fixtureSha256,
      persistedSha256: gradeResult.persistedSha256,
    },
    arm: "scripted-u-e2e",
    plannerModelId: null,
    startedAt: outcome.startedAt,
    endedAt: outcome.finishedAt,
    source: "gated-trial",
    runId: outcome.runId,
    trialKey: outcome.trialKey,
  });
  return {
    episode,
    fixtureSha256: sha256(fixtureCsv),
    gate: gateResult,
    capture:
      outcome.capture === null
        ? null
        : { path: outcome.capture.path, format: "csv", bytes: outcome.capture.bytes },
    desktop: {
      backend: outcome.backend,
      isolation: outcome.isolation,
      networkEnforced: outcome.networkEnforced,
      image: outcome.image,
    },
  };
}

/** Every file an export wrote, as text. */
function writtenFiles(outDir: string): string[] {
  return [
    "records.jsonl",
    "manifest.json",
    "schema.json",
    ...readdirSync(join(outDir, "episodes")).map((f) => join("episodes", f)),
  ].map((f) => readFileSync(join(outDir, f), "utf8"));
}

function refusalOf(fn: () => unknown): ExportRefused {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExportRefused) return e;
    throw e;
  }
  throw new Error("expected the export to be refused");
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

describe("track U end-to-end: fleet -> real gate + real grader -> episodes -> dataset ($0)", () => {
  it("runs 8 trials 4 at a time, clean, and exports positives and labelled negatives only", async () => {
    const { base, fleet, candidates } = await runBatch(MIXED, 4);
    expect(fleet.clean).toBe(true);
    expect(fleet.contamination).toEqual([]);
    expect(fleet.maxConcurrent).toBeLessThanOrEqual(4);
    expect(fleet.maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(fleet.outcomes.map((o) => o.error)).toEqual(Array(8).fill(null));
    // The local-process backend reports its isolation honestly (destruction is pinned in
    // test/desktops/backend.test.ts, "destroys every one").
    expect(fleet.outcomes.every((o) => o.isolation === "process" && !o.networkEnforced)).toBe(true);

    // The real gate and the real grader agree on every gradable trial.
    const byMode = new Map(MIXED.map((p, k) => [p.mode + p.i, candidates[k]!]));
    const verdict = (m: string) => byMode.get(m)!.episode.gate!.verdict;
    const status = (m: string) => {
      const t = byMode.get(m)!.episode.groundTruth;
      return t.source === "independent-grader" ? t.status : null;
    };
    expect([verdict("honest1"), status("honest1")]).toEqual(["verified", "pass"]);
    expect([verdict("no-edit3"), status("no-edit3")]).toEqual(["refuted", "fail"]);
    expect(verdict("wrong-row4")).toBe("refuted");
    expect([verdict("crash6"), status("crash6")]).toEqual(["uncertain", "ungradable"]);
    expect(byMode.get("no-claim5")!.episode.agentClaim).toBe("not-done");
    for (const c of candidates) expect(validateSchema(c.episode, episodeMirrorSchema)).toEqual([]);

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
    const idOf = (m: string) => byMode.get(m)!.episode.episodeId;
    expect([...result.excluded].sort((x, y) => x.code.localeCompare(y.code))).toEqual([
      { episodeId: idOf("crash6"), code: "MISSING_CAPTURE" },
      { episodeId: idOf("no-claim5"), code: "NOT_CLAIMED" },
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
      expect(record.desktop).toEqual({
        backend: "local-process/1",
        isolation: "process",
        networkEnforced: false,
        image: IMAGE,
      });
      const episodeText = readFileSync(join(outDir, record.episode.file), "utf8");
      expect(sha256(Buffer.from(episodeText))).toBe(record.episode.sha256);
      const ep = JSON.parse(episodeText);
      expect(validateSchema(ep, episodeMirrorSchema)).toEqual([]);
      expect(ep.simulated).toBe(true);
      expect(ep.harness.plannerModelId).toBeNull();
      expect(ep.groundTruth.graderVersion).toBe(GRADER_VERSION);
      if (record.label === "positive") {
        expect(ep.gate).toMatchObject({ verdict: "verified", accepted: true });
        expect(ep.groundTruth.status).toBe("pass");
        expect(ep.agentClaim).toBe("done");
      } else {
        expect(ep.gate).toMatchObject({ verdict: "refuted", accepted: false });
        expect(ep.groundTruth.status).toBe("fail");
      }
      expect(ep.actions.items.length).toBeGreaterThanOrEqual(2);
      // Codes only: the gate's human-readable reasons are never exported.
      expect(Object.keys(ep.gate).sort()).toEqual(["accepted", "oracle", "reasonCodes", "verdict"]);
    }
    // No host path anywhere in what was written: not the temp base, not the desktop roots.
    const written = writtenFiles(outDir).join("\n");
    expect(written).not.toContain(base);
    expect(written).not.toContain(tmpdir());
    const [records, ...others] = writtenFiles(outDir);
    for (const doc of records!.trimEnd().split("\n"))
      expect(scanForLeaks(JSON.parse(doc))).toEqual([]);
    for (const text of others) expect(scanForLeaks(JSON.parse(text))).toEqual([]);
    // The claim text the agent handed the gate is not part of the episode.
    expect(written).not.toContain("Done. Set");
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
      trialKey: "u-task-22:run-22",
      canaryOf: "u-task-21:run-21",
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

  it("planted markers an agent writes (observation or action) refuse the whole export", async () => {
    const markers = [
      ["/", "home", "/", "alice-u", "/", "notes.txt"].join(""),
      ["sk", "-ant-", "u".repeat(4), "planted", "9".repeat(8)].join(""),
      ["C:", "\\", "Users", "\\", "bob"].join(""),
      ["%2F", "Users", "%2F", "bob"].join(""),
      "zz-planted-operator-marker",
    ];
    let i = 30;
    for (const marker of markers) {
      for (const mode of ["leak", "leak-action"] as const) {
        const { base, candidates } = await runBatch(
          [
            { i: i++, mode: "honest" },
            { i: i++, mode, marker },
          ],
          2,
        );
        const outDir = join(base, "ds");
        const refused = refusalOf(() =>
          exportDataset(candidates, {
            outDir,
            now: NOW,
            hygiene: { forbiddenStrings: ["zz-planted-operator-marker"] },
          }),
        );
        expect(refused.code, `${mode} ${marker}`).toBe("LEAK");
        expect(
          refused.where.startsWith(`episodes/${candidates[1]!.episode.episodeId}.json:$.`),
        ).toBe(true);
        expect(refused.message).not.toContain(marker);
        expect(existsSync(outDir)).toBe(false);
      }
    }
  }, 120_000);

  it("planted markers in the seeded fixture never reach the dataset unless echoed, and then refuse it", async () => {
    const markers = [
      ["/", "home", "/", "fixture-owner", "/", "x"].join(""),
      ["sk", "-ant-", "fixture", "planted", "7".repeat(10)].join(""),
    ];
    let i = 60;
    for (const marker of markers) {
      // An honest agent on a planted fixture: the marker is in the captured bytes (graded,
      // digested) but the container never carries capture bytes, so nothing leaks.
      const quiet = await runBatch([{ i: i++, mode: "honest", fixtureMarker: marker }], 1);
      const outDir = join(quiet.base, "ds");
      const r = exportDataset(quiet.candidates, { outDir, includeNegatives: true, now: NOW });
      expect(r.manifest.counts).toMatchObject({ candidates: 1 });
      for (const text of writtenFiles(outDir)) expect(text).not.toContain(marker);
      // An agent that echoes the fixture's planted cell into its transcript is refused.
      const echo = await runBatch([{ i: i++, mode: "leak", marker, fixtureMarker: marker }], 1);
      const refused = refusalOf(() =>
        exportDataset(echo.candidates, {
          outDir: join(echo.base, "ds"),
          includeNegatives: true,
          now: NOW,
        }),
      );
      expect(refused.code).toBe("LEAK");
      expect(refused.message).not.toContain(marker);
    }
  }, 60_000);

  it("a vault value an agent reads off the host is refused via the operator deny-list built from the vault", async () => {
    const base = mkdtempSync(join(tmpdir(), "myco-u-vault-"));
    const vault = join(base, "vault.env");
    // Planted, and deliberately NOT secret-shaped: only the deny-list can catch it.
    const value = ["plain", "vault", "value", "4417"].join("-");
    writeFileSync(vault, `MYCO_U_PLANTED_ENTRY=${value}\n`);
    expect(leaksIn(value, { hostIdentity: false })).toEqual([]);
    const forbiddenStrings = forbiddenStringsFromFiles([vault]);
    expect(forbiddenStrings).toContain(value);

    const { base: runBase, candidates } = await runBatch(
      [{ i: 70, mode: "read-vault", vaultPath: vault }],
      1,
    );
    // The local-process agent really read the host file (process isolation allows it).
    const seen = candidates[0]!.episode.observations.items.map((o) => (o as { text: string }).text);
    expect(seen.some((t) => t.includes(value))).toBe(true);
    const outDir = join(runBase, "ds");
    const refused = refusalOf(() =>
      exportDataset(candidates, { outDir, now: NOW, hygiene: { forbiddenStrings } }),
    );
    expect(refused).toMatchObject({ code: "LEAK", detail: "forbidden-string" });
    expect(refused.message).not.toContain(value);
    expect(existsSync(outDir)).toBe(false);
  }, 60_000);
});
