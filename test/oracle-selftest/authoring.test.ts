/**
 * TIF-271 (M2-09 part 2) unpaid instrumentation: authoring-cost records, recorder, summary.
 * Includes a SIMULATED agent-authoring dry run: a scripted "author" (no model) produces a
 * target-only oracle, it goes through the real R5 self-test, and the record is refused as
 * evidence. Nothing here calls a model.
 */
import { describe, expect, it } from "vitest";
import { MAX_CALL_MICROS, MAX_OUTPUT } from "../../src/baseline/planner.ts";
import { parseCsvSpreadsheet } from "../../src/core/filepersist.ts";
import {
  AuthoringError,
  AuthoringRecorder,
  costUsd,
  FROZEN_RATES,
  handRecord,
  summarizeAuthoring,
} from "../../src/oracle-selftest/authoring.ts";
import { runSelfTest } from "../../src/oracle-selftest/run.ts";
import { calcCases, calcRecordEditOracle } from "../../src/oracle-selftest/subjects.ts";
import type { CorruptionClass, OracleUnderTest } from "../../src/oracle-selftest/types.ts";
import { calcRecordEditVerifier, intentFor } from "../../src/tasks/calc-record-edit.ts";
import type { CalcRecordEditParams } from "../../src/tasks/intent.ts";

const MODEL = FROZEN_RATES.model;
const call = (inputTokens: number, outputTokens: number) => ({
  model: MODEL,
  inputTokens,
  outputTokens,
});

describe("frozen rates", () => {
  it("match the repo planner's (MAX_CALL_MICROS = 5,000 x input + MAX_OUTPUT x output)", () => {
    expect(MAX_CALL_MICROS).toBe(
      5_000 * FROZEN_RATES.inputMicros + MAX_OUTPUT * FROZEN_RATES.outputMicros,
    );
  });
  it("price calls exactly and refuse an unpriced model or bad counts", () => {
    expect(costUsd([call(1_000_000, 0)])).toBe(2);
    expect(costUsd([call(0, 1_000_000)])).toBe(10);
    expect(costUsd([call(12_000, 800), call(15_000, 1_200)])).toBeCloseTo(
      (27_000 * 2 + 2_000 * 10) / 1e6,
      12,
    );
    expect(() => costUsd([{ model: "other-model", inputTokens: 1, outputTokens: 1 }])).toThrow(
      /no frozen rate for model other-model/,
    );
    expect(() => costUsd([call(-1, 0)])).toThrow(/non-negative integers/);
    expect(() => costUsd([call(1.5, 0)])).toThrow(/non-negative integers/);
  });
});

describe("AuthoringRecorder", () => {
  it("records calls, time and cost; keeps the self-test summary beside them", () => {
    let now = 1_000;
    const rec = new AuthoringRecorder(
      {
        sessionId: "s1",
        family: "calc-record-edit",
        oracle: "agent-calc-1",
        authorModelId: MODEL,
        simulated: true,
      },
      () => now,
    );
    rec.recordCall(call(10_000, 500));
    rec.recordCall(call(12_000, 700));
    now = 46_000;
    const report = runSelfTest(calcRecordEditOracle, calcCases(2)).report;
    const r = rec.finish(report);
    expect(r).toMatchObject({
      author: "agent",
      authorModelId: MODEL,
      simulated: true,
      wallClockS: 45,
      modelCalls: 2,
      tokens: { input: 22_000, output: 1_200 },
      selfTest: { pass: true, claims: [...report.claims] },
    });
    expect(r.costUsd).toBeCloseTo((22_000 * 2 + 1_200 * 10) / 1e6, 12);
  });
  it("refuses a call from another model, and use after finish", () => {
    const rec = new AuthoringRecorder(
      { sessionId: "s2", family: "f", oracle: "o", authorModelId: MODEL, simulated: true },
      () => 0,
    );
    expect(() =>
      rec.recordCall({ model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1 }),
    ).toThrow(/got a call from claude-opus-5-5/);
    rec.finish(null);
    expect(() => rec.recordCall(call(1, 1))).toThrow(AuthoringError);
    expect(() => rec.finish(null)).toThrow(/already finished/);
  });
});

describe("hand records and the summary", () => {
  it("a hand record has no model, calls or cost; unmeasured time stays null, never 0", () => {
    const r = handRecord({
      sessionId: "h1",
      family: "calc-record-edit",
      oracle: "calc-record-edit/csv",
      wallClockS: null,
      selfTest: null,
    });
    expect(r).toMatchObject({
      author: "hand",
      authorModelId: null,
      modelCalls: null,
      costUsd: null,
      wallClockS: null,
      tokens: { input: null, output: null },
    });
  });

  it("summarizes per author over measured records only, and refuses simulated records as evidence", () => {
    const report = runSelfTest(calcRecordEditOracle, calcCases(2)).report;
    const hand = handRecord({
      sessionId: "h1",
      family: "calc-record-edit",
      oracle: "calc-record-edit/csv",
      wallClockS: null,
      selfTest: report,
    });
    const rec = new AuthoringRecorder(
      {
        sessionId: "a1",
        family: "calc-record-edit",
        oracle: "agent-1",
        authorModelId: MODEL,
        simulated: true,
      },
      () => 0,
    );
    rec.recordCall(call(1_000_000, 0));
    const agent = rec.finish(report);
    const { summaries, errors } = summarizeAuthoring([hand, agent]);
    expect(errors).toEqual([]);
    expect(summaries).toEqual([
      {
        author: "hand",
        sessions: 1,
        selfTested: 1,
        selfTestPassed: 1,
        cost: { measured: 0, totalUsd: null, meanUsd: null },
        wallClock: { measured: 0, meanS: null },
      },
      {
        author: "agent",
        sessions: 1,
        selfTested: 1,
        selfTestPassed: 1,
        cost: { measured: 1, totalUsd: 2, meanUsd: 2 },
        wallClock: { measured: 1, meanS: 0 },
      },
    ]);
    expect(summarizeAuthoring([hand, agent], { evidence: true }).errors).toContain(
      "1 simulated record(s): dry-run records are never evidence",
    );
  });

  it("refuses empty input, duplicates, and inconsistent records", () => {
    expect(summarizeAuthoring([]).errors).toContain("no authoring records");
    const h = handRecord({
      sessionId: "h1",
      family: "f",
      oracle: "o",
      wallClockS: 60,
      selfTest: null,
    });
    expect(summarizeAuthoring([h, h]).errors).toContain("duplicate sessionId h1");
    expect(summarizeAuthoring([{ ...h, costUsd: 0.5 }]).errors.join()).toMatch(
      /hand-authored record carries no model, calls or cost/,
    );
    expect(summarizeAuthoring([{ ...h, author: "agent" }]).errors.join()).toMatch(
      /agent-authored record names its model/,
    );
    expect(summarizeAuthoring([{ ...h, extra: 1 }]).errors.join()).toMatch(/unexpected property/);
  });
});

describe("SIMULATED agent-authoring dry run (no model; never evidence)", () => {
  it("a scripted author's oracle goes through the real R5 self-test and the record says so", () => {
    let now = 0;
    const rec = new AuthoringRecorder(
      {
        sessionId: "dry-1",
        family: "calc-record-edit",
        oracle: "scripted-target-only",
        authorModelId: MODEL,
        simulated: true,
      },
      () => now,
    );
    // The scripted "agent" writes a target-only oracle (what an author might plausibly produce)
    // and "spends" two simulated calls.
    rec.recordCall(call(8_000, 600));
    rec.recordCall(call(9_000, 900));
    now = 30_000;
    const authored: OracleUnderTest<CalcRecordEditParams> = {
      name: "scripted-target-only",
      version: "dry-run",
      claims: new Set<CorruptionClass>([
        "edit-missing",
        "wrong-value",
        "wrong-target",
        "collateral",
      ]),
      verify(doc, params) {
        if (doc.bytes === null) return { status: "uncertain", code: "missing" };
        const v = calcRecordEditVerifier.verify(
          parseCsvSpreadsheet(new TextDecoder().decode(doc.bytes), doc.fileName),
          intentFor(params),
        );
        return { status: v.status, code: v.status };
      },
    };
    const report = runSelfTest(authored, calcCases(3)).report;
    // It over-claims collateral: the self-test catches that, which is the point of R5.
    expect(report.pass).toBe(false);
    expect(report.reasons).toEqual(["collateral: 3 of 3 corruptions verified"]);
    const record = rec.finish(report);
    expect(record).toMatchObject({
      simulated: true,
      selfTest: { pass: false },
      modelCalls: 2,
      wallClockS: 30,
    });
    const { summaries, errors } = summarizeAuthoring([record]);
    expect(errors).toEqual([]);
    expect(summaries[1]).toMatchObject({ author: "agent", selfTested: 1, selfTestPassed: 0 });
    expect(summarizeAuthoring([record], { evidence: true }).errors.join()).toMatch(
      /never evidence/,
    );
  });
});
