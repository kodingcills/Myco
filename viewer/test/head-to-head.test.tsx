import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { HeadToHeadView } from "../src/components/HeadToHead.tsx";
import { parseHeadToHead, resolveSameOriginReportUrl } from "../src/data/head-to-head.ts";

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

test("the decision is the page heading and tables carry scoped headers", () => {
  const report = parseHeadToHead(fixture);
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  expect(html).toMatch(/<h1[^>]*>A-stands/);
  // Exactly one heading, or a reader (and a screen reader) cannot tell which is
  // the page title.
  expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
  // Every table must be headed and every header scoped, so a screen reader can
  // name each cell. A table that loses its <thead> must fail, not be skipped.
  const tables = html.split("<table").slice(1);
  expect(tables.length).toBeGreaterThanOrEqual(3);
  for (const table of tables) {
    const headers = table.split("</thead>")[0]?.match(/<th\b[^>]*>/g) ?? [];
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header).toContain('scope="col"');
  }
});

test("a pair row whose claim is unknown reads `not recorded`, never no", () => {
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
  // gui-spec §4.6: missing data reads exactly `not recorded`.
  expect(text).toContain("1 silent-drop not recorded not recorded");
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
  const text = textOf(html);
  // gui-spec §4.6: missing reads `not recorded`; an interval that cannot be computed reads
  // `could not look`. Neither may be collapsed into a measured zero.
  expect(text).toContain("not recorded");
  expect(text).toContain("could not look");
  expect(text).not.toContain("n/a");
});

test("arm headers use the four fixed verdict words, never Refuted or Uncertain", () => {
  const report = parseHeadToHead(fixture);
  expect(report).toBeDefined();
  if (!report) return;
  const html = renderToStaticMarkup(<HeadToHeadView report={report} />);
  const table = html.split("<table")[1] ?? "";
  const headers = (table.split("</thead>")[0]?.match(/<th\b[^>]*>([^<]*)</g) ?? []).join(" ");
  // gui-spec §4.3 fixes the words and forbids synonyms.
  expect(headers).toContain("Verified");
  expect(headers).toContain("Failed");
  expect(headers).toContain("Unknown");
  const text = textOf(html);
  expect(text).not.toContain("Refuted");
  expect(text).not.toContain("Uncertain");
});

test("the generated time is local with an ET label, never a raw UTC Z", () => {
  const report = parseHeadToHead({ ...fixture, generatedAt: "2026-11-23T18:30:00.000Z" });
  expect(report).toBeDefined();
  if (!report) return;
  const text = textOf(renderToStaticMarkup(<HeadToHeadView report={report} />));
  // gui-spec §4.5: absolute timestamps read HH:MM:SS.mmm ET.
  expect(text).toMatch(/Generated \d{2}:\d{2}:\d{2}\.\d{3} ET/);
  expect(text).not.toContain("18:30:00.000Z");
});

test("the prompt-variant note names this decision's own variant, not a fixture's", () => {
  const report = parseHeadToHead({
    ...fixture,
    decision: {
      ...fixture.decision,
      taskId: "some-other-task",
      promptVariant: "other-variant",
    },
  });
  expect(report).toBeDefined();
  if (!report) return;
  const text = textOf(renderToStaticMarkup(<HeadToHeadView report={report} />));
  expect(text).toContain("some-other-task");
  expect(text).toContain("other-variant");
  // The old copy hardcoded these two names; neither may survive.
  expect(text).not.toContain("ef-t01b");
  // The note must name the variant as the thing this decision covers, rather than pairing the
  // two fields in a parenthetical — the fixture's taskId already embeds the variant, so the
  // pairing reads as a repetition. Match the sentence, not a count.
  const note = text.slice(text.indexOf("does not pool"));
  expect(note).toContain("covers the other-variant variant of some-other-task only");
  expect(note).not.toMatch(/some-other-task\s*\(\s*other-variant\s*\)/);
});

test("a ?compare= address off this origin is refused, not fetched", () => {
  const base = "https://viewer.example/app/";
  expect(resolveSameOriginReportUrl("/reports/r.json", base)).toHaveProperty("url");
  expect(resolveSameOriginReportUrl("reports/r.json", base)).toHaveProperty("url");
  expect(resolveSameOriginReportUrl("https://viewer.example/reports/r.json", base)).toHaveProperty(
    "url",
  );
  const crossOrigin = resolveSameOriginReportUrl("https://evil.example/r.json", base);
  expect(crossOrigin).toHaveProperty("error");
  const protocolRelative = resolveSameOriginReportUrl("//evil.example/r.json", base);
  expect(protocolRelative).toHaveProperty("error");
  const notAUrl = resolveSameOriginReportUrl("http://[", base);
  expect(notAUrl).toHaveProperty("error");
});
