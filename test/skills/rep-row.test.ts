/**
 * Track M's graded row (`myco.skills.rep-row/1`): "verified" is capability-spec §1.1 exactly.
 * Test rows are gate-less (done claim + grader pass); learn rows are gated (done claim + gate
 * verified and accepted + grader pass on the same bytes). A stored skill can come only from a
 * verified learn row: never from the gate's verdict alone, never from a grader pass alone.
 */
import { describe, expect, it } from "vitest";
import {
  buildRepRow,
  RepRowError,
  type RepRowInput,
  repOutcome,
  repRowProblems,
} from "../../src/skills/rep-row.ts";
import { GENESIS } from "../../src/skills/store.ts";

const BYTES = "b".repeat(64);
const PASS = { status: "pass" as const, persistedSha256: BYTES };
const FAIL = { status: "fail" as const, persistedSha256: BYTES };
const VERIFIED = { verdict: "verified" as const, accepted: true, persistedSha256: BYTES };

const testRow = (over: Partial<RepRowInput> = {}): RepRowInput => ({
  phase: "test",
  arm: "cold",
  kind: "repeat",
  unitId: "rep-v1-repeat-01",
  taskId: "fc-v1-001",
  instructionSha256: "1".repeat(64),
  fixtureSha256: "2".repeat(64),
  scheduleIndex: 0,
  runId: "run-1",
  preregHash: "3".repeat(64),
  preregCommit: "4".repeat(40),
  baseSurface: "C1",
  plannerModelId: "claude-sonnet-5-5",
  stepBudget: 30,
  steps: 12,
  wallMs: 1000,
  storeHead: GENESIS,
  retrievedSkillIds: [],
  claim: "done",
  gate: null,
  grade: PASS,
  harnessFault: null,
  admittedSkillId: null,
  estimatedUsd: 0.01,
  ...over,
});

const learnRow = (over: Partial<RepRowInput> = {}): RepRowInput =>
  testRow({ phase: "learn", arm: "learn", kind: "learn", unitId: null, gate: VERIFIED, ...over });

describe("test rows are gate-less (§1.1, §2 M Gate use)", () => {
  it.each<[string, Partial<RepRowInput>, string]>([
    ["done + pass", {}, "verified"],
    ["no claim + pass", { claim: "none" }, "correct-not-claimed"],
    ["not-done + pass", { claim: "not-done" }, "correct-not-claimed"],
    ["done + fail", { grade: FAIL }, "false-done"],
    [
      "done + ungradable",
      { grade: { status: "ungradable", persistedSha256: BYTES } },
      "false-done",
    ],
    ["done + not graded", { grade: null }, "ungraded"],
    ["not done + fail", { claim: "not-done", grade: FAIL }, "not-done"],
    ["harness fault", { harnessFault: "timeout" }, "harness-fault"],
  ])("%s -> %s", (_n, over, outcome) => {
    const row = buildRepRow(testRow(over));
    expect(row.outcome).toBe(outcome);
    expect(row.verified).toBe(outcome === "verified");
    expect(row.evidence).toBe("never-r1");
  });

  it("refuses a test row that carries a gate verdict", () => {
    expect(() => buildRepRow(testRow({ gate: VERIFIED }))).toThrow(
      new RepRowError("TEST_ROW_GATED"),
    );
  });

  it("a cold row never retrieves and never reads a non-empty store", () => {
    expect(repRowProblems(testRow({ retrievedSkillIds: ["sk-1"] }))).toContain(
      "RETRIEVED_WITHOUT_STORE",
    );
    expect(repRowProblems(testRow({ storeHead: "c".repeat(64) }))).toContain("STORE_NOT_EMPTY");
    expect(
      repRowProblems(
        testRow({ arm: "skills-on", storeHead: "c".repeat(64), retrievedSkillIds: ["sk-1"] }),
      ),
    ).toEqual([]);
  });

  it("steps cannot exceed the budget; a simulated planner is flagged", () => {
    expect(repRowProblems(testRow({ steps: 31 }))).toContain("STEPS");
    expect(buildRepRow(testRow({ plannerModelId: "simulated:scripted" })).simulated).toBe(true);
    expect(buildRepRow(testRow()).simulated).toBe(false);
  });
});

describe("learn rows are gated, and only grader-confirmed outcomes may store a skill", () => {
  it.each<[string, Partial<RepRowInput>, string]>([
    ["done + verified + pass", {}, "verified"],
    ["gate verified but grader fail", { grade: FAIL }, "false-done"],
    ["gate verified but ungraded", { grade: null }, "ungraded"],
    [
      "grader pass but gate refuted",
      { gate: { ...VERIFIED, verdict: "refuted" } },
      "correct-not-accepted",
    ],
    [
      "grader pass but gate uncertain",
      { gate: { ...VERIFIED, verdict: "uncertain" } },
      "correct-not-accepted",
    ],
    [
      "grader pass but not accepted",
      { gate: { ...VERIFIED, accepted: false } },
      "correct-not-accepted",
    ],
    [
      "gate and grader read different bytes",
      { gate: { ...VERIFIED, persistedSha256: "e".repeat(64) } },
      "correct-not-accepted",
    ],
    ["no done claim", { claim: "not-done" }, "correct-not-claimed"],
  ])("%s -> %s", (_n, over, outcome) => {
    expect(repOutcome(learnRow(over))).toBe(outcome);
  });

  it("a stored skill from a verified learn row is accepted", () => {
    expect(buildRepRow(learnRow({ admittedSkillId: "sk-0123456789abcdef" })).verified).toBe(true);
  });

  it.each<[string, Partial<RepRowInput>]>([
    ["the gate's verdict alone (grader fail)", { grade: FAIL }],
    ["the gate's verdict alone (not graded)", { grade: null }],
    ["a grader pass alone (gate refuted)", { gate: { ...VERIFIED, verdict: "refuted" } }],
    ["no done claim", { claim: "none" }],
    ["a harness fault", { harnessFault: "timeout" }],
  ])("refuses a stored skill from %s", (_n, over) => {
    expect(() =>
      buildRepRow(learnRow({ ...over, admittedSkillId: "sk-0123456789abcdef" })),
    ).toThrow(new RepRowError("SKILL_FROM_UNVERIFIED"));
  });

  it("refuses a stored skill outside the learn phase, and an ungated learn row", () => {
    expect(() => buildRepRow(testRow({ admittedSkillId: "sk-0123456789abcdef" }))).toThrow(
      new RepRowError("SKILL_OUTSIDE_LEARN"),
    );
    expect(() => buildRepRow(learnRow({ gate: null }))).toThrow(
      new RepRowError("LEARN_ROW_UNGATED"),
    );
    expect(() => buildRepRow(learnRow({ retrievedSkillIds: ["sk-1"] }))).toThrow(
      new RepRowError("RETRIEVED_WITHOUT_STORE"),
    );
  });

  it("re-checks a stored row: a flipped verified or outcome is caught", () => {
    const row = buildRepRow(testRow({ grade: FAIL }));
    expect(repRowProblems({ ...row, verified: true })).toContain("VERIFIED_CONTRADICTS");
    expect(repRowProblems({ ...row, outcome: "verified" })).toContain("OUTCOME_CONTRADICTS");
    expect(repRowProblems({ ...row, simulated: true })).toContain("SIMULATED_FLAG");
  });
});
