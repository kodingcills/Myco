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
import { recoveryTraceEvents, runRecovery } from "../core/recovery.js";
import { type RunOutcome, runProgram } from "../core/runner.ts";
import { findNode } from "../core/state.ts";
import type { TaskIntent, Verdict } from "../core/verify.ts";
import { intentFor, validateIntent } from "../tasks/calc-record-edit.js";
import { generateFixture } from "../tasks/fixture.js";
import { type CalcRecordEditParams, groundTruth } from "../tasks/intent.js";
import { unoVerifierOverAgent } from "../verify/uno-verifier.js";
import type { AgentClient } from "../win/agent-client.js";
import { unoModified, unoString, WindowsCalcAdapter } from "../win/calc-adapter.js";
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
  /**
   * Kill soffice after this many adapter actions have been dispatched. A timer
   * cannot land mid-program reliably: launching Calc and making it observable
   * takes ~30 s, so a wall-clock kill fires during launch and the trial never
   * executes a step. Counting acts (not recorded steps) is deliberate: the
   * kill must land after the action whose effect we want to interrupt, and a
   * step record only exists once its post-act observation succeeded.
   */
  killAfterStep?: number;
  /**
   * Enable the ADR-0006 recovery ladder (M1-011). Off by default: the
   * non-recovery behavior (interrupted trial → honest uncertain) is
   * unchanged.
   */
  recovery?: boolean;
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
  const programAdapter =
    options.killAfterStep === undefined
      ? adapter
      : killAfterStepAdapter(adapter, options.killAfterStep, options.client);
  const outcome: RunOutcome = launchFailure
    ? {
        program: program.name,
        completed: false,
        steps: [],
        guardFailure: launchFailure,
        finalState: null,
        lastGoodStep: null,
        lastGoodStateVersion: null,
      }
    : await runProgramSafe(programAdapter, program);

  // 4b. Recovery ladder (ADR-0006, M1-011): only for a genuine mid-program
  //     interruption — steps already executed + a structured GuardFailure.
  //     Launch failures and convert failures have no known-good point to
  //     resume from and stay on the plain path.
  let recovered = outcome;
  const recoveryEvents: TraceEvent[] = [];
  if (options.recovery && !outcome.completed && outcome.steps.length > 0) {
    const failedAt = outcome.guardFailure?.step ?? program.steps.length;
    const saveStepIndex = program.steps.findIndex((s) => s.isSave === true);
    try {
      const result = await runRecovery(
        programAdapter,
        program,
        outcome,
        {
          // Re-observe rung: read-only UNO readback of the target cell +
          // isModified — the same facts the independent verifier consults,
          // but this only decides whether to STOP retrying; the verdict
          // itself always comes from the UnoVerifier below.
          intentSatisfied: async () => {
            try {
              const cell = await options.client.unoEval({
                call: "get_string",
                cell: gt.cellRef,
                socket: options.unoSocket,
              });
              if (unoString(cell) !== gt.expectedValue) return false;
              const modified = await options.client.unoEval({
                call: "is_modified",
                socket: options.unoSocket,
              });
              return !unoModified(modified);
            } catch {
              return false; // could not look — never guess satisfied
            }
          },
          // Relaunch rung: launchCalc kills any stray instance, reopens the
          // fixture, and blocks until UNO answers — the app returns exactly
          // to the known-good (pristine) state.
          relaunch: async () => {
            try {
              await adapter.launchCalc();
              return true;
            } catch {
              return false;
            }
          },
        },
        {
          maxRetries: 2,
          // Reversibility: the calc-record-edit program is reversible up to
          // the save (the edit is not persisted until save). When the failure
          // is at or past the save step, redoing could double-apply or mask
          // a partial save: no silent redo, honest uncertain instead.
          isReversible: () => saveStepIndex < 0 || failedAt < saveStepIndex,
        },
      );
      recovered = result.outcome;
      recoveryEvents.push(...recoveryTraceEvents(result.attempts));
    } catch (error) {
      // The ladder itself failed (not the app): record it and fall through
      // with the original outcome — the verifier still runs.
      const message = error instanceof Error ? error.message : String(error);
      recoveryEvents.push({
        type: "recovery",
        timestamp: new Date().toISOString(),
        event: `ladder-error:${message}`,
        stateVersion: outcome.lastGoodStateVersion ?? 0,
      });
    }
  }
  const finalOutcome = recovered;

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
    steps: finalOutcome.steps.map(stepFromRecord),
    guardFailure: finalOutcome.guardFailure,
    verdict,
    trace: [...trace, ...recoveryEvents],
  });

  return {
    runId,
    verdict,
    completed: finalOutcome.completed,
    elapsedMs: Date.now() - started,
    xlsxPath,
  };
}

/** runProgram, with adapter/UNO failures folded into a guard-failure outcome. */
/**
 * Delegating adapter that kills soffice.bin once N steps have completed, so
 * the fault lands after the edit and before the save — the interruption M1's
 * recovery criterion is about. The kill is fire-and-forget: the next adapter
 * call observes the dead app and the runner reports a bounded failure.
 */
function killAfterStepAdapter(
  inner: AppAdapter,
  afterStep: number,
  client: AgentClient,
): AppAdapter {
  let completed = 0;
  return {
    observe: () => inner.observe(),
    capabilities: () => inner.capabilities(),
    issueRef: (nodeId: string) => inner.issueRef?.(nodeId) ?? null,
    async act(action) {
      const result = await inner.act(action);
      completed += 1;
      if (completed === afterStep) {
        process.stderr.write(`[kill-fault] killing soffice.bin after step ${completed}\n`);
        void client.kill({ image_name: "soffice.bin" }).catch(() => {});
      }
      return result;
    },
  };
}

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
      lastGoodStep: null,
      lastGoodStateVersion: null,
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
