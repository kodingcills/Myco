/**
 * TIF-270 (M2-07): the whole-document Calc check and the multi-step Calc family with
 * checkpoint verdicts and one retry.
 *
 *  - calc-record-edit v2: `verified` needs the whole saved document to equal the pristine
 *    fixture with the edit applied; a correct target with collateral damage is refuted
 *    with DOCUMENT_COLLATERAL (a target-only check fails these tests).
 *  - calc-multi-step: per-checkpoint verdicts from the persisted document and the spec
 *    alone; the agent cannot send steps, values or checkpoints.
 *  - the gate validates the oracle's codes and checkpoints and computes `lastVerified`
 *    itself.
 *  - the retry loop restores the gate's last verified checkpoint and never makes a third
 *    attempt; the mock end-to-end demo shows retry → verified and fail twice → refuted.
 *  - gate code reuses nothing from the independent grader (`src/benchmark/`).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsvSpreadsheet } from "../../src/core/filepersist.ts";
import { type GateResult, ORACLE_INPUT_FIELDS, REASON_CODES } from "../../src/gate/api.ts";
import {
  type CellEdit,
  documentCsv,
  expectedCells,
  parseDocument,
  pristineCells,
  targetRef,
} from "../../src/gate/calc-document.ts";
import {
  type CalcMultiStepSpec,
  calcMultiStepFamily,
  FAMILIES,
  type OracleFamily,
} from "../../src/gate/families.ts";
import {
  buildRegistry,
  createGate,
  fileEvidenceReader,
  type TaskEntry,
} from "../../src/gate/gate.ts";
import {
  type MultiStepHarness,
  retryCheckpoint,
  runMultiStepTrial,
} from "../../src/gate/multistep.ts";
import { MS_SPEC, runMultiStepMockDemo } from "../../src/gate/multistep-demo.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { CALC_SPEC, tempRoot, writeState } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SEED = CALC_SPEC.fixtureSeed;
const EDIT: CellEdit = {
  rowKey: CALC_SPEC.rowKey,
  column: CALC_SPEC.column,
  newValue: CALC_SPEC.newValue,
};

/** A CSV document: the fixture with `edits` applied, then `mutate` on the raw rows. */
function sheet(seed: string, edits: readonly CellEdit[], mutate?: (rows: string[][]) => void) {
  const rows = documentCsv(seed, edits)
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
  mutate?.(rows);
  return `${rows.map((row) => row.join(",")).join("\n")}\n`;
}

/** A mutator for `sheet`: set row `r`, column `c` (0-based, header = row 0) to `value`. */
function setCell(r: number, c: number, value: string) {
  return (rows: string[][]) => {
    const row = rows[r];
    if (row) row[c] = value;
  };
}

async function check(
  entry: TaskEntry,
  csv: string,
  families: ReadonlyMap<string, OracleFamily> = FAMILIES,
): Promise<GateResult> {
  const root = tempRoot();
  writeState(root, "r", entry.stateFile, csv);
  return createGate({
    tasks: buildRegistry([entry], families),
    reader: fileEvidenceReader(root),
    assignment: { taskId: entry.id, runId: "r" },
  }).check({ taskId: entry.id, runId: "r" });
}

const CALC: TaskEntry = {
  id: "calc-1",
  family: "calc-record-edit",
  stateFile: "sheet.csv",
  spec: CALC_SPEC,
};

function assertInvariant(result: GateResult) {
  expect(result.accepted).toBe(result.verdict === "verified");
  if (result.accepted) expect(result.reasonCodes).toContain("ORACLE_PASS");
  for (const code of result.reasonCodes) expect(REASON_CODES).toContain(code);
}

describe("calc-record-edit v2: the whole document must equal pristine + intent", () => {
  it("verified only when the target holds the value and every other cell is pristine", async () => {
    const result = await check(CALC, sheet(SEED, [EDIT]));
    assertInvariant(result);
    expect(result).toMatchObject({
      verdict: "verified",
      reasonCodes: ["ORACLE_PASS"],
      oracle: { family: "calc-record-edit", version: "2" },
    });
  });

  // Each case keeps the target correct. A check that looks only at the target cell
  // returns verified for all of them; the whole-document check must refute each one.
  const collateral: [string, (rows: string[][]) => void, string][] = [
    ["another cell in the same row changed", setCell(2, 2, "777"), "C3"],
    ["a cell in another row changed", setCell(4, 4, "$1.00"), "E5"],
    ["a non-target cell cleared", setCell(3, 1, ""), "B4"],
    ["a header renamed", setCell(0, 0, "ID"), "A1"],
    ["a cell added past the last column", (rows) => void (rows[1] as string[]).push("extra"), "F2"],
    ["a row added below the data", (rows) => void rows.push(["EMP-9999", "New Row"]), ""],
    ["a date cell saved as a serial", setCell(2, 3, "45000"), "D3"],
    ["a data row deleted", (rows) => void rows.splice(5, 1), ""],
  ];
  it.each(collateral)(
    "target right, %s → refuted DOCUMENT_COLLATERAL",
    async (_name, mutate, ref) => {
      const result = await check(CALC, sheet(SEED, [EDIT], mutate));
      assertInvariant(result);
      expect(result.verdict).toBe("refuted");
      expect(result.reasonCodes).toEqual(["ORACLE_FAIL", "DOCUMENT_COLLATERAL"]);
      const reason = result.reasons.find((r) => r.startsWith("DOCUMENT_COLLATERAL")) ?? "";
      if (ref) expect(reason).toContain(ref);
    },
  );

  it("collateral reasons name cells, never the fixture's pristine values", async () => {
    const pristine = generateFixture(SEED).rows[2]?.[2] as string;
    const result = await check(CALC, sheet(SEED, [EDIT], setCell(3, 2, "1")));
    expect(result.reasons.join("\n")).not.toContain(pristine);
    expect(result.reasons.join("\n")).toContain("C4");
  });

  it("target wrong and collateral damage → both codes", async () => {
    const result = await check(CALC, sheet(SEED, [], setCell(4, 1, "Someone Else")));
    expect(result.reasonCodes).toEqual(["ORACLE_FAIL", "TARGET_MISMATCH", "DOCUMENT_COLLATERAL"]);
  });

  it("the spec must hold a CSV-safe, non-empty newValue", () => {
    for (const newValue of ["", "a,b", 'say "hi"', "two\nlines"]) {
      expect(() => buildRegistry([{ ...CALC, spec: { ...CALC_SPEC, newValue } }])).toThrow(
        /newValue must be non-empty/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// calc-multi-step
// ---------------------------------------------------------------------------

const MS: TaskEntry = {
  id: "ms-1",
  family: "calc-multi-step",
  stateFile: "sheet.csv",
  spec: MS_SPEC,
};
const [S1, S2, S3] = MS_SPEC.steps as [CellEdit, CellEdit, CellEdit];
const MSEED = MS_SPEC.fixtureSeed;

function verdicts(result: GateResult): string {
  return (result.checkpoints?.verdicts ?? [])
    .map((cp) => (cp.verdict === "verified" ? "V" : "R"))
    .join("");
}

/** Insert `extra` raw lines after line `at` (0-based, header = line 0) of a CSV text. */
function insertLines(csv: string, at: number, extra: readonly string[], eol = "\n"): string {
  const lines = csv.trimEnd().split("\n");
  lines.splice(at + 1, 0, ...extra);
  return `${lines.join(eol)}${eol}`;
}

// Round-2 D1: the M1 reader drops empty lines before numbering rows, so a blank line used to
// shift every record below it without the gate noticing (the grader fails such a document).
// The gate's strict parse keeps row structure exact: an interior blank or all-empty row is
// refuted. Round-3 D2: rows after the last row with content hold no content (like a
// trailing empty column), so trailing blank lines and `,,,,` rows are the same document,
// as the independent grader already ruled (test/gate/calc-gate-grader-agreement.test.ts).
describe("calc-record-edit v2: row structure is exact (blank lines, extra rows)", () => {
  const exact = sheet(SEED, [EDIT]);
  const allowed: [string, string][] = [
    ["one trailing LF (the fixture's own format)", exact],
    ["no trailing newline", exact.trimEnd()],
    ["CRLF line endings, one trailing CRLF", exact.replaceAll("\n", "\r\n")],
    ["CRLF line endings, no trailing newline", exact.trimEnd().replaceAll("\n", "\r\n")],
    ["a blank line at the end", `${exact}\n`],
    ["two blank lines at the end", `${exact}\n\n`],
    ["a CRLF blank line at the end", `${exact.replaceAll("\n", "\r\n")}\r\n`],
    ["an all-empty row at the end", `${exact},,,,\n`],
  ];
  it.each(allowed)("%s → verified", async (_name, csv) => {
    const result = await check(CALC, csv);
    assertInvariant(result);
    expect(result.verdict).toBe("verified");
  });

  const structural: [string, string][] = [
    ["a blank line after the header (the round-1 probe)", insertLines(exact, 0, [""])],
    ["a blank line after row 3", insertLines(exact, 2, [""])],
    ["two blank lines inside the sheet", insertLines(exact, 4, ["", ""])],
    ["a CRLF blank line inside a CRLF sheet", insertLines(exact, 1, [""], "\r\n")],
    ["an all-empty row inside the sheet", insertLines(exact, 3, [",,,,"])],
  ];
  it.each(structural)("%s → refuted DOCUMENT_COLLATERAL", async (_name, csv) => {
    const result = await check(CALC, csv);
    assertInvariant(result);
    expect(result.verdict).toBe("refuted");
    expect(result.reasonCodes).toContain("DOCUMENT_COLLATERAL");
    expect(result.reasons.some((r) => r.startsWith("DOCUMENT_COLLATERAL"))).toBe(true);
  });

  it("parseDocument keeps interior blank lines as rows; trailing empty rows add nothing", () => {
    expect(parseDocument("a,b\n\nc,d\n")).toEqual({
      cells: { A1: "a", B1: "b", A3: "c", B3: "d" },
    });
    expect(parseDocument("a,b\r\nc,d")).toEqual({ cells: { A1: "a", B1: "b", A2: "c", B2: "d" } });
    expect(parseDocument("a,b\nc,d\n\n,,\r\n\n")).toEqual(parseDocument("a,b\nc,d"));
    expect(parseDocument("")).toEqual({ cells: {} });
    expect(parseDocument(exact).cells).toEqual(parseCsvSpreadsheet(exact, "x").cells);
  });
});

// Round-2 D2: refuted reasons carry no cell value: not the requested newValue, and not the
// cell's current content, which for an untouched target is the pristine fixture value.
describe("agent-facing reasons carry neither the requested value nor a pristine value", () => {
  it("calc-record-edit, target untouched", async () => {
    const pristine = pristineCells(SEED).get(targetRef(SEED, EDIT)) as string;
    const result = await check(CALC, sheet(SEED, []));
    expect(result.reasonCodes).toEqual(["ORACLE_FAIL", "TARGET_MISMATCH"]);
    const text = result.reasons.join("\n");
    expect(text).toContain(targetRef(SEED, EDIT));
    expect(text).not.toContain(EDIT.newValue);
    expect(text).not.toContain(pristine);
  });

  it("calc-multi-step, nothing done (every step's cell still pristine)", async () => {
    const result = await check(MS, sheet(MSEED, []));
    const text = result.reasons.join("\n");
    for (const step of [S1, S2, S3]) {
      const ref = targetRef(MSEED, step);
      expect(text).toContain(ref);
      expect(text).not.toContain(step.newValue);
      expect(text).not.toContain(pristineCells(MSEED).get(ref) as string);
    }
  });
});

describe("calc-multi-step: per-checkpoint verdicts from the document alone", () => {
  const cases: [string, string, number, GateResult["verdict"], string][] = [
    ["pristine (nothing done)", "RRR", 0, "refuted", sheet(MSEED, [])],
    ["step 1 done", "VRR", 1, "refuted", sheet(MSEED, [S1])],
    ["steps 1-2 done", "VVR", 2, "refuted", sheet(MSEED, [S1, S2])],
    ["all steps done", "VVV", 3, "verified", sheet(MSEED, [S1, S2, S3])],
    ["only step 3 done", "RRR", 0, "refuted", sheet(MSEED, [S3])],
    ["steps 1 and 3 done", "VRR", 1, "refuted", sheet(MSEED, [S1, S3])],
    ["step 2 typo", "VRR", 1, "refuted", sheet(MSEED, [S1, { ...S2, newValue: "4224" }, S3])],
    [
      "all done plus collateral",
      "RRR",
      0,
      "refuted",
      sheet(MSEED, [S1, S2, S3], setCell(1, 1, "Scratch Note")),
    ],
  ];
  it.each(cases)("%s → %s, lastVerified %i, %s", async (_name, want, last, verdict, csv) => {
    const result = await check(MS, csv);
    assertInvariant(result);
    expect(result.verdict).toBe(verdict);
    expect(verdicts(result)).toBe(want);
    expect(result.checkpoints).toMatchObject({ total: 3, lastVerified: last });
    expect(result.oracle).toMatchObject({ family: "calc-multi-step", version: "1" });
  });

  it("collateral damage refutes even with every target right", async () => {
    const result = await check(MS, sheet(MSEED, [S1, S2, S3], setCell(1, 1, "Scratch Note")));
    expect(result.reasonCodes).toEqual(["ORACLE_FAIL", "DOCUMENT_COLLATERAL"]);
  });

  it.each([
    ["a blank line inside the sheet", (csv: string) => insertLines(csv, 3, [""])],
    ["an all-empty row inside the sheet", (csv: string) => insertLines(csv, 1, [",,,,"])],
  ])("every step right but %s → every checkpoint refuted (round-2 D1)", async (_name, edit) => {
    const result = await check(MS, edit(sheet(MSEED, [S1, S2, S3])));
    assertInvariant(result);
    expect(result.reasonCodes).toContain("DOCUMENT_COLLATERAL");
    expect(verdicts(result)).toBe("RRR");
    expect(result.checkpoints).toMatchObject({ total: 3, lastVerified: 0 });
  });

  it("every step right plus empty rows at the end → every checkpoint verified (round-3 D2)", async () => {
    const result = await check(MS, `${sheet(MSEED, [S1, S2, S3])}\n,,,,\r\n`);
    assertInvariant(result);
    expect(verdicts(result)).toBe("VVV");
  });

  it("the agent cannot supply steps, values or checkpoints; the oracle never runs", async () => {
    let calls = 0;
    const spy: OracleFamily = {
      ...calcMultiStepFamily,
      decide: (...args) => {
        calls += 1;
        return calcMultiStepFamily.decide(...args);
      },
    };
    const families = new Map([[spy.id, spy]]);
    const root = tempRoot();
    writeState(root, "r", "sheet.csv", sheet(MSEED, []));
    const gate = createGate({
      tasks: buildRegistry([MS], families),
      reader: fileEvidenceReader(root),
      assignment: { taskId: "ms-1", runId: "r" },
    });
    for (const extra of [
      { steps: [] },
      { checkpoints: { lastVerified: 3 } },
      { checkpoint: 3 },
      { lastVerified: 3 },
      { newValue: "4224" },
      { edits: [] },
    ]) {
      const result = await gate.check({ taskId: "ms-1", runId: "r", ...extra });
      expect(result.reasonCodes).toEqual(["ORACLE_INPUT_REJECTED"]);
      expect(result.accepted).toBe(false);
      expect(result.checkpoints).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  const badSpecs: [string, unknown, RegExp][] = [
    ["one step", { fixtureSeed: MSEED, steps: [S1] }, /2-10 edits/],
    ["eleven steps", { fixtureSeed: MSEED, steps: Array(11).fill(S1) }, /2-10 edits/],
    [
      "a repeated target",
      { fixtureSeed: MSEED, steps: [S1, { ...S1, newValue: "Ops Two" }] },
      /again/,
    ],
    [
      "a value equal to the pristine cell",
      {
        fixtureSeed: MSEED,
        steps: [S1, { ...S2, newValue: pristineCells(MSEED).get(targetRef(MSEED, S2)) }],
      },
      /change nothing/,
    ],
    [
      "a value Calc would rewrite",
      { fixtureSeed: MSEED, steps: [S1, { ...S2, column: "name", newValue: "lowercase" }] },
      /rewriting/,
    ],
    [
      "an unknown row",
      { fixtureSeed: MSEED, steps: [S1, { ...S2, rowKey: "EMP-9999" }] },
      /not present/,
    ],
    [
      "the key column",
      { fixtureSeed: MSEED, steps: [S1, { ...S2, column: "id" }] },
      /non-editable/,
    ],
    [
      "a comma in a value",
      { fixtureSeed: MSEED, steps: [S1, { ...S2, column: "name", newValue: "A,B" }] },
      /comma/,
    ],
    ["no seed", { steps: [S1, S2] }, /fixtureSeed/],
  ];
  it.each(badSpecs)("the registry rejects a spec with %s", (_name, spec, message) => {
    expect(() => buildRegistry([{ ...MS, spec }])).toThrow(message);
  });

  it("the host-generated checkpoint documents parse back to the expected cells", () => {
    expect(documentCsv(MSEED, [])).toBe(generateFixture(MSEED).csv);
    for (let k = 0; k <= 3; k++) {
      const edits = MS_SPEC.steps.slice(0, k);
      const parsed = parseCsvSpreadsheet(documentCsv(MSEED, edits), "x").cells;
      expect(new Map(Object.entries(parsed))).toEqual(expectedCells(MSEED, edits));
    }
  });
});

// ---------------------------------------------------------------------------
// The gate's checks on the new oracle fields
// ---------------------------------------------------------------------------

describe("gate: oracle codes and checkpoints are validated, lastVerified is the gate's", () => {
  const cp = (...v: ("verified" | "refuted")[]) =>
    v.map((verdict, i) => ({ checkpoint: i + 1, verdict }));
  const malformed: [string, unknown][] = [
    [
      "verified with a failure code",
      { status: "verified", reasons: [], codes: ["TARGET_MISMATCH"] },
    ],
    [
      "uncertain with a failure code",
      { status: "uncertain", reasons: [], codes: ["DOCUMENT_COLLATERAL"] },
    ],
    ["an unknown code", { status: "refuted", reasons: [], codes: ["ORACLE_PASS"] }],
    [
      "a repeated code",
      { status: "refuted", reasons: [], codes: ["TARGET_MISMATCH", "TARGET_MISMATCH"] },
    ],
    ["codes not an array", { status: "refuted", reasons: [], codes: "TARGET_MISMATCH" }],
    [
      "verified with a refuted checkpoint",
      {
        status: "verified",
        reasons: [],
        checkpoints: [
          { checkpoint: 1, verdict: "refuted" },
          { checkpoint: 2, verdict: "verified" },
        ],
      },
    ],
    [
      "refuted whose last checkpoint is verified",
      { status: "refuted", reasons: [], checkpoints: cp("refuted", "verified") },
    ],
    [
      "uncertain with checkpoints",
      { status: "uncertain", reasons: [], checkpoints: cp("refuted") },
    ],
    [
      "checkpoints numbered from 0",
      { status: "refuted", reasons: [], checkpoints: [{ checkpoint: 0, verdict: "refuted" }] },
    ],
    [
      "checkpoints out of order",
      {
        status: "refuted",
        reasons: [],
        checkpoints: [
          { checkpoint: 2, verdict: "refuted" },
          { checkpoint: 1, verdict: "refuted" },
        ],
      },
    ],
    [
      "an uncertain checkpoint",
      { status: "refuted", reasons: [], checkpoints: [{ checkpoint: 1, verdict: "uncertain" }] },
    ],
    ["empty checkpoints", { status: "refuted", reasons: [], checkpoints: [] }],
    [
      "65 checkpoints",
      { status: "refuted", reasons: [], checkpoints: cp(...Array(65).fill("refuted")) },
    ],
  ];
  it.each(malformed)("%s → uncertain ORACLE_INVALID_OUTPUT", async (_name, output) => {
    const family: OracleFamily = {
      id: "fake",
      version: "1",
      checkSpec: () => undefined,
      decide: () => output as never,
    };
    const result = await check(
      { id: "t", family: "fake", stateFile: "s.csv", spec: {} },
      "x",
      new Map([[family.id, family]]),
    );
    assertInvariant(result);
    expect(result.reasonCodes).toEqual(["ORACLE_INVALID_OUTPUT"]);
    expect(result.checkpoints).toBeUndefined();
  });

  it("lastVerified counts leading verified checkpoints; an oracle's own value is ignored", async () => {
    const family: OracleFamily = {
      id: "fake",
      version: "1",
      checkSpec: () => undefined,
      decide: () =>
        ({
          status: "refuted",
          reasons: [],
          checkpoints: cp("verified", "refuted", "verified", "refuted"),
          lastVerified: 4,
        }) as never,
    };
    const result = await check(
      { id: "t", family: "fake", stateFile: "s.csv", spec: {} },
      "x",
      new Map([[family.id, family]]),
    );
    expect(result.checkpoints).toEqual({
      total: 4,
      lastVerified: 1,
      verdicts: cp("verified", "refuted", "verified", "refuted"),
    });
  });
});

// ---------------------------------------------------------------------------
// The one-retry loop
// ---------------------------------------------------------------------------

function fakeResult(accepted: boolean, lastVerified?: number): GateResult {
  return {
    apiVersion: "myco.gate/v1",
    verdict: accepted ? "verified" : lastVerified === undefined ? "uncertain" : "refuted",
    accepted,
    reasonCodes: [accepted ? "ORACLE_PASS" : "ORACLE_FAIL"],
    reasons: [],
    evidenceRefs: [],
    request: {},
    ...(lastVerified === undefined
      ? {}
      : { checkpoints: { total: 3, lastVerified, verdicts: [] } }),
    checkedAt: "2026-11-26T00:00:00Z",
  };
}

function scripted(results: GateResult[]) {
  const log: string[] = [];
  const harness: MultiStepHarness = {
    restore: async (k) => void log.push(`restore ${k}`),
    runAgent: async ({ attempt, fromCheckpoint }) => {
      log.push(`agent ${attempt} from ${fromCheckpoint}`);
      return { claim: "done" };
    },
    capture: async (attempt) => void log.push(`capture ${attempt}`),
    checkGate: async () => {
      log.push("gate");
      const next = results.shift();
      if (!next) throw new Error("gate called too often");
      return next;
    },
  };
  return { harness, log };
}

describe("runMultiStepTrial: one retry from the gate's last verified checkpoint", () => {
  it("refuted at checkpoint 2 → restore checkpoint 1, retry once → verified", async () => {
    const { harness, log } = scripted([fakeResult(false, 1), fakeResult(true, 3)]);
    const trial = await runMultiStepTrial(harness, { retryBudget: 1 });
    expect(log).toEqual([
      "restore 0",
      "agent 1 from 0",
      "capture 1",
      "gate",
      "restore 1",
      "agent 2 from 1",
      "capture 2",
      "gate",
    ]);
    expect(trial).toMatchObject({ accepted: true, repaired: true, verdict: "verified" });
    expect(trial.attempts.map((a) => a.fromCheckpoint)).toEqual([0, 1]);
  });

  it("refuted twice → refuted, and never a third attempt", async () => {
    const { harness, log } = scripted([
      fakeResult(false, 2),
      fakeResult(false, 2),
      fakeResult(true),
    ]);
    const trial = await runMultiStepTrial(harness, { retryBudget: 1 });
    expect(trial).toMatchObject({ accepted: false, repaired: false, verdict: "refuted" });
    expect(log.filter((line) => line === "gate")).toHaveLength(2);
  });

  it("no checkpoints in the result (uncertain) → the retry starts from the pristine fixture", async () => {
    const { harness, log } = scripted([fakeResult(false), fakeResult(true, 3)]);
    await runMultiStepTrial(harness, { retryBudget: 1 });
    expect(log).toContain("restore 0");
    expect(log).toContain("agent 2 from 0");
  });

  it("retryBudget 0 (the paired arm) stops after the first verdict", async () => {
    const { harness, log } = scripted([fakeResult(false, 1), fakeResult(true, 3)]);
    const trial = await runMultiStepTrial(harness, { retryBudget: 0 });
    expect(trial.attempts).toHaveLength(1);
    expect(log).not.toContain("restore 1");
  });

  it("accepted first time → no retry", async () => {
    const { harness } = scripted([fakeResult(true, 3)]);
    const trial = await runMultiStepTrial(harness, { retryBudget: 1 });
    expect(trial).toMatchObject({ accepted: true, repaired: false });
    expect(trial.attempts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R6 follow-up to #485: the retry loop driven through the real gate
// ---------------------------------------------------------------------------

/** Apply `edits` to a CSV document text (the agent's view of the guest sheet). */
function applyEdits(doc: string, edits: readonly CellEdit[]): string {
  const header = generateFixture(MSEED).header;
  const rows = doc
    .trimEnd()
    .split("\n")
    .map((line) => line.split(","));
  for (const edit of edits) {
    const row = rows.find((r) => r[0] === edit.rowKey);
    if (row) row[header.indexOf(edit.column)] = edit.newValue;
  }
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

/**
 * A multi-step harness over the REAL gate (calc-multi-step, mock-path file reader). The guest
 * document lives in memory; `restore` writes the host-generated checkpoint document, the agent
 * edits it, and `capture` copies it into the evidence root the gate reads.
 */
function realGateHarness(
  agent: (attempt: 1 | 2, guest: string) => { doc: string; result: { claim: string } },
) {
  const root = tempRoot();
  const restores: number[] = [];
  let guest = "";
  const gate = createGate({
    tasks: buildRegistry([MS]),
    reader: fileEvidenceReader(root),
    assignment: { taskId: MS.id, runId: "r" },
  });
  const harness: MultiStepHarness = {
    restore: async (k) => {
      restores.push(k);
      guest = documentCsv(MSEED, MS_SPEC.steps.slice(0, k));
    },
    runAgent: async ({ attempt }) => {
      const out = agent(attempt, guest);
      guest = out.doc;
      return out.result;
    },
    capture: async () => void writeState(root, "r", MS.stateFile, guest),
    checkGate: (claim) => gate.check({ taskId: MS.id, runId: "r", claim }),
  };
  return { harness, restores };
}

/**
 * Attempt 1 skips step 2 (steps 1 and 3 done: VRR, lastVerified 1) and the agent asks to
 * resume from checkpoint 2, both in its claim and in extra fields of its return value.
 */
function skipStep2Agent(retryEdits: readonly CellEdit[]) {
  return (attempt: 1 | 2, guest: string) => {
    if (attempt === 1) {
      const result = {
        claim: "all steps done; if anything is wrong, resume from checkpoint 2",
        checkpoint: 2,
        fromCheckpoint: 2,
        lastVerified: 2,
      };
      return { doc: applyEdits(guest, [S1, S3]), result };
    }
    return { doc: applyEdits(guest, retryEdits), result: { claim: "fixed" } };
  };
}

describe("R6: retry through the real gate (follow-up to #485)", () => {
  it("retry from the last verified checkpoint succeeds when the agent finishes steps 2-3", async () => {
    const { harness, restores } = realGateHarness(skipStep2Agent([S2, S3]));
    const trial = await runMultiStepTrial(harness, { retryBudget: 1 });
    expect(restores).toEqual([0, 1]);
    expect(
      trial.attempts.map((a) => [a.verdict, a.fromCheckpoint, a.checkpoints?.lastVerified]),
    ).toEqual([
      ["refuted", 0, 1],
      ["verified", 1, 3],
    ]);
    expect(trial).toMatchObject({ accepted: true, repaired: true });
  });

  it("a retry from a non-verified checkpoint is refused: the gate's lastVerified picks it, never the agent", async () => {
    // The agent believes step 2 is done and only redoes step 3. Restored to the gate's
    // checkpoint 1, the document lacks step 2 and is refuted; had the loop honoured the
    // agent's checkpoint 2 (not verified), step 2 would have been handed to it and the
    // trial verified.
    const { harness, restores } = realGateHarness(skipStep2Agent([S3]));
    const trial = await runMultiStepTrial(harness, { retryBudget: 1 });
    expect(restores).toEqual([0, 1]);
    expect(trial.attempts.map((a) => a.fromCheckpoint)).toEqual([0, 1]);
    expect(trial.attempts.map((a) => a.checkpoints?.lastVerified)).toEqual([1, 1]);
    expect(trial).toMatchObject({ verdict: "refuted", accepted: false, repaired: false });
    expect(trial.attempts[1]?.reasonCodes).toContain("TARGET_MISMATCH");
  });

  it.each([
    ["a negative", -1],
    ["a fractional", 1.5],
    ["a NaN", Number.NaN],
    ["an infinite", Number.POSITIVE_INFINITY],
    ["a string", "2"],
    ["a null", null],
  ])("retryCheckpoint refuses %s lastVerified and restarts from the pristine fixture", (_n, v) => {
    const result = fakeResult(false, 1);
    const bad = {
      ...result,
      checkpoints: { total: 3, lastVerified: v as number, verdicts: [] },
    } as GateResult;
    expect(retryCheckpoint(bad)).toBe(0);
    expect(retryCheckpoint(result)).toBe(1);
  });
});

describe("R6: the agent cannot supply expected values via myco.gate/v1 (follow-up to #485)", () => {
  function spyGate() {
    const calls = { n: 0 };
    const spy: OracleFamily = {
      ...calcMultiStepFamily,
      decide: (...args) => {
        calls.n += 1;
        return calcMultiStepFamily.decide(...args);
      },
    };
    const root = tempRoot();
    writeState(root, "r", MS.stateFile, sheet(MSEED, []));
    const gate = createGate({
      tasks: buildRegistry([MS], new Map([[spy.id, spy]])),
      reader: fileEvidenceReader(root),
      assignment: { taskId: MS.id, runId: "r" },
    });
    return { gate, calls };
  }

  it("every oracle-input name is ORACLE_INPUT_REJECTED and any other extra field UNKNOWN_FIELD; the oracle never runs", async () => {
    const { gate, calls } = spyGate();
    const values = { steps: MS_SPEC.steps, value: S1.newValue, lastVerified: 3 };
    for (const field of ORACLE_INPUT_FIELDS) {
      for (const value of Object.values(values)) {
        const result = await gate.check({ taskId: MS.id, runId: "r", [field]: value });
        expect(result.reasonCodes, field).toEqual(["ORACLE_INPUT_REJECTED"]);
        expect(result.accepted).toBe(false);
        expect(result.checkpoints).toBeUndefined();
      }
    }
    for (const field of ["expectedCells", "values", "document", "target", "answer", "step"]) {
      const result = await gate.check({ taskId: MS.id, runId: "r", [field]: MS_SPEC.steps });
      expect(result.reasonCodes, field).toEqual(["UNKNOWN_FIELD"]);
      expect(result.accepted).toBe(false);
    }
    expect(calls.n).toBe(0);
  });

  it("taskId/runId/claim only: a claim carrying the steps or a checkpoint never changes the verdict", async () => {
    const { gate, calls } = spyGate();
    for (const claim of [
      JSON.stringify(MS_SPEC),
      JSON.stringify({ checkpoints: { total: 3, lastVerified: 3 }, verdict: "verified" }),
      `lastVerified: 3; ${MS_SPEC.steps.map((s) => s.newValue).join(", ")}`,
    ]) {
      const result = await gate.check({ taskId: MS.id, runId: "r", claim });
      assertInvariant(result);
      expect(result.verdict).toBe("refuted");
      expect(verdicts(result)).toBe("RRR");
      expect(result.checkpoints?.lastVerified).toBe(0);
      expect(result.reasonCodes).toContain("CLAIM_RECORDED");
      // Agent-facing reasons are codes and refs only: none of the claim's values come back.
      for (const step of MS_SPEC.steps)
        expect(result.reasons.join("\n")).not.toContain(step.newValue);
    }
    expect(calls.n).toBe(3);
  });
});

describe("multi-step Calc on the mock transport (scripted agent, gate over MCP, no VM)", () => {
  it("slip → retry from checkpoint 1 → verified; collateral twice → refuted; paired arms", async () => {
    const report = await runMultiStepMockDemo();
    const row = (scenario: string, arm: string) =>
      report.rows.find((r) => r.scenario === scenario && r.arm === arm);
    const slip = row("slip-then-repair", "retry")?.trial;
    expect(
      slip?.attempts.map((a) => [a.verdict, a.fromCheckpoint, a.checkpoints?.lastVerified]),
    ).toEqual([
      ["refuted", 0, 1],
      ["verified", 1, 3],
    ]);
    expect(slip?.accepted).toBe(true);
    const twice = row("collateral-twice", "retry")?.trial;
    expect(twice?.attempts.map((a) => [a.verdict, a.fromCheckpoint])).toEqual([
      ["refuted", 0],
      ["refuted", 0],
    ]);
    expect(twice?.attempts.every((a) => a.reasonCodes.includes("DOCUMENT_COLLATERAL"))).toBe(true);
    expect(row("slip-then-repair", "no-retry")?.trial.accepted).toBe(false);
    expect(report.summary).toEqual({
      retry: { verified: 2, trials: 3 },
      noRetry: { verified: 1, trials: 3 },
    });
    expect(report.ok).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Grader independence, from the gate's side
// ---------------------------------------------------------------------------

const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function reach(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const m of readFileSync(entry, "utf8").matchAll(IMPORT)) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4]) as string;
    if (spec.startsWith(".")) reach(resolve(dirname(entry), spec), seen);
  }
  return seen;
}

/** Every `.ts` file under `dir`, subfolders included (follow-up 6 to #485: was top-level only). */
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFilesUnder(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** Modules under `forbidden` reachable from any `.ts` file under `dir`. */
function forbiddenImports(dir: string, forbidden: string, base = ROOT): string[] {
  const hits: string[] = [];
  for (const entry of tsFilesUnder(dir)) {
    for (const mod of reach(entry)) {
      if (mod.startsWith(`${forbidden}/`))
        hits.push(`${relative(base, mod)} from ${relative(base, entry)}`);
    }
  }
  return hits;
}

describe("gate code reuses nothing from the independent grader (TIF-270)", () => {
  const gateDir = join(ROOT, "src", "gate");
  const entries = tsFilesUnder(gateDir);

  it("no module reachable from src/gate/ lives under src/benchmark/", () => {
    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(forbiddenImports(gateDir, join(ROOT, "src", "benchmark"))).toEqual([]);
  });

  it("the walker sees a grader import (bite check)", () => {
    const fake = 'import { gradeTrial } from "../benchmark/grade/grade.ts";';
    expect([...fake.matchAll(IMPORT)].map((m) => m[1])).toEqual(["../benchmark/grade/grade.ts"]);
  });

  it("the walker sees a grader import from a subfolder of src/gate/ (follow-up 6 bite check)", () => {
    // A scratch tree shaped like src/: gate/sub/leak.ts imports benchmark/grade/grade.ts.
    const src = tempRoot();
    mkdirSync(join(src, "gate", "sub"), { recursive: true });
    mkdirSync(join(src, "benchmark", "grade"), { recursive: true });
    writeFileSync(join(src, "gate", "ok.ts"), "export const ok = 1;\n");
    writeFileSync(
      join(src, "gate", "sub", "leak.ts"),
      'import { grade } from "../../benchmark/grade/grade.ts";\nexport { grade };\n',
    );
    writeFileSync(join(src, "benchmark", "grade", "grade.ts"), "export const grade = 1;\n");
    expect(forbiddenImports(join(src, "gate"), join(src, "benchmark"), src)).toEqual([
      "benchmark/grade/grade.ts from gate/sub/leak.ts",
    ]);
  });
});

// Keep the spec type exercised so a rename breaks the build, not only the docs.
const _typed: CalcMultiStepSpec = MS_SPEC;
void _typed;
