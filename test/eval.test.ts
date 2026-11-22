import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEvaluation } from "../src/core/eval.ts";
import { FakeSpreadsheetApp } from "../src/fake/app.ts";
import { delayedSave, focusChange, invalidTarget, killApp } from "../src/fake/faults.ts";
import { cellVerifier, setCellFamily } from "../src/fake/tasks.ts";

function freshSheet(name: string): { dir: string; file: (trial: number) => string } {
  const dir = mkdtempSync(join(tmpdir(), `myco-eval-${name}-`));
  const file = (trial: number) => {
    const p = join(dir, `sheet-${trial}.csv`);
    writeFileSync(p, ",\n,\n,\n,\n");
    return p;
  };
  return { dir, file };
}

describe("eval harness", () => {
  it("reports a verified happy path over 3 clean trials", async () => {
    const { file } = freshSheet("happy");
    const summary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [{ name: "none" }],
      trials: 3,
      filePathFor: file,
    });
    expect(summary.trials).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.verified).toBe(3);
    expect(summary.falseSuccesses).toBe(0);
  });

  it("reports 0 false successes when every trial is corrupted with kill-app-before-save", async () => {
    const { file } = freshSheet("kill");
    const summary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [killApp()],
      trials: 5,
      filePathFor: file,
    });
    expect(summary.trials).toBe(5);
    expect(summary.falseSuccesses).toBe(0);
    for (const r of summary.results) {
      expect(r.verdict?.status === "verified").toBe(false);
    }
  });

  it("reports 0 false successes under delayed-save, focus-change, and invalid-target faults", async () => {
    const { file } = freshSheet("faults");
    const summary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [delayedSave(), focusChange(), invalidTarget(), { name: "none" }],
      trials: 4,
      filePathFor: file,
    });
    expect(summary.falseSuccesses).toBe(0);
    const cleanTrial = summary.results[3];
    expect(cleanTrial?.verdict?.status).toBe("verified");
    expect(cleanTrial?.groundTruthSatisfied).toBe(true);
    for (const r of summary.results.slice(0, 3)) {
      expect(r.falseSuccess).toBe(false);
    }
  });

  it("counts a verdict of verified with unsatisfied ground truth as a false success", async () => {
    const { file } = freshSheet("liar");
    const lyingVerifier = {
      verify: () => ({ status: "verified" as const, reasons: ["trust me"] }),
    };
    const summary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: lyingVerifier,
      family: setCellFamily,
      faults: [killApp()],
      trials: 2,
      filePathFor: file,
    });
    expect(summary.falseSuccesses).toBe(2);
  });

  it("writes trace.jsonl and result.json evidence per run", async () => {
    const { dir, file } = freshSheet("evidence");
    await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [{ name: "none" }],
      trials: 1,
      filePathFor: file,
      runsDir: join(dir, "runs"),
    });
    const runsDir = join(dir, "runs");
    const runIds = readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, "result.json")));
    expect(runIds).toHaveLength(1);
    const runDir = join(runsDir, runIds[0] as string);
    const traceLines = readFileSync(join(runDir, "trace.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(traceLines.length).toBeGreaterThan(0);
    const first = JSON.parse(traceLines[0] as string);
    expect(first.type).toBe("run-start");
    const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
    expect(result.steps.length).toBe(3);
    expect(result.verdict.status).toBe("verified");
    expect(result.verdict.score).toBe(1);
    expect(result.verdict.checks[0]?.passed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an uncertain verdict, not refuted, when the persisted file is deleted mid-run", async () => {
    const { file } = freshSheet("deleted");
    const summary = await runEvaluation({
      adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
      verifier: cellVerifier,
      family: setCellFamily,
      faults: [
        {
          name: "delete-persisted-file",
          afterProgram(ctx) {
            const p = file(ctx.trialIndex);
            if (existsSync(p)) rmSync(p);
          },
        },
      ],
      trials: 1,
      filePathFor: file,
    });
    const result = summary.results[0];
    expect(result?.verdict?.status).toBe("uncertain");
    expect(result?.verdict?.status).not.toBe("refuted");
    expect(summary.uncertain).toBe(1);
    expect(summary.falseSuccesses).toBe(0);
  });

  // chmod 000 does not block root, so the file stays readable and the fault never arms
  // (seen in the Claude cloud container, which runs as root). Skip there rather than
  // weaken the assertion.
  it.skipIf(process.getuid?.() === 0)(
    "returns an uncertain verdict when the persisted file is unreadable",
    async () => {
      const { file } = freshSheet("corrupt");
      const summary = await runEvaluation({
        adapterFor: (t) => new FakeSpreadsheetApp({ filePath: file(t) }),
        verifier: cellVerifier,
        family: setCellFamily,
        faults: [
          {
            name: "corrupt-persisted-file",
            afterProgram(ctx) {
              const p = file(ctx.trialIndex);
              writeFileSync(p, "garbage that parses as a blank cell");
              chmodSync(p, 0o000);
            },
          },
        ],
        trials: 1,
        filePathFor: file,
      });
      const result = summary.results[0];
      expect(result?.verdict?.status).toBe("uncertain");
      expect(result?.verdict?.status).not.toBe("refuted");
      expect(result?.verdict?.status).not.toBe("verified");
    },
  );
});
