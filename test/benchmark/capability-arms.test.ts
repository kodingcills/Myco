/**
 * The capability-arm values of `myco.benchmark.arm-row/1` (tracks I-V; capability-spec.md
 * §3.4, capability-spec-2.md §1.5): one reviewed schema change adds every track's arm and its
 * same-harness baseline arm. Capability rows are experiment rows: the check refuses every new
 * value under `--require-r1` (the task-set binding) and `--evidence`, the M2 pack check refuses
 * them in every pack, and `myco-gate` and `hcu+shell` rows behave exactly as before.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkArmRowSchema,
  CAPABILITY_ARM_PAIRS,
  CAPABILITY_ARMS,
  R1_PATH_ARMS,
} from "../../schemas/benchmark-ledger.ts";
import { m2PackManifestSchema } from "../../schemas/m2-evidence.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  type BenchmarkArmRow,
  type CapabilityArm,
  type CheckOptions,
  type CheckResult,
  checkBenchmark,
  expectedAccepted,
  type LedgerArmRow,
} from "../../src/benchmark/check.ts";
import { type BenchmarkGradeRow, gradeRow } from "../../src/benchmark/grade/row.ts";
import { buildTaskSet } from "../../src/benchmark/taskset.ts";
import { checkPack } from "../../src/m2/evidence.ts";
import {
  input,
  manifest,
  r1Trials,
  r2Manifest,
  r2Trials,
  TEST_R2_ALLOW,
} from "../m2/pack-fixture.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const H = (c: string) => c.repeat(64);
const doc = (n: number) => n.toString(16).padStart(64, "0");

/** The values the PR adds, derived from each track's **Arms** in the two capability specs. */
const EXPECTED_CAPABILITY_ARMS = [
  "C1", // baseline: screenshot-only on the capability (Ultra) harness; B = C1 (spec-2 §1.3)
  "C1+I", // I primary vs C1
  "hcu+shell+I", // I secondary vs hcu+shell
  "hcu+shell+J", // J primary vs hcu+shell
  "C1+K", // K vs no-recovery (C1, gated)
  "C1+L", // L at N = 4 vs C1 at N = 1
  "C1+M", // M skills-on vs cold
  "C1+M-cold", // M cold: the same surface, empty store (M's baseline)
  "C1+N", // N: B+N vs B
  "C1+O", // O: B+O vs B
  "C1+P", // P: B+P vs B (both gated)
  "hcu+shell+R", // R primary vs hcu+shell
  "C1+T", // T reader primary vs C1
  "hcu+shell+T", // T reader secondary vs hcu+shell
  "C1+U", // U stage 2: C1 on the microVM backend at N = 8 vs C1 at N = 1
  "hcu+shell+U", // U stage 2: hcu+shell on the microVM backend vs hcu+shell at N = 1
  "hcu+shell+V", // V vs H (hcu+shell); V's rows are gated
];

function row(key: string, over: Partial<LedgerArmRow> = {}): LedgerArmRow {
  const base: LedgerArmRow = {
    schema: "myco.benchmark.arm-row/1",
    taskSetVersion: "cap-plumbing",
    arm: "C1+I",
    trialKey: key,
    taskId: `task-${key}`,
    faultClass: "none",
    fixtureSha256: H("a"),
    instructionSha256: H("b"),
    plannerModelId: "claude-sonnet-5-5",
    outputCeiling: null,
    claim: "done",
    gate: null,
    accepted: true,
    persistedSha256: H("c"),
    cause: null,
    cost: { modelUsd: 0.5, wallClockS: null, vmS: null },
  };
  const merged = { ...base, ...over };
  return { ...merged, accepted: over.accepted ?? expectedAccepted(merged) };
}

function grade(r: LedgerArmRow, status: "pass" | "fail" = "pass"): BenchmarkGradeRow {
  return gradeRow(r.trialKey, r.taskId, {
    graderVersion: "false-completion-grader/1",
    status,
    reasons: status === "pass" ? [] : ["x"],
    fixtureSha256: r.fixtureSha256,
    persistedSha256: r.persistedSha256,
    target: "B2",
    targetSatisfied: status === "pass",
    mismatches: [],
    mismatchCount: 0,
  });
}

/** One gate-less, accepted, graded-pass row per capability arm. */
function capLedger(arms: readonly CapabilityArm[] = CAPABILITY_ARMS) {
  const rows = arms.map((arm, i) => row(`c${i}`, { arm, persistedSha256: doc(i + 1) }));
  const expectTrials = Object.fromEntries(arms.map((a) => [a, 1])) as CheckOptions["expectTrials"];
  return { rows, grades: rows.map((r) => grade(r)), expectTrials };
}

/** fc-v1 as a gated ledger with real hashes: R1 passes on it when bound (r1-split-cost.test). */
function fcLedger() {
  const rows = buildTaskSet().tasks.map((t, i): BenchmarkArmRow => {
    const bind = {
      arm: "myco-gate" as const,
      taskSetVersion: "fc-v1",
      taskId: t.taskId,
      faultClass: t.faultClass,
      fixtureSha256: t.fixtureSha256,
      instructionSha256: t.instructionSha256,
      persistedSha256: doc(1000 + i),
    };
    const key = `f${i}`;
    if (!t.satisfiable)
      return row(key, {
        ...bind,
        gate: { called: false, verdict: null, unregistrable: true },
        cause: { kind: "oracle", detail: "unregistrable" },
      }) as BenchmarkArmRow;
    if (t.faultClass === "none")
      return row(key, { ...bind, gate: { called: true, verdict: "verified" } }) as BenchmarkArmRow;
    return row(key, {
      ...bind,
      gate: { called: true, verdict: "refuted" },
      cause: { kind: "agent", detail: "refuted" },
    }) as BenchmarkArmRow;
  });
  const grades = rows.map((r) => grade(r, r.faultClass === "none" ? "pass" : "fail"));
  return { rows, grades };
}
const R1_OPTS = {
  expectTrials: { "myco-gate": 100 },
  expectUnregistrable: { "myco-gate": 10 },
} as const;

const CAP_ERROR =
  /capability-arm row\(s\) .*: capability rows are experiment rows, never R1 or evidence$/;

describe("capability arms: the schema change", () => {
  it("adds exactly the I-V arm values and their baselines, and keeps the R1-path arms", () => {
    expect([...CAPABILITY_ARMS]).toEqual(EXPECTED_CAPABILITY_ARMS);
    expect([...R1_PATH_ARMS]).toEqual(["myco-gate", "hcu+shell"]);
    const props = benchmarkArmRowSchema.properties as Record<string, { enum?: unknown[] }>;
    expect(props.arm?.enum).toEqual(["myco-gate", "hcu+shell", ...EXPECTED_CAPABILITY_ARMS]);
    expect(new Set(CAPABILITY_ARMS).size).toBe(CAPABILITY_ARMS.length);
  });

  it("every capability arm names its track and a baseline that is an admitted arm", () => {
    const admitted = new Set<string>([...R1_PATH_ARMS, ...CAPABILITY_ARMS]);
    const tracks = new Set<string>();
    for (const arm of CAPABILITY_ARMS) {
      if (arm === "C1" || arm === "C1+M-cold") continue; // baselines
      const pair = CAPABILITY_ARM_PAIRS[arm];
      expect(admitted.has(pair.baseline)).toBe(true);
      expect(arm.endsWith(`+${pair.track}`)).toBe(true);
      // The capability arm is its baseline's surface plus the track (spec §1.3 parity), except
      // M, whose baseline (cold) has the same surface with an empty store.
      if (pair.track !== "M") expect(arm).toBe(`${pair.baseline}+${pair.track}`);
      tracks.add(pair.track);
    }
    // Q and S have property bars and no arms (capability-spec-2.md §2 Q, S).
    expect([...tracks].sort()).toEqual([
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "R",
      "T",
      "U",
      "V",
    ]);
    expect(Object.keys(CAPABILITY_ARM_PAIRS).length).toBe(CAPABILITY_ARMS.length - 2);
  });

  it("validates a row on every new arm, and still refuses an arm no track defined", () => {
    for (const arm of CAPABILITY_ARMS)
      expect(validateSchema(row("k", { arm }), benchmarkArmRowSchema)).toEqual([]);
    for (const bad of ["B+N", "fast-path", "K", "c1", "C1+Q", "C1+S", "hcu+shell ", "myco-gate+I"])
      expect(validateSchema({ ...row("k"), arm: bad }, benchmarkArmRowSchema)).not.toEqual([]);
  });
});

describe("capability arms: refused under --require-r1 and --evidence", () => {
  it("a capability-only ledger is consistent without the flags (plumbing), with no R1", () => {
    const { rows, grades, expectTrials } = capLedger();
    const r = checkBenchmark(rows, grades, { expectTrials });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.r1).toBeNull();
    expect(r.arms.map((a) => a.arm).sort()).toEqual([...CAPABILITY_ARMS].sort());
  });

  for (const flag of ["evidence", "bindTaskSet"] as const) {
    it(`refuses EVERY capability arm under ${flag} (each value alone)`, () => {
      for (const arm of CAPABILITY_ARMS) {
        const { rows, grades, expectTrials } = capLedger([arm]);
        const r = checkBenchmark(rows, grades, { expectTrials, [flag]: true });
        expect(r.ok, arm).toBe(false);
        expect(
          r.errors.filter((e) => CAP_ERROR.test(e)),
          arm,
        ).toEqual([
          `1 capability-arm row(s) (arm ${JSON.stringify(arm)}; c0): capability rows are experiment rows, never R1 or evidence`,
        ]);
      }
    });
  }

  it("names every capability arm in one refusal, and counts every row", () => {
    const { rows, grades, expectTrials } = capLedger();
    const r = checkBenchmark(rows, grades, { expectTrials, evidence: true });
    const cap = r.errors.filter((e) => CAP_ERROR.test(e));
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatch(new RegExp(`^${CAPABILITY_ARMS.length} capability-arm row`));
    for (const arm of CAPABILITY_ARMS) expect(cap[0]).toContain(JSON.stringify(arm));
  });

  it("one capability row in an otherwise passing bound R1 ledger fails R1", () => {
    const { rows, grades } = fcLedger();
    const ok = checkBenchmark(rows, grades, { ...R1_OPTS, bindTaskSet: true });
    expect(ok.errors).toEqual([]);
    expect(ok.r1?.pass).toBe(true);
    for (const arm of CAPABILITY_ARMS) {
      const cap = row("cap", { arm, taskSetVersion: "fc-v1", persistedSha256: doc(5000) });
      const r = checkBenchmark([...rows, cap], [...grades, grade(cap)], {
        expectTrials: { ...R1_OPTS.expectTrials, [arm]: 1 },
        expectUnregistrable: R1_OPTS.expectUnregistrable,
        bindTaskSet: true,
      });
      expect(r.errors, arm).toEqual([
        `1 capability-arm row(s) (arm ${JSON.stringify(arm)}; cap): capability rows are experiment rows, never R1 or evidence`,
      ]);
      expect(r.r1?.pass, arm).toBe(false);
    }
  });

  it("a capability row relabelled with a Claude planner and corrections off is still refused", () => {
    const cap = row("x", {
      arm: "C1+K",
      plannerModelId: "claude-opus-5-5",
      gate: { called: true, verdict: "verified", corrections: "off" },
    });
    const r = checkBenchmark([cap], [grade(cap)], {
      expectTrials: { "C1+K": 1 },
      evidence: true,
    });
    expect(r.provenance).toBe("evidence");
    expect(r.errors).toEqual([
      '1 capability-arm row(s) (arm "C1+K"; x): capability rows are experiment rows, never R1 or evidence',
    ]);
  });
});

describe("capability arms: the CLI refuses them under --require-r1 and --evidence", () => {
  it("exit 0 for a plumbing check, exit 1 with --evidence or --require-r1", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-cap-arms-"));
    try {
      const { rows, grades } = capLedger(["C1+I", "C1"]);
      writeFileSync(join(dir, "arm.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
      writeFileSync(join(dir, "g.jsonl"), `${grades.map((r) => JSON.stringify(r)).join("\n")}\n`);
      const run = (extra: string[]) =>
        spawnSync(
          "npx",
          [
            "tsx",
            join(ROOT, "scripts", "benchmark-check.ts"),
            "--arm",
            join(dir, "arm.jsonl"),
            "--grades",
            join(dir, "g.jsonl"),
            "--expect",
            "C1+I=1",
            "--expect",
            "C1=1",
            ...extra,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
      const plain = run([]);
      expect(plain.status).toBe(0);
      expect((JSON.parse(plain.stdout) as CheckResult).ok).toBe(true);
      for (const flag of ["--evidence", "--require-r1"]) {
        const out = run([flag]);
        expect(out.status, flag).toBe(1);
        expect((JSON.parse(out.stdout) as CheckResult).errors, flag).toEqual([
          '2 capability-arm row(s) (arm "C1+I", "C1"; c0, c1): capability rows are experiment rows, never R1 or evidence',
        ]);
      }
      const bad = run(["--expect", "B+N=1"]);
      expect(bad.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capability arms: the M2 pack check refuses them in every pack", () => {
  it("the pack manifest cannot list a capability arm", () => {
    for (const arm of CAPABILITY_ARMS)
      expect(
        validateSchema(manifest({ expectTrials: { [arm]: 1 } as never }), m2PackManifestSchema),
        arm,
      ).not.toEqual([]);
  });

  it("a capability row in an otherwise passing R1 or R2 pack fails the pack", () => {
    const r1 = input(r1Trials());
    const r2 = input(r2Trials(), r2Manifest());
    expect(checkPack(r1)).toMatchObject({ ok: true, errors: [] });
    expect(checkPack(r2, TEST_R2_ALLOW)).toMatchObject({ ok: true, errors: [] });
    for (const pack of [r1, r2])
      for (const arm of CAPABILITY_ARMS) {
        const cap = row("cap", { arm, taskSetVersion: "fx-synthetic", persistedSha256: doc(9000) });
        const r = checkPack(
          {
            ...pack,
            arm: [...pack.arm, cap],
            grades: [...pack.grades, grade(cap)],
          },
          TEST_R2_ALLOW,
        );
        expect(r.ok, arm).toBe(false);
        expect(r.errors, arm).toContain(`ledger: ${arm}: no expected trial count given`);
      }
  });
});

describe("capability arms: acceptance keys on gate presence; R1-path rows unchanged", () => {
  /** `expectedAccepted` as it was before this change, for the R1-path arms. */
  const before = (r: BenchmarkArmRow) => {
    if (r.claim !== "done") return false;
    if (r.arm === "hcu+shell") return true;
    return r.gate?.called === true && r.gate.verdict === "verified";
  };
  const claims = ["done", "not-done", "no-claim"] as const;
  const gates: LedgerArmRow["gate"][] = [
    null,
    { called: false, verdict: null },
    { called: false, verdict: null, unregistrable: true },
    { called: true, verdict: "verified" },
    { called: true, verdict: "verified", corrections: "on" },
    { called: true, verdict: "refuted" },
    { called: true, verdict: "uncertain" },
    { called: true, verdict: null },
  ];

  it("myco-gate and hcu+shell: identical to the previous rule on every claim x gate shape", () => {
    for (const arm of R1_PATH_ARMS)
      for (const claim of claims)
        for (const gate of gates) {
          const r = row("k", { arm, claim, gate, accepted: false }) as BenchmarkArmRow;
          expect(expectedAccepted(r), `${arm} ${claim} ${JSON.stringify(gate)}`).toBe(before(r));
        }
  });

  it("myco-gate and hcu+shell: the check's result on the fc-v1 and R2 ledgers is unchanged", () => {
    const { rows, grades } = fcLedger();
    const r = checkBenchmark(rows, grades, { ...R1_OPTS, bindTaskSet: true, evidence: true });
    expect(r.errors).toEqual([]);
    expect(r.r1).toMatchObject({
      pass: true,
      headline: { numerator: 0, denominator: 100 },
      gated: { trials: 90, accepted: 60, falseDoneAccepted: 0, acceptedUngradable: 0 },
    });
    const two = r2Trials();
    const r2 = checkBenchmark(
      two.map((t) => t.arm),
      two.map((t) => t.grade),
      { expectTrials: { "myco-gate": 30, "hcu+shell": 30 }, evidence: true },
    );
    expect(r2.errors).toEqual([]);
    expect(r2.arms.map((a) => [a.arm, a.accepted, a.falseDoneAccepted])).toEqual([
      ["hcu+shell", 25, 10],
      ["myco-gate", 20, 0],
    ]);
  });

  it("a gate-less capability row is accepted on a done claim alone", () => {
    for (const arm of CAPABILITY_ARMS) {
      expect(expectedAccepted(row("k", { arm, gate: null, accepted: false })), arm).toBe(true);
      for (const claim of ["not-done", "no-claim"] as const)
        expect(expectedAccepted(row("k", { arm, claim, gate: null })), arm).toBe(false);
    }
  });

  it("a gated capability row needs the gate called and verified (the gate only withholds)", () => {
    for (const arm of CAPABILITY_ARMS)
      for (const claim of claims)
        for (const gate of gates.filter((g) => g !== null)) {
          const want = claim === "done" && gate?.called === true && gate.verdict === "verified";
          expect(expectedAccepted(row("k", { arm, claim, gate, accepted: false })), arm).toBe(want);
        }
  });

  it("the check refuses a capability row whose accepted contradicts claim and gate", () => {
    const lie = row("x", {
      arm: "C1+P",
      gate: { called: true, verdict: "refuted" },
      accepted: true,
    });
    const r = checkBenchmark([lie], [grade(lie, "fail")], { expectTrials: { "C1+P": 1 } });
    expect(r.errors).toEqual(["x: accepted=true contradicts claim=done and gate"]);
  });
});
