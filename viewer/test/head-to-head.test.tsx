import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { HeadToHeadView } from "../src/components/HeadToHead.tsx";
import { parseHeadToHead } from "../src/data/head-to-head.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/head-to-head.json", import.meta.url), "utf8"),
);

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("renders the decided row, the exact arm numbers, and the paired table", () => {
  const report = parseHeadToHead(fixture);
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  const text = textOf(html);
  expect(text).toContain("A-stands");
  expect(text).toContain("ef-t01b-add-four-items-noverify");
  expect(text).toContain("30");
  expect(text).toContain("0.0313");
  expect(text).toContain("myco 30 0 30 0 0 0.0%–11.4%");
  expect(text).toContain("hcu+shell 30 6 24 0 6 9.5%–37.3%");
  expect(text).toContain("6 favour Myco");
  expect(text).toContain("0 favour the comparator");
  expect(text).toContain("1 silent-drop no yes");
  expect(text).toContain("screenshot-only");
  expect(text).toContain("A refused decision is a result");
  // A cropped screenshot must not pass as live: the headline itself says simulated.
  expect(text).toContain("A-stands (simulated)");
  // Non-live rule notes are prefixed so no conclusion reads unqualified.
  for (const note of fixture.decision.notes as string[]) {
    expect(text).toContain(`Simulated: ${note}`);
  }
  expect(html).toContain("data-simulated-badge");
  expect(text).toContain("Simulated");
  expect(text).toContain("Not a live result");
  expect(text).toContain("viewer/fixtures/head-to-head.json (synthetic)");
  // A decision row is not a run verdict: no verdict badge anywhere.
  expect(html).not.toContain('data-verdict="Verified"');
});

test("a refused decision renders as not decided, never as a pass", () => {
  const report = parseHeadToHead({
    ...fixture,
    decision: {
      ...fixture.decision,
      status: "refused",
      reason: "insufficient-pairs",
      row: "underpowered",
    },
  });
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  const text = textOf(html);
  expect(text).toContain("Not decided");
  expect(text).toContain("Refused: insufficient-pairs");
  expect(html).not.toContain('data-verdict="Verified"');
});

test("a report with no provenance is unknown, never live-looking", () => {
  const { provenance: _provenance, ...withoutProvenance } = fixture;
  const report = parseHeadToHead(withoutProvenance);
  expect(report?.provenance?.kind).toBe("unknown");
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  const text = textOf(html);
  expect(html).toContain("data-simulated-badge");
  expect(text).toContain("Unknown source");
  expect(text).toContain("Not a live result");
});

test("a live report carries no badge and says the rule returned the row", () => {
  const report = parseHeadToHead({
    ...fixture,
    provenance: { kind: "live", arms: [] },
  });
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  const text = textOf(html);
  expect(html).not.toContain("data-simulated-badge");
  expect(text).toContain("The pre-registered rule returned this row");
  expect(text).toContain("A-stands");
  expect(text).not.toContain("A-stands (");
  for (const note of fixture.decision.notes as string[]) {
    expect(text).toContain(note);
    expect(text).not.toContain(`Simulated: ${note}`);
  }
});

test("rejects a run artifact and a malformed report", () => {
  expect(
    parseHeadToHead({ runId: "r", taskId: "t", verdict: { status: "verified" } }),
  ).toBeUndefined();
  expect(parseHeadToHead({ decision: { status: "decided" }, arms: [] })).toBeUndefined();
  expect(parseHeadToHead(null)).toBeUndefined();
});

test("a pair row whose claim is unknown renders n/a, never no", () => {
  const report = parseHeadToHead({
    ...fixture,
    decision: {
      ...fixture.decision,
      pairRows: [
        {
          seed: 1,
          faultClass: "silent-drop",
          mycoFalseSuccess: false,
          comparatorFalseSuccess: false,
          claimKnown: false,
        },
        {
          seed: 2,
          faultClass: "silent-drop",
          mycoFalseSuccess: true,
          comparatorFalseSuccess: false,
          claimKnown: true,
        },
      ],
    },
  });
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  const text = textOf(html);
  // The unknown row must not read as a denial, and the known row must still read.
  expect(text).toContain("1 silent-drop n/a n/a");
  expect(text).toContain("2 silent-drop yes no");
});

test("an unknown false-success value is not rendered as a measured zero", () => {
  const report = parseHeadToHead({
    ...fixture,
    arms: [
      {
        armId: "myco",
        trials: [{ verdict: "verified", falseSuccess: false, falseSuccessKnown: false }],
      },
    ],
  });
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  expect(textOf(html)).toContain("n/a (unknown)");
});
