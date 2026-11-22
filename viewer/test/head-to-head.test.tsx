import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { HeadToHeadView } from "../src/components/HeadToHead.tsx";
import { parseHeadToHead } from "../src/data/head-to-head.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/head-to-head.json", import.meta.url), "utf8"),
);

test("parses the report fixture and renders the decided row", () => {
  const report = parseHeadToHead(fixture);
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  expect(html).toContain("A-stands");
  expect(html).toContain("ef-t01b-add-four-items-noverify");
  expect(html).toContain("30");
  expect(html).toContain("screenshot-only");
  expect(html).toContain("not run");
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
  expect(html).toContain("Not decided");
  expect(html).toContain("Refused: insufficient-pairs");
  // The decision is a rule row, not a verdict: a decided A-stands must not render
  // as a Verified badge, because Verified means "this run's outcome was proven".
  expect(html).not.toContain('data-verdict="Verified"');
});

test("rejects a run artifact and a malformed report", () => {
  expect(
    parseHeadToHead({ runId: "r", taskId: "t", verdict: { status: "verified" } }),
  ).toBeUndefined();
  expect(parseHeadToHead({ decision: { status: "decided" }, arms: [] })).toBeUndefined();
  expect(parseHeadToHead(null)).toBeUndefined();
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
  expect(html).toContain("n/a (unknown)");
});
