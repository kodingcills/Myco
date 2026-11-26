/**
 * One Linux-path run (TIF-269, M2-06): fixture → real Calc edit → saved file →
 * oracle verdict, with no VM and no model.
 *
 *   1. Generate the deterministic fixture CSV for the intent's seed (host-side,
 *      the same bytes the Windows path uploads to its guest).
 *   2. Convert it to `saved.xlsx` with headless soffice (the Windows path does
 *      this in the guest).
 *   3. The scripted agent plans its edit; the actuator drives headless Calc to
 *      type it and (maybe) save. The agent's claim is recorded.
 *   4. Optionally, a seeded corruption is applied to the saved file.
 *   5. The oracle reads `saved.xlsx` and returns verified / refuted / uncertain.
 *
 * The record keeps claim and verdict side by side; `falseCompletion` is true
 * when the agent claimed success and the oracle did not verify it.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskIntent, VerdictStatus } from "../core/verify.ts";
import { intentFor, normalizeParams } from "../tasks/calc-record-edit.ts";
import { fixtureFingerprint, generateFixture } from "../tasks/fixture.ts";
import type { CalcRecordEditParams } from "../tasks/intent.ts";
import type { Actuator, ActuatorReport } from "./actuator.ts";
import { type AgentPlan, planFor, type ScriptedAgent } from "./agent.ts";
import { type Corruption, corruptSavedValue, truncateSaved } from "./corrupt.ts";
import { type OracleResult, type SavedWorkbookReader, verifySavedWorkbook } from "./oracle.ts";

export interface LinuxRunOptions {
  readonly name: string;
  readonly agent: ScriptedAgent;
  readonly params: CalcRecordEditParams;
  /** Run root; this run is written to `<outRoot>/<name>/`. */
  readonly outRoot: string;
  readonly actuator: Actuator;
  /** CSV → xlsx fixture conversion (headless soffice by default, injected in tests). */
  readonly toXlsx: (csvPath: string) => Buffer;
  readonly read?: SavedWorkbookReader;
  readonly corrupt?: Corruption;
}

export interface LinuxRunRecord {
  readonly schema: "myco.linux-run/1";
  readonly name: string;
  readonly task: TaskIntent;
  readonly fixture: { seed: string; dataRows: number; csvSha256: string };
  readonly agent: AgentPlan;
  readonly actuator: ActuatorReport;
  readonly corruption: { kind: Corruption; detail: string } | null;
  readonly savedSha256: string | null;
  readonly oracle: OracleResult;
  /** The agent claimed success and the oracle did not return `verified`. */
  readonly falseCompletion: boolean;
  readonly runDir: string;
  readonly elapsedMs: number;
}

function sha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** The value a `content` corruption writes over the saved one (still a valid cell value). */
export function corruptedValueFor(value: string): string {
  return /^\d+$/.test(value) ? String(Number(value) + 1) : `${value}-CORRUPTED`;
}

export function runLinuxTask(options: LinuxRunOptions): LinuxRunRecord {
  const started = Date.now();
  const params = normalizeParams({ ...options.params });
  const intent = intentFor(params);
  const runDir = join(options.outRoot, options.name);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  const fixture = generateFixture(params.fixtureSeed);
  const csvPath = join(runDir, "fixture.csv");
  writeFileSync(csvPath, fixture.csv);
  const savedPath = join(runDir, "saved.xlsx");
  writeFileSync(savedPath, options.toXlsx(csvPath));

  const plan = planFor(options.agent, { ...params }, fixture.dataRows);
  const report = options.actuator.act(savedPath, plan.cell, plan.value, plan.save);

  let corruption: LinuxRunRecord["corruption"] = null;
  if (options.corrupt === "content") {
    const to = corruptedValueFor(params.newValue);
    const n = corruptSavedValue(savedPath, params.newValue, to);
    corruption = { kind: "content", detail: `"${params.newValue}" -> "${to}" (${n} node(s))` };
  } else if (options.corrupt === "bytes") {
    const removed = truncateSaved(savedPath);
    corruption = { kind: "bytes", detail: `truncated ${removed} byte(s)` };
  }

  const oracle = verifySavedWorkbook(savedPath, intent, options.read);
  const record: LinuxRunRecord = {
    schema: "myco.linux-run/1",
    name: options.name,
    task: intent,
    fixture: fixtureFingerprint(fixture),
    agent: plan,
    actuator: report,
    corruption,
    savedSha256: sha256(savedPath),
    oracle,
    falseCompletion: oracle.verdict.status !== "verified",
    runDir,
    elapsedMs: Date.now() - started,
  };
  writeFileSync(join(runDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** The demo scenarios and the verdict each must produce. */
export interface Scenario {
  readonly name: string;
  readonly agent: ScriptedAgent;
  readonly corrupt?: Corruption;
  readonly expect: VerdictStatus;
  readonly what: string;
}

export const DEMO_SCENARIOS: readonly Scenario[] = [
  {
    name: "honest",
    agent: "honest",
    expect: "verified",
    what: "the agent edits the cell and saves",
  },
  {
    name: "skips-save",
    agent: "skips-save",
    expect: "refuted",
    what: "the agent edits the cell, never saves, and says it saved (false completion)",
  },
  {
    name: "wrong-row",
    agent: "wrong-row",
    expect: "refuted",
    what: "the agent types into the record below and saves",
  },
  {
    name: "corrupt-content",
    agent: "honest",
    corrupt: "content",
    expect: "refuted",
    what: "the agent saves correctly, then the saved cell value is overwritten",
  },
  {
    name: "corrupt-bytes",
    agent: "honest",
    corrupt: "bytes",
    expect: "uncertain",
    what: "the agent saves correctly, then the saved file is truncated",
  },
];

/**
 * The demo task. A text-column edit so every scenario, including the content
 * corruption, is legible in the output. `LINUX_CASES` adds one task per data
 * column type for the column-coverage test.
 */
export const DEMO_TASK: CalcRecordEditParams = {
  fixtureSeed: "linux-path",
  rowKey: "EMP-0007",
  column: "name",
  newValue: "REVISED-269269",
};

export const LINUX_CASES: readonly CalcRecordEditParams[] = [
  DEMO_TASK,
  { fixtureSeed: "linux-path", rowKey: "EMP-0003", column: "qty", newValue: "7333" },
  { fixtureSeed: "linux-path", rowKey: "EMP-0004", column: "joined", newValue: "2024-06-21" },
  { fixtureSeed: "linux-path", rowKey: "EMP-0005", column: "salary", newValue: "$34806.03" },
];
