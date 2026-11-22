import { Tabs } from "@base-ui/react/tabs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { OpenScreen } from "../src/components/OpenScreen.tsx";
import { CheckRow } from "../src/components/Proof.tsx";
import { VerdictBadge } from "../src/components/VerdictBadge.tsx";
import { VerdictBar } from "../src/components/VerdictBar.tsx";
import type { DisplayVerdict } from "../src/data/verdict.ts";
import type { OpenedRun } from "../src/store.ts";

const verdicts = [
  ["Verified", undefined, "check"],
  ["Recovered", undefined, "undo-2"],
  ["Failed", undefined, "x"],
  ["Failed", "False success", "x"],
  ["Unknown", undefined, "circle-help"],
  ["Unknown", "Not scored", "circle-help"],
] as const satisfies readonly [DisplayVerdict["label"], DisplayVerdict["subtype"], string][];

test.each(verdicts)("%s %s renders with the %s glyph", (label, subtype, glyph) => {
  const html = renderToStaticMarkup(<VerdictBadge size="xl" label={label} subtype={subtype} />);
  expect(html).toContain(`data-verdict="${label}"`);
  expect(html).toContain(`data-glyph="${glyph}"`);
  expect(html).toContain(`>${label}</span>`);
  if (subtype) expect(html).toContain(`>· ${subtype}</span>`);
});

test("a null check displays Unknown and its could-not-look reason", () => {
  const html = renderToStaticMarkup(
    <CheckRow
      check={{
        label: "Unknown",
        source: { file: "result.json", path: "/verdict/checks/0" },
        value: {
          name: "readback",
          passed: null,
          reason: "File could not be read",
          partial_score: { score: 0.25, weight: 0.5 },
        },
      }}
    />,
  );
  expect(html).toContain('data-glyph="circle-help"');
  expect(html).toContain(">Unknown</span>");
  expect(html).toContain("could not look · File could not be read");
  expect(html).toContain("Partial score 0.25");
  expect(html).toContain("w=0.50");
  expect(html).toContain("result.json#/verdict/checks/0");
});

test("Open screen exposes both picker inputs with the specified empty-state copy", () => {
  const html = renderToStaticMarkup(<OpenScreen />);
  expect(html).toContain("Open a Myco run");
  expect(html).toContain("Drop a .mycotrace file or a run folder, or press ⌘O.");
  expect(html).toContain(">Open…</button>");
  expect(html).toContain('accept=".mycotrace,.json,.jsonl"');
  expect(html).toContain('webkitdirectory=""');
});

test("VerdictBar renders Simulated badge when manifest or result is simulated", () => {
  const run: OpenedRun = {
    key: "test-run",
    name: "test-run",
    files: [],
    opened: Date.now(),
    loading: false,
    data: {
      manifest: { format: "mycotrace/1", runId: "run-sim", files: {}, simulated: true },
      result: {
        runId: "run-sim",
        taskId: "todo-save",
        taskParams: {},
        startedAt: "2026-11-22T13:30:00.000Z",
        steps: [],
        verdict: { status: "refuted", checks: [], score: 0.5, reasons: [] },
        simulated: true,
      },
      events: [],
      byStep: new Map(),
      ledger: [],
      artifactPaths: [],
      parseErrors: [],
      validation: { kind: "complete", manifestChecked: true },
    },
    verdict: { label: "Failed", subtype: "False success", sources: [] },
  };
  const html = renderToStaticMarkup(
    <Tabs.Root defaultValue="proof">
      <VerdictBar run={run} />
    </Tabs.Root>,
  );
  expect(html).toContain("data-simulated-badge");
  expect(html).toContain(">Simulated</span>");
});
