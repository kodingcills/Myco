import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCsvSpreadsheet } from "../src/core/filepersist.ts";
import type { TaskIntent } from "../src/core/verify.ts";
import { cellVerifier } from "../src/fake/tasks.ts";

function sheetPath(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-verify-"));
  const filePath = join(dir, "sheet.csv");
  writeFileSync(filePath, content);
  return filePath;
}

function intentFor(cell: string, value: string, trial = 0): TaskIntent {
  return { taskId: "fake-set-cell", params: { cell, value, trial }, describe: "" };
}

describe("verifier independence", () => {
  it("refutes, never verifies, when the adapter claimed success but the file lacks the edit", () => {
    const persisted = readCsvSpreadsheet(sheetPath("h1,h2\nv1,\n"));
    const verdict = cellVerifier.verify(persisted, intentFor("B2", "hello"));
    expect(verdict.status).toBe("refuted");
    expect(verdict.status).not.toBe("verified");
    expect(verdict.reasons.join(" ")).toContain("B2");
  });

  it("refutes when the persisted value differs from the intent", () => {
    const persisted = readCsvSpreadsheet(sheetPath("h1,h2\nv1,WRONG\n"));
    const verdict = cellVerifier.verify(persisted, intentFor("B2", "hello"));
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("WRONG");
  });

  it("verifies only when the persisted file independently contains the intended value", () => {
    const persisted = readCsvSpreadsheet(sheetPath("h1,h2\nv1,hello\n"));
    const verdict = cellVerifier.verify(persisted, intentFor("B2", "hello"));
    expect(verdict.status).toBe("verified");
  });

  it("reads B2 from row 2, column 2 of a CSV", () => {
    const persisted = readCsvSpreadsheet(sheetPath("h1,h2\nv1,expected\n"));
    expect(persisted.cells.B2).toBe("expected");
  });
});
