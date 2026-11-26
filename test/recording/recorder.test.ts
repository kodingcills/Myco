/**
 * Track R recorder: operator-started, visible, allowlisted, and never storing a secret or a
 * host path (planted-marker tests). Each guard here is mutation-proven (see the PR's table).
 */
import { describe, expect, it } from "vitest";
import { CompileError, compileRecording } from "../../src/recording/compile.ts";
import {
  RecorderError,
  recordDemonstration,
  START_BANNER,
  STOP_BANNER,
  serializeRecording,
  startRecording,
} from "../../src/recording/recorder.ts";
import { cellFor, scriptedHuman } from "../../src/recording/scripted-human.ts";
import { assertClean, findSensitive, SensitiveContentError } from "../../src/recording/scrub.ts";
import {
  ALL_MARKERS,
  fixtureBytes,
  operator,
  PLANTED_GH,
  PLANTED_KEY,
  PLANTED_LINUX_HOME,
  PLANTED_MAC_HOME,
  PLANTED_OPERATOR_MARKER,
} from "./helpers.ts";

const doc = fixtureBytes("track-r-rec");
const base = { before: doc, simulated: true, recordingId: "rec-test" } as const;

function noMarkers(text: string) {
  for (const m of ALL_MARKERS) expect(text).not.toContain(m);
}

describe("operator-started and visible", () => {
  it("refuses to start unless the operator starts it", () => {
    for (const startedBy of ["agent", "gate", "", "Operator"]) {
      expect(() =>
        startRecording({ ...base, start: { startedBy, interactive: true }, indicator: () => {} }),
      ).toThrow(RecorderError);
    }
  });

  it("refuses to start without an indicator, and when the indicator fails", () => {
    expect(() =>
      startRecording({ ...base, start: operator, indicator: undefined as never }),
    ).toThrow(/visible/);
    expect(() =>
      startRecording({
        ...base,
        start: operator,
        indicator: () => {
          throw new Error("no terminal");
        },
      }),
    ).toThrow(/indicator failed/);
  });

  it("shows the banner at start (before capture) and at stop, and records the consent", async () => {
    const shown: string[] = [];
    const active = startRecording({ ...base, start: operator, indicator: (l) => shown.push(l) });
    expect(shown).toEqual([START_BANNER]);
    const rec = active.stop(doc);
    expect(shown).toEqual([START_BANNER, STOP_BANNER]);
    expect(rec.consent).toEqual({
      startedBy: "operator",
      indicatorShown: true,
      interactive: false,
    });
  });
});

describe("semantic capture with before/after state", () => {
  it("records app-level cell edits, saves and GUI fallbacks, and both document states", async () => {
    const cell = cellFor(doc, "EMP-0003", "name");
    const rec = await recordDemonstration(
      scriptedHuman({
        document: doc,
        steps: [
          { do: "select", cell },
          { do: "type", cell, text: "Revised Person" },
          { do: "save" },
        ],
      }),
      { ...base, start: operator, indicator: () => {} },
    );
    expect(rec.actions.filter((a) => a.kind === "cell-edit")).toEqual([
      { seq: expect.any(Number), kind: "cell-edit", source: "app", cell, value: "Revised Person" },
    ]);
    expect(rec.actions.some((a) => a.kind === "save")).toBe(true);
    expect(rec.actions.some((a) => a.kind === "gui" && a.cell === cell)).toBe(true);
    expect(rec.before.rows).not.toEqual(rec.after.rows);
    expect(rec.documentName).toBe("document.csv");
    expect(rec.redactions).toEqual([]);
  });

  it("refuses an unreadable after-document (no recording)", () => {
    const active = startRecording({ ...base, start: operator, indicator: () => {} });
    expect(() => active.stop(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(/after document/);
  });
});

describe("planted markers: secrets and host paths never reach a recording", () => {
  it("drops window titles, key text, clipboard and paths (allowlist) and counts them", async () => {
    const cell = cellFor(doc, "EMP-0002", "name");
    const rec = await recordDemonstration(
      scriptedHuman({
        document: doc,
        windowTitle: `${PLANTED_LINUX_HOME} - LibreOffice Calc`,
        steps: [
          { do: "copy", text: `${PLANTED_KEY} ${PLANTED_GH}` },
          { do: "select", cell },
          { do: "type", cell, text: "Safe Value" },
          { do: "copy", text: PLANTED_MAC_HOME },
          { do: "save" },
        ],
      }),
      { ...base, start: operator, indicator: () => {} },
    );
    const text = serializeRecording(rec);
    noMarkers(text);
    expect(rec.droppedFields).toBeGreaterThan(10);
    expect(rec.redactions).toEqual([]);
    // Nothing was redacted, so the demonstration still compiles.
    expect(compileRecording(rec).workflow.steps).toHaveLength(2);
  });

  it("redacts a secret or host path typed into a cell, and the compiler refuses it", async () => {
    for (const planted of [PLANTED_KEY, PLANTED_LINUX_HOME, PLANTED_MAC_HOME]) {
      const cell = cellFor(doc, "EMP-0004", "name");
      const rec = await recordDemonstration(
        scriptedHuman({
          document: doc,
          steps: [{ do: "type", cell, text: planted }, { do: "save" }],
        }),
        { ...base, start: operator, indicator: () => {} },
      );
      noMarkers(serializeRecording(rec));
      // Redacted in the action log AND in the after-document snapshot; path and kind only.
      expect(rec.redactions.map((r) => r.field)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^actions\[/),
          expect.stringMatching(/^after\.rows/),
        ]),
      );
      expect(() => compileRecording(rec)).toThrow(CompileError);
      expect(() => compileRecording(rec)).toThrow(/RECORDING_REDACTED/);
    }
  });

  it("refuses operator-supplied markers anywhere, including the recording id", async () => {
    const rec = await recordDemonstration(
      scriptedHuman({
        document: doc,
        steps: [{ do: "type", cell: "B2", text: `X ${PLANTED_OPERATOR_MARKER}` }, { do: "save" }],
      }),
      {
        ...base,
        recordingId: `rec-${PLANTED_OPERATOR_MARKER}`,
        markers: [PLANTED_OPERATOR_MARKER],
        start: operator,
        indicator: () => {},
      },
    );
    noMarkers(JSON.stringify(rec));
    expect(rec.redactions.some((r) => r.field === "recordingId" && r.kind === "marker")).toBe(true);
  });

  it("the last net refuses a recording that still holds one (assertClean)", () => {
    expect(() => assertClean({ a: [{ b: PLANTED_KEY }] })).toThrow(SensitiveContentError);
    expect(() => assertClean({ [PLANTED_LINUX_HOME]: 1 })).toThrow(/key is host-path/);
    // The error names the path and rule, never the content.
    try {
      assertClean({ a: PLANTED_KEY });
    } catch (error) {
      expect(String(error)).not.toContain(PLANTED_KEY);
    }
  });

  it("the last net in stop() catches a field the normalizer never scrubs (injected clock)", () => {
    const clock = () => ({ toISOString: () => PLANTED_KEY }) as unknown as Date;
    const active = startRecording({ ...base, start: operator, indicator: () => {}, now: clock });
    expect(() => active.stop(doc)).toThrow(SensitiveContentError);
  });

  it("serializeRecording refuses a tampered recording", async () => {
    const active = startRecording({ ...base, start: operator, indicator: () => {} });
    const rec = active.stop(doc);
    const tampered = { ...rec, recorder: { name: PLANTED_KEY, version: "1" } };
    expect(() => serializeRecording(tampered)).toThrow(SensitiveContentError);
  });

  it("the detector covers the shapes it claims and passes fixture data", () => {
    for (const s of [
      PLANTED_KEY,
      PLANTED_GH,
      PLANTED_LINUX_HOME,
      PLANTED_MAC_HOME,
      ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
      ["MY_API", "_KEY=abc123"].join(""),
      ["C:", "\\Users\\x"].join(""),
      ["file:", "//server/x"].join(""),
      "~/secrets/x",
      ["Q3nX8vLp", "2RkT7wYz", "4MbJ9dHc", "6FsA1eGu"].join(""),
    ]) {
      expect(findSensitive(s), s.slice(0, 6)).toBeDefined();
    }
    for (const s of ["Ada Ito", "429", "2024-01-02", "$45000.10", "EMP-0007", "a".repeat(64)]) {
      expect(findSensitive(s)).toBeUndefined();
    }
    // A sha256 digest is not a secret.
    expect(
      findSensitive("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
    ).toBeUndefined();
  });
});
