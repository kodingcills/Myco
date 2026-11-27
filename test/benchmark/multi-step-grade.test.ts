/**
 * Track K: the multi-step grader entry (`src/benchmark/grade/multi-step.ts`,
 * `multi-step-grader/1`). Grades the final captured document of a multi-step Calc task from
 * the pristine fixture bytes, the steps and the column types; never a claim or a verdict.
 *
 *  G1 pass needs every step held and every other cell pristine (CSV and Calc-shaped xlsx).
 *  G2 a missing step, a wrong typed value, collateral damage, an added cell or content on
 *     another sheet fails, and `perStep` says which steps hold.
 *  G3 could-not-look and ambiguous intents are `ungradable`, never pass.
 *  G4 for one step it agrees with the false-completion grader (`grade`) on status.
 *  G5 on CSV it agrees with the gate's `calc-multi-step` decision (pass iff verified) over
 *     seeded random documents, without sharing its code.
 *  G6 it takes no claim, verdict, checkpoint or correction: extra fields change nothing.
 *  G7 it imports only this directory's grade and sheet modules.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type GradeInput, grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import {
  gradeMultiStep,
  type MultiStepGradeEdit,
  type MultiStepGradeInput,
} from "../../src/benchmark/grade/multi-step.ts";
import { type CellEdit, documentCsv, targetRef } from "../../src/gate/calc-document.ts";
import { calcMultiStepFamily } from "../../src/gate/families.ts";
import { FIXTURE_COLUMNS, generateFixture } from "../../src/tasks/fixture.ts";
import { buildXlsx, calcImport, type TestCell } from "./xlsx-writer.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SEED = "k-grader-seed-1";
const FIXTURE = generateFixture(SEED);
const FIXTURE_BYTES = new TextEncoder().encode(FIXTURE.csv);
const TYPES = Object.fromEntries(FIXTURE_COLUMNS.map((c) => [c.name, c.type]));

/** Eight edits, two per data column, on distinct records (ms-long-v1's shape). */
const STEPS: readonly CellEdit[] = [
  { rowKey: "EMP-0001", column: "name", newValue: "Ops Lead" },
  { rowKey: "EMP-0002", column: "qty", newValue: "4242" },
  { rowKey: "EMP-0003", column: "joined", newValue: "2024-02-29" },
  { rowKey: "EMP-0004", column: "salary", newValue: "$61234.50" },
  { rowKey: "EMP-0005", column: "name", newValue: "Night Shift" },
  { rowKey: "EMP-0001", column: "qty", newValue: "7" },
  { rowKey: "EMP-0002", column: "joined", newValue: "2021-07-04" },
  { rowKey: "EMP-0003", column: "salary", newValue: "$45000.05" },
];

const csv = (text: string) => ({ format: "csv" as const, bytes: new TextEncoder().encode(text) });

function input(
  persisted: MultiStepGradeInput["persisted"],
  steps: readonly MultiStepGradeEdit[] = STEPS,
  extra: Partial<MultiStepGradeInput> = {},
): MultiStepGradeInput {
  return {
    fixtureCsv: FIXTURE_BYTES,
    fixtureSha256: sha256(FIXTURE_BYTES),
    persisted,
    steps,
    columnTypes: TYPES,
    ...extra,
  };
}

/** CSV rows of the fixture with `edits` applied, then `mutate` on the raw rows. */
function sheet(edits: readonly CellEdit[], mutate?: (rows: string[][]) => void): string {
  const rows = documentCsv(SEED, edits)
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  mutate?.(rows);
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

function xlsx(
  edits: readonly CellEdit[],
  change: Record<string, TestCell | null> = {},
  extra = {},
) {
  const cells: Record<string, TestCell> = calcImport(documentCsv(SEED, edits));
  for (const [ref, cell] of Object.entries(change)) {
    if (cell === null) delete cells[ref];
    else cells[ref] = cell;
  }
  return { format: "xlsx" as const, bytes: buildXlsx({ cells, ...extra }) };
}

describe("multi-step grader: G1 pass", () => {
  it("the fixture has room for the steps", () => {
    expect(FIXTURE.dataRows).toBeGreaterThanOrEqual(5);
  });

  it("passes a CSV document holding every step and nothing else", () => {
    const r = gradeMultiStep(input(csv(sheet(STEPS))));
    expect(r.status).toBe("pass");
    expect(r.reasons).toEqual([]);
    expect(r.stepsSatisfied).toBe(8);
    expect(r.collateralCount).toBe(0);
    expect(r.perStep.map((s) => s.target)).toEqual(STEPS.map((s) => targetRef(SEED, s)));
    expect(r.graderVersion).toBe("multi-step-grader/1");
  });

  it("passes a Calc-shaped xlsx document holding every step (typed cells)", () => {
    expect(gradeMultiStep(input(xlsx(STEPS))).status).toBe("pass");
  });

  it("is order-blind: the final document is graded, not the order of the edits", () => {
    expect(gradeMultiStep(input(csv(sheet([...STEPS].reverse())))).status).toBe("pass");
  });
});

describe("multi-step grader: G2 fail", () => {
  it("fails when any one step is missing, and names it", () => {
    for (let i = 0; i < STEPS.length; i++) {
      const r = gradeMultiStep(input(csv(sheet(STEPS.filter((_, j) => j !== i)))));
      expect(r.status, `step ${i + 1}`).toBe("fail");
      expect(r.stepsSatisfied).toBe(7);
      expect(r.perStep.filter((s) => !s.satisfied).map((s) => s.step)).toEqual([i + 1]);
      expect(r.collateralCount).toBe(0);
      expect(r.reasons).toEqual([`steps not held: ${i + 1}`]);
    }
  });

  it("fails the pristine document (no step done)", () => {
    const r = gradeMultiStep(input(csv(FIXTURE.csv)));
    expect(r.status).toBe("fail");
    expect(r.stepsSatisfied).toBe(0);
  });

  it("fails collateral damage even when every step holds", () => {
    const r = gradeMultiStep(
      input(
        csv(
          sheet(STEPS, (rows) => {
            (rows[6] as string[])[1] = "Scratch";
          }),
        ),
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.stepsSatisfied).toBe(8);
    expect(r.collateralCount).toBe(1);
    expect(r.mismatches).toEqual(["B7"]);
  });

  it("fails an added row and an added column", () => {
    const row = sheet(STEPS, (rows) => {
      rows.push(["EMP-9999", "x", "1", "2020-01-01", "$1.00"]);
    });
    expect(gradeMultiStep(input(csv(row))).status).toBe("fail");
    const col = sheet(STEPS, (rows) => {
      (rows[1] as string[]).push("extra");
    });
    expect(gradeMultiStep(input(csv(col))).status).toBe("fail");
  });

  it("fails a target with the right text but the wrong type (xlsx)", () => {
    const qty = targetRef(SEED, STEPS[1] as CellEdit);
    // 4242 stored as a date serial is not the integer 4242.
    const r = gradeMultiStep(input(xlsx(STEPS, { [qty]: { t: "n", v: 4242, style: "date" } })));
    expect(r.status).toBe("fail");
    expect(r.perStep[1]?.satisfied).toBe(false);
  });

  it("fails a formula in place of a literal", () => {
    const ref = targetRef(SEED, STEPS[1] as CellEdit);
    const r = gradeMultiStep(
      input(xlsx(STEPS, { [ref]: { t: "n-formula", f: "4000+242", v: 4242 } })),
    );
    expect(r.status).toBe("fail");
  });

  it("fails content on another sheet", () => {
    const r = gradeMultiStep(input(xlsx(STEPS, {}, { extraSheet: { A1: { t: "s", v: "x" } } })));
    expect(r.status).toBe("fail");
    expect(r.reasons.join(" ")).toMatch(/other than the first/);
  });

  it("fails a step naming a record or column the fixture does not have (unsatisfiable)", () => {
    const steps = [...STEPS, { rowKey: "EMP-9999", column: "name", newValue: "x" }];
    const r = gradeMultiStep(input(csv(sheet(STEPS)), steps));
    expect(r.status).toBe("fail");
    expect(r.perStep[8]).toEqual({ step: 9, target: null, satisfied: false });
    const key = [...STEPS, { rowKey: "EMP-0001", column: "id", newValue: "x" }];
    expect(gradeMultiStep(input(csv(sheet(STEPS)), key)).status).toBe("fail");
  });
});

describe("multi-step grader: G3 ungradable, never pass", () => {
  const good = csv(sheet(STEPS));
  const cases: [string, MultiStepGradeInput][] = [
    ["fixture digest mismatch", input(good, STEPS, { fixtureSha256: "0".repeat(64) })],
    ["not captured", input(null)],
    ["declared xlsx, bytes CSV", input({ format: "xlsx", bytes: good.bytes })],
    ["declared csv, bytes zip", input({ format: "csv", bytes: xlsx(STEPS).bytes })],
    ["not UTF-8", input({ format: "csv", bytes: new Uint8Array([0xff, 0xfe, 0x00]) })],
    ["no steps", input(good, [])],
    [
      "33 steps",
      input(
        good,
        Array.from({ length: 33 }, () => STEPS[0] as CellEdit),
      ),
    ],
    [
      "a non-string value",
      input(good, [{ rowKey: "EMP-0001", column: "qty", newValue: 7 as unknown as string }]),
    ],
    ["two steps on one cell", input(good, [STEPS[0] as CellEdit, { ...(STEPS[0] as CellEdit) }])],
    [
      "a column type present but undefined",
      input(good, STEPS, { columnTypes: { ...TYPES, salary: undefined as never } }),
    ],
    [
      "a column type that is not a type",
      input(good, STEPS, { columnTypes: { ...TYPES, salary: "money" as never } }),
    ],
    [
      "a column type absent",
      input(good, STEPS, {
        columnTypes: Object.fromEntries(Object.entries(TYPES).filter(([k]) => k !== "qty")),
      }),
    ],
    ["steps not an array", input(good, "x" as unknown as MultiStepGradeEdit[])],
  ];
  for (const [name, i] of cases)
    it(name, () => {
      const r = gradeMultiStep(i);
      expect(r.status).toBe("ungradable");
      expect(r.perStep).toEqual([]);
      expect(r.stepsSatisfied).toBeNull();
    });

  it("a duplicate record key in the fixture is ambiguous", () => {
    const dup = `${FIXTURE.csv}EMP-0001,Dup,1,2020-01-01,$1.00\n`;
    const bytes = new TextEncoder().encode(dup);
    const r = gradeMultiStep({
      ...input(csv(dup)),
      fixtureCsv: bytes,
      fixtureSha256: sha256(bytes),
    });
    expect(r.status).toBe("ungradable");
    expect(r.reasons[0]).toMatch(/ambiguous/);
  });
});

describe("multi-step grader: G4 agrees with the false-completion grader for one step", () => {
  const edit = STEPS[1] as CellEdit;
  const ref = targetRef(SEED, edit);
  const docs: [string, GradeInput["persisted"]][] = [
    ["done", csv(sheet([edit]))],
    ["pristine", csv(FIXTURE.csv)],
    [
      "collateral",
      csv(
        sheet([edit], (rows) => {
          (rows[3] as string[])[1] = "Z";
        }),
      ),
    ],
    ["wrong value", csv(sheet([{ ...edit, newValue: "4224" }]))],
    ["xlsx done", xlsx([edit])],
    ["xlsx date-typed", xlsx([edit], { [ref]: { t: "n", v: 4242, style: "date" } })],
    ["absent", null],
  ];
  for (const [name, persisted] of docs)
    it(name, () => {
      const single = grade({
        fixtureCsv: FIXTURE_BYTES,
        fixtureSha256: sha256(FIXTURE_BYTES),
        persisted,
        intent: edit,
        columnTypes: TYPES,
      });
      expect(gradeMultiStep(input(persisted, [edit])).status).toBe(single.status);
    });
});

describe("multi-step grader: G5 agrees with the gate's calc-multi-step decision on CSV", () => {
  it("pass iff verified over 300 seeded random documents", () => {
    let s = 0x9e3779b9;
    const rand = (n: number) => {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return s % n;
    };
    const spec = { fixtureSeed: SEED, steps: STEPS };
    expect(calcMultiStepFamily.checkSpec(spec)).toBeUndefined();
    const counts = { pass: 0, fail: 0 };
    for (let i = 0; i < 300; i++) {
      const done = STEPS.filter(() => rand(4) !== 0);
      const text = sheet(done, (rows) => {
        const kind = rand(5);
        if (kind === 0) {
          const r = 1 + rand(rows.length - 1);
          (rows[r] as string[])[1 + rand(4)] = `x${rand(9)}`;
        } else if (kind === 1) {
          const t = STEPS[rand(STEPS.length)] as CellEdit;
          const r = rows.findIndex((row) => row[0] === t.rowKey);
          const c = FIXTURE_COLUMNS.findIndex((col) => col.name === t.column);
          (rows[r] as string[])[c] = `${t.newValue}0`;
        }
      });
      const bytes = new TextEncoder().encode(text);
      const g = gradeMultiStep(input(csv(text)));
      const gate = calcMultiStepFamily.decide(bytes, spec, "sheet.csv");
      expect(g.status === "pass", `doc ${i}`).toBe(gate.status === "verified");
      counts[g.status === "pass" ? "pass" : "fail"]++;
    }
    // Both outcomes are exercised.
    expect(counts.pass).toBeGreaterThan(10);
    expect(counts.fail).toBeGreaterThan(10);
  });
});

describe("multi-step grader: G6 and G7 independence", () => {
  it("extra claim, verdict, checkpoint and correction fields change nothing", () => {
    for (const persisted of [csv(sheet(STEPS)), csv(FIXTURE.csv)]) {
      const plain = gradeMultiStep(input(persisted));
      const tainted = gradeMultiStep({
        ...input(persisted),
        claim: "done",
        verdict: "verified",
        checkpoints: { lastVerified: 8 },
        corrections: [{ kind: "target_unchanged" }],
      } as MultiStepGradeInput);
      expect(tainted).toEqual(plain);
    }
  });

  it("imports only ./grade.ts and ./sheet.ts", () => {
    const code = readFileSync(join(ROOT, "src/benchmark/grade/multi-step.ts"), "utf8");
    const specs = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.sort()).toEqual(["./grade.ts", "./sheet.ts"]);
    expect(code).not.toMatch(/import\s*\(|require\s*\(/);
  });
});
