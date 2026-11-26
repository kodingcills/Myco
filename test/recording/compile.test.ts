/**
 * Track R compiler: a recording becomes a parameterized workflow and a derived oracle only
 * when the action log and the before/after document agree. Every refusal code is pinned.
 */
import { describe, expect, it } from "vitest";
import {
  BindingError,
  bindWorkflow,
  type CompileErrorCode,
  compileRecording,
  inferKind,
} from "../../src/recording/compile.ts";
import { recordDemonstration } from "../../src/recording/recorder.ts";
import { cellFor, type HumanStep, scriptedHuman } from "../../src/recording/scripted-human.ts";
import type { Recording } from "../../src/recording/types.ts";
import { fixtureBytes, operator, PLANTED_KEY } from "./helpers.ts";

const doc = fixtureBytes("track-r-compile");
const name7 = cellFor(doc, "EMP-0007", "name");
const qty3 = cellFor(doc, "EMP-0003", "qty");

async function record(steps: HumanStep[], document = doc): Promise<Recording> {
  return recordDemonstration(scriptedHuman({ document, steps }), {
    start: operator,
    indicator: () => {},
    before: document,
    simulated: true,
    recordingId: "rec-compile",
  });
}

function refusal(rec: Recording): CompileErrorCode | undefined {
  try {
    compileRecording(rec);
    return undefined;
  } catch (error) {
    return (error as { code?: CompileErrorCode }).code;
  }
}

describe("compile: happy paths", () => {
  it("one edit: record + value parameters, keyed steps, three allowlisted assertions", async () => {
    const { workflow, oracle } = compileRecording(
      await record([{ do: "type", cell: name7, text: "Revised Person" }, { do: "save" }]),
    );
    expect(workflow.parameters).toEqual([
      { name: "record", role: "record", kind: "key", demonstrated: "EMP-0007" },
      { name: "name", role: "value", kind: "text", demonstrated: "Revised Person" },
    ]);
    expect(workflow.steps).toEqual([
      {
        op: "set-cell",
        rowKey: { param: "record" },
        column: "name",
        value: { param: "name" },
        evidence: "app",
      },
      { op: "save" },
    ]);
    expect(oracle.trust).toBe("derived");
    expect(oracle.assertions.map((a) => a.type)).toEqual([
      "header-equals-fixture",
      "cell-equals",
      "others-equal-fixture",
    ]);
    expect(workflow.simulated).toBe(true);
    expect(workflow.workflowId).toMatch(/^wf-[0-9a-f]{12}$/);
  });

  it("several edits on two records, typed columns, in demonstration order", async () => {
    const { workflow } = compileRecording(
      await record([
        { do: "type", cell: qty3, text: "512" },
        { do: "type", cell: name7, text: "Second Edit" },
        { do: "save" },
      ]),
    );
    expect(workflow.parameters.map((p) => [p.name, p.kind])).toEqual([
      ["record_1", "key"],
      ["qty_1", "integer"],
      ["record_2", "key"],
      ["name_2", "text"],
    ]);
  });

  it("a cell changed only through GUI events compiles as a gui-fallback step", async () => {
    const { workflow } = compileRecording(
      await record([{ do: "type-gui-only", cell: name7, text: "Gui Path" }, { do: "save" }]),
    );
    expect(workflow.steps[0]).toMatchObject({ op: "set-cell", evidence: "gui-fallback" });
  });

  it("an edit then a revert before saving is not a step", async () => {
    const before = cellFor(doc, "EMP-0003", "name");
    const original = new TextDecoder().decode(doc).split("\n")[3]?.split(",")[1] as string;
    const { workflow } = compileRecording(
      await record([
        { do: "type", cell: before, text: "Temporary" },
        { do: "type", cell: before, text: original },
        { do: "type", cell: name7, text: "Kept Edit" },
        { do: "save" },
      ]),
    );
    expect(workflow.steps).toHaveLength(2);
  });

  it("infers column kinds from data", () => {
    expect(inferKind(["1", "22", "-3"])).toBe("integer");
    expect(inferKind(["2024-01-02"])).toBe("date");
    expect(inferKind(["$1.00", "$20"])).toBe("currency");
    expect(inferKind(["Ada", "1"])).toBe("text");
  });
});

describe("compile: refusals (fail closed)", () => {
  it("NO_SAVE, NO_EDITS, UNSAVED_TRAILING_EDITS", async () => {
    expect(refusal(await record([{ do: "type", cell: name7, text: "Never Saved" }]))).toBe(
      "NO_SAVE",
    );
    expect(refusal(await record([{ do: "save" }]))).toBe("NO_EDITS");
    expect(
      refusal(
        await record([
          { do: "type", cell: name7, text: "Saved" },
          { do: "save" },
          { do: "type", cell: qty3, text: "77" },
        ]),
      ),
    ).toBe("UNSAVED_TRAILING_EDITS");
  });

  it("UNEXPLAINED_CHANGE: a saved change no recorded action explains", async () => {
    const rec = await record([{ do: "type", cell: name7, text: "Explained" }, { do: "save" }]);
    const after = rec.after.rows.map((r) => [...r]);
    (after[3] as string[])[1] = "Unexplained";
    expect(refusal({ ...rec, after: { ...rec.after, rows: after } })).toBe("UNEXPLAINED_CHANGE");
  });

  it("LOG_CONTRADICTS_DOCUMENT: the app reported a value the saved file does not hold", async () => {
    const rec = await record([{ do: "type", cell: name7, text: "Reported" }, { do: "save" }]);
    const actions = rec.actions.map((a) => (a.kind === "cell-edit" ? { ...a, value: "Other" } : a));
    expect(refusal({ ...rec, actions })).toBe("LOG_CONTRADICTS_DOCUMENT");
  });

  it("HEADER_CHANGED, KEY_CHANGED, STRUCTURE_CHANGED, CLEARED_CELL", async () => {
    expect(
      refusal(await record([{ do: "type", cell: "B1", text: "Renamed" }, { do: "save" }])),
    ).toBe("HEADER_CHANGED");
    expect(
      refusal(await record([{ do: "type", cell: "A3", text: "EMP-9999" }, { do: "save" }])),
    ).toBe("KEY_CHANGED");
    const rows = new TextDecoder().decode(doc).trimEnd().split("\n").length;
    expect(
      refusal(
        await record([{ do: "type", cell: `A${rows + 1}`, text: "EMP-9999" }, { do: "save" }]),
      ),
    ).toBe("STRUCTURE_CHANGED");
    const rec = await record([{ do: "type", cell: name7, text: "X Value" }, { do: "save" }]);
    const after = rec.after.rows.map((r) => [...r]);
    (after[7] as string[])[1] = "";
    const actions = rec.actions.map((a) => (a.kind === "cell-edit" ? { ...a, value: "" } : a));
    expect(refusal({ ...rec, actions, after: { ...rec.after, rows: after } })).toBe("CLEARED_CELL");
  });

  it("VALUE_NOT_REPLAYABLE: a value Calc would rewrite, or of the wrong kind", async () => {
    expect(
      refusal(await record([{ do: "type", cell: name7, text: "lowercase start" }, { do: "save" }])),
    ).toBe("VALUE_NOT_REPLAYABLE");
    expect(
      refusal(await record([{ do: "type", cell: qty3, text: "Twelve" }, { do: "save" }])),
    ).toBe("VALUE_NOT_REPLAYABLE");
  });

  it("NOT_OPERATOR_STARTED, RECORDING_REDACTED, RECORDING_MALFORMED", async () => {
    const rec = await record([{ do: "type", cell: name7, text: "Fine Value" }, { do: "save" }]);
    expect(refusal({ ...rec, consent: { ...rec.consent, startedBy: "agent" as "operator" } })).toBe(
      "NOT_OPERATOR_STARTED",
    );
    expect(refusal({ ...rec, consent: { ...rec.consent, indicatorShown: false as true } })).toBe(
      "NOT_OPERATOR_STARTED",
    );
    expect(refusal({ ...rec, redactions: [{ field: "x", kind: "secret" }] })).toBe(
      "RECORDING_REDACTED",
    );
    // A recording edited on disk to carry a secret is refused even with no redaction listed.
    expect(refusal({ ...rec, recordingId: PLANTED_KEY })).toBe("RECORDING_REDACTED");
    expect(refusal({ ...rec, schema: "other" as never })).toBe("RECORDING_MALFORMED");
  });
});

describe("binding", () => {
  it("binds parameters, defaults to the demonstration, and refuses bad bindings", async () => {
    const compiled = compileRecording(
      await record([{ do: "type", cell: name7, text: "Revised Person" }, { do: "save" }]),
    );
    expect(bindWorkflow(compiled).edits).toEqual([
      { rowKey: "EMP-0007", column: "name", value: "Revised Person" },
    ]);
    const b = bindWorkflow(compiled, { record: "EMP-0002", name: "New Name" });
    expect(b.edits).toEqual([{ rowKey: "EMP-0002", column: "name", value: "New Name" }]);
    expect(b.oracle.assertions[1]).toEqual({
      type: "cell-equals",
      rowKey: "EMP-0002",
      column: "name",
      value: "New Name",
    });
    for (const bad of <Record<string, string>[]>[
      { nope: "x" },
      { name: "a,b" },
      { name: "" },
      { name: 'Quote"d' },
      { name: "lower" },
      { name: PLANTED_KEY },
      // Pass every other check (uppercase start, CSV-safe, text kind) but are sensitive.
      { name: ["Session", "Token=abc123"].join("") },
      { name: ["C:", "\\Data\\payroll"].join("") },
      { record: "../etc" },
    ]) {
      expect(() => bindWorkflow(compiled, bad), JSON.stringify(Object.keys(bad))).toThrow(
        BindingError,
      );
    }
  });

  it("refuses two steps bound to one cell", async () => {
    const compiled = compileRecording(
      await record([
        { do: "type", cell: name7, text: "First Edit" },
        { do: "type", cell: cellFor(doc, "EMP-0003", "name"), text: "Second Edit" },
        { do: "save" },
      ]),
    );
    expect(() => bindWorkflow(compiled, { record_1: "EMP-0001", record_2: "EMP-0001" })).toThrow(
      /same cell/,
    );
  });
});
