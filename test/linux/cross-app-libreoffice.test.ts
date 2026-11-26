/**
 * Capability track P (tier 2), acceptance item 5: the cross-app task end to end on the Linux
 * headless LibreOffice path (no VM, no model, $0). A scripted agent reads the source notice
 * (PDF), types into a real headless Calc (CSV, stored in place) and a real headless Writer
 * (plain text, stored in place), the harness snapshots both documents after every step, and
 * the real gate decides each checkpoint from those persisted bytes. The independent grader
 * grades the same evidence and must agree.
 *
 * Scenarios (`CROSS_APP_SCENARIOS`): a correct run verifies; a wrong value at step 1, 2 and
 * 3, and collateral damage at a calc and at a writer step, are refuted at the right step
 * with the right code; an earlier failure repaired by a later step stays refuted (no
 * masking); one retry from the last verified checkpoint repairs a slip, and never a third
 * attempt.
 *
 * Opt-in like `linux-path.test.ts`: runs only with MYCO_LINUX_PATH=1 or
 * MYCO_LINUX_PATH_REQUIRED=1 (each scenario starts several soffice processes). Skips cleanly
 * without soffice, Python-UNO or Writer, except under MYCO_LINUX_PATH_REQUIRED=1 (the `linux
 * path` CI job), where a missing prerequisite FAILS so the suite cannot pass by skipping.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pythonBinary, pythonUnoAvailable } from "../../src/linux/actuator.ts";
import {
  libreOfficeCrossAppActuator,
  WRITER_ACTUATOR_SCRIPT,
} from "../../src/linux/cross-app-actuator.ts";
import { sofficeBinary, sofficeVersion } from "../../src/linux/soffice.ts";
import { buildXaTaskSet, type XaTask } from "../../src/tasks/cross-app-taskset.ts";
import { gradeTrial, runAll } from "../cross-app/helpers.ts";

const required = process.env.MYCO_LINUX_PATH_REQUIRED === "1";
const optedIn = required || process.env.MYCO_LINUX_PATH === "1";

/** Writer is a separate package from Calc on Debian/Ubuntu: probe it with the actuator. */
function writerAvailable(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "myco-writer-probe-"));
  try {
    const doc = join(dir, "probe.txt");
    writeFileSync(doc, "Probe:\n");
    const r = spawnSync(
      pythonBinary(),
      [
        WRITER_ACTUATOR_SCRIPT,
        "--doc",
        doc,
        "--label",
        "Probe:",
        "--text",
        " ok",
        "--soffice",
        sofficeBinary(),
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    return r.status === 0 && readFileSync(doc, "utf8").includes("Probe: ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sofficeOk = optedIn && sofficeVersion() !== null;
const unoOk = sofficeOk && pythonUnoAvailable();
const writerOk = unoOk && writerAvailable();
const available = optedIn && sofficeOk && unoOk && writerOk;

/** The xa-v1 task whose edits cover the date and currency columns (Calc's rewriting risks). */
const TASK = (() => {
  const { tasks } = buildXaTaskSet();
  const typed = (t: XaTask) =>
    new Set(t.spec.steps.flatMap((s) => s.edits.map((e) => e.column))).has("joined") &&
    new Set(t.spec.steps.flatMap((s) => s.edits.map((e) => e.column))).has("salary");
  return tasks.find(typed) ?? (tasks[0] as XaTask);
})();

describe("prerequisites", () => {
  it.runIf(required)(
    "soffice, Python-UNO and Writer are installed (MYCO_LINUX_PATH_REQUIRED=1)",
    () => {
      expect(sofficeOk, "soffice --version").toBe(true);
      expect(unoOk, "python3 -c 'import uno'").toBe(true);
      expect(writerOk, "headless Writer opens, edits and stores a text report").toBe(true);
    },
  );
});

describe.skipIf(!available)("cross-app task against real headless Calc and Writer", () => {
  const root = mkdtempSync(join(tmpdir(), "myco-cross-app-lo-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(`${TASK.taskId}: every scenario gets its expected verdict, checkpoint and code; the grader agrees`, async () => {
    const runs = await runAll(TASK, libreOfficeCrossAppActuator(), root);
    for (const run of runs) {
      expect(run.actuator).toBe("libreoffice");
      expect(run.mismatches, run.scenario).toEqual([]);
      const last = run.results[run.results.length - 1];
      const grade = gradeTrial(TASK, join(root, "evidence", run.runId));
      expect(grade.status, `${run.scenario}: ${grade.reasons.join("; ")}`).toBe(
        run.trial.accepted ? "pass" : "fail",
      );
      if (!run.trial.accepted)
        expect(grade.firstFailure, run.scenario).toBe((last?.checkpoints?.lastVerified ?? -1) + 1);
    }
    // Writer stored the report with its own filter (a leading BOM): real bytes, not the fake's.
    const report = readFileSync(join(root, "evidence", "xa-clean", "end", "report.txt"));
    expect([...report.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  }, 600_000);
});
