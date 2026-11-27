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
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AnalysisInputs,
  analysisExitCode,
  analyzeRecoveryPacks,
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

/** 40 tasks, half faulted; K verifies the first `kOnly` extra tasks. */
function rows(arm: RecoveryArm, n = 40, kOnly = 6, over: Partial<RecoveryRow> = {}) {
  return Array.from({ length: n }, (_, i) =>
    row(`ms-${i}`, arm, arm === "K" ? i < kOnly || i >= 20 : i >= 20, i % 2 === 0, over),
  );
}
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
    k: pack("K", complete(rows("K")), prereg),
    none: pack("no-recovery", complete(rows("no-recovery")), prereg),
    ...over,
  };
}

describe("A1: drafts and plumbing are never evidence", () => {
  it("the committed draft refuses an evidence analysis and names what is pending", () => {
    expect(() => analyzeRecoveryPacks(inputs({ prereg: DRAFT, files: disk }))).toThrow(
      /draft \(pending: stepBudget, taskSet\.size, taskSet\.manifestSha256\)/,
    );
  });

  it("the draft runs plumbing on simulated rows, with evidence false", () => {
    const sim = (arm: RecoveryArm) =>
      complete(rows(arm, 6, 5, { simulated: true, plannerModelId: "simulated:scripted" }));
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
    expect(r).toMatchObject({ frozen: false, evidence: false });
    expect(r.bar.evidence).toBe(false);
    expect(r.preregistrationHash).toBe(DRAFT.preregistrationHash);
  });

  it("plumbing against a frozen pre-registration is still never evidence", () => {
    const r = analyzeRecoveryPacks(inputs({ plumbing: true }));
    expect(r.status === "analyzed" && r.evidence).toBe(false);
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
    expect(r).toMatchObject({ frozen: true, evidence: true });
    expect(r.bar.all).toMatchObject({ tasks: 40, kOnly: 6, noneOnly: 0 });
    expect(r.bar.passes).toBe(true);
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
    ["39 tasks", null, 39, /39 rows, pre-registered at 40/],
  ];
  for (const [name, over, n, re] of cases)
    it(`refuses ${name}`, () => {
      const k = complete(rows("K", n ?? 40, 6, over ?? {}));
      const none = complete(rows("no-recovery", n ?? 40, 6, over ?? {}));
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
    ).toThrow(/21 faulted tasks, pre-registered at 20/);
  });

  it("simulated rows against a frozen pre-registration are refused without --plumbing", () => {
    const sim = (arm: RecoveryArm) => complete(rows(arm, 40, 6, { simulated: true }));
    expect(() =>
      analyzeRecoveryPacks(
        inputs({ k: pack("K", sim("K")), none: pack("no-recovery", sim("no-recovery")) }),
      ),
    ).toThrow(/simulated/);
  });
});

describe("A7: the shared capability-analysis guard (#652)", () => {
  it("a frozen pre-registration with matching evidence rows is shown, exit 0", () => {
    const r = analyzeRecoveryPacks(inputs());
    expect(r.status === "analyzed" && r.verdict).toBe("shown");
    expect(r.status === "analyzed" && r.reasons).toEqual([]);
    expect(analysisExitCode(r)).toBe(0);
  });

  it("the draft (pending items) runs plumbing but is never shown: LEAD_RULING_PENDING, exit 3", () => {
    // Real-model rows that would pass the bar: only the pending list and plumbing block it.
    const r = analyzeRecoveryPacks(
      inputs({
        prereg: DRAFT,
        files: disk,
        k: pack("K", complete(rows("K")), DRAFT),
        none: pack("no-recovery", complete(rows("no-recovery")), DRAFT),
        plumbing: true,
      }),
    );
    expect(r.status).toBe("analyzed");
    if (r.status !== "analyzed") return;
    expect(r.bar.passes).toBe(true);
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons).toContain(
      "LEAD_RULING_PENDING: stepBudget, taskSet.size, taskSet.manifestSha256",
    );
    expect(r.exitCode).toBe(3);
    expect(analysisExitCode(r)).toBe(3);
  });

  it('a row whose simulated is the string "true" never counts (plumbing, frozen)', () => {
    const odd = (arm: RecoveryArm) =>
      complete(rows(arm, 40, 6, { simulated: "true" as unknown as boolean }));
    const r = analyzeRecoveryPacks(
      inputs({
        k: pack("K", odd("K")),
        none: pack("no-recovery", odd("no-recovery")),
        plumbing: true,
      }),
    );
    expect(r.status).toBe("analyzed");
    if (r.status !== "analyzed") return;
    expect(r.verdict).toBe("not-shown");
    expect(r.reasons).toContain("SIMULATED: 80 row(s); simulated rows are never evidence");
  });

  it("a halted result reports exit 0 (reported, never summarized)", () => {
    expect(
      analysisExitCode({
        status: "halted",
        preregistrationHash: FROZEN.preregistrationHash,
        arm: "K",
        halt: { trialKey: "ms-3#K", attempt: 2, grade: "fail" },
      }),
    ).toBe(0);
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

  it("a plumbing run against the committed draft prints the result and exits 3 (#652)", () => {
    // The pack's frozen commit is HEAD, which must hold this prereg.json (commit it first).
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    const commit = head.stdout.trim();
    const atHead = spawnSync("git", ["show", `${commit}:${K_PREREG_PATH}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(preregHash(JSON.parse(atHead.stdout)), "HEAD must hold the working k-v1 prereg").toBe(
      DRAFT.preregistrationHash,
    );
    const k = write("k3.json", { ...pack("K", complete(rows("K")), DRAFT), preregCommit: commit });
    const none = write("n3.json", {
      ...pack("no-recovery", complete(rows("no-recovery")), DRAFT),
      preregCommit: commit,
    });
    const r = cli(["--prereg", K_PREREG_PATH, "--k", k, "--none", none, "--plumbing"]);
    expect(r.status).toBe(3);
    const out = JSON.parse(r.stdout);
    expect(out.verdict).toBe("not-shown");
    expect(out.reasons[0]).toMatch(/^LEAD_RULING_PENDING: /);
  });

  it("a plumbing run whose commit does not hold the pre-registration is refused (exit 1)", () => {
    const k = write("k2.json", {
      ...pack("K", complete(rows("K")), DRAFT),
      preregCommit: "0".repeat(40),
    });
    const none = write("n2.json", {
      ...pack("no-recovery", complete(rows("no-recovery")), DRAFT),
      preregCommit: "0".repeat(40),
    });
    const r = cli(["--prereg", K_PREREG_PATH, "--k", k, "--none", none, "--plumbing"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/commit does not hold this pre-registration/);
  });
});
