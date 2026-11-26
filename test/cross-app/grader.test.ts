/**
 * Capability track P: the independent grader's cross-app readers
 * (`src/benchmark/grade/cross-app.ts`, `report-text.ts`). They read the committed bundle
 * bytes, never the gate's code (pinned by `test/benchmark/independence.test.ts`), grade every
 * step's snapshot plus the end state, and answer `ungradable` for anything they cannot read,
 * never throwing and never passing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CrossAppGradeInput, gradeCrossApp } from "../../src/benchmark/grade/cross-app.ts";
import type { ColumnType } from "../../src/benchmark/grade/grade.ts";
import { ReportReadError, readReportLines } from "../../src/benchmark/grade/report-text.ts";
import { noticePdf, reportAt, sheetAt, sourceLines } from "../../src/tasks/cross-app.ts";
import { buildXaTaskSet, type XaTask } from "../../src/tasks/cross-app-taskset.ts";
import { BUNDLE } from "./helpers.ts";

const task = buildXaTaskSet().tasks[2] as XaTask;
const spec = task.spec;
const enc = (text: string) => new TextEncoder().encode(text);

function input(
  snapshots?: CrossAppGradeInput["snapshots"],
  extra: Partial<CrossAppGradeInput> = {},
): CrossAppGradeInput {
  const n = spec.steps.length;
  return {
    fixtureCsv: readFileSync(join(BUNDLE, task.fixtureFile)),
    fixtureSha256: task.fixtureSha256,
    reportTemplate: readFileSync(join(BUNDLE, task.reportTemplateFile)),
    reportTemplateSha256: task.reportTemplateSha256,
    source: enc(noticePdf(sourceLines(spec))),
    sourceSha256: task.sourceSha256,
    steps: spec.steps,
    columnTypes: task.columnTypes as Record<string, ColumnType>,
    snapshots:
      snapshots ??
      Array.from({ length: n + 1 }, (_, s) => ({
        sheet: enc(sheetAt(spec, Math.min(s + 1, n))),
        report: enc(reportAt(spec, Math.min(s + 1, n))),
      })),
    ...extra,
  };
}

const correct = () => [...input().snapshots];

describe("cross-app grader", () => {
  it("passes a correct trial", () => {
    const r = gradeCrossApp(input());
    expect(r.status, r.reasons.join("; ")).toBe("pass");
    expect(r.perStep.map((p) => p.step)).toEqual([1, 2, 3, "end"]);
  });

  it("fails at the first wrong step, even when later snapshots are right", () => {
    const snaps = correct();
    snaps[0] = { sheet: enc(sheetAt(spec, 0)), report: snaps[0]?.report ?? null };
    const r = gradeCrossApp(input(snaps));
    expect(r.status).toBe("fail");
    expect(r.firstFailure).toBe(1);
    expect(r.perStep.filter((p) => !p.pass).map((p) => p.step)).toEqual([1]);
  });

  it("fails on report collateral (an extra line) at step 3, and on an end state that regressed", () => {
    const snaps = correct();
    snaps[2] = { sheet: snaps[2]?.sheet ?? null, report: enc(`${reportAt(spec, 3)}PS\n`) };
    expect(gradeCrossApp(input(snaps)).firstFailure).toBe(3);
    const end = correct();
    end[3] = { sheet: enc(sheetAt(spec, 1)), report: end[3]?.report ?? null };
    expect(gradeCrossApp(input(end)).firstFailure).toBe("end");
  });

  it("accepts a Writer BOM, CRLF line ends and RFC 4180 quoting (its own readers, not the gate's)", () => {
    const snaps = correct().map((s, i) =>
      i < 2
        ? s
        : {
            sheet: s.sheet,
            report: enc(`﻿${reportAt(spec, 3).replace(/\n/g, "\r\n")}`),
          },
    );
    expect(gradeCrossApp(input(snaps)).status).toBe("pass");
  });

  const ungradable: Array<[string, () => CrossAppGradeInput, RegExp]> = [
    ["a swapped notice", () => input(undefined, { source: enc("%PDF-1.4\n") }), /source notice/],
    ["no notice", () => input(undefined, { source: null }), /not captured/],
    ["a swapped template", () => input(undefined, { reportTemplate: enc("x\n") }), /template/],
    ["a swapped sheet", () => input(undefined, { fixtureCsv: enc("id\n") }), /pristine sheet/],
    ["a missing snapshot", () => input(correct().slice(0, 3)), /one snapshot per step/],
    [
      "a missing document",
      () => input(correct().map((s, i) => (i === 1 ? { sheet: s.sheet, report: null } : s))),
      /missing a document/,
    ],
    [
      "a report with a NUL",
      () =>
        input(
          correct().map((s, i) => (i === 2 ? { sheet: s.sheet, report: enc("a\u0000\n") } : s)),
        ),
      /control byte/,
    ],
    [
      "a report that is not UTF-8",
      () =>
        input(
          correct().map((s, i) =>
            i === 2 ? { sheet: s.sheet, report: new Uint8Array([0xc3, 0x28]) } : s,
          ),
        ),
      /UTF-8/,
    ],
    [
      "a CR-only report",
      () =>
        input(
          correct().map((s, i) =>
            i === 2 ? { sheet: s.sheet, report: enc(reportAt(spec, 3).replace(/\n/g, "\r")) } : s,
          ),
        ),
      /carriage return/,
    ],
    [
      "an intent the fixture cannot hold",
      () =>
        input(undefined, {
          steps: [
            { app: "calc", edits: [{ rowKey: "EMP-9999", column: "qty", newValue: "1" }] },
            ...spec.steps.slice(1),
          ],
        }),
      /unsatisfiable/,
    ],
  ];
  for (const [name, make, message] of ungradable) {
    it(`is ungradable (never pass, never throw) for ${name}`, () => {
      const r = gradeCrossApp(make());
      expect(r.status).toBe("ungradable");
      expect(r.reasons.join("; ")).toMatch(message);
    });
  }

  it("readReportLines refuses hostile bytes with ReportReadError", () => {
    for (const bad of [
      enc("a\rb\n"),
      enc("\u001b[2J"),
      enc(`${"y".repeat(10_001)}\n`),
      enc("x\n".repeat(10_002)),
      enc("﻿﻿a"),
    ])
      expect(() => readReportLines(bad)).toThrow(ReportReadError);
    expect(readReportLines(enc("a \t\r\nb\n\n"))).toEqual(["a", "b"]);
  });
});
