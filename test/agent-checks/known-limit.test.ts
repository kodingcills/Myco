/**
 * Track C, #610 item 2 (nit 3 of #590's final verdict): the documented limit, executed.
 *
 * R5's draw is wide but finite (docs §5): no drawn document carries three errors, or more than
 * one inserted row. A check that is honest on everything the draw produces and says `verified`
 * to a document with a target error plus two inserted rows passes R5, and then lies on that real
 * document. This test shows both, so the docs' claim is executed rather than stated, and then
 * shows the lying signal reaches nothing: the gate refutes the document, the grader fails it,
 * and `checkBenchmark`, `checkPack` and `checkAbPack` refuse any row that carries the signal.
 *
 * If a future draw covers this shape, the first test fails: move the shape into
 * `wide-selftest.test.ts` as a refusal and pick a new known limit here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AgentCheckSignal,
  proposeAgentCheck,
  runAgentCheck,
} from "../../src/agent-checks/check.ts";
import { checkBenchmark } from "../../src/benchmark/check.ts";
import { type ColumnType, grade, sha256 } from "../../src/benchmark/grade/grade.ts";
import { buildRegistry, createGate, fileEvidenceReader } from "../../src/gate/gate.ts";
import { checkAbPack, readAbPack } from "../../src/m2/ab-pack.ts";
import { checkPack } from "../../src/m2/evidence.ts";
import { FIXTURE_COLUMNS } from "../../src/tasks/fixture.ts";
import { tempRoot, writeState } from "../gate/helpers.ts";
import { writeAbPack } from "../m2/ab-fixture.ts";
import { input, manifest, r1Trials } from "../m2/pack-fixture.ts";
import {
  BINDING,
  cleanupPlugins,
  errorCountingPrelude,
  honestSource,
  makeCheck,
  SPEC,
  TASK,
} from "./helpers.ts";
import { COL, fixture, ORIGINAL, otherRow, realDoc, T, targetRow } from "./wide-attacks.ts";

const roots: string[] = [];
afterAll(() => {
  cleanupPlugins();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Lies on a target error plus two or more inserted rows: three errors, never drawn. */
const LIMIT = honestSource({
  prelude: errorCountingPrelude("st.inserted >= 2 && st.tv !== intent.newValue"),
});
/** The real document it lies on: the wrong target, and two rows nobody asked for. */
const threeErrors = realDoc((rows) => {
  targetRow(rows)[COL] = ORIGINAL;
  otherRow(rows, 0)[COL] = SPEC.newValue;
  rows.push(["NEW-1", "Nobody Here", "7", "2021-01-01", "$1.00"]);
  rows.push(["NEW-2", "Nobody Else", "8", "2021-01-02", "$2.00"]);
});
const csv = Buffer.from(threeErrors.bytes as Uint8Array).toString("utf8");

let signal: AgentCheckSignal;
beforeAll(() => {
  const r = proposeAgentCheck(makeCheck(LIMIT), BINDING, TASK);
  if (!r.ok) throw new Error(`the known limit is no longer a limit: ${r.code}`);
  signal = runAgentCheck(r.check, BINDING, threeErrors, SPEC);
}, T);

describe("#610 item 2: the known limit, executed", () => {
  it("a check that lies only on three-error documents passes R5 and lies on a real one", () => {
    expect(signal.provenance?.selftest.pass).toBe(true);
    expect([signal.status, signal.code, signal.codeSource]).toEqual(["verified", "LGTM", "check"]);
    // The label stays on the lie: advisory, never evidence.
    expect([signal.advisory, signal.r1Evidence, signal.evidenceClass]).toEqual([
      true,
      false,
      "agent-written-advisory",
    ]);
  });

  it("the gate refutes the document, and with the signal in the request it does not run", async () => {
    const root = tempRoot();
    writeState(root, BINDING.runId, "sheet.csv", csv);
    const gate = createGate({
      tasks: buildRegistry([
        { id: BINDING.taskId, family: "calc-record-edit", stateFile: "sheet.csv", spec: SPEC },
      ]),
      reader: fileEvidenceReader(root),
      assignment: { taskId: BINDING.taskId, runId: BINDING.runId },
    });
    const base = { taskId: BINDING.taskId, runId: BINDING.runId };
    expect((await gate.check(base)).verdict).toBe("refuted");
    const smuggled = await gate.check({ ...base, agentCheck: signal });
    expect([smuggled.verdict, smuggled.accepted, smuggled.reasonCodes]).toEqual([
      "uncertain",
      false,
      ["UNKNOWN_FIELD"],
    ]);
  });

  it("the grader fails the document, with or without the signal attached", () => {
    const fixtureCsv = Buffer.from(fixture.csv);
    const g = {
      fixtureCsv,
      fixtureSha256: sha256(fixtureCsv),
      persisted: { format: "csv" as const, bytes: Buffer.from(csv) },
      intent: { rowKey: SPEC.rowKey, column: SPEC.column, newValue: SPEC.newValue },
      columnTypes: Object.fromEntries(FIXTURE_COLUMNS.map((c) => [c.name, c.type])) as Record<
        string,
        ColumnType
      >,
    };
    const plain = grade(g);
    expect(plain.status).toBe("fail");
    expect(grade({ ...g, agentCheck: signal, status: "pass" } as never)).toEqual(plain);
  });

  it("checkBenchmark, checkPack and checkAbPack refuse any row carrying the lying signal", () => {
    const AGENT = /agent-written check signal.*advisory only, never evidence/;
    for (const evidence of [false, true]) {
      const r = checkBenchmark([{ agentCheck: signal }], [], { expectTrials: {}, evidence });
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(AGENT);
    }
    const pack = input(r1Trials(), manifest());
    const ops = pack.ops as Record<string, unknown>[];
    const p = checkPack({ ...pack, ops: [{ ...ops[0], agentCheck: signal }, ...ops.slice(1)] });
    expect(p.ok).toBe(false);
    expect(p.errors.join("\n")).toMatch(AGENT);
    const root = mkdtempSync(join(tmpdir(), "track-c-limit-"));
    roots.push(root);
    const ab = readAbPack(writeAbPack("m2-ab-limit", { stage: 1 }, root), root);
    expect(checkAbPack(ab).ok).toBe(true);
    const a = checkAbPack({ ...ab, on: { ...ab.on, arm: [...ab.on.arm, signal] } });
    expect(a.ok).toBe(false);
    expect(a.errors.join("\n")).toMatch(AGENT);
  });
});
