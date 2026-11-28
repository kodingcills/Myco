/**
 * Agent-safe corrections (M2 scope add B: the self-correcting loop).
 *
 * Acceptance bar, by section:
 *  1. supported cases get a closed-schema correction; unsupported cases get none;
 *  2. leakage: planted markers in non-target cells, the sealed fixture, the oracle config
 *     and the operator's paths never reach any agent-facing output (in process, MCP wire,
 *     CLI), and every correction carries only its kind's allowed fields;
 *  3. (`corrections-loop.test.ts`) the end-to-end mock-transport loop;
 *  4. gaming: echoing a correction changes nothing; another task or run gets
 *     ASSIGNMENT_MISMATCH and no correction;
 *  5. the codes-only rule holds on every other reason path: turning corrections on changes
 *     nothing in a result except adding `corrections` on the two admissible paths.
 * No model, no VM, no network.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CORRECTION_CELL_LIMIT,
  CORRECTION_KINDS,
  CORRECTION_VALUE_LIMIT,
  type Correction,
  type GateResult,
} from "../../src/gate/api.ts";
import { targetRef } from "../../src/gate/calc-document.ts";
import { main } from "../../src/gate/cli.ts";
import {
  correctionsAdmissible,
  correctionsEnabled,
  sealCorrections,
} from "../../src/gate/corrections.ts";
import { calcRecordEditFamily, FAMILIES, type OracleFamily } from "../../src/gate/families.ts";
import {
  buildRegistry,
  createGate,
  type EvidenceReader,
  fileEvidenceReader,
  type GateConfig,
  type GateDiagnostic,
  type TaskEntry,
} from "../../src/gate/gate.ts";
import { CORRECTIONS_INSTRUCTIONS, GATE_TOOL, handleLine } from "../../src/gate/mcp-server.ts";
import { MS_SPEC } from "../../src/gate/multistep-demo.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { CALC_SPEC, tempRoot, writeState } from "./helpers.ts";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const TASK = "calc-task";
const RUN = "run-1";
const STATE = "doc.csv";
const NOW = () => new Date("2026-11-26T00:00:00Z");

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

function a1(ref: string): { r: number; c: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  let c = 0;
  for (const ch of m[1] as string) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

/** `csv` with cells set (null clears) by A1 ref; rows/columns grow as needed. */
function withCells(csv: string, cells: Record<string, string | null>): string {
  const rows = csv
    .trimEnd()
    .split("\n")
    .map((l) => l.split(","));
  for (const [ref, value] of Object.entries(cells)) {
    const { r, c } = a1(ref);
    while (rows.length <= r) rows.push([]);
    const row = rows[r] as string[];
    while (row.length <= c) row.push("");
    row[c] = value ?? "";
  }
  return `${rows.map((r) => r.join(",")).join("\n")}\n`;
}

const RECORD_TARGET = targetRef(CALC_SPEC.fixtureSeed, CALC_SPEC);
const PRISTINE = generateFixture(CALC_SPEC.fixtureSeed).csv;
/** A non-target data cell (row 4, column B). */
const OTHER = "B4";

function recordEntry(spec: object = CALC_SPEC, extra: Partial<TaskEntry> = {}): TaskEntry {
  return { id: TASK, family: "calc-record-edit", stateFile: STATE, spec, ...extra };
}

function gateFor(
  root: string,
  opts: {
    entry?: TaskEntry;
    families?: ReadonlyMap<string, OracleFamily>;
    corrections?: boolean;
    onDecision?: GateConfig["onDecision"];
    onDiagnostic?: GateConfig["onDiagnostic"];
    reader?: EvidenceReader;
  } = {},
) {
  const entry = opts.entry ?? recordEntry();
  return createGate({
    tasks: buildRegistry([entry], opts.families ?? FAMILIES),
    reader: opts.reader ?? fileEvidenceReader(root),
    assignment: { taskId: TASK, runId: RUN },
    now: NOW,
    ...(opts.corrections === false ? {} : { corrections: { families: [entry.family] } }),
    ...(opts.onDecision ? { onDecision: opts.onDecision } : {}),
    ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
}

async function checkDoc(doc: string | null, opts: Parameters<typeof gateFor>[1] = {}) {
  const root = tempRoot();
  if (doc !== null) writeState(root, RUN, STATE, doc);
  return gateFor(root, opts).check({ taskId: TASK, runId: RUN });
}

/** Every correction carries exactly its kind's allowed fields. */
const ALLOWED: Record<Correction["kind"], readonly string[]> = {
  target_value_mismatch: [
    "kind",
    "step",
    "cell",
    "record",
    "column",
    "expected",
    "observed",
    "observedTruncated",
  ],
  target_unchanged: ["kind", "step", "cell", "record", "column", "expected"],
  document_not_saved: ["kind", "evidence"],
  collateral_change: ["kind", "cells", "more"],
};
function expectClosedSchema(corrections: readonly Correction[]): void {
  for (const c of corrections) {
    expect(CORRECTION_KINDS).toContain(c.kind);
    for (const key of Object.keys(c)) expect(ALLOWED[c.kind]).toContain(key);
  }
}

// ---------------------------------------------------------------------------
// 1. Supported and unsupported cases
// ---------------------------------------------------------------------------

describe("1. supported cases get a closed-schema correction", () => {
  const where = { cell: RECORD_TARGET, record: "EMP-0002", column: "name", expected: "Gate Ops" };

  it("wrong target value: target_value_mismatch with what the saved cell holds", async () => {
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: "Gate Opz" }));
    expect(result.verdict).toBe("refuted");
    expect(result.corrections).toEqual([
      { kind: "target_value_mismatch", ...where, observed: "Gate Opz" },
    ]);
  });

  it("a cleared target: observed is null", async () => {
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: null }));
    expect(result.corrections).toEqual([
      { kind: "target_value_mismatch", ...where, observed: null },
    ]);
  });

  it("a long observed value is cut to the limit and flagged", async () => {
    const long = "x".repeat(CORRECTION_VALUE_LIMIT + 50);
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: long }));
    expect(result.corrections).toEqual([
      {
        kind: "target_value_mismatch",
        ...where,
        observed: "x".repeat(CORRECTION_VALUE_LIMIT),
        observedTruncated: true,
      },
    ]);
  });

  it("target unchanged (beside a collateral change): no value, only what was asked", async () => {
    const result = await checkDoc(withCells(PRISTINE, { [OTHER]: "Scratch" }));
    expect(result.corrections).toEqual([
      { kind: "target_unchanged", ...where },
      { kind: "collateral_change", cells: [OTHER], more: 0 },
    ]);
  });

  it("document not saved: no file after the agent stopped (uncertain STATE_MISSING)", async () => {
    const result = await checkDoc(null);
    expect(result.verdict).toBe("uncertain");
    expect(result.reasonCodes).toEqual(["STATE_MISSING"]);
    expect(result.corrections).toEqual([{ kind: "document_not_saved", evidence: "no_saved_file" }]);
  });

  it("document not saved: the saved document is the one the agent was given", async () => {
    const result = await checkDoc(PRISTINE);
    expect(result.corrections).toEqual([
      { kind: "document_not_saved", evidence: "saved_file_unchanged" },
    ]);
  });

  it("collateral change alone: addresses only, capped, with the rest counted", async () => {
    const edits: Record<string, string> = { [RECORD_TARGET]: "Gate Ops" };
    for (let r = 20; r < 20 + CORRECTION_CELL_LIMIT + 3; r++) edits[`J${r}`] = "added";
    const result = await checkDoc(withCells(PRISTINE, edits));
    expect(result.corrections).toHaveLength(1);
    const [c] = result.corrections as [Correction];
    expect(c.kind).toBe("collateral_change");
    if (c.kind !== "collateral_change") throw new Error("unreachable");
    expect(c.cells).toHaveLength(CORRECTION_CELL_LIMIT);
    expect(c.more).toBe(3);
    expect(JSON.stringify(c)).not.toContain("added");
  });

  it("multi-step: one correction per missed step, with its step number", async () => {
    const seed = MS_SPEC.fixtureSeed;
    const [s1, s2, s3] = MS_SPEC.steps as [
      (typeof MS_SPEC.steps)[0],
      (typeof MS_SPEC.steps)[0],
      (typeof MS_SPEC.steps)[0],
    ];
    const refs = MS_SPEC.steps.map((s) => targetRef(seed, s));
    const doc = withCells(generateFixture(seed).csv, {
      [refs[0] as string]: s1.newValue,
      [refs[1] as string]: "4224",
    });
    const entry: TaskEntry = {
      id: TASK,
      family: "calc-multi-step",
      stateFile: STATE,
      spec: MS_SPEC,
    };
    const result = await checkDoc(doc, { entry });
    expect(result.checkpoints?.lastVerified).toBe(1);
    expect(result.corrections).toEqual([
      {
        kind: "target_value_mismatch",
        step: 2,
        cell: refs[1],
        record: s2.rowKey,
        column: s2.column,
        expected: s2.newValue,
        observed: "4224",
      },
      {
        kind: "target_unchanged",
        step: 3,
        cell: refs[2],
        record: s3.rowKey,
        column: s3.column,
        expected: s3.newValue,
      },
    ]);
  });
});

describe("1. unsupported cases get none", () => {
  it("verified: none", async () => {
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: "Gate Ops" }));
    expect(result.accepted).toBe(true);
    expect(result).not.toHaveProperty("corrections");
  });

  it("off by default: a refuted result carries none", async () => {
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: "Gate Opz" }), {
      corrections: false,
    });
    expect(result.verdict).toBe("refuted");
    expect(result).not.toHaveProperty("corrections");
  });

  it("the gate's comparison disagreeing with the oracle: none, and the operator is told", async () => {
    // An oracle (same id and version) that names only collateral for a target mismatch.
    const lying: OracleFamily = {
      ...calcRecordEditFamily,
      decide: () => ({ status: "refuted", reasons: ["x"], codes: ["DOCUMENT_COLLATERAL"] }),
    };
    const seen: GateDiagnostic[] = [];
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: "Gate Opz" }), {
      families: new Map([["calc-record-edit", lying]]),
      onDiagnostic: (d) => seen.push(d),
    });
    expect(result.verdict).toBe("refuted");
    expect(result).not.toHaveProperty("corrections");
    expect(seen.map((d) => d.stage)).toEqual(["correction"]);
  });

  it("an oracle refuting a document the gate finds correct: none", async () => {
    const lying: OracleFamily = {
      ...calcRecordEditFamily,
      decide: () => ({ status: "refuted", reasons: ["x"], codes: ["TARGET_MISMATCH"] }),
    };
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: "Gate Ops" }), {
      families: new Map([["calc-record-edit", lying]]),
    });
    expect(result.verdict).toBe("refuted");
    expect(result).not.toHaveProperty("corrections");
  });

  it("an unlogged decision (AUDIT_FAILED) carries none", async () => {
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: "Gate Opz" }), {
      onDecision: () => {
        throw new Error("log down");
      },
    });
    expect(result.reasonCodes).toContain("AUDIT_FAILED");
    expect(result).not.toHaveProperty("corrections");
  });

  it("the decision log sees exactly what the agent sees (corrections included)", async () => {
    const logged: GateResult[] = [];
    const result = await checkDoc(withCells(PRISTINE, { [RECORD_TARGET]: "Gate Opz" }), {
      onDecision: (r) => {
        logged.push(r);
      },
    });
    expect(logged).toEqual([result]);
  });
});

describe("policy: opt-in per family, refused when it cannot be honoured", () => {
  const task = (family: string, version: string, spec: object = {}) =>
    ({
      id: "t",
      family: { id: family, version },
      stateFile: STATE,
      spec,
      specSha256: "0",
    }) as never;

  it("absent or not naming the task's family: off", () => {
    expect(correctionsEnabled(undefined, task("calc-record-edit", "3"))).toBe(false);
    expect(
      correctionsEnabled({ families: ["calc-multi-step"] }, task("calc-record-edit", "3")),
    ).toBe(false);
    expect(
      correctionsEnabled({ families: ["calc-record-edit"] }, task("calc-record-edit", "3")),
    ).toBe(true);
  });

  it("a family without correction support (todo-items, unknown) is refused", () => {
    for (const family of ["todo-items", "bogus"])
      expect(() =>
        correctionsEnabled({ families: [family] }, task("calc-record-edit", "3")),
      ).toThrow(/^invalid gate corrections: family/);
  });

  it("a family version corrections do not mirror is refused (the rule must be the oracle's)", () => {
    expect(() =>
      correctionsEnabled({ families: ["calc-record-edit"] }, task("calc-record-edit", "2")),
    ).toThrow(/not the version corrections mirror/);
  });

  it("a non-CSV persisted format is refused (the gate stays CSV-only for Calc)", () => {
    expect(() =>
      correctionsEnabled(
        { families: ["calc-record-edit"] },
        task("calc-record-edit", "3", { persistedFormat: "xlsx" }),
      ),
    ).toThrow(/corrections read CSV only/);
  });

  it("createGate refuses a bad policy, so a misconfigured gate never starts", () => {
    expect(() =>
      createGate({
        tasks: buildRegistry([recordEntry()]),
        reader: fileEvidenceReader(tempRoot()),
        assignment: { taskId: TASK, runId: RUN },
        corrections: { families: ["todo-items"] },
      }),
    ).toThrow(/^invalid gate corrections/);
  });

  it("the CLI refuses a bad --corrections with usage exit 3", async () => {
    const io = cliIo();
    const tasks = join(tempRoot(), "tasks.json");
    writeFileSync(tasks, JSON.stringify({ tasks: [recordEntry()] }));
    const code = await main(
      [
        "check",
        "--evidence-root",
        tempRoot(),
        "--tasks",
        tasks,
        "--no-builtin",
        "--task",
        TASK,
        "--run",
        RUN,
        "--corrections",
        "todo-items",
      ],
      io,
    );
    expect(code).toBe(3);
    expect(io.err()).toContain("invalid gate corrections");
  });
});

describe("sealCorrections: the closed schema, rebuilt from the spec's targets", () => {
  const targets = [{ cell: "C3", record: "EMP-0002", column: "name", expected: "Gate Ops" }];
  const good = {
    kind: "target_value_mismatch",
    cell: "C3",
    record: "EMP-0002",
    column: "name",
    expected: "Gate Ops",
    observed: "x",
  };

  it("passes well-formed corrections through unchanged", () => {
    expect(sealCorrections([good], targets)).toEqual([good]);
    expect(
      sealCorrections([{ kind: "collateral_change", cells: ["B4"], more: 0 }], targets),
    ).toEqual([{ kind: "collateral_change", cells: ["B4"], more: 0 }]);
  });

  const BAD: [string, unknown][] = [
    ["an extra field", { ...good, pristine: "LEAK" }],
    ["an expected value the instruction did not give", { ...good, expected: "LEAK" }],
    ["a cell the task does not target", { ...good, cell: "B4" }],
    ["a record the task does not name", { ...good, record: "EMP-9999" }],
    ["a step the task does not have", { ...good, step: 2 }],
    ["observed equal to expected (not a mismatch)", { ...good, observed: "Gate Ops" }],
    ["an over-long observed", { ...good, observed: "x".repeat(CORRECTION_VALUE_LIMIT + 1) }],
    ["a non-string observed", { ...good, observed: 5 }],
    ["an unknown kind", { kind: "oracle_says", text: "LEAK" }],
    ["a target_unchanged with a value", { ...good, kind: "target_unchanged" }],
    ["a collateral cell that is a target", { kind: "collateral_change", cells: ["C3"], more: 0 }],
    ["a collateral non-address", { kind: "collateral_change", cells: ["../x"], more: 0 }],
    ["a collateral value", { kind: "collateral_change", cells: ["B4"], more: 0, values: ["x"] }],
    ["a bad evidence", { kind: "document_not_saved", evidence: "LEAK" }],
  ];
  for (const [name, bad] of BAD) {
    it(`drops ALL corrections for ${name}`, () => {
      expect(sealCorrections([good, bad], targets)).toBeUndefined();
    });
  }
});

describe("correctionsAdmissible: only ORACLE_FAIL and STATE_MISSING paths", () => {
  const doc: Correction[] = [{ kind: "collateral_change", cells: ["B4"], more: 0 }];
  const missing: Correction[] = [{ kind: "document_not_saved", evidence: "no_saved_file" }];
  it("admits refuted ORACLE_FAIL document corrections and the uncertain STATE_MISSING one", () => {
    expect(correctionsAdmissible("refuted", false, ["ORACLE_FAIL"], doc)).toBe(true);
    expect(correctionsAdmissible("uncertain", false, ["STATE_MISSING"], missing)).toBe(true);
  });
  it("refuses every other path and every mismatched pairing", () => {
    expect(correctionsAdmissible("verified", true, ["ORACLE_PASS"], doc)).toBe(false);
    expect(correctionsAdmissible("refuted", false, ["ORACLE_FAIL", "AUDIT_FAILED"], doc)).toBe(
      false,
    );
    expect(correctionsAdmissible("refuted", false, ["ORACLE_FAIL"], missing)).toBe(false);
    expect(correctionsAdmissible("uncertain", false, ["STATE_MISSING"], doc)).toBe(false);
    for (const code of [
      "ASSIGNMENT_MISMATCH",
      "STATE_UNREADABLE",
      "STATE_CORRUPT",
      "ORACLE_ERROR",
      "ORACLE_INVALID_OUTPUT",
      "ORACLE_UNCERTAIN",
      "FIXTURE_MISMATCH",
      "INVALID_REQUEST",
    ] as const) {
      expect(correctionsAdmissible("uncertain", false, [code], doc)).toBe(false);
      expect(correctionsAdmissible("uncertain", false, [code], missing)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Leakage
// ---------------------------------------------------------------------------

function cliIo() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (d) => {
    out += String(d);
  });
  stderr.on("data", (d) => {
    err += String(d);
  });
  return { stdin: new PassThrough(), stdout, stderr, out: () => out, err: () => err };
}

// #514 round 1, N1: the MCP instructions announce corrections only when they are on for the
// assigned task, so an R1 (corrections off) agent sees exactly the pre-corrections text.
describe("MCP instructions mention corrections only when they are on (N1)", () => {
  const INIT = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const instructionsOf = (line: string) =>
    String((JSON.parse(line) as { result: { instructions: string } }).result.instructions);
  const anyGate = () =>
    createGate({
      tasks: buildRegistry([recordEntry()]),
      reader: fileEvidenceReader(tempRoot()),
      assignment: { taskId: TASK, runId: RUN },
    });

  it("handleLine: off by default, appended when on", async () => {
    const off = instructionsOf((await handleLine(anyGate(), INIT)) ?? "");
    expect(off).toContain('verdict "verified"');
    expect(off.toLowerCase()).not.toContain("correction");
    const on = instructionsOf((await handleLine(anyGate(), INIT, { corrections: true })) ?? "");
    expect(on).toBe(off + CORRECTIONS_INSTRUCTIONS);
  });

  async function mcpInstructions(extra: string[]): Promise<string> {
    const tasks = join(tempRoot(), "tasks.json");
    writeFileSync(tasks, JSON.stringify({ tasks: [recordEntry()] }));
    const io = cliIo();
    io.stdin.end(`${INIT}\n`);
    const code = await main(
      [
        "mcp",
        "--evidence-root",
        tempRoot(),
        "--tasks",
        tasks,
        "--no-builtin",
        "--task",
        TASK,
        "--run",
        RUN,
        ...extra,
      ],
      io,
    );
    expect(code).toBe(0);
    return instructionsOf(io.out().trim());
  }

  it("CLI mcp: only a policy that covers the assigned task's family announces corrections", async () => {
    expect(await mcpInstructions([])).not.toContain(CORRECTIONS_INSTRUCTIONS);
    expect(await mcpInstructions(["--corrections", "calc-record-edit"])).toContain(
      CORRECTIONS_INSTRUCTIONS,
    );
    // A valid policy for another family: corrections are off for this task, so no mention.
    expect(await mcpInstructions(["--corrections", "calc-multi-step"])).not.toContain(
      CORRECTIONS_INSTRUCTIONS,
    );
  });
});

describe("2. leakage: planted markers never reach agent-facing output", () => {
  // The operator's side, with a marker everywhere the agent must not see.
  const base = mkdtempSync(join(tmpdir(), "myco-LEAKROOTMARKER-"));
  const root = join(base, "evidence");
  const seed = "leakseedmarker";
  const fixtureFile = "fixture.csv";
  const generated = generateFixture(seed);
  const header = generated.header;
  const nameCol = header.indexOf("name");
  const target = targetRef(seed, { rowKey: "EMP-0002", column: "name", newValue: "Gate Ops" });
  const targetRow = a1(target).r;
  // Sealed fixture: every non-target `name` cell holds a fixture marker, the target cell holds
  // a pristine-target marker. Header and record keys stay where the seed puts them.
  const fixtureRows = [header, ...generated.rows].map((row, r) =>
    r === 0
      ? [...row]
      : row.map((v, c) =>
          c !== nameCol ? v : r === targetRow ? "LEAKPRISTINETARGET" : `LEAKFIXMARK${r}`,
        ),
  );
  const fixture = `${fixtureRows.map((r) => r.join(",")).join("\n")}\n`;
  const fixtureSha256 = sha(fixture);
  const spec = { fixtureSeed: seed, rowKey: "EMP-0002", column: "name", newValue: "Gate Ops" };
  const entry = recordEntry({ ...spec, fixtureFile, fixtureSha256 }, { title: "LEAKTITLEMARKER" });
  const tasksFile = join(base, "LEAKTASKSFILEMARKER-tasks.json");
  const auditFile = join(base, "LEAKAUDITMARKER.jsonl");
  mkdirSync(root, { recursive: true });
  writeFileSync(tasksFile, JSON.stringify({ tasks: [entry] }));
  const collateralCell = `${String.fromCharCode(65 + nameCol)}5`;

  /** The saved documents, one per supported correction kind (plus combinations). */
  const SCENARIOS: [string, string | null, Correction["kind"][]][] = [
    ["wrong target", withCells(fixture, { [target]: "Gate Opz" }), ["target_value_mismatch"]],
    [
      "target unchanged, a marker cell overwritten by an agent marker",
      withCells(fixture, { [collateralCell]: "LEAKAGENTNONTARGET" }),
      ["target_unchanged", "collateral_change"],
    ],
    [
      "collateral only: a marker cell cleared, an agent marker added",
      withCells(fixture, { [target]: "Gate Ops", [collateralCell]: null, K40: "LEAKAGENTADDED" }),
      ["collateral_change"],
    ],
    ["saved unchanged", fixture, ["document_not_saved"]],
    ["not saved", null, ["document_not_saved"]],
  ];
  const FORBIDDEN = [
    "LEAKROOTMARKER",
    "LEAKTASKSFILEMARKER",
    "LEAKAUDITMARKER",
    "LEAKTITLEMARKER",
    seed,
    "LEAKFIXMARK",
    "LEAKPRISTINETARGET",
    "LEAKAGENT",
    base,
  ];
  /** Additionally never inside a correction (they are in evidenceRefs by the v1 contract). */
  const NEVER_IN_CORRECTIONS = [fixtureSha256, fixtureFile, STATE, "fixture", "sha256", "/"];

  const kinds = new Set<string>();
  SCENARIOS.forEach(([name, doc, want], index) => {
    it(`${name}: in process, MCP wire and CLI carry only the allowed fields`, async () => {
      const runId = `leak-${index}`;
      mkdirSync(join(root, runId), { recursive: true });
      writeFileSync(join(root, runId, fixtureFile), fixture);
      if (doc !== null) writeFileSync(join(root, runId, STATE), doc);
      const gate = createGate({
        tasks: buildRegistry([entry]),
        reader: fileEvidenceReader(root),
        assignment: { taskId: TASK, runId },
        corrections: { families: ["calc-record-edit"] },
      });
      const request = { taskId: TASK, runId, claim: "done" };

      const direct = await gate.check(request);
      const wire =
        (await handleLine(
          gate,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: GATE_TOOL, arguments: request },
          }),
        )) ?? "";
      const viaMcp = (JSON.parse(wire) as { result: { structuredContent: GateResult } }).result
        .structuredContent;
      const cliArgs = [
        "check",
        "--evidence-root",
        root,
        "--tasks",
        tasksFile,
        "--no-builtin",
        "--task",
        TASK,
        "--run",
        runId,
        "--claim",
        "done",
        "--audit",
        auditFile,
        "--corrections",
        "calc-record-edit",
      ];
      const jsonIo = cliIo();
      await main([...cliArgs, "--json"], jsonIo);
      const textIo = cliIo();
      await main(cliArgs, textIo);
      const viaCli = JSON.parse(jsonIo.out()) as GateResult;

      for (const result of [direct, viaMcp, viaCli]) {
        const corrections = result.corrections ?? [];
        expect(corrections.map((c) => c.kind)).toEqual(want);
        expectClosedSchema(corrections);
        for (const c of corrections) kinds.add(c.kind);
        const inCorrections = JSON.stringify(corrections);
        for (const text of [...FORBIDDEN, ...NEVER_IN_CORRECTIONS])
          expect(inCorrections, `correction carries ${text}`).not.toContain(text);
      }
      for (const output of [JSON.stringify(direct), wire, jsonIo.out(), textIo.out()])
        for (const text of FORBIDDEN)
          expect(output, `agent-facing output carries ${text}`).not.toContain(text);
      // The text CLI shows the same corrections.
      for (const c of direct.corrections ?? [])
        expect(textIo.out()).toContain(`correction: ${JSON.stringify(c)}`);
    });
  });

  it("every correction kind was exercised by the leakage scenarios", () => {
    expect([...kinds].sort()).toEqual([...CORRECTION_KINDS].sort());
  });

  it("the only values a correction carries: the requested value and the agent's own target cell", async () => {
    const runId = "leak-values";
    mkdirSync(join(root, runId), { recursive: true });
    writeFileSync(join(root, runId, fixtureFile), fixture);
    writeFileSync(
      join(root, runId, STATE),
      withCells(fixture, { [target]: "Agent Typed", [collateralCell]: "LEAKAGENTNONTARGET" }),
    );
    const result = await createGate({
      tasks: buildRegistry([entry]),
      reader: fileEvidenceReader(root),
      assignment: { taskId: TASK, runId },
      corrections: { families: ["calc-record-edit"] },
    }).check({ taskId: TASK, runId });
    const strings = JSON.stringify(result.corrections)
      .match(/"(?:[^"\\]|\\.)*"/g)
      ?.map((s) => JSON.parse(s) as string);
    const allowed = new Set([
      ...Object.values(ALLOWED).flat(),
      ...CORRECTION_KINDS,
      target,
      collateralCell,
      "EMP-0002",
      "name",
      "Gate Ops",
      "Agent Typed",
    ]);
    for (const s of strings ?? []) expect(allowed, `unexpected string ${s}`).toContain(s);
  });
});

// ---------------------------------------------------------------------------
// 4. Gaming (in process; the spawned-MCP versions are in corrections-loop.test.ts)
// ---------------------------------------------------------------------------

describe("4. gaming", () => {
  const wrong = withCells(PRISTINE, { [RECORD_TARGET]: "Gate Opz" });

  it("echoing the correction back (claim, or into another cell) leaves the verdict refuted", async () => {
    const root = tempRoot();
    writeState(root, RUN, STATE, wrong);
    const gate = gateFor(root);
    const first = await gate.check({ taskId: TASK, runId: RUN });
    const echo = JSON.stringify(first.corrections);
    const second = await gate.check({ taskId: TASK, runId: RUN, claim: echo });
    expect(second.verdict).toBe("refuted");
    expect(second.corrections).toEqual(first.corrections);
    // Writing the correction's text into a non-target cell is collateral, still refuted.
    writeState(root, RUN, STATE, withCells(wrong, { [OTHER]: "expected Gate Ops" }));
    const third = await gate.check({ taskId: TASK, runId: RUN, claim: echo });
    expect(third.verdict).toBe("refuted");
    expect(third.corrections?.map((c) => c.kind)).toEqual([
      "target_value_mismatch",
      "collateral_change",
    ]);
  });

  it("sending corrections or an expected value in the request is rejected, with none", async () => {
    const root = tempRoot();
    writeState(root, RUN, STATE, wrong);
    const gate = gateFor(root);
    const first = await gate.check({ taskId: TASK, runId: RUN });
    const asField = await gate.check({ taskId: TASK, runId: RUN, corrections: first.corrections });
    expect(asField.reasonCodes).toEqual(["UNKNOWN_FIELD"]);
    expect(asField).not.toHaveProperty("corrections");
    const asExpected = await gate.check({ taskId: TASK, runId: RUN, expected: "Gate Opz" });
    expect(asExpected.reasonCodes).toEqual(["ORACLE_INPUT_REJECTED"]);
    expect(asExpected).not.toHaveProperty("corrections");
  });

  it("another taskId or runId: ASSIGNMENT_MISMATCH and no correction", async () => {
    const root = tempRoot();
    writeState(root, RUN, STATE, wrong);
    writeState(root, "run-2", STATE, wrong);
    const gate = gateFor(root);
    for (const request of [
      { taskId: TASK, runId: "run-2" },
      { taskId: "other-task", runId: RUN },
      { taskId: "other-task", runId: "run-2" },
    ]) {
      const result = await gate.check(request);
      expect(result.reasonCodes).toEqual(["ASSIGNMENT_MISMATCH"]);
      expect(result).not.toHaveProperty("corrections");
      expect(result.evidenceRefs).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The codes-only rule on every other reason path
// ---------------------------------------------------------------------------

describe("5. corrections change nothing but the correction field, on every reason path", () => {
  const wrong = withCells(PRISTINE, { [RECORD_TARGET]: "Gate Opz" });
  const sealedSpec = (bytes: string) => ({
    ...CALC_SPEC,
    fixtureFile: "fixture.csv",
    fixtureSha256: sha(bytes),
  });
  const withFamily = (decide: OracleFamily["decide"]) =>
    new Map([["calc-record-edit", { ...calcRecordEditFamily, decide }]]);

  interface Path {
    readonly name: string;
    readonly code: string;
    readonly setup: (root: string) => void;
    readonly request?: unknown;
    readonly entry?: TaskEntry;
    readonly families?: ReadonlyMap<string, OracleFamily>;
    readonly onDecision?: GateConfig["onDecision"];
    readonly corrected?: true;
  }
  const req = { taskId: TASK, runId: RUN, claim: "done" };
  const PATHS: Path[] = [
    { name: "not an object", code: "INVALID_REQUEST", setup: () => {}, request: "x" },
    { name: "unknown field", code: "UNKNOWN_FIELD", setup: () => {}, request: { ...req, a: 1 } },
    {
      name: "oracle input",
      code: "ORACLE_INPUT_REJECTED",
      setup: () => {},
      request: { ...req, cells: {} },
    },
    {
      name: "api version",
      code: "UNSUPPORTED_API_VERSION",
      setup: () => {},
      request: { ...req, apiVersion: "myco.gate/v0" },
    },
    {
      name: "assignment",
      code: "ASSIGNMENT_MISMATCH",
      setup: (root) => writeState(root, "run-2", STATE, wrong),
      request: { ...req, runId: "run-2" },
    },
    { name: "missing", code: "STATE_MISSING", setup: () => {}, corrected: true },
    {
      name: "unreadable",
      code: "STATE_UNREADABLE",
      setup: (root) => mkdirSync(join(root, RUN, STATE), { recursive: true }),
    },
    {
      name: "corrupt",
      code: "STATE_CORRUPT",
      setup: (root) => writeState(root, RUN, STATE, new Uint8Array([0xff, 0xfe, 0x41])),
    },
    {
      name: "fixture unreadable",
      code: "FIXTURE_UNREADABLE",
      setup: (root) => writeState(root, RUN, STATE, wrong),
      entry: recordEntry(sealedSpec(PRISTINE)),
    },
    {
      name: "fixture mismatch",
      code: "FIXTURE_MISMATCH",
      setup: (root) => {
        writeState(root, RUN, STATE, wrong);
        writeState(root, RUN, "fixture.csv", `${PRISTINE}x\n`);
      },
      entry: recordEntry(sealedSpec(PRISTINE)),
    },
    {
      name: "oracle error (fixture does not hold the record)",
      code: "ORACLE_ERROR",
      setup: (root) => {
        writeState(root, RUN, STATE, wrong);
        writeState(root, RUN, "fixture.csv", "a,b\n");
      },
      entry: recordEntry(sealedSpec("a,b\n")),
    },
    {
      name: "oracle invalid output",
      code: "ORACLE_INVALID_OUTPUT",
      setup: (root) => writeState(root, RUN, STATE, wrong),
      families: withFamily(() => ({ status: "maybe" }) as never),
    },
    {
      name: "oracle uncertain",
      code: "ORACLE_UNCERTAIN",
      setup: (root) => writeState(root, RUN, STATE, wrong),
      families: withFamily(() => ({ status: "uncertain", reasons: ["?"] })),
    },
    {
      name: "audit failed",
      code: "AUDIT_FAILED",
      setup: (root) => writeState(root, RUN, STATE, wrong),
      onDecision: () => {
        throw new Error("log down");
      },
    },
    {
      name: "verified",
      code: "ORACLE_PASS",
      setup: (root) =>
        writeState(root, RUN, STATE, withCells(PRISTINE, { [RECORD_TARGET]: "Gate Ops" })),
    },
    {
      name: "refuted",
      code: "ORACLE_FAIL",
      setup: (root) => writeState(root, RUN, STATE, wrong),
      corrected: true,
    },
  ];

  for (const path of PATHS) {
    it(`${path.code} (${path.name})`, async () => {
      const results: GateResult[] = [];
      for (const corrections of [false, true]) {
        const root = tempRoot();
        path.setup(root);
        const gate = gateFor(root, {
          corrections,
          ...(path.entry ? { entry: path.entry } : {}),
          ...(path.families ? { families: path.families } : {}),
          ...(path.onDecision ? { onDecision: path.onDecision } : {}),
        });
        results.push(await gate.check(path.request ?? req));
      }
      const [off, on] = results as [GateResult, GateResult];
      expect(off.reasonCodes).toContain(path.code);
      expect(off).not.toHaveProperty("corrections");
      const { corrections, ...rest } = on;
      // Identical verdict, codes, reasons, refs, request, oracle and checkpoints.
      expect(rest).toEqual(off);
      if (path.corrected) expect(corrections?.length).toBeGreaterThan(0);
      else expect(on).not.toHaveProperty("corrections");
      // Reasons stay codes and cell refs: the agent's typed value never enters them.
      for (const reason of on.reasons) expect(reason).not.toContain("Gate Opz");
    });
  }
});
