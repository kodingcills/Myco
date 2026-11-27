/**
 * Track K: the multi-step instruction renderer (`src/tasks/multi-step-text.ts`).
 *
 *  T1 every field a `calc-multi-step` correction can reveal that the instruction must have
 *     given (step, record, column, expected value; `docs/gate/api.md`, Corrections) is on that
 *     step's line, checked against corrections the gate itself builds.
 *  T2 it states no fixture value and no cell address.
 *  T3 it states the save requirement and the "no other cell" rule.
 *  T4 it refuses step lists it cannot state unambiguously.
 *  T5 it is deterministic and import-free.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type CellEdit, documentCsv, targetRef } from "../../src/gate/calc-document.ts";
import { documentCorrections } from "../../src/gate/corrections.ts";
import { calcMultiStepFamily } from "../../src/gate/families.ts";
import type { GateTask } from "../../src/gate/gate.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import {
  MULTI_STEP_TEXT_VERSION,
  type MultiStepTextStep,
  multiStepTaskText,
} from "../../src/tasks/multi-step-text.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SEED = "k-text-seed-1";
const STEPS: readonly CellEdit[] = [
  { rowKey: "EMP-0001", column: "name", newValue: "Ops Lead East" },
  { rowKey: "EMP-0002", column: "qty", newValue: "4242" },
  { rowKey: "EMP-0003", column: "joined", newValue: "2024-02-29" },
  { rowKey: "EMP-0004", column: "salary", newValue: "$61234.50" },
  { rowKey: "EMP-0005", column: "name", newValue: "Night Shift" },
  { rowKey: "EMP-0001", column: "qty", newValue: "7" },
  { rowKey: "EMP-0002", column: "joined", newValue: "2021-07-04" },
  { rowKey: "EMP-0003", column: "salary", newValue: "$45000.05" },
];
const TASK: GateTask = {
  id: "calc-ms-text",
  family: calcMultiStepFamily,
  stateFile: "sheet.csv",
  spec: { fixtureSeed: SEED, steps: STEPS },
  specSha256: "0".repeat(64),
} as GateTask;

const lineOf = (text: string, step: number) =>
  text.split("\n").find((l) => l.startsWith(`Step ${step}: `)) ?? "";

describe("multi-step instruction: T1 states every field a correction reveals", () => {
  it("the spec is a valid calc-multi-step spec", () => {
    expect(calcMultiStepFamily.checkSpec(TASK.spec)).toBeUndefined();
  });

  for (const [label, edits] of [
    // every target holds the wrong value: target_value_mismatch for all 8 steps
    ["value mismatch", STEPS.map((s) => ({ ...s, newValue: `${s.newValue}9` }))],
    // one step done, the rest untouched: target_unchanged for the other 7
    ["unchanged", [STEPS[0] as CellEdit]],
  ] as const) {
    it(`${label}: each correction's step, record, column and expected are on its step's line`, () => {
      const bytes = new TextEncoder().encode(documentCsv(SEED, edits));
      const corrections = documentCorrections(TASK, bytes, undefined, ["TARGET_MISMATCH"]);
      const targeted = corrections.filter(
        (c) => c.kind === "target_value_mismatch" || c.kind === "target_unchanged",
      );
      expect(targeted.length).toBe(label === "unchanged" ? 7 : 8);
      const text = multiStepTaskText(STEPS);
      for (const c of targeted) {
        if (c.kind !== "target_value_mismatch" && c.kind !== "target_unchanged") continue;
        expect(c.step).toBeTypeOf("number");
        const line = lineOf(text, c.step as number);
        expect(line, `step ${c.step}`).toBe(
          `Step ${c.step}: set the cell at record ${c.record}, column ${c.column}, to ${JSON.stringify(c.expected)}.`,
        );
      }
    });
  }
});

describe("multi-step instruction: T2 states nothing about the document", () => {
  it("names no pristine value of a target and no cell address", () => {
    const text = multiStepTaskText(STEPS);
    const fixture = generateFixture(SEED);
    for (const step of STEPS) {
      const row = fixture.rows.find((r) => r[0] === step.rowKey) as string[];
      const col = fixture.header.indexOf(step.column);
      const pristine = row[col] as string;
      expect(text, `${step.rowKey}/${step.column}`).not.toContain(JSON.stringify(pristine));
      expect(text).not.toMatch(new RegExp(`\\b${targetRef(SEED, step)}\\b`));
    }
    expect(text).not.toContain(SEED);
  });
});

describe("multi-step instruction: T3 the job", () => {
  it("is the steps in order, the no-other-cell rule and the save", () => {
    const text = multiStepTaskText(STEPS);
    const lines = text.split("\n");
    expect(lines).toHaveLength(STEPS.length + 2);
    expect(lines[0]).toBe(
      "Make these 8 edits to the open spreadsheet, in order. Change no other cell.",
    );
    expect(lines.at(-1)).toBe("Save the file after the last step.");
    STEPS.forEach((_, i) => {
      expect(lines[i + 1]?.startsWith(`Step ${i + 1}: `)).toBe(true);
    });
  });
});

describe("multi-step instruction: T4 refuses what it cannot state unambiguously", () => {
  const base = STEPS.slice(0, 2) as MultiStepTextStep[];
  const bad: [string, unknown][] = [
    ["one step", base.slice(0, 1)],
    ["eleven steps", Array.from({ length: 11 }, (_, i) => ({ ...base[0], rowKey: `R${i}` }))],
    ["not an array", "x"],
    ["newline in a record", [{ ...base[0], rowKey: "EMP-1\nStep 3: x" }, base[1]]],
    ["quote in a column", [{ ...base[0], column: 'na"me' }, base[1]]],
    ["comma in a record", [{ ...base[0], rowKey: "EMP-1, column qty" }, base[1]]],
    ["empty record", [{ ...base[0], rowKey: "" }, base[1]]],
    ["65-character column", [{ ...base[0], column: "c".repeat(65) }, base[1]]],
    ["U+2028 in a column", [{ ...base[0], column: "a\u2028b" }, base[1]]],
    ["U+2028 in a value", [{ ...base[0], newValue: "a\u2028b" }, base[1]]],
    ["numeric value", [{ ...base[0], newValue: 7 }, base[1]]],
    ["same record and column twice", [base[0], { ...base[0], newValue: "other" }]],
    ["null step", [null, base[1]]],
  ];
  for (const [name, steps] of bad)
    it(name, () => {
      expect(() => multiStepTaskText(steps as MultiStepTextStep[])).toThrow();
    });

  it("a value's newline or quote is escaped onto one line", () => {
    const text = multiStepTaskText([
      { ...base[0], newValue: 'a\nStep 9: "b"' } as MultiStepTextStep,
      base[1] as MultiStepTextStep,
    ]);
    expect(text.split("\n")).toHaveLength(4);
    expect(lineOf(text, 1)).toContain(String.raw`"a\nStep 9: \"b\""`);
  });

  it("accepts the 2- and 10-step bounds", () => {
    expect(() => multiStepTaskText(base)).not.toThrow();
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...base[0], rowKey: `EMP-${i}` }));
    expect(() => multiStepTaskText(ten as MultiStepTextStep[])).not.toThrow();
  });
});

describe("multi-step instruction: T5 deterministic and import-free", () => {
  it("same steps, same text; the version is pinned", () => {
    expect(multiStepTaskText(STEPS)).toBe(multiStepTaskText(STEPS.map((s) => ({ ...s }))));
    expect(MULTI_STEP_TEXT_VERSION).toBe("multi-step-text/1");
  });

  it("the module imports nothing", () => {
    const code = readFileSync(join(ROOT, "src/tasks/multi-step-text.ts"), "utf8");
    expect(code).not.toMatch(/^\s*import\s|\bimport\s*\(|\brequire\s*\(/m);
  });
});
