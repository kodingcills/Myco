/**
 * Linux path (TIF-269) — against a real headless LibreOffice Calc.
 *
 * Opt-in: it runs only with MYCO_LINUX_PATH=1 or MYCO_LINUX_PATH_REQUIRED=1,
 * because each case starts several soffice processes, and inside the parallel
 * `pnpm test` that load timed out an unrelated 5 s test. `pnpm test` keeps the
 * hermetic `linux-unit.test.ts`. Even when opted in, it needs `soffice` and
 * Python-UNO and skips without them, except under MYCO_LINUX_PATH_REQUIRED=1
 * (the `linux path` CI job), where a missing prerequisite FAILS, so the suite
 * can never pass there by skipping (the TIF-119 lesson).
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calcActuator, pythonUnoAvailable } from "../../src/linux/actuator.ts";
import { corruptSavedValue, truncateSaved } from "../../src/linux/corrupt.ts";
import { verifySavedWorkbook } from "../../src/linux/oracle.ts";
import {
  corruptedValueFor,
  DEMO_SCENARIOS,
  DEMO_TASK,
  LINUX_CASES,
  runLinuxTask,
} from "../../src/linux/run.ts";
import {
  CSV_EXPORT_FILTER,
  csvToXlsxBytes,
  sofficeBinary,
  sofficeVersion,
  xlsxToCsvBytes,
} from "../../src/linux/soffice.ts";
import { intentFor } from "../../src/tasks/calc-record-edit.ts";
import { groundTruth } from "../../src/tasks/intent.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const required = process.env.MYCO_LINUX_PATH_REQUIRED === "1";
const optedIn = required || process.env.MYCO_LINUX_PATH === "1";
const available = optedIn && sofficeVersion() !== null && pythonUnoAvailable();

const RUN_TIMEOUT = 120_000;

/**
 * A raw headless conversion for test inputs and controls, outside the module
 * under test: throwaway profile, fresh output dir, returns the produced file.
 */
function sofficeConvert(
  source: string,
  convertTo: string,
  workRoot: string,
  extraArgs: readonly string[],
): string {
  const work = mkdtempSync(join(workRoot, "conv-"));
  const outDir = join(work, "out");
  spawnSync(
    sofficeBinary(),
    [
      "--headless",
      "--norestore",
      "--nologo",
      `-env:UserInstallation=${pathToFileURL(join(work, "profile")).href}`,
      ...extraArgs,
      "--convert-to",
      convertTo,
      "--outdir",
      outDir,
      source,
    ],
    { encoding: "utf8", timeout: RUN_TIMEOUT },
  );
  const ext = convertTo.split(":")[0]!;
  const out = join(outDir, `${basename(source).replace(/\.[^.]+$/, "")}.${ext}`);
  if (!existsSync(out)) throw new Error(`test conversion produced no ${ext} for ${source}`);
  return out;
}

describe("prerequisites", () => {
  it.runIf(required)("soffice and Python-UNO are installed (MYCO_LINUX_PATH_REQUIRED=1)", () => {
    expect(sofficeVersion(), "soffice --version").not.toBeNull();
    expect(pythonUnoAvailable(), "python3 -c 'import uno'").toBe(true);
  });
});

describe.skipIf(!available)("Linux path against real Calc", () => {
  let out: string;
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "myco-linux-path-"));
  });
  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  const run = (name: string, params = DEMO_TASK, agent: "honest" | "skips-save" = "honest") =>
    runLinuxTask({
      name,
      agent,
      params,
      outRoot: out,
      actuator: calcActuator(),
      toXlsx: (csv) => csvToXlsxBytes(csv),
    });

  for (const params of LINUX_CASES) {
    it(
      `honest edit of a ${params.column} cell is verified from the saved file`,
      () => {
        const record = run(`case-${params.column}`, params);
        expect(record.actuator.ok, record.actuator.error).toBe(true);
        expect(record.actuator.after).toBe(params.newValue);
        expect(record.oracle.verdict.status).toBe("verified");
        expect(record.oracle.observed).toBe(params.newValue);
      },
      RUN_TIMEOUT,
    );
  }

  for (const s of DEMO_SCENARIOS) {
    it(
      `scenario ${s.name}: ${s.expect}`,
      () => {
        const record = runLinuxTask({
          name: `scenario-${s.name}`,
          agent: s.agent,
          params: DEMO_TASK,
          outRoot: out,
          actuator: calcActuator(),
          toXlsx: (csv) => csvToXlsxBytes(csv),
          ...(s.corrupt ? { corrupt: s.corrupt } : {}),
        });
        expect(record.actuator.ok, record.actuator.error).toBe(true);
        expect(record.oracle.verdict.status).toBe(s.expect);
      },
      RUN_TIMEOUT,
    );
  }

  it(
    "false completion: Calc shows the value, the agent says done, the saved file is refuted",
    () => {
      const record = run("false-completion", DEMO_TASK, "skips-save");
      // What the agent "saw" on screen matched its claim...
      expect(record.actuator.after).toBe(DEMO_TASK.newValue);
      expect(record.agent.claim).toMatch(/saved the file/);
      // ...and the saved file still holds the fixture value.
      expect(record.oracle.verdict.status).toBe("refuted");
      expect(record.oracle.observed).toBe(groundTruth(DEMO_TASK).previousValue);
      expect(record.falseCompletion).toBe(true);
    },
    RUN_TIMEOUT,
  );

  it(
    "mutation proof: the same saved file is verified, then refuted once its value is corrupted, then uncertain once truncated",
    () => {
      const record = run("mutation");
      const intent = intentFor({ ...DEMO_TASK });
      const saved = join(record.runDir, "saved.xlsx");
      expect(verifySavedWorkbook(saved, intent).verdict.status).toBe("verified");

      const contentCopy = join(record.runDir, "content.xlsx");
      copyFileSync(saved, contentCopy);
      corruptSavedValue(contentCopy, DEMO_TASK.newValue, corruptedValueFor(DEMO_TASK.newValue));
      const refuted = verifySavedWorkbook(contentCopy, intent);
      expect(refuted.verdict.status).toBe("refuted");
      expect(refuted.observed).toBe(corruptedValueFor(DEMO_TASK.newValue));

      const bytesCopy = join(record.runDir, "bytes.xlsx");
      copyFileSync(saved, bytesCopy);
      truncateSaved(bytesCopy);
      const uncertain = verifySavedWorkbook(bytesCopy, intent);
      expect(uncertain.verdict.status).toBe("uncertain");
      expect(uncertain.verdict.status).not.toBe("verified");
    },
    RUN_TIMEOUT,
  );

  it(
    "a CSV renamed to .xlsx is not read as text: uncertain",
    () => {
      const record = run("renamed-csv");
      const fake = join(record.runDir, "renamed.xlsx");
      copyFileSync(join(record.runDir, "fixture.csv"), fake);
      expect(verifySavedWorkbook(fake, intentFor({ ...DEMO_TASK })).verdict.status).toBe(
        "uncertain",
      );
    },
    RUN_TIMEOUT,
  );

  it(
    "inputs no readback can parse are refused: a renamed CSV and a ZIP holding a CSV",
    () => {
      const record = run("filter-guard");
      const renamed = join(record.runDir, "renamed.xlsx");
      copyFileSync(join(record.runDir, "fixture.csv"), renamed);
      expect(() => xlsxToCsvBytes(renamed)).toThrow(/produced no csv/);
      // A ZIP that passes the header check but holds no workbook.
      const zipped = join(record.runDir, "zipped.xlsx");
      writeFileSync(
        zipped,
        zipSync({
          "fixture.csv": new Uint8Array(readFileSync(join(record.runDir, "fixture.csv"))),
        }),
      );
      expect(() => xlsxToCsvBytes(zipped)).toThrow(/produced no csv/);
      expect(verifySavedWorkbook(zipped, intentFor({ ...DEMO_TASK })).verdict.status).toBe(
        "uncertain",
      );
    },
    RUN_TIMEOUT,
  );

  it(
    "the forced import filter refuses an .ods renamed to .xlsx that soffice would otherwise read (fail closed)",
    () => {
      // The honest run's saved file holds the edited value. Re-save it as ODS and
      // give it an .xlsx name: it is a ZIP, so it passes the header check.
      const record = run("filter-ods");
      const work = mkdtempSync(join(tmpdir(), "myco-linux-ods-"));
      try {
        const ods = sofficeConvert(join(record.runDir, "saved.xlsx"), "ods", work, []);
        const disguised = join(record.runDir, "disguised.xlsx");
        copyFileSync(ods, disguised);
        expect(readFileSync(disguised).subarray(0, 2).toString("latin1")).toBe("PK");

        // Control: with no import filter soffice auto-detects ODS and exports the
        // edited data, so this input tells "filter forced" apart from "no filter".
        const unfiltered = sofficeConvert(disguised, CSV_EXPORT_FILTER, work, []);
        expect(readFileSync(unfiltered, "utf8")).toContain(`EMP-0007,${DEMO_TASK.newValue},`);

        // With the forced Excel 2007 XML filter: nothing is produced...
        expect(() => xlsxToCsvBytes(disguised)).toThrow(/produced no csv/);
        // ...so the oracle could not look: uncertain, never verified from a non-xlsx.
        const result = verifySavedWorkbook(disguised, intentFor({ ...DEMO_TASK }));
        expect(result.verdict.status).toBe("uncertain");
        expect(result.observed).toBeNull();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    RUN_TIMEOUT,
  );

  it(
    "pnpm myco-linux --demo --json exits 0 with every scenario passing",
    () => {
      const result = spawnSync(
        process.execPath,
        [
          join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
          join(ROOT, "scripts", "linux-run.ts"),
          "--demo",
          "--json",
          "--out",
          join(out, "cli"),
        ],
        { encoding: "utf8", timeout: RUN_TIMEOUT },
      );
      expect(result.status, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout);
      expect(summary.pass).toBe(true);
      expect(summary.scenarios.map((s: { name: string }) => s.name)).toEqual(
        DEMO_SCENARIOS.map((s) => s.name),
      );
      for (const s of DEMO_SCENARIOS) {
        expect(
          summary.scenarios.find((row: { name: string }) => row.name === s.name),
          s.name,
        ).toMatchObject({ expect: s.expect, verdict: s.expect, pass: true });
      }
      expect(
        summary.scenarios.find((s: { name: string }) => s.name === "skips-save"),
      ).toMatchObject({ verdict: "refuted", falseCompletion: true });
    },
    RUN_TIMEOUT,
  );

  it(
    "pnpm myco-linux --demo exits 1 when a scenario gets the wrong verdict (actuator lands one row low)",
    () => {
      // A Python wrapper in front of the real actuator: it types into the cell one
      // row below the one asked for, and still reports ok. Real Calc, real save,
      // real oracle; only the honest scenario's verdict changes (verified -> refuted).
      const bin = mkdtempSync(join(tmpdir(), "myco-linux-lowrow-"));
      try {
        const wrapper = join(bin, "python-one-row-low");
        writeFileSync(
          wrapper,
          [
            "#!/usr/bin/env python3",
            "import os, re, sys",
            `real = ${JSON.stringify(process.env.MYCO_PYTHON ?? "python3")}`,
            "args = sys.argv[1:]",
            'if "--cell" in args:',
            '    i = args.index("--cell") + 1',
            '    m = re.fullmatch(r"([A-Z]+)(\\d+)", args[i])',
            "    args[i] = m.group(1) + str(int(m.group(2)) + 1)",
            "os.execvp(real, [real] + args)",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const result = spawnSync(
          process.execPath,
          [
            join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
            join(ROOT, "scripts", "linux-run.ts"),
            "--demo",
            "--json",
            "--out",
            join(out, "cli-low-row"),
          ],
          {
            encoding: "utf8",
            timeout: RUN_TIMEOUT,
            env: { ...process.env, MYCO_PYTHON: wrapper },
          },
        );
        expect(result.status, result.stderr).toBe(1);
        const summary = JSON.parse(result.stdout);
        expect(summary.pass).toBe(false);
        const rows = new Map(summary.scenarios.map((r: { name: string }) => [r.name, r] as const));
        // The actuator ran (its report is ok), so only the verdict check can fail it.
        const honestRecord = JSON.parse(
          readFileSync(join(out, "cli-low-row", "honest", "record.json"), "utf8"),
        );
        expect(honestRecord.actuator.ok).toBe(true);
        expect(rows.get("honest")).toMatchObject({
          expect: "verified",
          verdict: "refuted",
          pass: false,
        });
        for (const s of DEMO_SCENARIOS.filter((x) => x.name !== "honest")) {
          expect(rows.get(s.name), s.name).toMatchObject({ verdict: s.expect, pass: true });
        }
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
    RUN_TIMEOUT,
  );
});
