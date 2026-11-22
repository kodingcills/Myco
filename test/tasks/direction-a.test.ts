import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerRowSchema } from "../../schemas/ledger-row.ts";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { loadTaskPackage, runDirectionATask } from "../../src/foundry/grader/direction-a-runner.ts";

describe("Direction A: Verified GUI Task Package & Runner", () => {
  it("parses tasks/todo-save.yaml cleanly", () => {
    const yamlPath = join(process.cwd(), "tasks/todo-save.yaml");
    expect(existsSync(yamlPath)).toBe(true);

    const taskPkg = loadTaskPackage(yamlPath);
    expect(taskPkg.name).toBe("todo-save");
    expect(taskPkg.version).toBe(1);
    expect(taskPkg.app).toBe("dogfood/apps/myco-todo");
    expect(taskPkg.desktop).toBe("linux-x11");
    expect(taskPkg.task).toBe("ef-t01-add-four-items");
    expect(taskPkg.fixture).toBe("ef-todo-silent-drop-v1");
    expect(taskPkg.intent.items).toHaveLength(4);
    expect(taskPkg.intent.items).toContain("bug: login page crashes on save");
    expect(taskPkg.intent.items).toContain("BUG: token expires too early");
  });

  it("executes tasks/todo-save.yaml, detects false success, and produces valid evidence", async () => {
    const yamlPath = join(process.cwd(), "tasks/todo-save.yaml");
    const taskPkg = loadTaskPackage(yamlPath);

    const result = await runDirectionATask(taskPkg, "runs", {
      captureScreenshots: true,
      packageArchive: true,
    });

    // Core Direction A / MVD-001 assertion:
    // Status bar claimed "saved 4 item(s)", but 2 items starting with BUG were silently dropped.
    // Myco MUST refute the run and catch the false success!
    expect(result.verdict).toBe("refuted");
    expect(result.falseSuccess).toBe(true);
    expect(result.exitCode).toBe(1);
    // Screenshot-free assertion, as amended when the fixture gained an untouched control
    // row: four new items were attempted, and the lists below say what happened to them.
    expect(result.itemsAttempted).toHaveLength(4);
    // Store has 2 seed items + an untouched control row + 2 new items = 5 total.
    // The control row is persisted with its stored text; the two new BUG items are not.
    expect(result.itemsPersisted).toHaveLength(5);
    expect(result.itemsMissing).toHaveLength(2);
    expect(result.itemsMissing).toEqual([
      "bug: login page crashes on save",
      "BUG: token expires too early",
    ]);
    expect(result.appStatusClaim).toBe("saved 7 item(s)");

    // Check evidence files on disk
    const runDir = result.runDir;
    expect(existsSync(join(runDir, "trace.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, "trace.extended.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, "result.json"))).toBe(true);
    expect(existsSync(join(runDir, "ledger.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
    expect(existsSync(result.archivePath)).toBe(true);

    // Validate result.json schema
    const resultRecord = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
    const resultIssues = validateSchema(resultRecord, resultRecordSchema);
    expect(resultIssues).toEqual([]);
    expect(resultRecord.verdict.status).toBe("refuted");
    expect(resultRecord.verdict.score).toBe(0.5);
    expect(resultRecord.verdict.checks).toHaveLength(4);

    // Validate trace.jsonl schema
    const traceLines = readFileSync(join(runDir, "trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(traceLines.length).toBeGreaterThan(10);
    for (const line of traceLines) {
      const issues = validateSchema(line, traceEventSchema);
      expect(issues).toEqual([]);
    }

    // Validate trace.extended.jsonl has claim events
    const extendedLines = readFileSync(join(runDir, "trace.extended.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const claimEvents = extendedLines.filter((l) => l.type === "claim");
    expect(claimEvents.length).toBe(5); // 1 app-ui status claim + 4 agent item claims

    // Validate ledger.jsonl schema
    const ledgerLines = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(ledgerLines).toHaveLength(1);
    expect(validateSchema(ledgerLines[0], ledgerRowSchema)).toEqual([]);
    expect(ledgerLines[0].oracle).toBe("ground-truth:false");

    // Validate manifest.json completeness
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    expect(manifest.format).toBe("mycotrace/1");
    expect(manifest.runId).toBe(result.runId);
    expect(manifest.files["trace.jsonl"]).toBeDefined();
    expect(manifest.files["trace.extended.jsonl"]).toBeDefined();
    expect(manifest.files["result.json"]).toBeDefined();
    expect(manifest.files["ledger.jsonl"]).toBeDefined();

    // Validate step screenshots in artifacts/
    for (let s = 0; s <= 5; s++) {
      expect(manifest.files[`artifacts/step-${s}.png`]).toBeDefined();
      expect(manifest.files[`artifacts/step-${s}-meta.json`]).toBeDefined();
      expect(existsSync(join(runDir, `artifacts/step-${s}.png`))).toBe(true);
      expect(existsSync(join(runDir, `artifacts/step-${s}-meta.json`))).toBe(true);
    }
  });
});
