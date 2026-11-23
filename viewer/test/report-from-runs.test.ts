import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { armSourcesFromRuns, type OpenedRunLike, reportFromRuns } from "../src/data/report-from-runs.ts";

// The committed run the scorecard links to, read the same way the viewer reads it.
const trial = JSON.parse(
  readFileSync(
    new URL("../../docs/research/experiments/m1-runs/m1-013/trial-0/result.json", import.meta.url),
    "utf8",
  ),
);

function run(key: string, name: string, result: unknown): OpenedRunLike {
  return { key, name, data: { result } };
}

test("the ArmSource the app can build is a myco-run-dir, one per open run", () => {
  const sources = armSourcesFromRuns([run("a", "trial-0", trial), run("b", "trial-1", trial)]);
  expect(sources.map((source) => source.kind)).toEqual(["myco-run-dir", "myco-run-dir"]);
  expect(sources.map((source) => source.path)).toEqual(["trial-0", "trial-1"]);
  // `content` is the artifact's own text, so `intake` parses what the file held.
  expect(JSON.parse(sources[0]!.content)).toEqual(trial);
});

test("a run with no result.json is not a source, and no sources is no report", () => {
  expect(armSourcesFromRuns([{ key: "a", name: "trial-0", data: {} }])).toEqual([]);
  expect(reportFromRuns([{ key: "a", name: "trial-0", data: {} }])).toBeUndefined();
});

test("two real runs render as two arms with the count the arms actually carry", () => {
  const report = reportFromRuns(
    [run("a", "trial-0", trial), run("b", "trial-1", trial)],
    "2026-11-23T00:00:00.000Z",
  );
  expect(report?.arms.map((arm) => arm.armId)).toEqual(["trial-0", "trial-1"]);
  expect(report?.arms.every((arm) => arm.trials.length === 1)).toBe(true);
  expect(report?.generatedAt).toBe("2026-11-23T00:00:00.000Z");
  // Two runs, each one trial, so the tally is two of whatever the artifact's verdict is.
  const word =
    trial.verdict.status === "verified"
      ? "verified"
      : trial.verdict.status === "refuted"
        ? "failed"
        : "unknown";
  expect(report?.decision.notes[0]).toContain(`2 ${word}`);
  expect(report?.decision.notes[0]).toContain("the 2 open run(s)");
});

test("provenance is never `live` for run arms, because result.json has no claim", () => {
  // `armFromMycoResult` reports falseSuccessKnown: false, so `provenanceFor` gives
  // `unknown`. The view must say so rather than look live.
  const report = reportFromRuns([run("a", "trial-0", trial)]);
  expect(report?.provenance?.kind).toBe("unknown");
  expect(report?.provenance?.arms?.[0]?.live).toBe(false);
  expect(report?.decision.notes.join(" ")).toContain("does not record the agent's claim");
});

test("a run whose result.json carries no verdict is refused by name, not invented", () => {
  const report = reportFromRuns([
    run("a", "trial-0", trial),
    run("b", "no-verdict", { runId: "x", startedAt: "2026-11-23T00:00:00.000Z" }),
  ]);
  expect(report?.arms.map((arm) => arm.armId)).toEqual(["trial-0"]);
  expect(report?.decision.ineligibleRows).toBe(1);
  expect(report?.decision.notes.join(" ")).toContain("no-verdict (no verdict)");
});

test("a single open run is a one-arm comparison, honestly", () => {
  const report = reportFromRuns([run("a", "trial-0", trial)]);
  expect(report?.arms).toHaveLength(1);
  expect(report?.decision.notes[0]).toContain("the 1 open run(s)");
});
