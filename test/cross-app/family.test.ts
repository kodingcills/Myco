/**
 * Capability track P (tier 2): the gate's `cross-app-steps` family and the gate's multi-file
 * read. Every check goes through the real gate (`createGate` + `fileEvidenceReader`), so
 * what is pinned is what runs: per-step checkpoints from each step's own snapshot, the
 * whole-document rule per document, no masking by a later step, the end state, the sealed
 * source notice, and fail-closed reads (any missing or unreadable file is `uncertain`).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crossAppFamily, parseReport } from "../../src/gate/cross-app.ts";
import { crossAppTaskEntry } from "../../src/gate/cross-app-demo.ts";
import type { OracleFamily } from "../../src/gate/families.ts";
import { FAMILIES, StateCorruptError } from "../../src/gate/families.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import {
  type CrossAppSpec,
  crossAppEvidenceFiles,
  crossAppSpecFor,
  END_DIR,
  noticePdf,
  REPORT_FILE,
  reportAt,
  SHEET_FILE,
  SOURCE_FILE,
  sheetAt,
  sourceLines,
  stepDir,
} from "../../src/tasks/cross-app.ts";
import { tempRoot } from "../gate/helpers.ts";

const SPEC = crossAppSpecFor("xa-family-test");
const TASK = "xa-task";
const RUN = "xa-run";

/** Write a correct trial's evidence; `override` replaces files (null deletes one). */
function writeTrial(
  root: string,
  spec: CrossAppSpec = SPEC,
  override: Record<string, string | Uint8Array | null> = {},
): void {
  const n = spec.steps.length;
  const files = new Map<string, string | Uint8Array>();
  for (let k = 1; k <= n; k++) {
    files.set(`${stepDir(k)}/${SHEET_FILE}`, sheetAt(spec, k));
    files.set(`${stepDir(k)}/${REPORT_FILE}`, reportAt(spec, k));
  }
  files.set(`${END_DIR}/${SHEET_FILE}`, sheetAt(spec, n));
  files.set(`${END_DIR}/${REPORT_FILE}`, reportAt(spec, n));
  files.set(SOURCE_FILE, noticePdf(sourceLines(spec)));
  for (const [file, content] of Object.entries(override)) {
    if (content === null) files.delete(file);
    else files.set(file, content);
  }
  for (const [file, content] of files) {
    const path = join(root, RUN, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

async function check(root: string, spec: CrossAppSpec = SPEC) {
  const gate = createGate({
    tasks: buildRegistry([crossAppTaskEntry(TASK, spec)]),
    reader: fileEvidenceReader(root),
    assignment: { taskId: TASK, runId: RUN },
  });
  return gate.check({ taskId: TASK, runId: RUN, claim: "done" });
}

async function trial(override: Record<string, string | Uint8Array | null> = {}) {
  const root = tempRoot();
  writeTrial(root, SPEC, override);
  try {
    return await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The step-k sheet with record/column set to value. */
function sheetWith(k: number, rowKey: string, column: string, value: string): string {
  const lines = sheetAt(SPEC, k).split("\n");
  const header = (lines[0] as string).split(",");
  const row = lines.findIndex((l) => l.split(",")[0] === rowKey);
  const cells = (lines[row] as string).split(",");
  cells[header.indexOf(column)] = value;
  lines[row] = cells.join(",");
  return lines.join("\n");
}

const [STEP1, STEP2, STEP3] = SPEC.steps as [
  CrossAppSpec["steps"][number],
  CrossAppSpec["steps"][number],
  CrossAppSpec["steps"][number],
];
const E1 = STEP1.edits[0] as { rowKey: string; column: string; newValue: string };

describe("the family is registered and its spec is checked", () => {
  it("is in FAMILIES and the generated spec is valid", () => {
    expect(FAMILIES.get("cross-app-steps")).toBe(crossAppFamily);
    expect(crossAppFamily.checkSpec(SPEC)).toBeUndefined();
  });

  const bad: Array<[string, (s: CrossAppSpec) => unknown, RegExp]> = [
    ["one step", (s) => ({ ...s, steps: s.steps.slice(0, 1) }), /2-10 steps/],
    ["bad source digest", (s) => ({ ...s, source: { ...s.source, sha256: "x" } }), /sha256/],
    ["source path", (s) => ({ ...s, source: { ...s.source, file: "../x.pdf" } }), /plain file/],
    [
      "writer reports a value no earlier calc step entered",
      (s) => ({ ...s, steps: [s.steps[2], s.steps[0], s.steps[1]] }),
      /earlier calc step/,
    ],
    [
      "writer value differs from the calc value",
      (s) => ({
        ...s,
        steps: [
          s.steps[0],
          s.steps[1],
          { app: "writer", edits: [{ ...E1, newValue: `${E1.newValue}0` }] },
        ],
      }),
      /earlier calc step/,
    ],
    [
      "the same cell twice",
      (s) => ({ ...s, steps: [s.steps[0], s.steps[0], s.steps[2]] }),
      /again/,
    ],
    [
      "a calc value Calc would rewrite",
      (s) => ({
        ...s,
        steps: [{ app: "calc", edits: [{ ...E1, newValue: "=1+1" }] }, s.steps[1], s.steps[2]],
      }),
      /rewriting|non-empty/,
    ],
    ["unknown app", (s) => ({ ...s, steps: [{ app: "impress", edits: [] }, ...s.steps] }), /app/],
    ["multi-line title", (s) => ({ ...s, reportTitle: "a\nb" }), /one line/],
  ];
  for (const [name, mutate, message] of bad) {
    it(`refuses a spec: ${name}`, () => {
      expect(crossAppFamily.checkSpec(mutate(SPEC))).toMatch(message);
    });
  }

  it("the registry needs stateFile to be one of the family's files", () => {
    expect(() =>
      buildRegistry([{ ...crossAppTaskEntry(TASK, SPEC), stateFile: "sheet.csv" }]),
    ).toThrow(/stateFile must be one of the family's state files/);
  });

  it("the registry refuses a family that lists unsafe or repeated files", () => {
    const base = crossAppFamily;
    for (const [list, message] of [
      [["end/sheet.csv", "../x"], /safe relative path/],
      [["end/sheet.csv", "end/sheet.csv"], /twice/],
      [[], /1-32/],
    ] as const) {
      const family: OracleFamily = { ...base, stateFiles: () => list };
      expect(() =>
        buildRegistry([crossAppTaskEntry(TASK, SPEC)], new Map([[base.id, family]])),
      ).toThrow(message);
    }
  });

  it("lists every snapshot, stateFile first, in the registry", () => {
    const task = buildRegistry([crossAppTaskEntry(TASK, SPEC)]).get(TASK);
    expect(task?.stateFiles?.[0]).toBe("end/sheet.csv");
    expect(new Set(task?.stateFiles)).toEqual(new Set(crossAppEvidenceFiles(3)));
  });
});

describe("verdicts from the real gate", () => {
  it("a correct trial verifies, with every snapshot and the sealed notice in the evidence", async () => {
    const result = await trial();
    expect(result.verdict).toBe("verified");
    expect(result.accepted).toBe(true);
    expect(result.checkpoints).toEqual({
      total: 3,
      lastVerified: 3,
      verdicts: [1, 2, 3].map((checkpoint) => ({ checkpoint, verdict: "verified" })),
    });
    expect(result.evidenceRefs.map((r) => `${r.kind}:${r.path}`)).toEqual([
      "persisted-state:end/sheet.csv",
      ...crossAppEvidenceFiles(3)
        .filter((f) => f !== "end/sheet.csv")
        .map((f) => `persisted-state:${f}`),
      `sealed-fixture:${SOURCE_FILE}`,
    ]);
  });

  it("refutes at step 1 when step 1's own snapshot is wrong, even though every later snapshot and the end state are right (no masking)", async () => {
    const result = await trial({
      [`${stepDir(1)}/${SHEET_FILE}`]: sheetWith(1, E1.rowKey, E1.column, `${E1.newValue}9`),
    });
    expect(result.verdict).toBe("refuted");
    expect(result.checkpoints?.lastVerified).toBe(0);
    expect(result.checkpoints?.verdicts.map((v) => v.verdict)).toEqual([
      "refuted",
      "refuted",
      "refuted",
    ]);
    expect(result.reasonCodes).toEqual(["ORACLE_FAIL", "TARGET_MISMATCH", "CLAIM_RECORDED"]);
    expect(result.reasons[0]).toMatch(/^step 1 \(sheet\.csv\): TARGET_MISMATCH: cell /);
  });

  it("refutes at step 2 when step 2 breaks step 1's cell (collateral against the expected document)", async () => {
    const result = await trial({
      [`${stepDir(2)}/${SHEET_FILE}`]: sheetWith(2, E1.rowKey, E1.column, "Changed Again"),
    });
    expect(result.checkpoints?.lastVerified).toBe(1);
    expect(result.reasonCodes).toContain("DOCUMENT_COLLATERAL");
    expect(result.reasons[0]).toMatch(/^step 2 \(sheet\.csv\): DOCUMENT_COLLATERAL/);
  });

  it("refutes at step 1 when a later step's edit is made early (the report filled at step 1)", async () => {
    const result = await trial({ [`${stepDir(1)}/${REPORT_FILE}`]: reportAt(SPEC, 3) });
    expect(result.checkpoints?.lastVerified).toBe(0);
    expect(result.reasons[0]).toMatch(/^step 1 \(report\.txt\): DOCUMENT_COLLATERAL/);
  });

  it("refutes the last checkpoint when only the end state differs", async () => {
    const result = await trial({ [`${END_DIR}/${REPORT_FILE}`]: reportAt(SPEC, 2) });
    expect(result.verdict).toBe("refuted");
    expect(result.checkpoints?.lastVerified).toBe(2);
    expect(result.reasons[0]).toMatch(/^end state \(report\.txt\): TARGET_MISMATCH/);
    expect(result.reasons.join("\n")).toMatch(/the end state differs/);
  });

  it("refutes collateral in the report: an added line", async () => {
    const result = await trial({
      [`${stepDir(3)}/${REPORT_FILE}`]: `${reportAt(SPEC, 3)}Signed: agent\n`,
    });
    expect(result.checkpoints?.lastVerified).toBe(2);
    expect(result.reasons[0]).toMatch(/report\.txt\): DOCUMENT_COLLATERAL: 1 line\(s\).*line 7/);
  });

  it("refuted reasons name cells and lines, never a value", async () => {
    const result = await trial({
      [`${stepDir(3)}/${REPORT_FILE}`]: reportAt(SPEC, 2),
      [`${stepDir(2)}/${SHEET_FILE}`]: sheetAt(SPEC, 1),
    });
    const text = result.reasons.join("\n");
    for (const step of [STEP1, STEP2, STEP3])
      for (const edit of step.edits) expect(text).not.toContain(edit.newValue);
  });

  it("accepts what Writer and Calc legitimately write: a BOM, CRLF line ends, trailing blanks", async () => {
    const report = `\ufeff${reportAt(SPEC, 3).replace(/\n/g, "  \r\n")}\r\n`;
    const result = await trial({
      [`${stepDir(3)}/${REPORT_FILE}`]: report,
      [`${END_DIR}/${REPORT_FILE}`]: report,
    });
    expect(result.verdict).toBe("verified");
  });
});

describe("fail closed: the gate never decides without every file", () => {
  it("a missing step snapshot is uncertain STATE_MISSING, and nothing is verified", async () => {
    const result = await trial({ [`${stepDir(2)}/${REPORT_FILE}`]: null });
    expect(result.verdict).toBe("uncertain");
    expect(result.accepted).toBe(false);
    expect(result.reasonCodes).toContain("STATE_MISSING");
    expect(result.reasons[0]).toContain("step-2/report.txt");
    expect(result.oracle).toBeUndefined();
  });

  it("a symlinked step snapshot is uncertain STATE_UNREADABLE", async () => {
    const root = tempRoot();
    writeTrial(root);
    const { symlinkSync, unlinkSync } = await import("node:fs");
    const target = join(root, RUN, stepDir(1), SHEET_FILE);
    unlinkSync(target);
    symlinkSync(join(root, RUN, END_DIR, SHEET_FILE), target);
    const result = await check(root);
    expect(result.verdict).toBe("uncertain");
    expect(result.reasonCodes).toContain("STATE_UNREADABLE");
  });

  it("a swapped source notice is uncertain FIXTURE_MISMATCH; a missing one FIXTURE_UNREADABLE", async () => {
    const swapped = await trial({ [SOURCE_FILE]: noticePdf(["Correction notice", "nothing"]) });
    expect(swapped.verdict).toBe("uncertain");
    expect(swapped.reasonCodes).toContain("FIXTURE_MISMATCH");
    const missing = await trial({ [SOURCE_FILE]: null });
    expect(missing.reasonCodes).toContain("FIXTURE_UNREADABLE");
  });

  const hostile: Array<[string, string | Uint8Array]> = [
    ["invalid UTF-8", new Uint8Array([0x43, 0xff, 0x0a])],
    ["a NUL byte", "Correction report\u0000\n"],
    ["a bare CR (CR-only file)", reportAt(SPEC, 3).replace(/\n/g, "\r")],
    ["a second BOM", `\ufeff\ufeff${reportAt(SPEC, 3)}`],
    ["an escape character", `${reportAt(SPEC, 3)}\u001b[2J\n`],
    ["too many lines", "\n".repeat(10_002).replace(/\n/g, "x\n")],
    ["a line too long", `${"x".repeat(10_001)}\n`],
  ];
  for (const [name, content] of hostile) {
    it(`a report with ${name} is uncertain STATE_CORRUPT`, async () => {
      const result = await trial({ [`${stepDir(3)}/${REPORT_FILE}`]: content });
      expect(result.verdict).toBe("uncertain");
      expect(result.reasonCodes).toContain("STATE_CORRUPT");
      expect(result.reasons[0]).toMatch(/^could not look: step-3\/report\.txt: /);
    });
  }

  it("a sheet that is not UTF-8 is uncertain STATE_CORRUPT", async () => {
    const result = await trial({ [`${stepDir(1)}/${SHEET_FILE}`]: new Uint8Array([0xc3, 0x28]) });
    expect(result.reasonCodes).toContain("STATE_CORRUPT");
  });

  it("decide without the snapshots or the notice is an oracle error, never a verdict", () => {
    const bytes = new TextEncoder().encode(sheetAt(SPEC, 3));
    expect(() => crossAppFamily.decide(bytes, SPEC, "r", {})).toThrow(/sealed source/);
    expect(() => crossAppFamily.decide(bytes, SPEC, "r", { fixture: new Uint8Array([1]) })).toThrow(
      /snapshots/,
    );
    expect(() =>
      crossAppFamily.decide(bytes, SPEC, "r", {
        fixture: new Uint8Array([1]),
        states: new Map([["end/sheet.csv", bytes]]),
      }),
    ).toThrow(/did not supply step-1/);
  });

  it("parseReport refusals are StateCorruptError (the gate's uncertain path)", () => {
    expect(() => parseReport(new Uint8Array([0xff]))).toThrow(StateCorruptError);
    expect(parseReport(new TextEncoder().encode("a  \r\nb\n\n\n"))).toEqual(["a", "b"]);
  });
});
