/**
 * Track R on the Linux path, with a REAL LibreOffice Calc (headless): Calc's own UNO
 * listeners record a scripted "human" demonstration, the compiler builds the workflow and
 * derived oracle, and the workflow replays through Calc on a fresh fixture, verified by the
 * gate and graded by the independent grader. $0: no model, no network.
 *
 * Opt-in, like test/linux/linux-path.test.ts: it runs with MYCO_LINUX_PATH=1 (skips when
 * soffice or Python-UNO is missing) or MYCO_LINUX_PATH_REQUIRED=1 (fails when missing).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pythonUnoAvailable } from "../../src/linux/actuator.ts";
import { sofficeVersion } from "../../src/linux/soffice.ts";
import { compileRecording } from "../../src/recording/compile.ts";
import { calcRecorderSource, calcReplayActuator } from "../../src/recording/linux-calc.ts";
import { recordDemonstration, serializeRecording } from "../../src/recording/recorder.ts";
import { replayWorkflow } from "../../src/recording/replay.ts";
import { cellFor } from "../../src/recording/scripted-human.ts";
import { ALL_MARKERS, fixtureBytes, operator, PLANTED_KEY } from "./helpers.ts";

const required = process.env.MYCO_LINUX_PATH_REQUIRED === "1";
const optedIn = required || process.env.MYCO_LINUX_PATH === "1";
const available = optedIn && sofficeVersion() !== null && pythonUnoAvailable();
const TIMEOUT = 180_000;

const work = mkdtempSync(join(tmpdir(), "myco-track-r-calc-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("track R with real Calc (opt-in)", () => {
  it.runIf(required)("soffice and Python-UNO are installed (MYCO_LINUX_PATH_REQUIRED=1)", () => {
    expect(available).toBe(true);
  });

  it.runIf(available)(
    "record via Calc's listeners, compile, replay via Calc on a fresh fixture: VERIFIED + PASS",
    async () => {
      const demo = fixtureBytes("track-r-calc-demo");
      const docPath = join(work, "demo.csv");
      writeFileSync(docPath, demo);
      const cell = cellFor(demo, "EMP-0004", "name");
      const rec = await recordDemonstration(
        calcRecorderSource({
          docPath,
          headless: true,
          script: [{ do: "type", cell, text: "Calc Recorded" }, { do: "save" }],
        }),
        {
          start: operator,
          indicator: () => {},
          before: demo,
          simulated: true,
          recordingId: "rec-calc",
        },
      );
      // App-level capture from Calc itself, and the file Calc saved.
      expect(rec.actions).toEqual([
        { seq: 1, kind: "cell-edit", source: "app", cell, value: "Calc Recorded" },
        { seq: 2, kind: "save", source: "app" },
      ]);
      // The CSV round-trips exactly apart from the edit (columns loaded as text).
      const changed = rec.after.rows.flatMap((row, r) =>
        row.flatMap((v, c) => (v !== rec.before.rows[r]?.[c] ? [`${r},${c}`] : [])),
      );
      expect(changed).toEqual(["4,1"]);
      const text = serializeRecording(rec);
      expect(text).not.toContain(work);

      const compiled = compileRecording(rec);
      const fresh = fixtureBytes("track-r-calc-fresh");
      const ok = await replayWorkflow({
        compiled,
        bindings: { record: "EMP-0002", name: "Calc Replayed" },
        fixture: fresh,
        actuator: calcReplayActuator(),
        evidenceRoot: join(work, "evidence"),
        runId: "run-calc",
      });
      expect(ok).toMatchObject({
        outcome: "replayed",
        actuator: { ok: true },
        gate: { family: "derived-workflow", verdict: "verified", accepted: true },
        grade: { status: "pass" },
        agree: true,
      });
    },
    TIMEOUT,
  );

  it.runIf(available)(
    "a secret typed in Calc is redacted at capture and the recording refuses to compile",
    async () => {
      const demo = fixtureBytes("track-r-calc-secret");
      const docPath = join(work, "secret.csv");
      writeFileSync(docPath, demo);
      const cell = cellFor(demo, "EMP-0003", "name");
      const rec = await recordDemonstration(
        calcRecorderSource({
          docPath,
          headless: true,
          script: [{ do: "type", cell, text: PLANTED_KEY }, { do: "save" }],
        }),
        {
          start: operator,
          indicator: () => {},
          before: demo,
          simulated: true,
          recordingId: "rec-calc-2",
        },
      );
      expect(readFileSync(docPath, "utf8")).toContain(PLANTED_KEY); // Calc did save it
      const text = serializeRecording(rec);
      for (const m of ALL_MARKERS) expect(text).not.toContain(m);
      expect(rec.redactions.length).toBeGreaterThan(0);
      expect(() => compileRecording(rec)).toThrow(/RECORDING_REDACTED/);
    },
    TIMEOUT,
  );
});
