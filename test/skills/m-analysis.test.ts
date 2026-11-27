/**
 * Track M's pre-registered analysis, end to end at $0 (no model, no VM, no network).
 *
 * The learn phase uses the REAL sealed gate and the REAL independent grader on scripted
 * documents (`gatedRun`), the real admission and the real store; test-phase rows are built
 * with `buildRepRow`. The analysis then decides the bar from the frozen pre-registration.
 * Planner ids here are fixtures: these packs exist only in memory and are never evidence.
 *
 * Pinned: hash mismatch, an uncommitted pre-registration, simulated rows and an unratified
 * pre-registration REFUSE the pack; the bar is shown only at p <= 0.05 with >= 5 discordant
 * units in the pre-registered direction; every guardrail, schedule and coverage breach makes
 * it not shown; a simulated pack is never shown.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";
import { admit } from "../../src/skills/admission.ts";
import { mcnemarOneSided } from "../../src/skills/arm.ts";
import {
  analyzeMPack,
  gitReadCommitted,
  mcnemarExactOneSided,
  type RepPack,
  type RepPackMeta,
} from "../../src/skills/m-analysis.ts";
import {
  type LoadedMPrereg,
  M_PREREG_PATH,
  mSchedule,
  preregHash,
  readMPrereg,
  repoFileSha256,
} from "../../src/skills/m-prereg.ts";
import { canonicalJson, recordDigest, sha256, skillIdFor } from "../../src/skills/record.ts";
import { buildRepRow, type RepRow, type RepRowInput } from "../../src/skills/rep-row.ts";
import { GENESIS, SkillStore, STORE_FILE, verifyLog } from "../../src/skills/store.ts";
import { candidateFrom, docWith, forbiddenFor, gatedRun, ROOT, taskById } from "./helpers.ts";

const MODEL = "claude-sonnet-5-5";
const COMMIT = "c".repeat(40);
const COMMITTED = readMPrereg(ROOT);
const FILES = repoFileSha256(ROOT);

/** The committed pre-registration as the lead would ratify it (pending rulings resolved). */
function ratified(): LoadedMPrereg {
  const prereg = structuredClone(COMMITTED.prereg) as unknown as Record<string, unknown>;
  prereg.ratification = { status: "ratified", pending: [] };
  return {
    ...COMMITTED,
    prereg: prereg as unknown as LoadedMPrereg["prereg"],
    hash: preregHash(prereg),
  };
}
const RATIFIED = ratified();
const committedAt =
  (loaded: LoadedMPrereg, commit = COMMIT) =>
  (c: string, path: string) =>
    c === commit && path === M_PREREG_PATH ? JSON.stringify(loaded.prereg) : null;

const SCHEDULE = mSchedule(COMMITTED.manifest, COMMITTED.prereg.seeds.assignment);
const unitById = new Map(COMMITTED.manifest.test.map((u) => [u.unitId, u]));

let base: string;
let storeText: string;
let storeHead: string;
let skillId: string;
let learnRows: RepRow[];

const common = (loaded: LoadedMPrereg) => ({
  preregHash: loaded.hash,
  preregCommit: COMMIT,
  baseSurface: "C1" as const,
  stepBudget: 30,
  wallMs: 60_000,
  estimatedUsd: 0.02,
});

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "myco-m-analysis-"));
  const vault = new VerdictVault({
    root: join(base, "vault"),
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
  const store = SkillStore.open(join(base, "store"));
  learnRows = [];
  for (const [i, taskId] of SCHEDULE.learn.entries()) {
    const task = taskById(taskId);
    const runId = `learn-${i}`;
    // The first two learn trials save the right edit, the third the wrong value: the real gate
    // and grader decide each one. The rest stop without a done claim.
    if (i < 3) {
      const run = await gatedRun(
        vault,
        base,
        task,
        runId,
        docWith(task, i < 2 ? task.intent.newValue : "WRONG-VALUE"),
      );
      if (run.outcome.status !== "decided") throw new Error("refused");
      const gate = run.outcome.result;
      const persisted = (gate.evidenceRefs ?? []).find((r) => r.kind === "persisted-state");
      const admitted = store.add(
        admit(candidateFrom(task, runId, run, { plannerModelId: MODEL }), forbiddenFor(task)),
      );
      learnRows.push(
        buildRepRow({
          ...common(RATIFIED),
          phase: "learn",
          arm: "learn",
          kind: "learn",
          unitId: null,
          taskId,
          instructionSha256: task.instructionSha256,
          fixtureSha256: task.fixtureSha256,
          scheduleIndex: i,
          runId,
          plannerModelId: MODEL,
          steps: 8,
          storeHead: GENESIS,
          retrievedSkillIds: [],
          claim: "done",
          gate: {
            verdict: gate.verdict,
            accepted: gate.accepted,
            persistedSha256: persisted?.sha256 ?? "",
          },
          grade: { status: run.grade.status, persistedSha256: run.grade.persistedSha256 ?? "" },
          harnessFault: null,
          admittedSkillId: admitted.stored ? admitted.skillId : null,
        }),
      );
    } else
      learnRows.push(
        buildRepRow({
          ...common(RATIFIED),
          phase: "learn",
          arm: "learn",
          kind: "learn",
          unitId: null,
          taskId,
          instructionSha256: task.instructionSha256,
          fixtureSha256: task.fixtureSha256,
          scheduleIndex: i,
          runId,
          plannerModelId: MODEL,
          steps: 30,
          storeHead: GENESIS,
          retrievedSkillIds: [],
          claim: "not-done",
          gate: { verdict: "refuted", accepted: false, persistedSha256: "d".repeat(64) },
          grade: { status: "fail", persistedSha256: "d".repeat(64) },
          harnessFault: null,
          admittedSkillId: null,
        }),
      );
  }
  const snap = store.snapshot();
  storeHead = snap.head;
  skillId = snap.skills[0]?.record.skillId as string;
  storeText = readFileSync(join(base, "store", STORE_FILE), "utf8");
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Rebuild a stored row with changes: its derived fields are recomputed, never copied. */
function rebuild(r: RepRow, over: Partial<RepRowInput>): RepRow {
  const { schema: _a, simulated: _b, verified: _c, outcome: _d, evidence: _e, ...input } = r;
  return buildRepRow({ ...input, ...over });
}

type Verdicts = (unitId: string, arm: "skills-on" | "cold") => boolean;

/** A pack whose test outcomes follow `v`, for `loaded`'s hash. */
function pack(v: Verdicts, opts: { loaded?: LoadedMPrereg; simulated?: boolean } = {}): RepPack {
  const loaded = opts.loaded ?? RATIFIED;
  const planner = opts.simulated ? "simulated:scripted" : MODEL;
  const test = SCHEDULE.test.map(({ unitId, arm }, i) => {
    const u = unitById.get(unitId) as NonNullable<ReturnType<typeof unitById.get>>;
    const ok = v(unitId, arm);
    return buildRepRow({
      ...common(loaded),
      phase: "test",
      arm,
      kind: u.kind,
      unitId,
      taskId: u.taskId,
      instructionSha256: u.instructionSha256,
      fixtureSha256: u.fixtureSha256,
      scheduleIndex: i,
      runId: `test-${i}`,
      plannerModelId: planner,
      steps: ok ? 10 : 30,
      storeHead: arm === "skills-on" && !opts.simulated ? storeHead : GENESIS,
      retrievedSkillIds: arm === "skills-on" && !opts.simulated ? [skillId] : [],
      claim: "done",
      gate: null,
      grade: { status: ok ? "pass" : "fail", persistedSha256: "e".repeat(64) },
      harnessFault: null,
      admittedSkillId: null,
    });
  });
  const learn = opts.simulated
    ? learnRows.map((r) =>
        rebuild(r, {
          preregHash: loaded.hash,
          plannerModelId: planner,
          admittedSkillId: null,
        }),
      )
    : learnRows.map((r) => ({ ...r, preregHash: loaded.hash }));
  const meta: RepPackMeta = {
    schema: "myco.skills.rep-pack/1",
    preregHash: loaded.hash,
    preregCommit: COMMIT,
    baseSurface: "C1",
    baseSurfaceBasis: {
      I: { status: "not-shown", verifiedRate: null, preregHash: "a".repeat(64) },
      J: { status: "not-run", verifiedRate: null, preregHash: null },
    },
    storeHead: opts.simulated ? GENESIS : storeHead,
    simulated: opts.simulated === true,
  };
  return { meta, rows: [...learn, ...test], storeText: opts.simulated ? "" : storeText };
}

const units = COMMITTED.manifest.test.map((u) => u.unitId);
/** skills-on verifies the first `a` units only it wins, cold the next `b`; the rest: both fail. */
const split =
  (a: number, b: number, both = 0): Verdicts =>
  (u, arm) => {
    const i = units.indexOf(u);
    if (i < a) return arm === "skills-on";
    if (i < a + b) return arm === "cold";
    return i < a + b + both;
  };

const analyze = (p: RepPack, loaded = RATIFIED, readCommitted = committedAt(loaded)) =>
  analyzeMPack(p, { loaded, fileSha256: FILES, readCommitted });

describe("the learn phase stores only grader-confirmed, gate-verified outcomes", () => {
  it("two verified learn trials stored skills; the refuted one did not", () => {
    expect(learnRows.slice(0, 3).map((r) => [r.outcome, r.admittedSkillId !== null])).toEqual([
      ["verified", true],
      ["verified", true],
      ["false-done", false],
    ]);
  });
});

describe("the bar (exact one-sided McNemar, p <= 0.05, >= 5 discordant)", () => {
  it("shown: 8 skills-on-only vs 1 cold-only (p = 10/512)", () => {
    const r = analyze(pack(split(8, 1, 10)));
    expect(r.refusals).toEqual([]);
    expect(r.notShown).toEqual([]);
    expect(r.result).toBe("shown");
    expect(r.primary).toMatchObject({ units: 40, skillsOnOnly: 8, coldOnly: 1, both: 10 });
    expect(r.primary?.p).toBeCloseTo(10 / 512, 12);
    expect(r.primary?.skillsOn.verified).toBe(18);
    expect(r.primary?.cold.verified).toBe(11);
    expect(r.guardrails).toEqual({
      storedSkills: 2,
      storedFromNonVerified: 0,
      storedSourceNotPass: 0,
      scanHits: 0,
    });
    expect(r.r1Evidence).toBe(false);
  });

  it("reports repeat and similar separately, and per-verified secondaries over ALL trials", () => {
    const r = analyze(pack(split(8, 1, 10)));
    const s = r.secondary as NonNullable<typeof r.secondary>;
    expect(s.repeat.units + s.similar.units).toBe(40);
    expect(s.repeat.skillsOnOnly + s.similar.skillsOnOnly).toBe(8);
    // skills-on: 18 verified of 40; steps 10 on a pass, 30 on a fail.
    expect(s.skillsOn.stepsPerVerified).toBeCloseTo((18 * 10 + 22 * 30) / 18, 9);
    expect(s.skillsOn.estimatedUsdPerVerified).toBeCloseTo((40 * 0.02) / 18, 9);
    expect(s.cold.falseDone).toBe(29);
  });

  it("a null cost makes the cost cell null, never 0", () => {
    const p = pack(split(8, 1, 10));
    const rows = p.rows.map((r, i) => (i === p.rows.length - 1 ? { ...r, estimatedUsd: null } : r));
    const s = analyze({ ...p, rows }).secondary as NonNullable<
      ReturnType<typeof analyze>["secondary"]
    >;
    expect([s.skillsOn.estimatedUsdPerVerified, s.cold.estimatedUsdPerVerified]).toContain(null);
  });

  it("underpowered at n with fewer than 5 discordant units", () => {
    const r = analyze(pack(split(4, 0, 10)));
    expect(r.result).toBe("not-shown");
    expect(r.notShown).toEqual(["UNDERPOWERED_AT_N: 4 discordant of 40"]);
  });

  it("5 of 5 discordant is shown (p = 1/32), the smallest table entry", () => {
    expect(analyze(pack(split(5, 0))).result).toBe("shown");
  });

  it("not shown above alpha (6 vs 3) and in the wrong direction (1 vs 8)", () => {
    expect(analyze(pack(split(6, 3))).notShown).toEqual([
      `P_ABOVE_ALPHA: ${mcnemarExactOneSided(6, 3)}`,
    ]);
    expect(analyze(pack(split(1, 8))).notShown).toEqual(["DIRECTION"]);
  });

  it("the exact test matches the spec's table and track M's existing implementation", () => {
    for (const [d, k, p] of [
      [5, 5, 0.0313],
      [6, 6, 0.0156],
      [8, 7, 0.0352],
      [10, 9, 0.0107],
      [12, 10, 0.0193],
      [15, 12, 0.0176],
      [20, 15, 0.0207],
    ] as const) {
      expect(mcnemarExactOneSided(k, d - k)).toBeCloseTo(p, 3);
      expect(mcnemarExactOneSided(k - 1, d - k + 1)).toBeGreaterThan(0.05);
      expect(mcnemarExactOneSided(k, d - k)).toBe(mcnemarOneSided(k, d - k));
    }
  });
});

describe("refusals (capability-spec §3.2, §3.5)", () => {
  it("refuses a real pack under the committed, not-yet-ratified pre-registration", () => {
    const r = analyze(pack(split(8, 1), { loaded: COMMITTED }), COMMITTED);
    expect(r.result).toBe("refused");
    expect(r.refusals).toEqual(["PREREG_NOT_RATIFIED"]);
    expect(r.primary).toBeNull();
  });

  it("refuses a pack whose pre-registration hash does not match", () => {
    const p = pack(split(8, 1));
    const r = analyze({ ...p, meta: { ...p.meta, preregHash: "f".repeat(64) } });
    expect(r.refusals).toContain("PREREG_HASH_MISMATCH");
    expect(r.result).toBe("refused");
  });

  it("refuses a pre-registration that is not committed at the pack's commit", () => {
    const r = analyze(pack(split(8, 1)), RATIFIED, committedAt(RATIFIED, "9".repeat(40)));
    expect(r.refusals).toEqual(["PREREG_NOT_COMMITTED"]);
    const edited = analyze(pack(split(8, 1)), RATIFIED, committedAt(COMMITTED));
    expect(edited.refusals).toEqual(["PREREG_NOT_COMMITTED"]);
  });

  it("refuses when an analysis file changed since the freeze", () => {
    const r = analyzeMPack(pack(split(8, 1)), {
      loaded: RATIFIED,
      fileSha256: (path) => (path === "src/skills/rep-row.ts" ? "0".repeat(64) : FILES(path)),
      readCommitted: committedAt(RATIFIED),
    });
    expect(r.refusals).toEqual([
      "PREREG_INVALID: analysis file src/skills/rep-row.ts changed since the freeze",
    ]);
  });

  it("simulated rows never count: one in a real pack refuses it", () => {
    const p = pack(split(8, 1));
    const rows = p.rows.map((r, i) =>
      i === 25 ? rebuild(r, { plannerModelId: "simulated:scripted" }) : r,
    );
    expect(analyze({ ...p, rows }).refusals).toEqual(["SIMULATED_ROWS_NEVER_COUNT"]);
  });

  it("a simulated pack is plumbing: analysed, never shown, even unratified", () => {
    const r = analyze(pack(split(20, 0), { loaded: COMMITTED, simulated: true }), COMMITTED);
    expect(r.refusals).toEqual([]);
    expect(r.result).toBe("simulated");
    expect(r.primary?.skillsOnOnly).toBe(20);
    const mixed = pack(split(20, 0), { loaded: COMMITTED, simulated: true });
    const rows = mixed.rows.map((x, i) => (i === 30 ? rebuild(x, { plannerModelId: MODEL }) : x));
    expect(analyze({ ...mixed, rows }, COMMITTED).refusals).toEqual([
      "REAL_ROWS_IN_SIMULATED_PACK",
    ]);
  });
});

describe("not shown: guardrails, schedule, coverage, parity, base surface", () => {
  const strong = () => pack(split(8, 1, 10));

  it("a stored skill whose source the grader did not pass is a breach (gate verdict alone)", () => {
    const p = strong();
    // A forged learn row: the gate verified, the grader failed, and a skill was stored anyway.
    const rows = p.rows.map((r) =>
      r.admittedSkillId === skillId
        ? {
            ...r,
            grade: { status: "fail" as const, persistedSha256: r.grade?.persistedSha256 ?? "" },
          }
        : r,
    );
    const res = analyze({ ...p, rows });
    expect(res.result).toBe("not-shown");
    expect(res.guardrails).toMatchObject({ storedFromNonVerified: 1, storedSourceNotPass: 1 });
    expect(res.notShown).toEqual(
      expect.arrayContaining([
        "GUARDRAIL_STORED_FROM_NON_VERIFIED: 1",
        "GUARDRAIL_SOURCE_NOT_PASS: 1",
      ]),
    );
  });

  it("a stored skill whose source row is missing, or names another skill, is a breach", () => {
    const p = strong();
    const rows = p.rows.map((r) =>
      r.admittedSkillId === skillId ? { ...r, admittedSkillId: null } : r,
    );
    expect(analyze({ ...p, rows }).guardrails?.storedFromNonVerified).toBe(1);
  });

  it("a skill holding a fixture value of its source task fails the scan", () => {
    const p = strong();
    // A hand-resealed log: the first skill gets the source task's record key planted in a step,
    // and every digest is recomputed. The store's task-independent rules cannot see this (it
    // does not know the task); the analysis's per-skill scan against the source task must.
    const first = JSON.parse(p.storeText.split("\n")[0] as string);
    const task = taskById(first.record.provenance.taskId);
    const { recordSha256: _r, skillId: _s, ...body } = first.record;
    body.steps = [...body.steps.slice(0, -1), `Find the row ${task.intent.rowKey}`];
    const recordSha256 = recordDigest(body);
    const record = { ...body, recordSha256, skillId: skillIdFor(recordSha256) };
    const event = { seq: first.seq, prevSha256: first.prevSha256, type: "admit", record };
    const head = sha256(canonicalJson(event));
    const forgedText = `${JSON.stringify({ ...event, eventSha256: head })}\n`;
    expect(verifyLog(forgedText).head).toBe(head);
    const rows = p.rows.map((r) => {
      if (r.phase === "learn")
        return {
          ...r,
          admittedSkillId: r.runId === first.record.provenance.runId ? record.skillId : null,
        };
      return r.arm === "skills-on"
        ? { ...r, storeHead: head, retrievedSkillIds: [record.skillId] }
        : r;
    });
    const res = analyze({
      meta: { ...p.meta, storeHead: head },
      rows,
      storeText: forgedText,
    });
    expect(res.guardrails).toEqual({
      storedSkills: 1,
      storedFromNonVerified: 0,
      storedSourceNotPass: 0,
      scanHits: 1,
    });
    expect(res.notShown).toEqual(["GUARDRAIL_SCAN: 1"]);
  });

  it("a missing trial makes the pack incomplete (no exclusions)", () => {
    const p = strong();
    const res = analyze({ ...p, rows: p.rows.slice(0, -1) });
    expect(res.result).toBe("not-shown");
    expect(res.notShown).toContain("INCOMPLETE_TEST: 79 of 80");
  });

  it("a harness fault stays in the denominator as not verified", () => {
    const p = strong();
    const rows = p.rows.map((r) =>
      r.phase === "test" && r.arm === "skills-on" && r.verified && r.unitId === units[0]
        ? rebuild(r, { harnessFault: "timeout" })
        : r,
    );
    const res = analyze({ ...p, rows });
    expect(res.primary?.units).toBe(40);
    expect(res.primary?.skillsOnOnly).toBe(7);
  });

  it("trials out of the pre-registered order are caught", () => {
    const p = strong();
    const test = p.rows.filter((r) => r.phase === "test");
    const a = test[0] as RepRow;
    const b = test[1] as RepRow;
    const swapped = p.rows.map((r) =>
      r === a
        ? { ...r, scheduleIndex: b.scheduleIndex }
        : r === b
          ? { ...r, scheduleIndex: a.scheduleIndex }
          : r,
    );
    expect(analyze({ ...p, rows: swapped }).notShown).toEqual(
      expect.arrayContaining([`SCHEDULE ${a.runId}`, `SCHEDULE ${b.runId}`]),
    );
  });

  it("parity: another model, another step budget, or a skills-on trial off the frozen store", () => {
    const p = strong();
    const at = (i: number, over: Partial<RepRowInput>) =>
      p.rows.map((r, j) => (j === i ? rebuild(r, over) : r));
    expect(analyze({ ...p, rows: at(30, { plannerModelId: "claude-other-1" }) }).notShown).toEqual(
      expect.arrayContaining(["ROW test-10: PARITY_MODEL", "PARITY_MIXED_MODEL"]),
    );
    expect(analyze({ ...p, rows: at(30, { stepBudget: 40 }) }).notShown).toContain(
      "ROW test-10: PARITY_STEP_BUDGET",
    );
    const onIdx = p.rows.findIndex((r) => r.arm === "skills-on");
    expect(analyze({ ...p, rows: at(onIdx, { storeHead: "9".repeat(64) }) }).notShown).toContain(
      `STORE_HEAD ${p.rows[onIdx]?.runId}`,
    );
  });

  it("the base surface must be the rule's: C1 is wrong once I is shown", () => {
    const p = strong();
    const res = analyze({
      ...p,
      meta: {
        ...p.meta,
        baseSurfaceBasis: {
          I: { status: "shown", verifiedRate: 0.6, preregHash: "a".repeat(64) },
          J: { status: "not-run", verifiedRate: null, preregHash: null },
        },
      },
    });
    expect(res.notShown).toContain("BASE_SURFACE_NOT_THE_RULE'S");
    const early = analyze({
      ...p,
      meta: {
        ...p.meta,
        baseSurfaceBasis: {
          I: { status: "not-run", verifiedRate: null, preregHash: null },
          J: { status: "not-run", verifiedRate: null, preregHash: null },
        },
      },
    });
    expect(early.notShown).toContain("BASE_SURFACE: I_NOT_DECIDED");
  });

  it("a store whose head is not the pack's is caught", () => {
    const p = strong();
    expect(analyze({ ...p, storeText: "" }).notShown).toEqual(
      expect.arrayContaining(["STORE_HEAD_NOT_PACK_HEAD"]),
    );
  });
});

describe("CLI", () => {
  it("refuses a real pack under the committed proposed pre-registration (exit 3)", () => {
    const dir = join(base, "cli-pack");
    mkdirSync(join(dir, "store"), { recursive: true });
    const p = pack(split(8, 1), { loaded: COMMITTED });
    writeFileSync(join(dir, "pack.json"), JSON.stringify(p.meta));
    writeFileSync(join(dir, "rows.jsonl"), `${p.rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    writeFileSync(join(dir, "store", "skills.jsonl"), p.storeText);
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts/m-learning-analysis.ts"), "--pack", dir],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(3);
    const report = JSON.parse(r.stdout);
    expect(report.result).toBe("refused");
    expect(report.refusals).toContain("PREREG_NOT_RATIFIED");
  }, 30_000);

  it("git reads a committed file at a commit, and nothing for a non-sha", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout.trim();
    const read = gitReadCommitted(ROOT);
    expect(read(head, "LICENSE")).toBe(readFileSync(join(ROOT, "LICENSE"), "utf8"));
    expect(read("HEAD", "LICENSE")).toBeNull();
    expect(read(head, "no/such/file")).toBeNull();
  });
});
