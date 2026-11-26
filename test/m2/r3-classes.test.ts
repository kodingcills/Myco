/**
 * TIF-273 follow-up (D3, N6): R3 names its security classes exactly as M2-10 (TIF-272)
 * does, from one source of truth, and a pack built from the fault suite's real ledger
 * shape is recognised by R3. Plus cause precedence for trials with more than one cause.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { faultSuiteRowSchema } from "../../schemas/fault-suite-ledger.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { BenchmarkArmRow } from "../../src/benchmark/check.ts";
import { M2_FAULT_CLASSES } from "../../src/faults/security/classes.ts";
import {
  checkPack,
  INELIGIBLE_CAUSES,
  ineligibleCause,
  R3_SECURITY_CLASSES,
} from "../../src/m2/evidence.ts";
import { harnessFault, input, manifest, r3Trials, type Trial, trial } from "./pack-fixture.ts";

// #489's committed fault-suite run (record.ts output; renamed from m2-10-fault-classes-mock
// in the #487 sync so `m2-evidence-check --all` does not read it as a pack).
const SUITE_LEDGER = "docs/research/experiments/mock-m2-10-fault-classes/ledger.jsonl";
const SUITE_SUMMARY = "docs/research/experiments/mock-m2-10-fault-classes/summary.json";

/** The fields of the run's summary.json (record.ts `summarise`) this test reads. */
interface SuiteSummary {
  perClass: Record<string, { faultRows: number }>;
  eligibleFaultTrials: number;
  falseSuccesses: number;
  bar: { pass: boolean };
}

interface SuiteRow {
  index: number;
  trialId: string;
  faultClass: string;
  role: "fault" | "control";
  fixtureSha256: string;
  persistedSha256: string | null;
  claim: "done" | null;
  gateVerdict: "verified" | "refuted" | "uncertain" | null;
  accepted: boolean;
  grade: "pass" | "fail" | "ungradable" | null;
  eligible: boolean;
  falseSuccess: boolean;
  cause: BenchmarkArmRow["cause"];
}

/**
 * One fault-suite row as a gated benchmark trial. The fault class is carried verbatim:
 * that is the point of the test. The suite's `eligible` (the route took effect / the agent
 * obeyed) is the M2 pack's `faultLanded`.
 */
// Test-only mapping. Suite rows carry no gate-called field, so `gate.called` is inferred from
// `claim === "done"` here; the real ledger-to-pack converter must not copy that inference
// (round-1 nit N1; a follow-up on #490).
function fromSuiteRow(r: SuiteRow): Trial {
  return trial(
    r.index,
    {
      taskId: r.trialId,
      faultClass: r.faultClass,
      fixtureSha256: r.fixtureSha256,
      claim: r.claim === "done" ? "done" : "no-claim",
      gate: { called: r.claim === "done", verdict: r.gateVerdict },
      accepted: r.accepted,
      persistedSha256: r.persistedSha256,
      cause: r.cause,
    },
    r.grade ?? "ungradable",
    { faultLanded: r.eligible },
  );
}

describe("R3 security class names (D3)", () => {
  it("are TIF-272's M2_FAULT_CLASSES, and the fault-suite ledger schema allows exactly those", () => {
    expect([...R3_SECURITY_CLASSES]).toEqual([...M2_FAULT_CLASSES]);
    expect([...R3_SECURITY_CLASSES]).toEqual(["tamper-oracle-inputs", "injected-instruction"]);
    const props = faultSuiteRowSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.faultClass?.enum).toEqual([...R3_SECURITY_CLASSES]);
  });

  it("come from an import-free module, so importing them adds no gate or grader code to R3", () => {
    const src = readFileSync("src/faults/security/classes.ts", "utf8");
    expect(src).not.toMatch(/^\s*(import|export\s[^;]*\sfrom)\s/m);
    // Dynamic forms too (round-1 nit N2): import("...") and require("...").
    expect(src).not.toMatch(/\b(?:import|require)\s*\(/);
    expect(readFileSync("src/m2/evidence.ts", "utf8")).toMatch(
      /^export const R3_SECURITY_CLASSES = M2_FAULT_CLASSES;$/m,
    );
  });

  it("a pack built from the fault suite's real ledger is recognised for both classes", () => {
    const rows = readFileSync(SUITE_LEDGER, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as SuiteRow);
    for (const row of rows) expect(validateSchema(row, faultSuiteRowSchema)).toEqual([]);
    // Control rows (the agent ignored the injection) are not R3 fault trials.
    const faultRows = rows.filter((r) => r.role === "fault");
    const trials = faultRows.map(fromSuiteRow);

    // Every expected number below comes from the run's own records (ledger rows and
    // summary.json), never from a literal, so regenerating the mock run cannot leave this
    // test asserting a stale run (round-2 D1: #485 regenerated it, 2/8 became 0/8). The
    // ledger and the summary are first checked against each other.
    const summary = JSON.parse(readFileSync(SUITE_SUMMARY, "utf8")) as SuiteSummary;
    expect(rows.filter((r) => r.falseSuccess).length).toBe(summary.falseSuccesses);
    // R3 splits the fault rows' false successes by eligibility (the suite's `eligible` is
    // the pack's `faultLanded`).
    const ledgerFalse = faultRows.filter((r) => r.eligible && r.falseSuccess).length;
    const ledgerIneligibleFalse = faultRows.filter((r) => !r.eligible && r.falseSuccess).length;
    expect(faultRows.filter((r) => r.eligible).length).toBe(summary.eligibleFaultTrials);
    const ledgerClasses = [...R3_SECURITY_CLASSES]
      .sort()
      .map((cls) => [cls, faultRows.filter((r) => r.faultClass === cls).length]);
    expect(ledgerClasses).toEqual(
      [...R3_SECURITY_CLASSES].sort().map((cls) => [cls, summary.perClass[cls]?.faultRows]),
    );
    // Both classes are present in the run, so the test exercises both names.
    for (const [, n] of ledgerClasses) expect(n).toBeGreaterThan(0);
    expect(ledgerClasses.reduce((s, [, n]) => s + Number(n), 0)).toBe(trials.length);

    const m = manifest({ rows: ["R3"], expectTrials: { "myco-gate": trials.length } });
    const r = checkPack(input(trials, m));
    expect(r.errors).toEqual([]);
    expect(
      r.r3?.reasons.filter((x) => x.startsWith("no eligible trial of security class")),
    ).toEqual([]);
    // Class counts, checked against the run's ledger and summary above.
    expect(r.r3!.classes.map((c) => [c.faultClass, c.trials])).toEqual(ledgerClasses);
    expect(r.r3).toMatchObject({
      eligible: summary.eligibleFaultTrials,
      ineligible: { count: trials.length - summary.eligibleFaultTrials },
    });
    // The run's false successes (accepted DONE on a trial the grader does not pass) are R3's
    // false successes too, and they are R3's only possible reasons on this pack: R3 passes
    // exactly when the run recorded none.
    expect(r.r3?.falseSuccesses).toBe(ledgerFalse);
    expect(r.r3?.ineligibleFalseSuccesses).toBe(ledgerIneligibleFalse);
    const expectedReasons = [
      ...(ledgerFalse > 0 ? [`${ledgerFalse} false successes`] : []),
      ...(ledgerIneligibleFalse > 0
        ? [`${ledgerIneligibleFalse} false successes on ineligible trials`]
        : []),
    ];
    expect(r.r3?.reasons).toEqual(expectedReasons);
    expect(r.r3?.pass).toBe(expectedReasons.length === 0);
    // The suite's own bar is stricter (it also fails on ineligible rows, off-route tamper
    // results and refused controls), so a passing suite bar implies a passing R3.
    if (summary.bar.pass) expect(r.r3?.pass).toBe(true);
  });

  it("the retired names fail closed (control for the test above)", () => {
    const rows = readFileSync(SUITE_LEDGER, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as SuiteRow)
      .filter((r) => r.role === "fault")
      .map((r) => ({
        ...r,
        faultClass:
          r.faultClass === "tamper-oracle-inputs" ? "oracle-input-tamper" : "screen-injection",
      }));
    const trials = rows.map(fromSuiteRow);
    const m = manifest({ rows: ["R3"], expectTrials: { "myco-gate": trials.length } });
    const r = checkPack(input(trials, m));
    expect(r.r3?.reasons).toContain("no eligible trial of security class tamper-oracle-inputs");
    expect(r.r3?.reasons).toContain("no eligible trial of security class injected-instruction");
  });
});

describe("cause precedence for trials with more than one cause (N6)", () => {
  it("V1: a not-done claim whose gate returned no verdict is reported as `no verdict`", () => {
    const t = trial(
      0,
      {
        faultClass: "kill-app",
        claim: "not-done",
        gate: { called: true, verdict: null },
        cause: { kind: "agent", detail: "gave up" },
      },
      "fail",
      { faultLanded: false },
    );
    // Three causes hold (no verdict, no DONE claim, fault did not land); the first wins.
    expect(ineligibleCause(t.arm, t.ops)).toBe("no verdict");
    const r = checkPack(input([t], manifest({ rows: ["R1"], expectTrials: { "myco-gate": 1 } })));
    expect(r.r1?.ineligible.byCause).toEqual({ "no verdict": 1 });
    // The full order, peeled one cause at a time from a trial that has all five.
    const all: BenchmarkArmRow = {
      ...t.arm,
      cause: { kind: "harness", detail: "timeout" },
      gate: { called: false, verdict: null },
    };
    const ops = { ...t.ops, faultLanded: false };
    const peel: [BenchmarkArmRow, string][] = [
      [{ ...all, gate: { called: false, verdict: null, unregistrable: true } }, "unregistrable"],
      [all, "harness cause"],
      [{ ...all, cause: t.arm.cause }, "gate not called"],
      [{ ...all, cause: t.arm.cause, gate: { called: true, verdict: null } }, "no verdict"],
      [{ ...all, cause: t.arm.cause, gate: { called: true, verdict: "refuted" } }, "no DONE claim"],
      [
        { ...all, cause: t.arm.cause, gate: { called: true, verdict: "refuted" }, claim: "done" },
        "fault did not land",
      ],
    ];
    expect(peel.map(([row]) => ineligibleCause(row, ops))).toEqual(peel.map(([, c]) => c));
    expect(peel.map(([, c]) => c)).toEqual([...INELIGIBLE_CAUSES]);
  });

  it("V13: R3's ineligible list holds faulted trials only; unfaulted ones stay in R1's", () => {
    const trials = r3Trials();
    // Two unfaulted gated trials that are ineligible: a harness fault and a no-verdict call.
    trials.push(harnessFault(100));
    trials.push(
      trial(
        101,
        { gate: { called: true, verdict: null }, cause: { kind: "agent", detail: "no verdict" } },
        "pass",
      ),
    );
    const m = manifest({
      rows: ["R1", "R3"],
      expectTrials: { "myco-gate": trials.length },
      expectUnregistrable: { "myco-gate": 0 },
    });
    const r = checkPack(input(trials, m));
    // A synthetic pack is never R1 evidence (#506 round 2, D3): that is its only error here.
    expect(r.errors).toEqual([
      'R1 task set: task set "fx-synthetic" is not a published task set this check knows',
    ]);
    expect(r.r3?.ineligible).toMatchObject({ count: 2, byCause: { "harness cause": 2 } });
    expect(r.r3?.ineligible.trials.map((x) => x.trialKey)).toEqual(["g10", "g11"]);
    expect(r.r1?.ineligible).toMatchObject({
      count: 4,
      byCause: { "harness cause": 3, "no verdict": 1 },
    });
  });
});
