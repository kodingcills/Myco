/**
 * TIF-270 round 3 (D2): the gate's whole-document Calc check (`calc-record-edit` v2) and the
 * independent grader (`src/benchmark/grade/`) must agree on every document of the round-2
 * verifier's probe set. Both read the same bytes: the gate through `createGate` and the
 * mock-path file reader, the grader through `grade()`.
 *
 * Trailing rows with no content (blank lines, CRLF blank lines, `,,,,` rows at the end) are
 * no content to both, like a trailing empty column; interior blank or all-empty rows shift
 * the records below them and fail both. A trailing row WITH content (`,,x,,`, a blank line
 * then `x`, or a cell holding only whitespace) is an added cell: refuted with
 * DOCUMENT_COLLATERAL by the gate and failed by the grader (round-3 S-1, follow-up to #485).
 *
 * Two rows are KNOWN DIVERGENCES, pinned here on purpose (false refutes, never a false
 * done): an RFC 4180 quoted target and CR-only line endings. The grader parses RFC 4180 and
 * splits on CR; the gate's strict parse does neither (documented in
 * `src/gate/calc-document.ts` and `docs/gate/api.md`, "Row structure"). If either is ever
 * fixed, its pin fails and moves to the agreeing rows.
 *
 * The probe table lives in `calc-probes.ts`; `xlsx-parity.test.ts` runs the same table
 * through the gate's xlsx path (TIF-274 prerequisite).
 */
import { describe, expect, it } from "vitest";
import { grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { AGREE, COLUMN_TYPES, INTENT, KNOWN_DIVERGENCES, SEED, SPEC } from "./calc-probes.ts";
import { tempRoot, writeState } from "./helpers.ts";

async function gateVerdict(csv: string) {
  const root = tempRoot();
  writeState(root, "r", "sheet.csv", csv);
  return createGate({
    tasks: buildRegistry([
      { id: "probe", family: "calc-record-edit", stateFile: "sheet.csv", spec: SPEC },
    ]),
    reader: fileEvidenceReader(root),
    assignment: { taskId: "probe", runId: "r" },
  }).check({ taskId: "probe", runId: "r" });
}

function graderStatus(csv: string) {
  const fixtureCsv = Buffer.from(generateFixture(SEED).csv);
  return grade({
    fixtureCsv,
    fixtureSha256: sha256(fixtureCsv),
    persisted: { format: "csv", bytes: Buffer.from(csv) },
    intent: INTENT,
    columnTypes: COLUMN_TYPES,
  }).status;
}

describe("gate and grader agree on the round-2 verifier's probe set (round-3 D2)", () => {
  it.each(AGREE.map((p) => [p.name, p] as const))("%s", async (_name, probe) => {
    const result = await gateVerdict(probe.csv);
    const status = graderStatus(probe.csv);
    expect({ gate: result.verdict, grader: status }).toEqual({
      gate: probe.gate,
      grader: probe.grader,
    });
    // The agreement itself, stated directly: verified exactly when the grader passes.
    expect(result.verdict === "verified").toBe(status === "pass");
    if (result.verdict === "refuted") expect(result.reasonCodes).toContain("DOCUMENT_COLLATERAL");
  });

  it.each(KNOWN_DIVERGENCES.map((p) => [p.name, p] as const))(
    'KNOWN DIVERGENCE (false refute, documented in docs/gate/api.md "Row structure"): %s',
    async (_name, probe) => {
      const result = await gateVerdict(probe.csv);
      expect(result.verdict).toBe(probe.gate);
      expect(result.accepted).toBe(false);
      expect(graderStatus(probe.csv)).toBe(probe.grader);
    },
  );
});
