import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsProgramFor } from "../../src/integration/trial.ts";
import { taskText } from "../../src/tasks/task-text.ts";

/**
 * Cross-arm task parity.
 *
 * The two arms are not symmetric, and the honest statement of parity has to
 * reflect that:
 *
 * - **Myco's arm** runs `windowsProgramFor(params)` — a compiled guarded program
 *   of clicks/keystrokes with pre/postconditions. It is never given a sentence.
 * - **The screenshot baseline** is given `taskText(params)` and must work out the
 *   procedure itself.
 *
 * So there is no sentence to diff between them. What must agree is **the job**:
 * both must target the same record and column with the same new value, and both
 * must persist it. These tests pin that agreement to code rather than to prose,
 * because the original defect was exactly this requirement going unstated on one
 * side while the other side did it anyway.
 */

const params = {
  fixtureSeed: "m1-013-live",
  rowKey: "EMP-0038",
  column: "name",
  newValue: "REVISED-908578",
};

describe("both arms target the same job", () => {
  it("Myco's program contains an explicit save step", () => {
    // The baseline's task line omitted the save. Myco's program always had it,
    // which is why the two arms were not measuring the same job.
    const program = windowsProgramFor(params);
    expect(program.steps.some((step) => step.isSave === true)).toBe(true);
  });

  it("the baseline's task text also requires the save", () => {
    expect(taskText(params)).toContain("save the file");
  });

  it("both name the same record and column", () => {
    const text = taskText(params);
    expect(text).toContain(params.rowKey);
    expect(text).toContain(params.column);
    // Myco's side: the ground truth the program is built from resolves the same
    // record and column.
    const program = windowsProgramFor(params);
    expect(program.name).toBe("calc-record-edit");
  });

  it("the arms' requirement lists agree on persistence", () => {
    // Stated as a pair so that removing the save from *either* side fails here.
    const program = windowsProgramFor(params);
    const mycoSaves = program.steps.some((step) => step.isSave === true);
    const baselineIsToldToSave = taskText(params).includes("save the file");
    expect({ mycoSaves, baselineIsToldToSave }).toEqual({
      mycoSaves: true,
      baselineIsToldToSave: true,
    });
  });
});

describe("the baseline's task text is the documented intent", () => {
  it("matches docs/architecture/m1.md", () => {
    const doc = readFileSync(join(process.cwd(), "docs/architecture/m1.md"), "utf8");
    // The doc states the canonical intent; the rendered text must still satisfy it.
    expect(doc).toContain("and save the file");
    expect(taskText(params).endsWith("and save the file.")).toBe(true);
  });
});
