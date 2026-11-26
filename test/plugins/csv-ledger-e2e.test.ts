/**
 * Capability track T, $0 end-to-end: a scripted agent (no model, no API) does ledger tasks
 * through the example plugin. It reads typed state with the plugin's READER to find its
 * target, edits the file, the harness captures the saved bytes, and the plugin's ORACLE
 * judges the capture. A separate checker written here (`independentGrade`, which imports
 * nothing from the plugin) grades the same bytes, which is the plugin-vs-grader agreement the
 * measurement bar uses. The scripted agent does use the plugin's `parseLedger`/`renderLedger`
 * to make its edits; only the checker is independent of the plugin.
 *
 * Every row here is simulated: it is never evidence for any bar.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LedgerIntent,
  ledgerRows,
  parseLedger,
  renderLedger,
  verifyLedger,
} from "../../examples/plugins/csv-ledger/plugin.ts";
import {
  type PluginRegistration,
  registerPlugin,
  runPluginOracle,
  runPluginReader,
} from "../../src/plugins/host/registry.ts";
import type { StateCell } from "../../src/plugins/sdk/protocol.ts";
import { EXAMPLE_DIR } from "./helpers.ts";

const HEADER = ["id", "payee", "amount", "category"];

let reg: PluginRegistration;
let work: string;

beforeAll(() => {
  const r = registerPlugin(EXAMPLE_DIR);
  if (!r.ok) throw new Error(`example did not register: ${r.code} ${r.reasons.join("; ")}`);
  reg = r.registration;
  work = mkdtempSync(join(tmpdir(), "myco-ledger-e2e-"));
}, 60_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

type Behaviour = "correct" | "neighbour-row" | "crash-mid-save" | "never-saved";

/** The scripted agent: locate the target through the reader's typed cells, then edit. */
function scriptedAgent(path: string, intent: LedgerIntent, behaviour: Behaviour): void {
  const reading = runPluginReader(reg, { fileName: path, bytes: readFileSync(path) });
  if (reading.status !== "ok" || reading.state?.kind !== "cells") throw new Error("no state");
  const cells = reading.state.cells;
  const col = cells.find(
    (c: StateCell) => c.ref.endsWith("1") && c.ref.length === 2 && c.value === intent.column,
  );
  const rowCell = cells.find(
    (c: StateCell) => c.ref.startsWith("A") && c.ref !== "A1" && String(c.value) === intent.id,
  );
  if (col === undefined || rowCell === undefined) throw new Error("target not found in state");
  const colIndex = col.ref.charCodeAt(0) - 65;
  const rowIndex = Number(rowCell.ref.slice(1)) - 2;
  const p = parseLedger(readFileSync(path));
  if (!p.ok) throw new Error("unreadable");
  const rows = p.rows.map((r) => [...r]);
  if (behaviour === "never-saved") return;
  const target = behaviour === "neighbour-row" ? (rowIndex + 1) % rows.length : rowIndex;
  (rows[target] as string[])[colIndex] = intent.value;
  const text = renderLedger(p.header, rows);
  writeFileSync(
    path,
    behaviour === "crash-mid-save" ? text.slice(0, Math.floor(text.length * 0.6)) : text,
  );
}

/** An independent checker for this test (reads the CSV its own way; never imports the plugin's oracle). */
function independentGrade(bytes: Buffer, intent: LedgerIntent): "pass" | "fail" | "ungradable" {
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) !== "" || !/^#rows,\d+$/.test(lines.at(-2) ?? "")) return "ungradable";
  const data = lines.slice(1, -2).map((l) => l.split(","));
  if (data.length !== Number((lines.at(-2) as string).split(",")[1])) return "ungradable";
  const col = (lines[0] as string).split(",").indexOf(intent.column);
  const row = data.find((r) => r[0] === intent.id);
  return row !== undefined && col >= 0 && row[col] === intent.value ? "pass" : "fail";
}

const TASKS: { intent: LedgerIntent; behaviour: Behaviour; expected: string; grade: string }[] = [
  {
    intent: { id: "3", column: "amount", value: "999" },
    behaviour: "correct",
    expected: "verified",
    grade: "pass",
  },
  {
    intent: { id: "1", column: "payee", value: "Florist" },
    behaviour: "correct",
    expected: "verified",
    grade: "pass",
  },
  {
    intent: { id: "2", column: "category", value: "gifts" },
    behaviour: "neighbour-row",
    expected: "refuted",
    grade: "fail",
  },
  {
    intent: { id: "4", column: "amount", value: "12" },
    behaviour: "crash-mid-save",
    expected: "uncertain",
    grade: "ungradable",
  },
  {
    intent: { id: "5", column: "amount", value: "77" },
    behaviour: "never-saved",
    expected: "refuted",
    grade: "fail",
  },
];

describe("csv-ledger end to end with a scripted agent ($0, simulated)", () => {
  it.each(TASKS.map((t, i) => [i, t] as const))(
    "task %i",
    (i, t) => {
      const path = join(work, `trial-${i}.csv`);
      writeFileSync(path, renderLedger(HEADER, ledgerRows(i + 2, 6)));
      scriptedAgent(path, t.intent, t.behaviour);
      const captured = readFileSync(path); // the harness's per-trial capture
      const verdict = runPluginOracle(reg, { fileName: path, bytes: captured }, t.intent);
      expect(verdict.status).toBe(t.expected);
      expect(verdict.provenance?.plugin).toBe("csv-ledger");
      expect(verdict.r1Evidence).toBe(false);
      const grade = independentGrade(captured, t.intent);
      expect(grade).toBe(t.grade);
      // The one thing a plugin oracle must never do: verified where the grader does not pass.
      if (verdict.status === "verified") expect(grade).toBe("pass");
    },
    30_000,
  );

  it("the in-process oracle and the sandboxed one agree (the sandbox changes nothing)", () => {
    const bytes = new TextEncoder().encode(renderLedger(HEADER, ledgerRows(3, 4)));
    const intent = { id: "2", column: "payee", value: "nobody" };
    expect(runPluginOracle(reg, { fileName: "x.csv", bytes }, intent).status).toBe(
      verifyLedger({ fileName: "x.csv", bytes }, intent).status,
    );
  }, 30_000);
});

describe("csv-ledger oracle unit cases", () => {
  const ok = renderLedger(HEADER, ledgerRows(1, 3));
  const doc = (s: string) => ({ fileName: "l.csv", bytes: new TextEncoder().encode(s) });
  it.each([
    ["missing file", null, "uncertain"],
    ["no final newline", ok.slice(0, -1), "uncertain"],
    ["wrong trailer count", ok.replace("#rows,3", "#rows,4"), "uncertain"],
    ["ragged row", ok.replace("\n2,", "\n2,extra,"), "uncertain"],
    ["quoted field", ok.replace("Grocer", '"Grocer"'), "uncertain"],
    ["invalid utf-8", "\xff", "uncertain"],
    ["duplicate id", ok.replace("\n2,", "\n1,"), "uncertain"],
  ])("%s is %s", (_l, text, status) => {
    const d =
      text === null
        ? { fileName: "l.csv", bytes: null }
        : text === "\xff"
          ? { fileName: "l.csv", bytes: new Uint8Array([0xff, 0x0a]) }
          : doc(text);
    expect(verifyLedger(d, { id: "1", column: "payee", value: "x" }).status).toBe(status);
  });
  it("a missing target row or column is refuted", () => {
    expect(verifyLedger(doc(ok), { id: "99", column: "payee", value: "x" })).toEqual({
      status: "refuted",
      code: "TARGET_ROW_MISSING",
    });
    expect(verifyLedger(doc(ok), { id: "1", column: "nope", value: "x" }).code).toBe(
      "TARGET_COLUMN_MISSING",
    );
  });
});
