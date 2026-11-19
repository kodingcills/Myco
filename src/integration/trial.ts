/**
 * Live-VM integration trial runner (M1-013 / TIF-17, part 1): one
 * calc-record-edit trial end-to-end on the real Windows VM — fixture from a
 * seed, converted guest-side, opened in Calc, edited via UIA, saved, closed,
 * verified by the UnoVerifier — emitting the same schema-valid evidence the
 * CI harness produces (runs/<runId>/trace.jsonl + result.json, ADR-0007).
 *
 * Program shape: src/tasks/calc-record-edit.ts programFor() is written against
 * the fake app's symbolic grid. On Windows the same guarded steps run with
 * the real adapter: the family contract (parameter generator, host-side
 * ground truth, verifier) is unchanged; the step ACTIONS map 1:1 (open=launch
 * + focus, locate=Name Box jump, set=Name Box jump + type, save=ctrl+s,
 * close=ctrl+w) and the PRE/POSTCONDITIONS re-check the authoritative UNO
 * observations the adapter surfaces. Where the fake app provides a fact the
 * real UI cannot (focusedNodeId), the guard is expressed over what UNO
 * actually reports (cell values, isModified, document presence).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ActResult, AppAdapter } from "../core/adapter.ts";
import { scoreVerdict } from "../core/eval.js";
import {
  type EvidenceStep,
  type RunRecord,
  stepFromRecord,
  type TraceEvent,
  writeRunEvidence,
} from "../core/evidence.js";
import { type GuardFailure, type Program, predicate } from "../core/program.ts";
import { type RunOutcome, runProgram } from "../core/runner.ts";
import { findNode } from "../core/state.ts";
import type { TaskIntent, Verdict } from "../core/verify.ts";
import { intentFor, validateIntent } from "../tasks/calc-record-edit.js";
import { generateFixture } from "../tasks/fixture.js";
import { type CalcRecordEditParams, groundTruth } from "../tasks/intent.js";
import { unoVerifierOverAgent } from "../verify/uno-verifier.js";
import type { AgentClient } from "../win/agent-client.js";
import { WindowsCalcAdapter } from "../win/calc-adapter.js";
import { WindowsFixtureConverter } from "./windows-fixture.js";

export interface TrialOptions {
  client: AgentClient;
  params: CalcRecordEditParams;
  /** UNO accept socket for this trial's Calc instance. */
  unoSocket: string;
  /** Host dir for runs/<runId>/ evidence. */
  runsDir: string;
  /** Guest dir for fixtures + helper (created in the guest by the converter). */
  guestDir?: string;
}

export interface TrialReport {
  runId: string;
  verdict: Verdict;
  completed: boolean;
  elapsedMs: number;
  xlsxPath: string | null;
}

/**
 * Run one trial end-to-end. Never throws for app-side failures: a program
 * guard failure, adapter error, or kill fault resolves to a verdict
 * (refuted/uncertain), and the evidence is written either way.
 */
export async function runTrial(options: TrialOptions): Promise<TrialReport> {
  const started = Date.now();
  const runId = randomUUID();
  const guestDir = options.guestDir ?? "C:\\myco\\runs";
  mkdirSync(join(options.runsDir, runId), { recursive: true });

  const fixture = generateFixture(options.params.fixtureSeed);
  const gt = groundTruth(options.params);
  // Key cell of the record row: header is row 1, data rows start at row 2.
  const keyCell = `A${gt.location.dataRowIndex + 2}`;
  const observedCells = [keyCell, gt.cellRef];

  const converter = new WindowsFixtureConverter({
    client: options.client,
    guestDir,
  });
  const adapter = new WindowsCalcAdapter({
    client: options.client,
    xlsxPath: "", // set after the convert lands
    unoSocket: options.unoSocket,
    observedCells,
    helperDir: guestDir,
  });

  const trace: TraceEvent[] = [];
  const _push = (event: TraceEvent) => trace.push(event);

  // Phases that must never throw: a mid-trial app death (kill fault) or a
  // failed launch folds into a guard-failure outcome + uncertain verdict,
  // with evidence written either way. Only the harness itself being broken
  // (no converter path) throws.
  let launchFailure: GuardFailure | undefined;
  try {
    await converter.convert(Buffer.from(fixture.csv, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeTrialEvidence(options.runsDir, {
      runId,
      taskId: "calc-record-edit",
      taskParams: options.params as unknown as Record<string, unknown>,
      startedAt: new Date(started).toISOString(),
      steps: [],
      guardFailure: {
        step: -1,
        phase: "precondition",
        predicateName: "fixture-convert",
        observed: message,
        reason: `fixture convert failed: ${message}`,
      },
      verdict: {
        status: "uncertain",
        reasons: [`could not look: fixture convert failed — ${message}`],
      },
      trace,
    });
    return {
      runId,
      verdict: {
        status: "uncertain",
        reasons: [`could not look: fixture convert failed — ${message}`],
      },
      completed: false,
      elapsedMs: Date.now() - started,
      xlsxPath: null,
    };
  }
  const xlsxPath = converter.lastXlsxPath;
  if (!xlsxPath) throw new Error("fixture convert produced no guest path");
  adapter.setXlsxPath(xlsxPath);

  // 2. Program: the family program, with Windows-mapped actions.
  const program = windowsProgramFor(options.params);

  // 3. Launch Calc on the fixture with the UNO socket, wait for observability.
  try {
    await adapter.launchCalc();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    launchFailure = {
      step: -1,
      phase: "precondition",
      predicateName: "adapter-available",
      observed: message,
      reason: `adapter unusable: ${message}`,
    };
  }
  // Trace: the launch itself is recorded implicitly — step 0's action/observation
  // pair proves the document opened. The ADR-0007 event vocabulary has no
  // launch event, and the schema rejects negative step indices.

  // 4. Run the guarded program (skipped when the launch itself failed).
  const outcome = launchFailure
    ? {
        program: program.name,
        completed: false,
        steps: [],
        guardFailure: launchFailure,
        finalState: null,
      }
    : await runProgramSafe(adapter, program);

  // 5. Verdict: the independent UnoVerifier over the live document + the
  //    persisted file. It closes the document itself (check (c)).
  const intent = intentFor(options.params);
  let verdict: Verdict;
  try {
    const verifier = unoVerifierOverAgent(options.client, options.unoSocket);
    verdict = await verifier.verify(intent, xlsxPath);
  } catch (error) {
    verdict = {
      status: "uncertain",
      reasons: [
        `could not look: verifier failed — ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  // 6. Evidence: same writer the CI harness uses, so the artifacts are
  //    schema-identical.
  writeTrialEvidence(options.runsDir, {
    runId,
    taskId: "calc-record-edit",
    taskParams: options.params as unknown as Record<string, unknown>,
    startedAt: new Date(started).toISOString(),
    steps: outcome.steps.map(stepFromRecord),
    guardFailure: outcome.guardFailure,
    verdict,
    trace,
  });

  return {
    runId,
    verdict,
    completed: outcome.completed,
    elapsedMs: Date.now() - started,
    xlsxPath,
  };
}

/** runProgram, with adapter/UNO failures folded into a guard-failure outcome. */
async function runProgramSafe(adapter: AppAdapter, program: Program): Promise<RunOutcome> {
  try {
    return await runProgram(adapter, program);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      program: program.name,
      completed: false,
      steps: [],
      guardFailure: {
        step: -1,
        phase: "precondition",
        predicateName: "adapter-available",
        observed: message,
        reason: `adapter unusable: ${message}`,
      },
      finalState: null,
    };
  }
}

/**
 * The guarded program for the real adapter. Same step semantics as
 * programFor() (family contract intact); actions map onto the Windows
 * adapter's vocabulary (click = Name Box jump; setValue = jump + type).
 * The open step's action is a no-op click on A1 — launchCalc already opened
 * the document; the postconditions prove it.
 */
export function windowsProgramFor(params: CalcRecordEditParams): Program {
  const validation = validateIntent(params);
  const intentValid = predicate(
    `intent targets an existing record and column (fixture "${params.fixtureSeed}")`,
    () => validation.ok,
    () => (validation.ok ? "intent valid" : `invalid target: ${validation.error}`),
  );
  if (!validation.ok) {
    return {
      name: "calc-record-edit",
      steps: [
        {
          action: { kind: "waitFor", predicate: () => false, timeoutMs: 0 },
          preconditions: [intentValid],
          postconditions: [],
        },
      ],
    };
  }
  const gt = groundTruth(params);
  const ref = gt.cellRef;

  const cellPristine = predicate(
    `cell ${ref} located at record ${params.rowKey}, column ${params.column}, holds fixture value "${gt.previousValue}"`,
    (s) => findNode(s, ref)?.value === gt.previousValue,
    (s) => `value=${JSON.stringify(findNode(s, ref)?.value ?? "<missing>")}`,
  );
  const cellHasNewValue = predicate(
    `cell ${ref} holds "${gt.expectedValue}"`,
    (s) => findNode(s, ref)?.value === gt.expectedValue,
    (s) => `value=${JSON.stringify(findNode(s, ref)?.value ?? "<missing>")}`,
  );
  const notDirty = predicate(
    "document not dirty after save",
    (s) => !s.facts.dirty,
    (s) => `dirty=${String(s.facts.dirty)}`,
  );
  const docOpen = predicate(
    "document open",
    (s) => s.facts.documentPath !== null,
    (s) => `documentPath=${JSON.stringify(s.facts.documentPath)}`,
  );

  return {
    name: "calc-record-edit",
    steps: [
      {
        // open: launchCalc ran before the program; prove the document is there.
        action: { kind: "click", ref: { nodeId: "A1" } },
        preconditions: [intentValid, docOpen],
        postconditions: [docOpen],
      },
      {
        // locate: Name Box jump to the target cell; the pristine-value
        // precondition proves row + column were located correctly.
        action: { kind: "click", ref: { nodeId: ref } },
        preconditions: [intentValid, docOpen, cellPristine],
        postconditions: [],
      },
      {
        // set: jump + type the new value (keyboard commit).
        action: { kind: "setValue", ref: { nodeId: ref }, value: gt.expectedValue },
        preconditions: [docOpen, cellPristine],
        postconditions: [cellHasNewValue],
      },
      {
        action: { kind: "keyPress", keys: "ctrl+s" },
        preconditions: [cellHasNewValue],
        postconditions: [notDirty],
        isSave: true,
      },
      // No close step on Windows: UNO dies with the document. The verifier
      // reads the live document for checks (a)/(b), then the persisted file
      // for (c) via a separate headless soffice — closing is unnecessary.
    ],
  };
}

interface EvidenceInput {
  runId: string;
  taskId: string;
  taskParams: Record<string, unknown>;
  startedAt: string;
  steps: EvidenceStep[];
  guardFailure?: RunOutcome["guardFailure"];
  verdict: Verdict;
  trace: TraceEvent[];
}

function writeTrialEvidence(runsDir: string, input: EvidenceInput): void {
  const scored = scoreVerdict(input.verdict, "calc-record-edit:intent-check");
  const record: RunRecord = {
    runId: input.runId,
    taskId: input.taskId,
    taskParams: input.taskParams,
    startedAt: input.startedAt,
    steps: input.steps,
    guardFailure: input.guardFailure,
    verdict: scored,
    unresolvedState:
      input.verdict.status === "uncertain" ? input.verdict.reasons.join("; ") : undefined,
  };
  writeRunEvidence(runsDir, record, input.trace);
}

/**
 * Kill-mid-program fault for the corrupted trial (M1-010 kill-app class):
 * registered as the fault event in the trace, then the guest `kill` op takes
 * the Calc process tree down before the save step lands. Exported for the
 * integration runner script.
 */
export async function killCalc(client: AgentClient, adapter: WindowsCalcAdapter): Promise<void> {
  const pid = adapter.calcPid;
  if (pid !== null) {
    await client.kill({ pid });
  } else {
    await client.kill({ image_name: "soffice.bin" });
  }
}

export type { ActResult, TaskIntent };
