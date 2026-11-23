import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunRecord, writeRunEvidence } from "../../src/core/evidence.ts";
import { taskText } from "../../src/tasks/task-text.ts";

/**
 * Instruction parity between the two arms (TIF-104).
 *
 * Myco's arm does **not** read a sentence — it executes `windowsProgramFor`, a
 * compiled guarded program. The screenshot baseline reads `taskText(params)`.
 * So "the same instruction" cannot mean the same prompt; it means the same
 * **job**, recorded as the same string on both sides.
 *
 * The defect this closes: Myco's program has always saved (an explicit
 * `isSave: true` step), while the baseline's task line omitted the save. The
 * arms were compared as if identical. arm-002 is recorded, not scored, for that
 * reason; arm-003 depends on this test passing.
 *
 * Enforcement is in two places:
 *  1. `src/integration/trial.ts` records `instruction: taskText(params)` on every
 *     Myco run, and `c1-trial.ts` records the same value on every baseline row.
 *  2. These tests pin both call sites so neither can drift unilaterally.
 */

const params = {
  fixtureSeed: "m1-013-live",
  rowKey: "EMP-0038",
  column: "name",
  newValue: "REVISED-908578",
};

const repoFile = (p: string) => join(process.cwd(), p);

describe("both arms render their instruction from one function", () => {
  it("Myco's runner calls taskText", () => {
    // The defect was that only the baseline rendered it. If this import or call
    // is removed, Myco's arm stops recording a comparable instruction and
    // arm-003's comparison loses its footing.
    const trial = readFileSync(repoFile("src/integration/trial.ts"), "utf8");
    expect(trial).toContain('from "../tasks/task-text.js"');
    expect(trial).toContain("instruction: taskText(options.params)");
  });

  it("the baseline runner calls taskText", () => {
    const c1 = readFileSync(repoFile("src/baseline/c1-trial.ts"), "utf8");
    expect(c1).toContain('from "../tasks/task-text.ts"');
    expect(c1).toContain("instruction: taskText(target.params)");
  });

  it("both call sites pass the same parameter shape", () => {
    // Same function, so the only way the strings can differ is a different
    // argument. Both pass the trial's params object directly.
    expect(readFileSync(repoFile("src/integration/trial.ts"), "utf8")).toContain(
      "taskText(options.params)",
    );
    expect(readFileSync(repoFile("src/baseline/c1-trial.ts"), "utf8")).toContain(
      "taskText(target.params)",
    );
  });

  it("renders one canonical string, so equal params give equal text", () => {
    // The string both arms persist for the same params.
    expect(taskText(params)).toBe(
      'Set the cell at record EMP-0038, column name, to "REVISED-908578", and save the file.',
    );
  });

  it("the instruction both arms record requires the save", () => {
    // This is the property arm-002 lacked. Myco's program saves as a step; the
    // baseline must be told to. If either side drops it, the comparison is
    // invalid again.
    expect(taskText(params)).toContain("save the file");
  });
});

describe("the recorded instruction reaches the artifact", () => {
  it("Myco's evidence record carries the field", () => {
    // `additionalProperties: false` in the schema means an undeclared field
    // would fail validation, so the schema must list it too.
    expect(readFileSync(repoFile("src/core/evidence.ts"), "utf8")).toContain(
      "instruction?: string",
    );
    const schema = readFileSync(repoFile("schemas/result-record.ts"), "utf8");
    expect(schema).toContain('instruction: { type: "string" }');
  });

  it("the baseline row carries the field", () => {
    expect(readFileSync(repoFile("src/baseline/index.ts"), "utf8")).toContain(
      "instruction?: string",
    );
  });

  it("the writer does not drop it", () => {
    const trial = readFileSync(repoFile("src/integration/trial.ts"), "utf8");
    expect(trial).toContain("input.instruction");
  });

  it("an absent instruction stays absent rather than being fabricated", () => {
    // Discovery's live runner has no sentence; it must omit the field, not
    // invent one. Optional in the type, and the writer spreads conditionally.
    const trial = readFileSync(repoFile("src/integration/trial.ts"), "utf8");
    expect(trial).toContain(
      "input.instruction === undefined ? {} : { instruction: input.instruction }",
    );
  });

  it("the schema is not strict about the field, so older records still validate", () => {
    // Not in `required` — records written before this change remain valid.
    const schema = readFileSync(repoFile("schemas/result-record.ts"), "utf8");
    const required = schema.slice(schema.indexOf("required: ["));
    expect(required.slice(0, 200)).not.toContain('"instruction"');
  });
});

describe("the two runs this task exists for", () => {
  it("arm-002's recorded rows are the ones that lacked parity", () => {
    // Guards the analysis in docs/research/experiments/c1-arm-002/FINAL.md:
    // if that evidence is deleted, the reason arm-003 exists is no longer
    // checkable from the repo.
    const p = "docs/research/experiments/c1-arm-002/FINAL.md";
    expect(existsSync(repoFile(p))).toBe(true);
    expect(readFileSync(repoFile(p), "utf8")).toContain("save");
  });
});

describe("the recorded instruction survives a real round trip", () => {
  // Behaviour-level, not a source pin. The call-site assertions above are
  // refactor-brittle; this drives the actual writer and reads the bytes back, so
  // a change that keeps the literal `taskText(...)` in source while dropping the
  // value is still caught.
  const record = (instruction?: string): RunRecord =>
    ({
      runId: "11111111-2222-3333-4444-555555555555",
      taskId: "calc-record-edit",
      taskParams: { rowKey: "EMP-0001", column: "name", newValue: "REVISED-1" },
      ...(instruction === undefined ? {} : { instruction }),
      startedAt: new Date(0).toISOString(),
      steps: [],
      verdict: {
        status: "verified",
        checks: [
          {
            name: "cell-persisted",
            passed: true,
            reason: "persisted value matches intent",
            partial_score: { score: 1, weight: 1 },
          },
        ],
        score: 1,
        reasons: [],
      },
    }) as RunRecord;

  it("writes the instruction to result.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-parity-"));
    const runDir = writeRunEvidence(join(dir, "runs"), record(taskText(params)), []);
    const written = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
    expect(written.instruction).toBe(taskText(params));
    expect(written.instruction).toContain("save the file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes no key at all when there is no instruction", () => {
    const dir = mkdtempSync(join(tmpdir(), "myco-parity-"));
    const runDir = writeRunEvidence(join(dir, "runs"), record(), []);
    const raw = readFileSync(join(runDir, "result.json"), "utf8");
    expect(JSON.parse(raw).instruction).toBeUndefined();
    // Absent, not null or empty string.
    expect(raw).not.toContain('"instruction"');
    rmSync(dir, { recursive: true, force: true });
  });
});
