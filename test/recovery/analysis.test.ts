/**
 * Track K: the pre-registered analysis (`src/recovery/analysis.ts`) and its command line
 * (`scripts/k-recovery-analysis.ts`).
 *
 *  A1 a draft pre-registration never analyses evidence; plumbing runs are never evidence.
 *  A2 a pack whose recorded hash, commit, arm or schema does not match is refused (§3.2).
 *  A3 a halted batch is reported as halted, never summarized.
 *  A4 against a frozen pre-registration, rows must match it: model, step budget, task set,
 *     task count and faulted count; matching packs give the bar as evidence.
 *  A5 a pre-registration that fails its check is refused.
 *  A6 the command line: usage errors exit 2; refusals exit 1 and name the reason.
 *  A7 the shared analysis rules (#652): R1 never "shown" while a lead ruling is pending (and
 *     the exit code is non-zero); R2 a row is real only when `simulated` is absent or exactly
 *     false; R3 a pre-registration hash mismatch, or a commit not on main, is refused.
 *  A8 never "shown" unless frozen, confirmatory and evidence: plumbing, a draft and an
 *     exploratory (n = 40) pre-registration report the statistics with `passes` false.
 *  A9 a complete batch holding a gate miss is refused (#647 round 1, N2).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AnalysisInputs,
  type AnalysisResult,
  analysisExitCode,
  analyzeRecoveryPacks,
  isSimulatedRow,
  type RecoveryPack,
} from "../../src/recovery/analysis.ts";
import type { BatchResult, RecoveryRow } from "../../src/recovery/batch.ts";
import { K_PREREG_PATH, type PreregFiles, preregHash } from "../../src/recovery/prereg.ts";
import type { RecoveryArm } from "../../src/recovery/trial.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DRAFT = JSON.parse(readFileSync(resolve(ROOT, K_PREREG_PATH), "utf8"));
const COMMIT = "c".repeat(40);
const MANIFEST = "a".repeat(64);

const disk: PreregFiles = {
  sha256: (p) =>
    existsSync(resolve(ROOT, p))
      ? createHash("sha256")
          .update(readFileSync(resolve(ROOT, p)))
          .digest("hex")
      : null,
  text: (p) => (existsSync(resolve(ROOT, p)) ? readFileSync(resolve(ROOT, p), "utf8") : null),
};
const withManifest: PreregFiles = {
  ...disk,
  sha256: (p) => (p === DRAFT.taskSet.manifestPath ? MANIFEST : disk.sha256(p)),
};

const FROZEN = (() => {
  const p = structuredClone(DRAFT);
  p.status = "frozen";
  p.pending = [];
  p.taskSet.manifestSha256 = MANIFEST;
  p.preregistrationHash = preregHash(p);
  return p;
})();

const row = (
  taskId: string,
  arm: RecoveryArm,
  pass: boolean,
  faulted: boolean,
  over: Partial<RecoveryRow> = {},
): RecoveryRow => ({
  schema: "myco.recovery.arm-row/1",
  taskSetVersion: "ms-long-v1",
  contrast: "K-vs-nothing",
  evidence: "never-r1",
  arm,
  trialKey: `${taskId}#${arm}`,
  taskId,
  faulted,
  faultKind: faulted ? "kill-app" : null,
  simulated: false,
  plannerModelId: "claude-sonnet-5-5",
  instructionSha256: "1".repeat(64),
  fixtureSha256: "2".repeat(64),
  claim: "done",
  gate: {
    called: true,
    verdict: pass ? "verified" : "refuted",
    corrections: arm === "K" ? "on" : "off",
  },
  accepted: pass,
  harnessCodes: [],
  retryBudget: arm === "K" ? 1 : 0,
  recoveryTools: arm === "K",
  attempts: 1,
  stepBudget: 80,
  steps: 20,
  elapsedMs: 1,
  costUsd: 0.1,
  grade: pass ? "pass" : "fail",
  ...over,
});

/** `n` tasks, half faulted; both arms verify the second half; K also the first `kOnly`. */
function rows(arm: RecoveryArm, n = 90, kOnly = 6, over: Partial<RecoveryRow> = {}) {
  const half = n / 2;
  return Array.from({ length: n }, (_, i) =>
    row(`ms-${i}`, arm, arm === "K" ? i < kOnly || i >= half : i >= half, i % 2 === 0, over),
  );
}
/** Simulated (plumbing) rows: flag true, a scripted planner. */
const simRows = (arm: RecoveryArm, n = 10, kOnly = 5) =>
  rows(arm, n, kOnly, { simulated: true, plannerModelId: "simulated:scripted" });
const complete = (r: RecoveryRow[]): BatchResult => ({
  status: "complete",
  rows: r,
  harnessAttempts: r.reduce((s, x) => s + x.attempts, 0),
});
function pack(arm: RecoveryArm, batch: BatchResult, prereg = FROZEN): RecoveryPack {
  return {
    schema: "myco.recovery.pack/1",
    arm,
    preregistrationHash: prereg.preregistrationHash,
    preregCommit: COMMIT,
    batch,
  };
}
function inputs(over: Partial<AnalysisInputs> = {}): AnalysisInputs {
  const prereg = (over.prereg ?? FROZEN) as typeof FROZEN;
  return {
    prereg,
    files: withManifest,
    committedPreregHash: (c) => (c === COMMIT ? prereg.preregistrationHash : null),
    commitOnMain: (c) => c === COMMIT,
    k: pack("K", complete(rows("K")), prereg),
    none: pack("no-recovery", complete(rows("no-recovery")), prereg),
    ...over,
  };
}

describe("A1: drafts and plumbing are never evidence", () => {
  it("the committed draft refuses an evidence analysis and names what is pending", () => {
    expect(() => analyzeRecoveryPacks(inputs({ prereg: DRAFT, files: disk }))).toThrow(
      /draft \(pending: taskSet\.manifestSha256, sizeRule\.applied\)/,
    );
  });

  it("the draft runs plumbing on simulated rows, with evidence false and never shown", () => {
    const sim = (arm: RecoveryArm) => complete(simRows(arm));
    const r = analyzeRecoveryPacks(
      inputs({
        prereg: DRAFT,
        files: disk,
        k: pack("K", sim("K"), DRAFT),
        none: pack("no-recovery", sim("no-recovery"), DRAFT),
        plumbing: true,
      }),
    );
    expect(r.status).toBe("analyzed");
    if (r.status !== "analyzed") return;
    expect(r).toMatchObject({ frozen: false, evidence: false, shown: false });
    expect(r.notShown).toEqual(["PLUMBING", "DRAFT"]);
    expect(r.leadRulingsPending).toEqual([]);
    // 5 discordant, all for K: the statistics pass, but a plumbing draft never "passes" (N1).
    expect(r.bar).toMatchObject({ evidence: false, passes: false, p: 0.03125 });
    expect(r.preregistrationHash).toBe(DRAFT.preregistrationHash);
    expect(analysisExitCode(r)).toBe(0);
  });

  it("plumbing against a frozen pre-registration is still never evidence nor shown", () => {
    const sim = (arm: RecoveryArm) => complete(simRows(arm));
    const r = analyzeRecoveryPacks(
      inputs({
        k: pack("K", sim("K")),
        none: pack("no-recovery", sim("no-recovery")),
        plumbing: true,
      }),
    );
    expect(r).toMatchObject({ status: "analyzed", evidence: false, frozen: true, shown: false });
    expect(r.status === "analyzed" && r.notShown).toEqual(["PLUMBING"]);
    expect(r.status === "analyzed" && r.bar.passes).toBe(false);
  });
});

describe("A2: a pack must be run against the committed pre-registration", () => {
  const cases: [string, Partial<AnalysisInputs>, RegExp][] = [
    [
      "another hash",
      { k: { ...pack("K", complete(rows("K"))), preregistrationHash: "0".repeat(64) } },
      /another pre-registration hash/,
    ],
    ["a commit without it", { committedPreregHash: () => null }, /commit does not hold/],
    [
      "a commit with another one",
      { committedPreregHash: () => "9".repeat(64) },
      /commit does not hold/,
    ],
    [
      "no commit",
      { none: { ...pack("no-recovery", complete(rows("no-recovery"))), preregCommit: "HEAD" } },
      /does not record the pre-registration's commit/,
    ],
    [
      "swapped arms",
      { k: pack("no-recovery", complete(rows("no-recovery"))) },
      /labelled no-recovery/,
    ],
    [
      "not a pack",
      { k: { ...pack("K", complete(rows("K"))), schema: "x" } as unknown as RecoveryPack },
      /not a recovery pack/,
    ],
  ];
  for (const [name, over, re] of cases)
    it(`refuses ${name}`, () => {
      expect(() => analyzeRecoveryPacks(inputs(over))).toThrow(re);
    });
});

describe("A3: a halted batch is reported, never summarized", () => {
  it("returns the halt and no bar", () => {
    const halted: BatchResult = {
      status: "halted",
      halt: { trialKey: "ms-3#K", attempt: 2, grade: "fail" },
      rows: rows("K").slice(0, 3),
      harnessAttempts: 4,
    };
    const r = analyzeRecoveryPacks(inputs({ k: pack("K", halted) }));
    expect(r).toEqual({
      status: "halted",
      preregistrationHash: FROZEN.preregistrationHash,
      frozen: true,
      evidence: false,
      shown: false,
      arm: "K",
      halt: { trialKey: "ms-3#K", attempt: 2, grade: "fail" },
    });
  });
});

describe("A4: rows must match a frozen pre-registration", () => {
  it("matching packs give the bar, as evidence", () => {
    const r = analyzeRecoveryPacks(inputs());
    expect(r.status).toBe("analyzed");
    if (r.status !== "analyzed") return;
    expect(r).toMatchObject({ frozen: true, evidence: true, shown: true, notShown: [] });
    expect(r.designation).toBe("confirmatory");
    expect(r.bar.all).toMatchObject({ tasks: 90, kOnly: 6, noneOnly: 0 });
    expect(r.bar.faulted.tasks).toBe(45);
    expect(r.bar.passes).toBe(true);
    expect(analysisExitCode(r)).toBe(0);
  });

  const cases: [string, Partial<RecoveryRow> | null, number | null, RegExp][] = [
    [
      "another model",
      { plannerModelId: "claude-opus-5-5" },
      null,
      /planner is not claude-sonnet-5-5/,
    ],
    ["another step budget", { stepBudget: 30 }, null, /step budget is not 80/],
    ["another task set", { taskSetVersion: "fc-v1" }, null, /task set is not ms-long-v1/],
    ["40 tasks (the unratified size)", null, 40, /40 rows, pre-registered at 90/],
    ["88 tasks", null, 88, /88 rows, pre-registered at 90/],
  ];
  for (const [name, over, n, re] of cases)
    it(`refuses ${name}`, () => {
      const k = complete(rows("K", n ?? 90, 6, over ?? {}));
      const none = complete(rows("no-recovery", n ?? 90, 6, over ?? {}));
      expect(() =>
        analyzeRecoveryPacks(inputs({ k: pack("K", k), none: pack("no-recovery", none) })),
      ).toThrow(re);
    });

  it("refuses a faulted count that is not the pre-registered half", () => {
    const shift = (r: RecoveryRow[]) =>
      r.map((x, i) => (i === 1 ? { ...x, faulted: true, faultKind: "focus-change" as const } : x));
    expect(() =>
      analyzeRecoveryPacks(
        inputs({
          k: pack("K", complete(shift(rows("K")))),
          none: pack("no-recovery", complete(shift(rows("no-recovery")))),
        }),
      ),
    ).toThrow(/46 faulted tasks, pre-registered at 45/);
  });

  it("simulated rows against a frozen pre-registration are refused without --plumbing", () => {
    const sim = (arm: RecoveryArm) => complete(rows(arm, 90, 6, { simulated: true }));
    expect(() =>
      analyzeRecoveryPacks(
        inputs({ k: pack("K", sim("K")), none: pack("no-recovery", sim("no-recovery")) }),
      ),
    ).toThrow(/holds a simulated row/);
  });
});

describe("A5: a pre-registration that fails its check is refused", () => {
  it("an edited field without a new hash", () => {
    const tampered = { ...FROZEN, stepBudget: 30 };
    expect(() => analyzeRecoveryPacks(inputs({ prereg: tampered }))).toThrow(
      /pre-registration is refused/,
    );
  });
});

describe("A6: the command line", () => {
  const cli = (args: string[]) =>
    spawnSync("npx", ["tsx", join(ROOT, "scripts", "k-recovery-analysis.ts"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
  const dir = mkdtempSync(join(tmpdir(), "k-analysis-"));
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it("usage errors exit 2", () => {
    expect(cli([]).status).toBe(2);
    expect(cli(["--prereg", "other.json", "--k", "a", "--none", "b"]).status).toBe(2);
    expect(cli(["--bogus"]).status).toBe(2);
  });

  it("the committed draft refuses an evidence run (exit 1)", () => {
    const k = write("k.json", pack("K", complete(rows("K")), DRAFT));
    const none = write("none.json", pack("no-recovery", complete(rows("no-recovery")), DRAFT));
    const r = cli(["--prereg", K_PREREG_PATH, "--k", k, "--none", none]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused: the pre-registration is a draft/);
  });

  it("a plumbing run whose commit is not on main is refused (exit 1)", () => {
    // A commit object that exists in this clone but is on no branch: a child of HEAD.
    const git = (args: string[]) =>
      spawnSync("git", args, {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      });
    const made = git(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "k-analysis test"]);
    expect(made.status).toBe(0);
    const offMain = made.stdout.trim();
    for (const commit of [offMain, "0".repeat(40)]) {
      const sim = (arm: RecoveryArm) => ({
        ...pack(arm, complete(simRows(arm)), DRAFT),
        preregCommit: commit,
      });
      const k = write("k2.json", sim("K"));
      const none = write("n2.json", sim("no-recovery"));
      const r = cli(["--prereg", K_PREREG_PATH, "--k", k, "--none", none, "--plumbing"]);
      expect(r.status, commit).toBe(1);
      expect(r.stderr, commit).toMatch(/commit is not on main/);
    }
  });
});

const sim = (arm: RecoveryArm) => complete(simRows(arm));
/** A copy of the committed draft with `patch` applied and the hash recomputed. */
function draftWith(patch: (p: typeof DRAFT) => void) {
  const p = structuredClone(DRAFT);
  patch(p);
  p.preregistrationHash = preregHash(p);
  return p;
}
function plumbingOn(prereg: typeof DRAFT, files: PreregFiles = disk): AnalysisResult {
  return analyzeRecoveryPacks(
    inputs({
      prereg,
      files,
      k: pack("K", sim("K"), prereg),
      none: pack("no-recovery", sim("no-recovery"), prereg),
      plumbing: true,
    }),
  );
}

describe("A7 R1: never shown while a lead ruling is pending, and the exit code is non-zero", () => {
  const cases: [string, (p: typeof DRAFT) => void, string][] = [
    [
      "a leadRulingPending item",
      (p) => {
        p.leadRulingPending = [{ field: "stepBudget", reason: "re-opened" }];
      },
      "stepBudget",
    ],
    [
      "a pending item whose reason says lead ruling pending",
      (p) => {
        p.pending.push({ field: "editsPerTask", reason: "Lead ruling pending" });
      },
      "editsPerTask",
    ],
    [
      "a lead-ruled field with no ruling",
      (p) => {
        p.leadRulings = p.leadRulings.filter(
          (r: { fields: string[] }) => !r.fields.includes("taskSet.size"),
        );
      },
      "taskSet.size",
    ],
  ];
  for (const [name, patch, field] of cases)
    it(name, () => {
      const r = plumbingOn(draftWith(patch));
      expect(r.status).toBe("analyzed");
      if (r.status !== "analyzed") return;
      expect(r.shown).toBe(false);
      expect(r.notShown).toContain("LEAD_RULING_PENDING");
      expect(r.leadRulingsPending).toContain(field);
      expect(r.bar.passes).toBe(false);
      expect(analysisExitCode(r)).toBe(1);
    });

  it("the committed pre-registration has no lead ruling pending", () => {
    const r = plumbingOn(DRAFT);
    expect(r.status === "analyzed" && r.notShown).not.toContain("LEAD_RULING_PENDING");
  });
});

describe("A7 R2: a row is real only when simulated is absent or exactly false", () => {
  it("isSimulatedRow", () => {
    const base = row("t", "K", true, false);
    const { simulated: _drop, ...absent } = base;
    expect(isSimulatedRow(absent)).toBe(false);
    expect(isSimulatedRow({ ...base, simulated: false })).toBe(false);
    for (const v of [true, "true", "false", 0, 1, null, undefined, {}, []])
      expect(isSimulatedRow({ ...base, simulated: v }), JSON.stringify(v) ?? "undefined").toBe(
        true,
      );
    expect(isSimulatedRow(null)).toBe(true);
    expect(isSimulatedRow("row")).toBe(true);
  });

  it("evidence: any simulated value other than false refuses the pack", () => {
    for (const v of [true, "true", "false", 0, 1, null]) {
      const r = rows("K");
      r[7] = { ...(r[7] as RecoveryRow), simulated: v as boolean };
      expect(
        () => analyzeRecoveryPacks(inputs({ k: pack("K", complete(r)) })),
        JSON.stringify(v),
      ).toThrow(/the K pack holds a simulated row/);
    }
  });

  it("plumbing: a real row (simulated false or absent) refuses the pack, so no draft peeks at data (N1)", () => {
    const real = rows("K", 10, 5, { plannerModelId: "simulated:scripted" });
    const { simulated: _drop, ...absent } = real[2] as RecoveryRow;
    const mixed = [...simRows("K").slice(0, 2), absent as RecoveryRow, ...simRows("K").slice(3)];
    for (const k of [real, mixed])
      expect(() =>
        analyzeRecoveryPacks(
          inputs({
            prereg: DRAFT,
            files: disk,
            k: pack("K", complete(k), DRAFT),
            none: pack("no-recovery", sim("no-recovery"), DRAFT),
            plumbing: true,
          }),
        ),
      ).toThrow(/the K pack holds a real row/);
  });
});

describe("A7 R3: a pre-registration hash mismatch, or a commit off main, is refused", () => {
  const cases: [string, Partial<AnalysisInputs>, RegExp][] = [
    [
      "a missing hash",
      {
        none: {
          ...pack("no-recovery", complete(rows("no-recovery"))),
          preregistrationHash: undefined as unknown as string,
        },
      },
      /no-recovery pack records another pre-registration hash/,
    ],
    [
      "the draft's hash on a frozen analysis",
      { k: pack("K", complete(rows("K")), DRAFT) },
      /K pack records another pre-registration hash/,
    ],
    ["a commit not on main", { commitOnMain: () => false }, /K pack's commit is not on main/],
    [
      "a commit on main that holds another pre-registration",
      { committedPreregHash: () => DRAFT.preregistrationHash },
      /commit does not hold this pre-registration/,
    ],
  ];
  for (const [name, over, re] of cases)
    it(`refuses ${name}`, () => {
      expect(() => analyzeRecoveryPacks(inputs(over))).toThrow(re);
    });
});

describe("A8: never shown unless frozen, confirmatory and evidence", () => {
  const MANIFEST_FILES = withManifest;
  const EXPLORATORY = (() => {
    const p = structuredClone(FROZEN);
    p.designation = "exploratory";
    p.taskSet.size = 40;
    p.taskSet.faultedTasks = 20;
    p.vmHoursEstimate.tasks = 40;
    p.vmHoursEstimate.trials = 80;
    p.vmHoursEstimate.trialsFormula = "40 tasks x 2 arms x k = 1";
    p.vmHoursEstimate.vmHours = 13.3;
    p.vmHoursEstimate.atTrialTimeout.vmHours = 45.3;
    p.preregistrationHash = preregHash(p);
    return p;
  })();

  it("an exploratory (n = 40) frozen pre-registration reports the statistics, never shown", () => {
    const r = analyzeRecoveryPacks(
      inputs({
        prereg: EXPLORATORY,
        files: MANIFEST_FILES,
        k: pack("K", complete(rows("K", 40)), EXPLORATORY),
        none: pack("no-recovery", complete(rows("no-recovery", 40)), EXPLORATORY),
      }),
    );
    expect(r).toMatchObject({
      status: "analyzed",
      frozen: true,
      evidence: true,
      designation: "exploratory",
      shown: false,
      notShown: ["EXPLORATORY"],
    });
    expect(r.status === "analyzed" && r.bar.p).toBeCloseTo(0.015625, 6);
    expect(r.status === "analyzed" && r.bar.passes).toBe(false);
  });

  it("underpowered and p above alpha are named", () => {
    const under = analyzeRecoveryPacks(inputs({ k: pack("K", complete(rows("K", 90, 4))) }));
    expect(under).toMatchObject({ shown: false, notShown: ["UNDERPOWERED", "P_ABOVE_ALPHA"] });
    // 5 for K, 3 for none: d = 8, p = 0.363 > 0.05.
    const k = rows("K", 90, 5);
    const none = rows("no-recovery", 90, 0).map((x, i) =>
      i >= 5 && i < 8
        ? {
            ...x,
            gate: { ...x.gate, verdict: "verified" as const },
            accepted: true,
            grade: "pass" as const,
          }
        : x,
    );
    const above = analyzeRecoveryPacks(
      inputs({ k: pack("K", complete(k)), none: pack("no-recovery", complete(none)) }),
    );
    expect(above).toMatchObject({ shown: false, notShown: ["P_ABOVE_ALPHA"] });
    expect(above.status === "analyzed" && above.bar.passes).toBe(false);
  });
});

describe("A9: a complete batch holding a gate miss is refused (N2)", () => {
  for (const grade of ["fail", "ungradable"] as const)
    it(`verified, graded ${grade}`, () => {
      const r = rows("no-recovery");
      r[50] = { ...(r[50] as RecoveryRow), grade };
      expect(() =>
        analyzeRecoveryPacks(inputs({ none: pack("no-recovery", complete(r)) })),
      ).toThrow(/no-recovery pack holds a gate miss \(ms-50#no-recovery: verified, graded/);
    });
});
