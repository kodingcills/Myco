import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  parseReportResult,
  parseTraceEvent,
  renderReport,
} from "../src/report/report.ts";

const SESSION_DIR = join(
  import.meta.dirname,
  "..",
  "docs",
  "research",
  "experiments",
  "m1-013-session1",
);

function loadRun(name: string) {
  const dir = join(SESSION_DIR, name);
  const result: unknown = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  const trace: unknown[] = readFileSync(join(dir, "trace.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line): unknown => JSON.parse(line));
  return { result, trace };
}

describe("run report", () => {
  it("renders a real verified run without inventing values", () => {
    const { result, trace } = loadRun("normal-711e16c1");
    const html = renderReport({
      result: parseReportResult(result),
      trace: trace.map(parseTraceEvent),
    });
    expect(html).toContain("Verified");
    expect(html).toContain("calc-record-edit");
    expect(html).toContain("REVISED-SESSION1");
    expect(html).toContain("EMP-0038");
    expect(html).not.toContain("Refuted");
  });

  it("renders a real refuted run as refuted", () => {
    const { result, trace } = loadRun("refuted-autocorrect-d7ad45bf");
    const html = renderReport({
      result: parseReportResult(result),
      trace: trace.map(parseTraceEvent),
    });
    expect(html).toContain("Refuted");
    expect(html).not.toContain("✓ Verified");
  });

  it("treats a record without a verdict as 'No verdict', never success", () => {
    const html = renderReport({
      result: parseReportResult({ recordKind: "session", runId: "s1", taskId: "probe" }),
      trace: [],
    });
    expect(html).toContain("No verdict");
    expect(html).toContain("It is not a success verdict.");
    expect(html).not.toContain("Verified");
    // An optional checks list without a verdict must not read as success either.
    const withChecks = renderReport({
      result: parseReportResult({
        runId: "s2",
        taskId: "probe",
        verdict: { checks: [{ name: "partial", passed: true, reason: "ok" }] },
      }),
      trace: [],
    });
    expect(withChecks).toContain("No verdict");
    expect(withChecks).not.toContain(">Verified<");
  });

  it("escapes every artifact value", () => {
    const html = renderReport({
      result: parseReportResult({
        runId: "<img src=x onerror=alert(1)>",
        taskId: "</style><script>alert(2)</script>",
        verdict: {
          status: "verified",
          score: 1,
          reasons: ["reason with <b>markup</b>"],
          checks: [
            {
              name: "<script>alert(3)</script>",
              passed: true,
              reason: '"quoted" & <tagged>',
              partial_score: { score: 1, weight: 1 },
            },
          ],
        },
        steps: [
          {
            step: 0,
            action: { kind: "click", ref: { nodeId: "<script>" } },
            preconditionResults: [
              { predicateName: "<b>p</b>", passed: false, observed: "<img src=x>" },
            ],
            postconditionResults: [],
            stateVersionBefore: 1,
            stateVersionAfter: 2,
          },
        ],
      }),
      trace: [],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(escapeHtml("\"'&<>")).toBe("&quot;&#39;&amp;&lt;&gt;");
  });

  it("survives 500 steps and long values", () => {
    const longValue = "x".repeat(10_000);
    const steps = Array.from({ length: 500 }, (_, step) => ({
      step,
      action: { kind: "setValue", ref: { nodeId: `A${step}` }, value: longValue },
      preconditionResults: [{ predicateName: "guard", passed: true, observed: longValue }],
      postconditionResults: [],
      stateVersionBefore: step,
      stateVersionAfter: step + 1,
    }));
    const html = renderReport({
      result: parseReportResult({
        runId: "r",
        taskId: "t",
        verdict: { status: "verified", score: 1, reasons: [], checks: [] },
        steps,
      }),
      trace: [],
    });
    expect(html).toContain(">500<");
    expect(html.match(/class="step"/g)?.length).toBe(500);
  });

  it("drops garbage instead of throwing", () => {
    expect(parseReportResult(null)).toEqual({
      recordKind: undefined,
      runId: undefined,
      taskId: undefined,
      taskParams: undefined,
      startedAt: undefined,
      steps: [],
      guardFailure: undefined,
      verdict: undefined,
      unresolvedState: undefined,
    });
    expect(parseTraceEvent("nope")).toEqual({});
    expect(() =>
      renderReport({ result: parseReportResult({ steps: [1, "x", null] }), trace: [] }),
    ).not.toThrow();
  });

  it("shows recovery and fault events from the trace", () => {
    const { result, trace } = loadRun("kill-87ee5b14");
    const html = renderReport({
      result: parseReportResult(result),
      trace: trace.map(parseTraceEvent),
    });
    expect(html).toContain("Faults, recovery, guard failures");
    expect(html.toLowerCase()).toContain("fault");
  });
});
