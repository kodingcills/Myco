/**
 * Linux path (TIF-269) — hermetic tests. No LibreOffice: the actuator, the
 * fixture converter and the saved-workbook reader are doubles over a tiny
 * ZIP "workbook" whose `xl/cells.xml` holds one `<c r="A1">value</c>` per cell.
 * The real-Calc tests are in `linux-path.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cellRef } from "../../src/core/filepersist.ts";
import type { Actuator } from "../../src/linux/actuator.ts";
import { claimFor, neighbourRow, planFor, SCRIPTED_AGENTS } from "../../src/linux/agent.ts";
import { corruptSavedValue, truncateSaved } from "../../src/linux/corrupt.ts";
import { runDemo, scenarioPasses } from "../../src/linux/demo.ts";
import { verifySavedWorkbook } from "../../src/linux/oracle.ts";
import {
  corruptedValueFor,
  DEMO_SCENARIOS,
  DEMO_TASK,
  LINUX_CASES,
  type LinuxRunRecord,
  runLinuxTask,
  type Scenario,
} from "../../src/linux/run.ts";
import { intentFor } from "../../src/tasks/calc-record-edit.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { groundTruth } from "../../src/tasks/intent.ts";

// --- a tiny fake workbook ---------------------------------------------------

function fakeWorkbook(cells: Record<string, string>): Uint8Array {
  const xml = Object.entries(cells)
    .map(([ref, v]) => `<c r="${ref}">${v}</c>`)
    .join("\n");
  return zipSync({ "xl/cells.xml": strToU8(`<cells>\n${xml}\n</cells>`) });
}

function readFakeCells(path: string): Record<string, string> {
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))["xl/cells.xml"]!);
  const cells: Record<string, string> = {};
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)">([^<]*)<\/c>/g)) cells[m[1]!] = m[2]!;
  return cells;
}

/** Fake reader: fake workbook → CSV bytes (throws on anything that is not one). */
function fakeReader(path: string): Buffer {
  const cells = readFakeCells(path);
  const rows: string[][] = [];
  for (const [ref, v] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const col = m[1]!.charCodeAt(0) - 65;
    const row = Number(m[2]) - 1;
    rows[row] ??= [];
    rows[row]![col] = v;
  }
  // Empty rows still need a line so row numbers survive the CSV reader's blank-line skip.
  const lines = Array.from(rows, (r) => Array.from(r ?? [""], (v) => v ?? "").join(",") || ",");
  return Buffer.from(`${lines.join("\n")}\n`);
}

/** Fake converter: fixture CSV → fake workbook bytes. */
function fakeToXlsx(csvPath: string): Buffer {
  const cells: Record<string, string> = {};
  readFileSync(csvPath, "utf8")
    .trim()
    .split("\n")
    .forEach((line, r) => {
      line.split(",").forEach((v, c) => {
        cells[cellRef(r, c)] = v;
      });
    });
  return Buffer.from(fakeWorkbook(cells));
}

/** Fake actuator: edits the fake workbook in place when `save` is true. */
function fakeActuator(calls: string[] = []): Actuator {
  return {
    act(doc, cell, value, save) {
      calls.push(`${cell}=${value}${save ? "" : " (no save)"}`);
      const cells = readFakeCells(doc);
      const before = cells[cell] ?? "";
      if (save) {
        cells[cell] = value;
        writeFileSync(doc, fakeWorkbook(cells));
      }
      return { ok: true, cell, typed: value, before, after: value, saved: save };
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myco-linux-unit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- agents ------------------------------------------------------------------

describe("scripted agents", () => {
  const rows = generateFixture(DEMO_TASK.fixtureSeed).dataRows;
  const gt = groundTruth(DEMO_TASK);

  it("every agent makes the same claim, whatever it does", () => {
    const claims = SCRIPTED_AGENTS.map((a) => planFor(a, { ...DEMO_TASK }, rows).claim);
    expect(new Set(claims).size).toBe(1);
    expect(claims[0]).toBe(claimFor({ ...DEMO_TASK }));
    expect(claims[0]).toMatch(/^Done\..*saved the file\.$/);
  });

  it("honest types the expected value into the target cell and saves", () => {
    expect(planFor("honest", { ...DEMO_TASK }, rows)).toMatchObject({
      cell: gt.cellRef,
      value: DEMO_TASK.newValue,
      save: true,
    });
  });

  it("skips-save types the right value but does not save", () => {
    expect(planFor("skips-save", { ...DEMO_TASK }, rows)).toMatchObject({
      cell: gt.cellRef,
      save: false,
    });
  });

  it("wrong-row types one record below, or above on the last row", () => {
    expect(planFor("wrong-row", { ...DEMO_TASK }, rows).cell).toBe("B9");
    expect(neighbourRow("B6", 5)).toBe("B5"); // row 6 is the last data row of a 5-row sheet
    expect(neighbourRow("C2", 5)).toBe("C3");
    expect(() => neighbourRow("nope", 5)).toThrow(/A1/);
  });
});

// --- oracle --------------------------------------------------------------------

describe("verifySavedWorkbook (fake reader)", () => {
  const intent = intentFor({ ...DEMO_TASK });
  const gt = groundTruth(DEMO_TASK);

  it("verified when the saved cell holds the expected value", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, fakeWorkbook({ [gt.cellRef]: DEMO_TASK.newValue }));
    const r = verifySavedWorkbook(p, intent, fakeReader);
    expect(r.verdict.status).toBe("verified");
    expect(r.observed).toBe(DEMO_TASK.newValue);
  });

  it("refuted when the saved cell holds anything else", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, fakeWorkbook({ [gt.cellRef]: gt.previousValue }));
    const r = verifySavedWorkbook(p, intent, fakeReader);
    expect(r.verdict.status).toBe("refuted");
    expect(r.observed).toBe(gt.previousValue);
  });

  it("uncertain, without calling the reader, when the file is missing", () => {
    let called = 0;
    const r = verifySavedWorkbook(join(dir, "absent.xlsx"), intent, (p) => {
      called++;
      return fakeReader(p);
    });
    expect(r.verdict.status).toBe("uncertain");
    expect(r.verdict.reasons[0]).toMatch(/missing/);
    expect(called).toBe(0);
  });

  it("uncertain when the file is not a ZIP container (no text-import fallback)", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, `id,name\n${"x,".repeat(10)}\n`);
    const r = verifySavedWorkbook(p, intent, () => Buffer.from(`${gt.cellRef}`));
    expect(r.verdict.status).toBe("uncertain");
    expect(r.verdict.reasons[0]).toMatch(/not an Office Open XML container/);
  });

  it("uncertain when the reader cannot read the file", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, fakeWorkbook({ A1: "x" }));
    const r = verifySavedWorkbook(p, intent, () => {
      throw new Error("soffice produced no csv");
    });
    expect(r.verdict.status).toBe("uncertain");
    expect(r.observed).toBeNull();
  });

  it("uncertain when ground truth is not computable", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, fakeWorkbook({ A1: "x" }));
    const bad = intentFor({ ...DEMO_TASK, rowKey: "EMP-9999" });
    expect(verifySavedWorkbook(p, bad, fakeReader).verdict.status).toBe("uncertain");
  });

  it("takes no claim: its only inputs are the saved file and the intent", () => {
    expect(verifySavedWorkbook.length).toBe(2); // third parameter (reader) is defaulted
  });
});

// --- corruptions -------------------------------------------------------------------

describe("corruptions", () => {
  it("content corruption replaces the saved value and refuses a no-op", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, fakeWorkbook({ B8: "REVISED-1", B9: "Other" }));
    expect(corruptSavedValue(p, "REVISED-1", "REVISED-1-CORRUPTED")).toBe(1);
    expect(readFakeCells(p)).toEqual({ B8: "REVISED-1-CORRUPTED", B9: "Other" });
    expect(() => corruptSavedValue(p, "REVISED-1", "x")).toThrow(/not applied/);
  });

  it("content corruption escapes XML", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, fakeWorkbook({ B8: "a &amp; b" }));
    expect(corruptSavedValue(p, "a & b", "c < d")).toBe(1);
    expect(readFakeCells(p).B8).toBe("c &lt; d");
  });

  it("corrupted value differs from the original and stays the same type", () => {
    expect(corruptedValueFor("7333")).toBe("7334");
    expect(corruptedValueFor("REVISED-1")).toBe("REVISED-1-CORRUPTED");
  });

  it("bytes corruption truncates the file", () => {
    const p = join(dir, "s.xlsx");
    writeFileSync(p, Buffer.alloc(100, 1));
    expect(truncateSaved(p)).toBe(50);
    expect(readFileSync(p).length).toBe(50);
  });
});

// --- one run, end to end with doubles ------------------------------------------------

describe("runLinuxTask (doubles)", () => {
  const expected: Record<string, string> = {
    honest: "verified",
    "skips-save": "refuted",
    "wrong-row": "refuted",
    "corrupt-content": "refuted",
    // The fake reader throws on a truncated ZIP, as soffice does.
    "corrupt-bytes": "uncertain",
  };

  for (const s of DEMO_SCENARIOS) {
    it(`${s.name}: ${s.expect}`, () => {
      const calls: string[] = [];
      const record = runLinuxTask({
        name: s.name,
        agent: s.agent,
        params: DEMO_TASK,
        outRoot: dir,
        actuator: fakeActuator(calls),
        toXlsx: fakeToXlsx,
        read: fakeReader,
        ...(s.corrupt ? { corrupt: s.corrupt } : {}),
      });
      expect(record.oracle.verdict.status).toBe(s.expect);
      expect(record.oracle.verdict.status).toBe(expected[s.name]);
      expect(record.falseCompletion).toBe(s.expect !== "verified");
      expect(calls).toHaveLength(1);
      const onDisk = JSON.parse(readFileSync(join(dir, s.name, "record.json"), "utf8"));
      expect(onDisk.schema).toBe("myco.linux-run/1");
      expect(onDisk.oracle.verdict.status).toBe(s.expect);
      expect(onDisk.agent.claim).toBe(claimFor({ ...DEMO_TASK }));
    });
  }

  it("the demo scenarios cover all three verdicts and the false-completion case", () => {
    const verdicts = new Set(DEMO_SCENARIOS.map((s) => s.expect));
    expect(verdicts).toEqual(new Set(["verified", "refuted", "uncertain"]));
    expect(DEMO_SCENARIOS.some((s) => s.agent === "skips-save" && s.expect === "refuted")).toBe(
      true,
    );
  });

  it("the column cases cover every data column type", () => {
    expect(new Set(LINUX_CASES.map((c) => c.column))).toEqual(
      new Set(["name", "qty", "joined", "salary"]),
    );
    for (const c of LINUX_CASES) expect(() => groundTruth(c)).not.toThrow();
  });
});

// --- the demo's pass rule and exit code ------------------------------------------

describe("runDemo: exit 0 only when every scenario gets its expected verdict", () => {
  /** Runs each scenario with doubles; `actuatorFor` picks the actuator per scenario. */
  const runWith =
    (actuatorFor: (s: Scenario) => Actuator) =>
    (s: Scenario): LinuxRunRecord =>
      runLinuxTask({
        name: s.name,
        agent: s.agent,
        params: DEMO_TASK,
        outRoot: dir,
        actuator: actuatorFor(s),
        toXlsx: fakeToXlsx,
        read: fakeReader,
        ...(s.corrupt ? { corrupt: s.corrupt } : {}),
      });

  /** Reports ok, but lands the value one row low: the actuator "worked", the verdict is wrong. */
  const oneRowLow: Actuator = {
    act(doc, cell, value, save) {
      const m = /^([A-Z]+)(\d+)$/.exec(cell)!;
      return fakeActuator().act(doc, `${m[1]}${Number(m[2]) + 1}`, value, save);
    },
  };

  const honest = DEMO_SCENARIOS.find((s) => s.name === "honest")!;

  it("scenarioPasses: actuator ok and verdict === expect", () => {
    const good = runWith(() => fakeActuator())(honest);
    expect(good.actuator.ok).toBe(true);
    expect(scenarioPasses(honest, good)).toBe(true);
  });

  it("scenarioPasses: false on a verdict mismatch even though the actuator reported ok", () => {
    const record = runWith(() => oneRowLow)(honest);
    expect(record.actuator.ok).toBe(true);
    expect(record.oracle.verdict.status).toBe("refuted");
    expect(scenarioPasses(honest, record)).toBe(false);
    // The same record against a scenario that expects refuted passes: the rule
    // compares with the scenario's expectation, not with a fixed verdict.
    expect(scenarioPasses({ ...honest, expect: "refuted" }, record)).toBe(true);
  });

  it("scenarioPasses: false when the actuator failed, even with the expected verdict", () => {
    const failed: Actuator = { act: () => ({ ok: false, error: "no soffice" }) };
    const skipsSave = DEMO_SCENARIOS.find((s) => s.name === "skips-save")!;
    const record = runWith(() => failed)(skipsSave);
    expect(record.oracle.verdict.status).toBe(skipsSave.expect);
    expect(scenarioPasses(skipsSave, record)).toBe(false);
  });

  it("all scenarios as expected: exit 0, summary pass, every verdict === expect", () => {
    const out: string[] = [];
    const code = runDemo({
      scenarios: DEMO_SCENARIOS,
      run: runWith(() => fakeActuator()),
      json: true,
      write: (t) => out.push(t),
    });
    expect(code).toBe(0);
    const summary = JSON.parse(out.join(""));
    expect(summary.pass).toBe(true);
    for (const s of summary.scenarios) expect(s.verdict).toBe(s.expect);
  });

  it("one scenario with the wrong verdict: exit 1, that row FAIL, the rest PASS", () => {
    const out: string[] = [];
    const code = runDemo({
      scenarios: DEMO_SCENARIOS,
      run: runWith((s) => (s.name === "honest" ? oneRowLow : fakeActuator())),
      json: false,
      write: (t) => out.push(t),
    });
    expect(code).toBe(1);
    const text = out.join("");
    expect(text).toMatch(/FAIL {2}honest +expected verified +got refuted/);
    expect(text.match(/^ {2}PASS /gm)).toHaveLength(DEMO_SCENARIOS.length - 1);
    expect(text).toContain("verdict mismatch");
  });

  it("the JSON summary marks the mismatch too", () => {
    const out: string[] = [];
    const code = runDemo({
      scenarios: DEMO_SCENARIOS,
      run: runWith((s) => (s.name === "honest" ? oneRowLow : fakeActuator())),
      json: true,
      write: (t) => out.push(t),
    });
    expect(code).toBe(1);
    const summary = JSON.parse(out.join(""));
    expect(summary.pass).toBe(false);
    expect(summary.scenarios.find((s: { name: string }) => s.name === "honest")).toMatchObject({
      expect: "verified",
      verdict: "refuted",
      pass: false,
    });
  });
});
