/**
 * R5 oracle self-test subjects for the cross-app family (capability track P, tier 2).
 *
 * The gate's `cross-app-steps` oracle decides each step's checkpoint from that step's
 * snapshot. Here it is plugged in as two oracles under test, one per document a step can
 * edit, each called through the family's real `decide` exactly as the gate calls it:
 *  - `cross-app/calc-step`: the saved document is a calc step's sheet snapshot (CSV);
 *  - `cross-app/writer-step`: the saved document is a writer step's report snapshot (text).
 * Every other snapshot of the trial is the correct one, so a case tests the step's oracle and
 * nothing else. The adapter follows the gate's contract (`src/gate/gate.ts`): a missing file
 * is `uncertain` (STATE_MISSING), and a `decide` that throws is `uncertain`.
 *
 * Classes claimed (the container classes `partial-save` / `missing-main-part` do not apply to
 * CSV or plain text, so they are not claimed and not run): edit-missing, wrong-value,
 * wrong-target, collateral, truncated, corrupt-byte, missing-file.
 *
 * Kept out of `report.ts` (the committed R5 report) so this track stays additive; its own
 * test runs the same `runSelfTest` and holds it to the same bar
 * (`test/cross-app/oracle-selftest.test.ts`).
 */

import { crossAppFamily } from "../gate/cross-app.ts";
import { nearMiss } from "../gate/cross-app-demo.ts";
import {
  type CrossAppSpec,
  crossAppEvidenceFiles,
  crossAppSpecFor,
  END_DIR,
  editsThrough,
  fieldLabel,
  noticePdf,
  REPORT_FILE,
  reportAt,
  reportText,
  SHEET_FILE,
  sheetAt,
  sourceLines,
  stepDir,
} from "../tasks/cross-app.ts";
import { flippedByte, truncated } from "../tasks/writer-docgen.ts";
import type { CorruptionClass, OracleUnderTest, SavedDocument, SelfTestCase } from "./types.ts";

export interface CrossAppStepIntent {
  readonly spec: CrossAppSpec;
  /** The step whose snapshot the saved document is (1-based). */
  readonly step: number;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

const CLAIMS = new Set<CorruptionClass>([
  "edit-missing",
  "wrong-value",
  "wrong-target",
  "collateral",
  "truncated",
  "corrupt-byte",
  "missing-file",
]);

/** Every snapshot of a correct trial, with the step's own document replaced by `doc`. */
function verifyStep(doc: SavedDocument, intent: CrossAppStepIntent) {
  if (doc.bytes === null) return { status: "uncertain" as const, code: "state-missing" };
  const { spec, step } = intent;
  const n = spec.steps.length;
  const states = new Map<string, Uint8Array>();
  for (const file of crossAppEvidenceFiles(n)) {
    const [dir, name] = file.split("/") as [string, string];
    const k = dir === END_DIR ? n : Number(dir.slice("step-".length));
    states.set(file, utf8(name === SHEET_FILE ? sheetAt(spec, k) : reportAt(spec, k)));
  }
  const own = spec.steps[step - 1]?.app === "calc" ? SHEET_FILE : REPORT_FILE;
  states.set(`${stepDir(step)}/${own}`, doc.bytes);
  try {
    const out = crossAppFamily.decide(
      states.get(`${END_DIR}/${SHEET_FILE}`) as Uint8Array,
      spec,
      "oracle-selftest",
      {
        fixture: utf8(noticePdf(sourceLines(spec))),
        states,
      },
    );
    const code =
      out.status === "verified"
        ? "postcondition-holds"
        : out.status === "refuted"
          ? `${(out.codes ?? []).join("+") || "refuted"}@checkpoint-${(out.checkpoints?.findIndex((c) => c.verdict === "refuted") ?? -2) + 1}`
          : "oracle-uncertain";
    return { status: out.status, code };
  } catch (error) {
    return {
      status: "uncertain" as const,
      code: (error as Error)?.name === "StateCorruptError" ? "state-corrupt" : "oracle-threw",
    };
  }
}

export const crossAppCalcStepOracle: OracleUnderTest<CrossAppStepIntent> = {
  name: "cross-app/calc-step",
  version: `gate-family-${crossAppFamily.version}`,
  claims: CLAIMS,
  verify: verifyStep,
};

export const crossAppWriterStepOracle: OracleUnderTest<CrossAppStepIntent> = {
  name: "cross-app/writer-step",
  version: `gate-family-${crossAppFamily.version}`,
  claims: CLAIMS,
  verify: verifyStep,
};

/** Set cells of a CSV by (row key, column). */
function editSheet(csv: string, edits: ReadonlyArray<readonly [string, string, string]>): string {
  const rows = csv
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.split(","));
  const header = rows[0] as string[];
  for (const [rowKey, column, value] of edits) {
    const col = header.indexOf(column);
    const row = rows.findIndex((r, i) => i > 0 && r[0] === rowKey);
    if (col < 1 || row < 1) throw new Error(`self-test sheet has no ${rowKey}/${column}`);
    (rows[row] as string[])[col] = value;
  }
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

const SEEDS = ["xa-selftest-1", "xa-selftest-2", "xa-selftest-3"];

function caseDoc(fileName: string, text: string | null): SavedDocument {
  return { fileName, bytes: text === null ? null : utf8(text) };
}

function corruptions(
  fileName: string,
  correct: string,
  values: {
    readonly missing: string;
    readonly wrongValue: string;
    readonly wrongTarget: string;
    readonly collateral: string;
  },
): SelfTestCase<CrossAppStepIntent>["corruptions"] {
  const bytes = utf8(correct);
  return [
    { cls: "edit-missing", doc: caseDoc(fileName, values.missing) },
    { cls: "wrong-value", doc: caseDoc(fileName, values.wrongValue) },
    { cls: "wrong-target", doc: caseDoc(fileName, values.wrongTarget) },
    { cls: "collateral", doc: caseDoc(fileName, values.collateral) },
    { cls: "truncated", doc: { fileName, bytes: truncated(bytes, 0.5) } },
    {
      cls: "corrupt-byte",
      doc: { fileName, bytes: flippedByte(bytes, Math.floor(bytes.length / 2)) },
    },
    { cls: "missing-file", doc: caseDoc(fileName, null) },
  ];
}

/** Calc-step cases: steps 1 and 2 of every seed's task. */
export function crossAppCalcStepCases(): SelfTestCase<CrossAppStepIntent>[] {
  const cases: SelfTestCase<CrossAppStepIntent>[] = [];
  for (const seed of SEEDS) {
    const spec = crossAppSpecFor(seed);
    spec.steps.forEach((step, i) => {
      if (step.app !== "calc") return;
      const k = i + 1;
      const edit = step.edits[0] as (typeof step.edits)[number];
      const before = sheetAt(spec, k - 1);
      const correct = sheetAt(spec, k);
      // A record no calc step targets: the neighbour for wrong-target, the victim for collateral.
      const targeted = new Set(editsThrough(spec, spec.steps.length).calc.map((e) => e.rowKey));
      const other = before
        .split("\n")
        .slice(1)
        .map((line) => line.split(",")[0] as string)
        .find((key) => key !== "" && !targeted.has(key)) as string;
      cases.push({
        id: `xa-calc-${seed}-step${k}`,
        intent: { spec, step: k },
        correct: caseDoc(SHEET_FILE, correct),
        corruptions: corruptions(SHEET_FILE, correct, {
          missing: before,
          wrongValue: editSheet(before, [[edit.rowKey, edit.column, nearMiss(edit.newValue)]]),
          wrongTarget: editSheet(before, [[other, edit.column, edit.newValue]]),
          collateral: editSheet(correct, [[other, "name", "Collateral Edit"]]),
        }),
      });
    });
  }
  return cases;
}

/** Writer-step cases: step 3 of every seed's task. */
export function crossAppWriterStepCases(): SelfTestCase<CrossAppStepIntent>[] {
  const cases: SelfTestCase<CrossAppStepIntent>[] = [];
  for (const seed of SEEDS) {
    const spec = crossAppSpecFor(seed);
    spec.steps.forEach((step, i) => {
      if (step.app !== "writer") return;
      const k = i + 1;
      const [first, second] = step.edits;
      if (first === undefined || second === undefined) throw new Error("writer step needs 2 edits");
      const earlier = editsThrough(spec, k - 1).writer;
      const fill = (pairs: ReadonlyArray<readonly [string, string]>) =>
        reportText(
          spec,
          new Map([...earlier.map((e) => [fieldLabel(e), e.newValue] as const), ...pairs]),
        );
      const correct = reportAt(spec, k);
      cases.push({
        id: `xa-writer-${seed}-step${k}`,
        intent: { spec, step: k },
        correct: caseDoc(REPORT_FILE, correct),
        corruptions: corruptions(REPORT_FILE, correct, {
          missing: reportAt(spec, k - 1),
          wrongValue: fill([
            [fieldLabel(first), nearMiss(first.newValue)],
            [fieldLabel(second), second.newValue],
          ]),
          // The first field's value written on the second field's line, the first left empty.
          wrongTarget: fill([[fieldLabel(second), first.newValue]]),
          collateral: correct.replace(`Sheet: ${SHEET_FILE}`, `Sheet: ${SHEET_FILE} (draft)`),
        }),
      });
    });
  }
  return cases;
}
