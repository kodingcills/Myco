/**
 * The draft public-R1 pre-registration under the lead's 13:55Z harness ruling (gap items 1,
 * 3, 4, 5): it states OSWorld's own harness and Claude runner at the pin, one action layer
 * asserted identical across arms, where DONE is intercepted, exactly the three ruled arms, the
 * upstream evaluate path as grader, and the WAA phase-2 entry; its hash is recomputable; and
 * the analysis refuses "shown" while anything is pending (#652 rule). Rows below are
 * synthetic inputs to the analysis function, not results.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UPSTREAM_METRIC_MOCK_VERSION } from "../../src/benchmark/upstream/evaluate.ts";
import type { UpstreamTask } from "../../src/benchmark/upstream/import.ts";
import { OSWORLD_HARNESS, OSWORLD_PIN } from "../../src/benchmark/upstream/pins.ts";
import {
  analyzePublicR1,
  canonicalJson,
  type PublicR1Prereg,
  type PublicR1Row,
  preregProblems,
  preregSha256,
  WAA_PHASE2_ENTRY,
} from "../../src/benchmark/upstream/prereg.ts";
import { OSWORLD_EVALUATE_GRADER } from "../../src/benchmark/upstream/r1-grade.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RAW = readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.json"), "utf8");
const MD = readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.md"), "utf8");
type Prereg = PublicR1Prereg & Record<string, unknown>;
const PREREG = JSON.parse(RAW) as Prereg;
const TASKS = readFileSync(join(ROOT, "benchmark/upstream/osworld-office-v1/tasks.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as UpstreamTask);
const SUBSET = new Set(TASKS.map((t) => t.taskId));
const clone = (): Prereg => JSON.parse(RAW);

/** A hypothetical fully-ruled, frozen copy, to show the analysis is not refusing for its own sake. */
function ruled(): Prereg {
  const p = clone() as Record<string, unknown>;
  (p.harness as Record<string, unknown>).provider = "docker";
  return {
    ...(p as Prereg),
    status: "frozen",
    model: "model-x",
    budget: "50 steps",
    gateOracle: "family-x",
    leadRulingPending: [],
  };
}
const row = (taskId: string, over: Partial<PublicR1Row> = {}): PublicR1Row => ({
  taskSetVersion: "osworld-office-v1",
  taskId,
  arm: "gate-before-done",
  label: "LIVE",
  graderVersion: OSWORLD_EVALUATE_GRADER,
  agentClaimedDone: true,
  upstreamStatus: "pass",
  gateVerdict: "verified",
  ...over,
});
const allRows = (over: (id: string, i: number) => Partial<PublicR1Row> = () => ({})) =>
  [...SUBSET].map((id, i) => row(id, over(id, i)));

describe("draft public-R1 pre-registration: the harness ruling's fields", () => {
  it("has no shape problem as committed", () => {
    expect(preregProblems(PREREG, SUBSET.size)).toEqual([]);
  });

  it("states OSWorld's own harness and the standard Claude runner at the pinned commit", () => {
    const h = PREREG.harness as Record<string, unknown>;
    expect(h.repo).toBe(OSWORLD_PIN.repo);
    expect(h.commit).toBe(OSWORLD_PIN.commit);
    expect(h.providerOptions).toEqual([
      "aws",
      "virtualbox",
      "vmware",
      "docker",
      "azure",
      "pyromind",
    ]);
    expect(PREREG.agentRunner).toMatchObject({
      file: "scripts/python/run_multienv_claude.py",
      commit: OSWORLD_PIN.commit,
    });
    expect(OSWORLD_HARNESS.files[OSWORLD_HARNESS.agentRunner]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("asserts one action layer, identical across arms, and says where and how DONE is intercepted", () => {
    expect(PREREG.actionLayer).toMatchObject({
      actionSpace: "claude_computer_use",
      observationType: "screenshot",
      identicalAcrossArms: true,
    });
    expect((PREREG.actionLayer as { assertion: string }).assertion).toMatch(
      /^Identical across arms/,
    );
    expect(PREREG.gateInterception).toMatchObject({
      api: "myco.gate/v1",
      request: ["taskId", "runId", "claim"],
      failClosed: true,
    });
  });

  it("has exactly the three ruled arms on the shared runner, action layer and budget; the gate only in arm (b)", () => {
    const arms = PREREG.arms as Record<string, unknown>[];
    expect(arms.map((a) => a.id)).toEqual(["no-gate", "gate-before-done", "self-check"]);
    expect(arms.map((a) => a.gate)).toEqual([false, true, false]);
    for (const a of arms)
      expect(a).toMatchObject({ agentRunner: "shared", actionLayer: "shared", budget: "shared" });
    expect(RAW).not.toMatch(
      /hcu-shell|screenshot-only|myco-gate"|namespace desktop|linux-namespace/i,
    );
  });

  it("grades with the upstream evaluate path at the pin, never the MOCK metric runner", () => {
    expect(PREREG.grader).toMatchObject({
      version: OSWORLD_EVALUATE_GRADER,
      path: "desktop_env/desktop_env.py#DesktopEnv.evaluate",
    });
    expect(OSWORLD_EVALUATE_GRADER).toBe(`osworld-desktopenv-evaluate@${OSWORLD_PIN.commit}`);
  });

  it("states the subset rule and count from OSWorld's own task list, with no exclusions", () => {
    expect(PREREG.subsetSize).toBe(117);
    expect(PREREG.n).toBe(SUBSET.size);
    expect(PREREG.exclusions).toEqual([]);
    expect(PREREG.subsetRule).toMatch(
      /libreoffice_calc, libreoffice_writer and libreoffice_impress/,
    );
  });

  it("keeps WAA as phase 2: deferred, not dropped", () => {
    expect(PREREG.phase2).toEqual([WAA_PHASE2_ENTRY]);
    expect(WAA_PHASE2_ENTRY).toBe(
      "WAA office subset (64 tasks @ eb220c4dcf64) via WAA's own Windows 11 image, in-VM server, evaluators and runner: deferred, not dropped.",
    );
  });

  it("keeps the truly open rulings pending, the gate oracle among them, and drops the namespace-desktop harness item", () => {
    const ids = PREREG.leadRulingPending.map((p) => p.split(":")[0]);
    expect(ids).toEqual(
      expect.arrayContaining([
        "asset-license",
        "model",
        "budget",
        "n",
        "pass-threshold",
        "gate-oracle",
      ]),
    );
    expect(ids).not.toContain("harness");
    expect(PREREG.gateOracle).toMatch(/^PENDING/);
    expect(PREREG.gateOracleConstraint).toMatch(/independent of the upstream evaluator/);
  });

  it("each missing ruling field is caught by the shape check", () => {
    const cases: [string, (p: Record<string, unknown>) => void][] = [
      [
        "HARNESS_NOT_PINNED",
        (p) => ((p.harness as Record<string, unknown>).commit = "0".repeat(40)),
      ],
      [
        "HARNESS_PROVIDERS_MISSING",
        (p) => delete (p.harness as Record<string, unknown>).providerOptions,
      ],
      [
        "AGENT_RUNNER_NOT_PINNED",
        (p) => ((p.agentRunner as Record<string, unknown>).file = "run.py"),
      ],
      [
        "ACTION_LAYER_NOT_ASSERTED_IDENTICAL",
        (p) => ((p.actionLayer as Record<string, unknown>).identicalAcrossArms = false),
      ],
      [
        "ACTION_LAYER_NOT_UPSTREAM",
        (p) => ((p.actionLayer as Record<string, unknown>).executor = "hcu"),
      ],
      [
        "ARM_ACTION_LAYER_DIFFERS:self-check",
        (p) =>
          (((p.arms as Record<string, unknown>[])[2] as Record<string, unknown>).actionLayer =
            "hcu+shell"),
      ],
      [
        "ARM_BUDGET_DIFFERS:no-gate",
        (p) =>
          (((p.arms as Record<string, unknown>[])[0] as Record<string, unknown>).budget =
            "100 steps"),
      ],
      [
        "ARM_GATE_WRONG:self-check",
        (p) => (((p.arms as Record<string, unknown>[])[2] as Record<string, unknown>).gate = true),
      ],
      [
        "ARMS_NOT_RULED",
        (p) =>
          (p.arms as unknown[]).push({
            id: "hcu-shell",
            actionLayer: "shared",
            agentRunner: "shared",
            budget: "shared",
            gate: false,
          }),
      ],
      [
        "GATE_INTERCEPTION_MISSING",
        (p) =>
          ((p.gateInterception as Record<string, unknown>).request = [
            "taskId",
            "runId",
            "claim",
            "expected",
          ]),
      ],
      [
        "GRADER_NOT_UPSTREAM_EVALUATE",
        (p) => ((p.grader as Record<string, unknown>).version = UPSTREAM_METRIC_MOCK_VERSION),
      ],
      ["WAA_PHASE2_MISSING", (p) => (p.phase2 = [])],
      ["SUBSET_SIZE_MISMATCH", (p) => (p.subsetSize = 130)],
      [
        "STALE_HARNESS_PENDING",
        (p) => (p.leadRulingPending as string[]).push("harness: display on the namespace desktops"),
      ],
    ];
    for (const [code, mutate] of cases) {
      const p = clone();
      mutate(p);
      expect(preregProblems(p, SUBSET.size), code).toContain(code);
    }
  });

  it("its hash is the SHA-256 of the canonical JSON, and the .md quotes it", () => {
    const hash = preregSha256(PREREG);
    expect(MD).toContain(`\`${hash}\``);
    expect(canonicalJson({ b: [2, { d: 1, c: 0 }], a: "x" })).toBe(
      '{"a":"x","b":[2,{"c":0,"d":1}]}',
    );
    expect(preregSha256({ ...clone(), n: 116 })).not.toBe(hash);
  });
});

describe("the public-R1 analysis refuses 'shown' while anything is pending", () => {
  it("refuses on the draft even with perfect LIVE rows", () => {
    const a = analyzePublicR1(PREREG, SUBSET, allRows());
    expect(a.verdict).toBe("refused");
    expect(a.reasons).toEqual(
      expect.arrayContaining([
        "PREREG_NOT_FROZEN",
        "LEAD_RULING_PENDING",
        "FIELD_PENDING:model",
        "FIELD_PENDING:budget",
        "FIELD_PENDING:gateOracle",
        "FIELD_PENDING:harness.provider",
      ]),
    );
  });

  it("refuses while any single lead ruling is pending, any field says PENDING, or the record has a shape problem", () => {
    expect(
      analyzePublicR1({ ...ruled(), leadRulingPending: ["n"] }, SUBSET, allRows()),
    ).toMatchObject({
      verdict: "refused",
      reasons: ["LEAD_RULING_PENDING"],
    });
    expect(analyzePublicR1({ ...ruled(), model: "PENDING: id" }, SUBSET, allRows())).toMatchObject({
      verdict: "refused",
      reasons: ["FIELD_PENDING:model"],
    });
    expect(analyzePublicR1({ ...ruled(), phase2: [] }, SUBSET, allRows())).toMatchObject({
      verdict: "refused",
      reasons: ["PREREG_INVALID:WAA_PHASE2_MISSING"],
    });
  });

  it("never counts MOCK or simulated rows, rows from the MOCK metric runner, or rows from an unregistered arm", () => {
    expect(
      analyzePublicR1(
        ruled(),
        SUBSET,
        allRows((_, i) => (i === 0 ? { label: "MOCK" } : {})),
      ).reasons,
    ).toEqual(["NON_LIVE_ROW"]);
    expect(
      analyzePublicR1(
        ruled(),
        SUBSET,
        allRows((_, i) => (i === 3 ? { label: "SIMULATED" } : {})),
      ).verdict,
    ).toBe("refused");
    expect(
      analyzePublicR1(
        ruled(),
        SUBSET,
        allRows((_, i) => (i === 5 ? { graderVersion: UPSTREAM_METRIC_MOCK_VERSION } : {})),
      ).reasons,
    ).toEqual(["NOT_UPSTREAM_EVALUATE_GRADED"]);
    expect(
      analyzePublicR1(ruled(), SUBSET, [
        ...allRows(),
        row([...SUBSET][0] as string, { arm: "hcu-shell" }),
      ]).reasons,
    ).toEqual(["ROW_ARM_NOT_REGISTERED"]);
  });

  it("refuses unless the gated LIVE rows cover exactly the n pre-registered subset tasks", () => {
    const rows = allRows();
    expect(analyzePublicR1(ruled(), SUBSET, rows.slice(1)).reasons).toEqual(["N_MISMATCH"]);
    expect(
      analyzePublicR1(ruled(), SUBSET, [...rows.slice(1), rows[1] as PublicR1Row]).reasons,
    ).toEqual(["N_MISMATCH"]);
    expect(
      analyzePublicR1(ruled(), SUBSET, [...rows, row("not-in-subset", { arm: "no-gate" })]).reasons,
    ).toEqual(["ROW_OUTSIDE_SUBSET"]);
  });

  it("once nothing is pending: a gate that catches every false done is 'shown'; one false accept is 'not shown'", () => {
    const caught = allRows((_, i) =>
      i < 10 ? { upstreamStatus: "fail", gateVerdict: "refuted" } : {},
    );
    expect(analyzePublicR1(ruled(), SUBSET, caught)).toEqual({
      verdict: "shown",
      reasons: [],
      falseDone: 10,
      falseAccepts: 0,
      caught: 10,
    });
    const leak = allRows((_, i) =>
      i === 0 ? { upstreamStatus: "fail", gateVerdict: "verified" } : {},
    );
    expect(analyzePublicR1(ruled(), SUBSET, leak)).toMatchObject({
      verdict: "not-shown",
      falseAccepts: 1,
    });
    const ungradableAccepted = allRows((_, i) =>
      i === 0 ? { upstreamStatus: "ungradable", gateVerdict: "verified" } : {},
    );
    expect(analyzePublicR1(ruled(), SUBSET, ungradableAccepted)).toMatchObject({
      verdict: "not-shown",
    });
  });
});
