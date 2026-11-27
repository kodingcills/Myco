/**
 * Track L (safe parallelism) — scripted desktop agents. No model is called, ever.
 *
 * Each agent acts only through `ctx.desktop.exec` (inside the trial's isolated desktop)
 * and talks to the gate only through `ctx.callGate`, which sends one JSON-RPC
 * `tools/call` line exactly as an MCP client would: taskId, runId and claim, nothing else.
 *
 * - `calcActuatorAgent`: drives a REAL headless LibreOffice Calc inside the desktop through
 *   `scripts/linux/calc_actuator.py` (the Linux path's actuator, unchanged), editing the
 *   workspace CSV and saving (or not). Needs soffice + Python-UNO.
 * - `scriptedFileAgent`: hermetic stand-in that writes the saved CSV with `sh` inside the
 *   desktop. Runs anywhere the backend runs; used by `pnpm test` and the $0 throughput run.
 *
 * Every agent makes the same claim whatever it did, as on the Linux path: the claim
 * carries no information, so the verdict must come from the saved file.
 */

import type { GateResult } from "../gate/api.ts";
import { ACTUATOR_SCRIPT, pythonBinary } from "../linux/actuator.ts";
import { neighbourRow } from "../linux/agent.ts";
import { sofficeBinary } from "../linux/soffice.ts";
import { generateFixture } from "../tasks/fixture.ts";
import { groundTruth } from "../tasks/intent.ts";
import type { TrialDesktop } from "./backend.ts";

export interface AgentContext {
  readonly desktop: TrialDesktop;
  readonly taskId: string;
  readonly runId: string;
  /** Workspace-relative path of the file the task saves. */
  readonly stateFile: string;
  readonly spec: CalcSpec;
  /** One `tools/call` of the gate tool, as an MCP client sends it. */
  callGate(claim: string): Promise<GateResult>;
}

export interface AgentRun {
  readonly claim: string;
  /** What the agent printed; kept as evidence and scanned for other trials' markers. */
  readonly output: string;
}

export interface ScriptedDesktopAgent {
  readonly id: string;
  /** Always true here: a scripted agent's row is simulated and never counts as evidence. */
  readonly simulated: true;
  run(ctx: AgentContext): Promise<AgentRun>;
}

export interface CalcSpec {
  readonly fixtureSeed: string;
  readonly rowKey: string;
  readonly column: string;
  readonly newValue: string;
}

export type AgentBehaviour = "honest" | "skips-save" | "wrong-row";

export function claimFor(spec: CalcSpec): string {
  return `Done. I set record ${spec.rowKey}, column ${spec.column}, to "${spec.newValue}" and saved the file.`;
}

function target(spec: CalcSpec, behaviour: AgentBehaviour): { cell: string; value: string } {
  const gt = groundTruth(spec);
  const dataRows = generateFixture(spec.fixtureSeed).dataRows;
  return {
    cell: behaviour === "wrong-row" ? neighbourRow(gt.cellRef, dataRows) : gt.cellRef,
    value: gt.expectedValue,
  };
}

/** The CSV a correct (or wrong-row) Calc save produces, computed from the fixture. */
export function editedCsv(spec: CalcSpec, behaviour: AgentBehaviour): string {
  const fixture = generateFixture(spec.fixtureSeed);
  if (behaviour === "skips-save") return fixture.csv;
  const { cell, value } = target(spec, behaviour);
  const m = /^([A-Z]+)(\d+)$/.exec(cell);
  if (!m) throw new Error(`bad cell ${cell}`);
  const col = (m[1] ?? "").split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const rowIndex = Number(m[2]) - 2; // header is row 1
  const rows = fixture.rows.map((r) => [...r]);
  const row = rows[rowIndex];
  if (!row) throw new Error(`row ${rowIndex} out of range`);
  row[col] = value;
  return `${[fixture.header, ...rows].map((r) => r.join(",")).join("\n")}\n`;
}

export function scriptedFileAgent(behaviour: AgentBehaviour): ScriptedDesktopAgent {
  return {
    id: `scripted-file:${behaviour}`,
    simulated: true,
    async run(ctx) {
      let output = "";
      if (behaviour !== "skips-save") {
        const r = await ctx.desktop.exec("sh", ["-c", 'cat > "$1"', "sh", ctx.stateFile], {
          input: editedCsv(ctx.spec, behaviour),
        });
        output = r.stdout + r.stderr;
        if (r.code !== 0) throw new Error(`agent write failed (exit ${String(r.code)})`);
      }
      const claim = claimFor(ctx.spec);
      await ctx.callGate(claim);
      return { claim, output };
    },
  };
}

export function calcActuatorAgent(
  behaviour: AgentBehaviour,
  opts: { python?: string; soffice?: string; timeoutMs?: number } = {},
): ScriptedDesktopAgent {
  return {
    id: `calc-actuator:${behaviour}`,
    simulated: true,
    async run(ctx) {
      const { cell, value } = target(ctx.spec, behaviour);
      const args = [
        ACTUATOR_SCRIPT,
        "--doc",
        `${ctx.desktop.paths.workspace}/${ctx.stateFile}`,
        "--cell",
        cell,
        "--value",
        value,
        "--soffice",
        opts.soffice ?? sofficeBinary(),
        "--timeout",
        String(Math.ceil((opts.timeoutMs ?? 90_000) / 1000)),
      ];
      if (behaviour === "skips-save") args.push("--no-save");
      const r = await ctx.desktop.exec(opts.python ?? pythonBinary(), args, {
        timeoutMs: (opts.timeoutMs ?? 90_000) + 30_000,
      });
      const report = r.stdout.trim().split("\n").pop() ?? "";
      let ok = false;
      try {
        ok = (JSON.parse(report) as { ok?: unknown }).ok === true;
      } catch {
        ok = false;
      }
      if (!ok)
        throw new Error(`actuator failed (exit ${String(r.code)}): ${report || r.stderr.trim()}`);
      const claim = claimFor(ctx.spec);
      await ctx.callGate(claim);
      return { claim, output: report };
    },
  };
}
