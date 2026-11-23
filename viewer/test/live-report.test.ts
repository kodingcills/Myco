import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  armFromFoundryAccounting,
  armFromMycoResult,
  intake,
  pairsFromFoundryReport,
  provenanceFor,
} from "../src/data/live-report.ts";

const mycoResult = JSON.parse(
  readFileSync(
    new URL(
      "../../docs/research/experiments/m1-013-session1/normal-711e16c1/result.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const c1Accounting = JSON.parse(readFileSync("/tmp/baseline/c1-arm2/accounting.json", "utf8"));
const c1Report = JSON.parse(readFileSync("/tmp/baseline/c1-arm2/report.json", "utf8"));

test("reads a real Myco run directory", () => {
  const arm = armFromMycoResult(mycoResult, "myco", "m1-013/normal-711e16c1");
  expect(arm?.trials).toHaveLength(1);
  expect(arm?.trials[0]?.verdict).toBe("verified");
  // result.json does not record the agent's claim, so false success is unknown.
  expect(arm?.trials[0]?.falseSuccessKnown).toBe(false);
});

test("reads the real C1 arm accounting", () => {
  const arm = armFromFoundryAccounting(c1Accounting, "c1", "c1-arm2/accounting.json");
  // 29 scored trials; the 30th is an omission, which the loader skips rather
  // than scoring as a failure.
  expect(arm?.trials.length).toBe(29);
  const counter: Record<string, number> = {};
  for (const trial of arm?.trials ?? []) counter[trial.verdict] = (counter[trial.verdict] ?? 0) + 1;
  expect(counter.refuted).toBeGreaterThanOrEqual(29);
  expect(arm?.trials.some((trial) => trial.verdict === "verified")).toBe(false);
});

test("reads the real Foundry paired report without inventing a false success", () => {
  const pairs = pairsFromFoundryReport(c1Report, "c1-arm2/report.json", "calc-record-edit");
  expect(pairs?.pairRows.length).toBe(29);
  // Neither side of these artifacts records its own claim, so no row claims a
  // false success; the loader must not guess one.
  expect(pairs?.pairRows.every((row) => row.mycoFalseSuccess === false)).toBe(true);
  expect(pairs?.pairRows.every((row) => row.comparatorFalseSuccess === false)).toBe(true);
});

test("provenance is derived from what the artifacts carry", () => {
  const myco = armFromMycoResult(mycoResult, "myco", "m1-013");
  const c1 = armFromFoundryAccounting(c1Accounting, "c1", "c1-arm2");
  expect(provenanceFor([])).toBe("unknown");
  // The Myco run does not carry the claim, so the pair is not fully live yet.
  expect(provenanceFor([myco!, c1!])).toBe("unknown");
  // An arm whose rows all carry the claim is live.
  expect(
    provenanceFor([
      {
        armId: "x",
        source: "s",
        trials: [{ verdict: "refuted", falseSuccess: true, falseSuccessKnown: true }],
      },
    ]),
  ).toBe("live");
});

test("intake refuses unreadable sources instead of inventing arms", () => {
  const result = intake([
    { armId: "myco", kind: "myco-run-dir", path: "broken.json", content: "{not json" },
    { armId: "c1", kind: "foundry-arm", path: "a.json", content: JSON.stringify({}) },
  ]);
  expect(result.arms).toEqual([]);
  expect(result.refused.map((entry) => entry.source).sort()).toEqual(["a.json", "broken.json"]);
});

test("intake assembles arms and pairs from real files", () => {
  const result = intake([
    { armId: "myco", kind: "myco-run-dir", path: "m1-013", content: JSON.stringify(mycoResult) },
    { armId: "c1", kind: "foundry-arm", path: "c1-arm2", content: JSON.stringify(c1Accounting) },
    { armId: "c1", kind: "foundry-report", path: "c1-report", content: JSON.stringify(c1Report) },
  ]);
  expect(result.arms.map((arm) => arm.armId).sort()).toEqual(["c1", "myco"]);
  expect(result.pairRows).toHaveLength(29);
  expect(result.refused).toEqual([]);
});
