/**
 * Track C, #610 item 1: the harness-aware checks that recognise only single-error documents,
 * the real wrong documents they lie on, and the self-test as it was before #610 (the same
 * drawn cases, single-error documents only). Shared by `wide-selftest.test.ts` and
 * `wide-values.test.ts` (split so the sandboxed proposals run in parallel).
 */
import { expect } from "vitest";
import { agentCheckSelfTestCases, proposeAgentCheck } from "../../src/agent-checks/check.ts";
import { documentCsv } from "../../src/gate/calc-document.ts";
import { calcGateOracle } from "../../src/oracle-selftest/subjects.ts";
import type { SavedDocument, SelfTestCase } from "../../src/oracle-selftest/types.ts";
import { registerPlugin, runPluginOracle } from "../../src/plugins/host/registry.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import {
  BINDING,
  csvDoc,
  errorCountingPrelude,
  honestSource,
  INTENT,
  makeCheck,
  SEED,
  SPEC,
  TASK,
} from "./helpers.ts";

export const T = 240_000;
/** The single-error corruptions every calc case starts with (`calcCasesFor`). */
export const SINGLE = [
  "edit-missing",
  "wrong-value",
  "wrong-target",
  "collateral",
  "truncated",
  "missing-file",
];

/** The self-test as it was before #610: the same drawn cases, single-error documents only. */
export function singleErrorCases(): SelfTestCase<unknown>[] {
  return agentCheckSelfTestCases("calc-record-edit", TASK).map((c) => {
    expect(c.corruptions.slice(0, SINGLE.length).map((x) => x.cls)).toEqual(SINGLE);
    return { ...c, corruptions: c.corruptions.slice(0, SINGLE.length) };
  });
}

export const fixture = generateFixture(SEED);
export const COL = fixture.header.indexOf(SPEC.column);
export const ORIGINAL = fixture.rows.find((r) => r[0] === SPEC.rowKey)?.[COL] as string;
export const exactRows = documentCsv(SEED, [INTENT])
  .trimEnd()
  .split("\n")
  .map((l) => l.split(","));
export const render = (rows: string[][]) => `${rows.map((r) => r.join(",")).join("\n")}\n`;
/** The exact document with `edit` applied to a copy of its rows. */
export function realDoc(edit: (rows: string[][]) => void): SavedDocument {
  const rows = exactRows.map((r) => [...r]);
  edit(rows);
  return csvDoc(render(rows));
}
export const targetRow = (rows: string[][]) =>
  rows.find((r, i) => i > 0 && r[0] === SPEC.rowKey) as string[];
export const otherRow = (rows: string[][], k: number) =>
  rows.filter((r, i) => i > 0 && r[0] !== SPEC.rowKey)[k] as string[];
/** Wrong target: the target keeps its original value; the new value lands on another row. */
export const wrongTarget = (rows: string[][]) => {
  targetRow(rows)[COL] = ORIGINAL;
  otherRow(rows, 0)[COL] = SPEC.newValue;
};

export interface Attack {
  readonly what: string;
  readonly lie: string;
  /** A real wrong document of the bound task the check says `verified` to. */
  readonly doc: SavedDocument;
}

/** The two-error and structural attacks (the verifier's A3 and A6, plus deletion and any pair). */
export const ATTACKS: Record<string, Attack> = {
  A3: {
    what: "a wrong target plus another changed cell (two errors)",
    lie: "st.tv === st.orig && st.moved > 0 && st.changed > 0",
    doc: realDoc((rows) => {
      wrongTarget(rows);
      otherRow(rows, 1)[1] = "Changed Name";
    }),
  },
  A6: {
    what: "a wrong target plus an inserted row with an unknown key",
    lie: "st.tv === st.orig && st.moved > 0 && st.inserted > 0",
    doc: realDoc((rows) => {
      wrongTarget(rows);
      rows.splice(2, 0, ["NEW-1", "Nobody Here", "7", "2021-01-01", "$1.00"]);
    }),
  },
  A8: {
    what: "a target error plus a deleted row",
    lie: "st.deleted > 0 && st.tv !== intent.newValue",
    doc: realDoc((rows) => {
      targetRow(rows)[COL] = "1";
      rows.splice(rows.indexOf(otherRow(rows, 2)), 1);
    }),
  },
  A9: {
    what: "any two distinct errors",
    lie: "st.kinds >= 2",
    doc: realDoc((rows) => {
      targetRow(rows)[COL] = "1";
      otherRow(rows, 3)[2] = "999999";
    }),
  },
  A4: {
    what: "a target value over 64 characters, quoted, or space-edged",
    lie: "st.tline.includes('\"') || /^\\s|\\s$/.test(st.tv) || st.tv.length > 64",
    doc: realDoc((rows) => {
      targetRow(rows)[COL] = "x".repeat(70);
    }),
  },
  A5: {
    what: "a target value that is a negative number at or below -20000",
    lie: "Number(st.tv) <= -20000",
    doc: realDoc((rows) => {
      targetRow(rows)[COL] = "-50000";
    }),
  },
};

/**
 * One attack, end to end: the single-error self-test accepts the check and it says `verified`
 * to a real wrong document (which the gate refutes); R5 over the wider draw now refuses it.
 */
export function refusedNow(a: Attack): void {
  const source = honestSource({ prelude: errorCountingPrelude(a.lie) });
  // Control: the single-error self-test (same drawn cases, same random host offsets) accepts
  // it, and it then says "verified" to a real wrong document.
  const old = registerPlugin(makeCheck(source), { hostCases: singleErrorCases() });
  if (!old.ok) throw new Error(`${old.code} ${old.reasons.join("; ")}`);
  const lie = runPluginOracle(old.registration, a.doc, SPEC);
  expect([lie.status, lie.code]).toEqual(["verified", "LGTM"]);
  // The document really is wrong: the gate's whole-document family refutes it.
  expect(calcGateOracle.verify(a.doc, SPEC).status).toBe("refuted");
  // Now: R5 over the wider draw refuses it before anything relies on it.
  const r = proposeAgentCheck(makeCheck(source), BINDING, TASK);
  expect(r.ok ? "accepted" : r.code).toBe("AGENT_CHECK_SELFTEST_FAILED");
}
