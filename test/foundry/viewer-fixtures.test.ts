import { describe, expect, it } from "vitest";
import { ledgerRowSchema } from "../../schemas/ledger-row.ts";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { buildViewerRun, VIEWER_RUNS } from "../../src/foundry/viewer/fixtures.ts";

/** gui-spec §6.2, reimplemented minimally so a fixture cannot drift from the mapping. */
function display(run: ReturnType<typeof buildViewerRun>): string {
  const v = run.result.verdict as { status: string; checks: { passed: boolean | null }[] };
  if (v.status === "uncertain" || v.checks.some((c) => c.passed === null)) return "Unknown";
  if (v.status === "refuted")
    return run.ledgerLines.some((l) => JSON.parse(l).oracle === "ground-truth:false")
      ? "Failed:False success"
      : "Failed";
  const recovered = run.traceLines.some((l) => JSON.parse(l).type === "recovery");
  return recovered ? "Recovered" : "Verified";
}

describe("viewer fixtures", () => {
  const runs = VIEWER_RUNS.map(buildViewerRun);

  it("every artifact validates against the closed M1 schemas", () => {
    for (const run of runs) {
      for (const l of run.traceLines)
        expect(validateSchema(JSON.parse(l), traceEventSchema)).toEqual([]);
      expect(validateSchema(run.result, resultRecordSchema)).toEqual([]);
      for (const l of run.ledgerLines)
        expect(validateSchema(JSON.parse(l), ledgerRowSchema)).toEqual([]);
    }
  });

  it("each run maps to its intended display verdict (spec §6.2)", () => {
    expect(runs.map(display)).toEqual(["Verified", "Recovered", "Failed:False success", "Unknown"]);
  });

  it("is deterministic", () => {
    const a = buildViewerRun(VIEWER_RUNS[2]!);
    const b = buildViewerRun(VIEWER_RUNS[2]!);
    expect(a.traceLines).toEqual(b.traceLines);
  });

  it("only the false-success run carries claim events, and only in the extended trace", () => {
    const fs = runs.find((r) => r.kind === "false-success")!;
    expect(fs.extendedTraceLines.some((l) => JSON.parse(l).type === "claim")).toBe(true);
    expect(fs.traceLines.some((l) => JSON.parse(l).type === "claim")).toBe(false);
    for (const r of runs.filter((r) => r !== fs))
      expect(r.extendedTraceLines.length).toBe(r.traceLines.length);
  });

  it("the false-success claim disagrees with the persisted check", () => {
    const fs = runs.find((r) => r.kind === "false-success")!;
    const claims = fs.extendedTraceLines
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "claim");
    expect(claims.find((c) => c.source === "app-ui").value).toMatch(/Saved 2 items/);
    const checks = (fs.result.verdict as { checks: { passed: boolean }[] }).checks;
    expect(checks.some((c) => c.passed === false)).toBe(true);
  });
});

describe("perf fixtures", () => {
  it("1,000 steps is ~10 events per step and schema-valid", () => {
    const run = buildViewerRun({ name: "p", kind: "verified", steps: 1000 });
    expect(run.traceLines.length).toBeGreaterThan(9000);
    expect(run.traceLines.length).toBeLessThan(11000);
    for (const l of run.traceLines.filter((_, i) => i % 97 === 0))
      expect(validateSchema(JSON.parse(l), traceEventSchema)).toEqual([]);
    expect(validateSchema(run.result, resultRecordSchema)).toEqual([]);
  });
});
