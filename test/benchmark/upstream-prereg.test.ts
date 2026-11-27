/**
 * #682 item 5: the draft public-R1 pre-registration refuses "shown" while anything is pending
 * (#652 rule), never counts MOCK or simulated rows, and only then applies the R1 bar. The rows
 * below are synthetic inputs to the analysis function, not results.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UPSTREAM_GRADER_VERSION } from "../../src/benchmark/upstream/evaluate.ts";
import type { UpstreamTask } from "../../src/benchmark/upstream/import.ts";
import {
  analyzePublicR1,
  type PublicR1Prereg,
  type PublicR1Row,
} from "../../src/benchmark/upstream/prereg.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const PREREG = JSON.parse(
  readFileSync(join(ROOT, "docs/benchmark/upstream/r1-public-prereg.json"), "utf8"),
) as PublicR1Prereg & { subsetSize: number; upstreamCommit: string; model: string };
const TASKS = readFileSync(join(ROOT, "benchmark/upstream/osworld-office-v1/tasks.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as UpstreamTask);
const SUBSET = new Set(
  TASKS.filter((t) => t.placement.target === "linux-namespace-desktop").map((t) => t.taskId),
);

/** A hypothetical fully-ruled, frozen copy, to show the analysis is not refusing for its own sake. */
const ruled: PublicR1Prereg = {
  ...PREREG,
  status: "frozen",
  model: "model-x",
  budget: "50 steps",
  leadRulingPending: [],
};
const row = (taskId: string, over: Partial<PublicR1Row> = {}): PublicR1Row => ({
  taskSetVersion: "osworld-office-v1",
  taskId,
  arm: "myco-gate",
  label: "LIVE",
  graderVersion: UPSTREAM_GRADER_VERSION,
  agentClaimedDone: true,
  upstreamStatus: "pass",
  gateVerdict: "verified",
  ...over,
});
const allRows = (over: (id: string, i: number) => Partial<PublicR1Row> = () => ({})) =>
  [...SUBSET].map((id, i) => row(id, over(id, i)));

describe("draft public-R1 pre-registration (#682 item 5)", () => {
  it("is a draft with pending lead rulings, and its subset rule matches the importer's placement", () => {
    expect(PREREG.status).toBe("draft");
    expect(PREREG.leadRulingPending.length).toBeGreaterThan(0);
    expect(PREREG.leadRulingPending.map((p) => p.split(":")[0])).toEqual(
      expect.arrayContaining([
        "asset-license",
        "model",
        "budget",
        "n",
        "pass-threshold",
        "gate-oracle",
      ]),
    );
    expect(PREREG.subsetSize).toBe(SUBSET.size);
    expect(PREREG.n).toBe(SUBSET.size);
    expect(PREREG.upstreamCommit).toBe(
      JSON.parse(
        readFileSync(join(ROOT, "benchmark/upstream/osworld-office-v1/manifest.json"), "utf8"),
      ).upstream.commit,
    );
  });

  it("refuses 'shown' on the draft even with perfect LIVE rows", () => {
    const a = analyzePublicR1(PREREG, SUBSET, allRows());
    expect(a.verdict).toBe("refused");
    expect(a.reasons).toEqual(
      expect.arrayContaining([
        "PREREG_NOT_FROZEN",
        "LEAD_RULING_PENDING",
        "FIELD_PENDING:model",
        "FIELD_PENDING:budget",
      ]),
    );
  });

  it("refuses while any single lead ruling is still pending, or any field still says PENDING", () => {
    expect(
      analyzePublicR1({ ...ruled, leadRulingPending: ["n"] }, SUBSET, allRows()),
    ).toMatchObject({
      verdict: "refused",
      reasons: ["LEAD_RULING_PENDING"],
    });
    expect(analyzePublicR1({ ...ruled, model: "PENDING: id" }, SUBSET, allRows())).toMatchObject({
      verdict: "refused",
      reasons: ["FIELD_PENDING:model"],
    });
  });

  it("never counts MOCK or simulated rows, or rows another grader graded", () => {
    expect(
      analyzePublicR1(
        ruled,
        SUBSET,
        allRows((_, i) => (i === 0 ? { label: "MOCK" } : {})),
      ).reasons,
    ).toEqual(["NON_LIVE_ROW"]);
    expect(
      analyzePublicR1(
        ruled,
        SUBSET,
        allRows((_, i) => (i === 3 ? { label: "SIMULATED" } : {})),
      ).verdict,
    ).toBe("refused");
    expect(
      analyzePublicR1(
        ruled,
        SUBSET,
        allRows((_, i) => (i === 5 ? { graderVersion: "false-completion-grader/1" } : {})),
      ).reasons,
    ).toEqual(["NOT_UPSTREAM_GRADED"]);
  });

  it("refuses unless the gated LIVE rows cover exactly the n pre-registered subset tasks", () => {
    const rows = allRows();
    expect(analyzePublicR1(ruled, SUBSET, rows.slice(1)).reasons).toEqual(["N_MISMATCH"]);
    expect(
      analyzePublicR1(ruled, SUBSET, [...rows.slice(1), rows[1] as PublicR1Row]).reasons,
    ).toEqual(["N_MISMATCH"]);
    expect(
      analyzePublicR1(ruled, SUBSET, [...rows, row("not-in-subset", { arm: "hcu-shell" })]).reasons,
    ).toEqual(["ROW_OUTSIDE_SUBSET"]);
  });

  it("once nothing is pending: a gate that catches every false done is 'shown'; one false accept is 'not shown'", () => {
    const caught = allRows((_, i) =>
      i < 10 ? { upstreamStatus: "fail", gateVerdict: "refuted" } : {},
    );
    expect(analyzePublicR1(ruled, SUBSET, caught)).toEqual({
      verdict: "shown",
      reasons: [],
      falseDone: 10,
      falseAccepts: 0,
      caught: 10,
    });
    const leak = allRows((_, i) =>
      i === 0 ? { upstreamStatus: "fail", gateVerdict: "verified" } : {},
    );
    expect(analyzePublicR1(ruled, SUBSET, leak)).toMatchObject({
      verdict: "not-shown",
      falseAccepts: 1,
    });
    const ungradableAccepted = allRows((_, i) =>
      i === 0 ? { upstreamStatus: "ungradable", gateVerdict: "verified" } : {},
    );
    expect(analyzePublicR1(ruled, SUBSET, ungradableAccepted)).toMatchObject({
      verdict: "not-shown",
    });
  });
});
