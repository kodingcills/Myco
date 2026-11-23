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
import { type FixtureFingerprint, fixtureFingerprint, generateFixture } from "../tasks/fixture.js";
import { type CalcRecordEditParams, type GroundTruth, groundTruth } from "../tasks/intent.js";
import { taskText } from "../tasks/task-text.js";
import { unoVerifierOverAgent } from "../verify/uno-verifier.js";
import type { AgentClient } from "../win/agent-client.js";
import {
  type CalcTimings,
  unoModified,
  unoString,
  WindowsCalcAdapter,
} from "../win/calc-adapter.js";
import {
  cleanupTrialGuest,
  describeGuestHealth,
  type GuestCleanupResult,
  type GuestHealthFinding,
  guestContaminated,
  probeGuestHealth,
} from "./guest-health.js";
import { guestBasename } from "./guest-shell.js";
import { type ConvertTiming, WindowsFixtureConverter } from "./windows-fixture.js";

export const LIVE_CORRUPTION_MODES = [
  "kill",
  "invalid-target",
  "dropped-save",
  "focus-change",
] as const;
export type LiveCorruptionMode = (typeof LIVE_CORRUPTION_MODES)[number];

interface CorruptionAudit {
  mode: LiveCorruptionMode;
  applied: boolean;
  recovery: boolean;
  persistedValue: string | null;
  persistedReadError?: string;
  recoveryEvents: string[];
  actionKinds: string[];
}

export interface TrialOptions {
  client: AgentClient;
  params: CalcRecordEditParams;
  /** UNO accept socket for this trial's Calc instance. */
  unoSocket: string;
  /** Host dir for runs/<runId>/ evidence. */
  runsDir: string;
  /** Guest dir for fixtures + helper (created in the guest by the converter). */
  guestDir?: string;
  /** Override FIXTURE_CONVERT_DEADLINE_MS. TESTS ONLY: live trials use the approved default. */
  fixtureConvertDeadlineMs?: number;
  /**
   * Kill soffice after this many adapter actions have been dispatched. A timer
   * cannot land mid-program reliably: launching Calc and making it observable
   * takes ~30 s, so a wall-clock kill fires during launch and the trial never
   * executes a step. Counting acts (not recorded steps) is deliberate: the
   * kill must land after the action whose effect we want to interrupt, and a
   * step record only exists once its post-act observation succeeded.
   */
  killAfterStep?: number;
  /** Opt into suite evidence for the existing kill mode. */
  auditKill?: boolean;
  fault?: Exclude<LiveCorruptionMode, "kill">;
  /**
   * Enable the ADR-0006 recovery ladder (M1-011). Off by default: the
   * non-recovery behavior (interrupted trial → honest uncertain) is
   * unchanged.
   */
  recovery?: boolean;
  /**
   * Skip the guest-health precondition. TESTS ONLY — the check is the whole
   * point of M1-019 on a real guest.
   */
  skipGuestHealth?: boolean;
  /** Bounded wait for the guest health/cleanup scripts (default 20s). */
  guestHygieneTimeoutMs?: number;
}

/**
 * Deadline for the guest-side fixture `.xlsx` to appear (M1-013 decision, approved
 * 2026-11-21). A cold headless convert right after a reset was measured at 30.8 s and
 * once at 169.4 s, so the earlier 60 s converter default could mark a healthy trial
 * uncertain. Each agent RPC keeps its own timeout; this bounds only the arrival poll.
 */
export const FIXTURE_CONVERT_DEADLINE_MS = 240_000;

export interface TrialReport {
  runId: string;
  verdict: Verdict;
  completed: boolean;
  elapsedMs: number;
  xlsxPath: string | null;
  guardFailure?: GuardFailure;
  /** M1-019: guest hygiene outcome, reported even when cleanup failed. */
  cleanup: GuestCleanupResult;
  /** How long the guest-side fixture convert took, against its deadline; null if never attempted. */
  fixtureConvert: ConvertTiming | null;
  /** Calc readiness and UI helper attempts, including recovery attempts. */
  timings: CalcTimings;
  /** Identity of the fixture bytes this trial uploaded (M1-013 sweep seed check). */
  fixture: FixtureFingerprint;
  corruption?: CorruptionAudit;
}

/**
 * Run one trial end-to-end. Never throws for app-side failures: a program
 * guard failure, adapter error, or kill fault resolves to a verdict
 * (refuted/uncertain). M1-019 adds two guarantees: the guest-health
 * precondition aborts uncertain on contamination, and everything the trial
 * started is cleaned up in a finally on every exit path. Cleanup never
 * changes the verdict and never throws out of the finally block.
 */
export async function runTrial(options: TrialOptions): Promise<TrialReport> {
  const started = Date.now();
  const runId = randomUUID();
  const guestDir = options.guestDir ?? "C:\\myco\\runs";
  const hygieneTimeoutMs = options.guestHygieneTimeoutMs ?? 20_000;
  mkdirSync(join(options.runsDir, runId), { recursive: true });

  const fixture = generateFixture(options.params.fixtureSeed);
  const gt = groundTruth(options.params);
  // Key cell of the record row: header is row 1, data rows start at row 2.
  const keyCell = `A${gt.location.dataRowIndex + 2}`;
  const observedCells = [keyCell, gt.cellRef];
  const trace: TraceEvent[] = [];
  const mode = options.fault ?? (options.auditKill ? "kill" : undefined);
  const corruption: CorruptionAudit | undefined = mode && {
    mode,
    applied: false,
    recovery: options.recovery ?? false,
    persistedValue: null,
    recoveryEvents: [],
    actionKinds: [],
  };
  const onFaultApplied = (detail: string) => {
    if (!corruption) return;
    corruption.applied = true;
    trace.push({
      type: "fault-injection",
      timestamp: new Date().toISOString(),
      fault: corruption.mode,
      detail,
    });
  };

  const converter = new WindowsFixtureConverter({
    client: options.client,
    guestDir,
    timeoutMs: options.fixtureConvertDeadlineMs ?? FIXTURE_CONVERT_DEADLINE_MS,
  });
  const adapter = new WindowsCalcAdapter({
    client: options.client,
    xlsxPath: "", // set after the convert lands
    unoSocket: options.unoSocket,
    observedCells,
    helperDir: guestDir,
    fault: options.fault ? { mode: options.fault, onApplied: onFaultApplied } : undefined,
  });

  let body: TrialBody | undefined;
  let cleanup: GuestCleanupResult = { killed: [], removed: [], residue: [], errors: [] };
  try {
    body = await runTrialBody({
      options,
      guestDir,
      converter,
      adapter,
      fixtureCsv: Buffer.from(fixture.csv, "utf8"),
      gt,
      trace,
      hygieneTimeoutMs,
      corruption,
      onFaultApplied,
    });
  } finally {
    cleanup = await cleanupAfterTrial(options, guestDir, converter, hygieneTimeoutMs);
    trace.push(...cleanupTraceEvents(cleanup));
  }

  // Reaching here means the body did not throw (a genuine harness bug would
  // propagate after the finally; there is no verdict to write in that case).
  const outcome = body as TrialBody;
  writeTrialEvidence(options.runsDir, {
    runId,
    taskId: "calc-record-edit",
    taskParams: options.params as unknown as Record<string, unknown>,
    // The job, rendered as text. Myco's arm executes a compiled program rather
    // than reading a sentence, but recording the sentence is what makes parity
    // with the screenshot baseline checkable: both arms now persist the same
    // string from the same function (TIF-104). See task-text.ts.
    instruction: taskText(options.params),
    startedAt: new Date(started).toISOString(),
    steps: outcome.steps.map(stepFromRecord),
    guardFailure: outcome.guardFailure,
    verdict: outcome.verdict,
    trace,
  });

  return {
    runId,
    verdict: outcome.verdict,
    guardFailure: outcome.guardFailure,
    completed: outcome.completed,
    elapsedMs: Date.now() - started,
    xlsxPath: outcome.xlsxPath,
    cleanup,
    fixtureConvert: converter.lastTiming,
    timings: adapter.timings,
    fixture: fixtureFingerprint(fixture),
    corruption,
  };
}

interface TrialBodyContext {
  options: TrialOptions;
  guestDir: string;
  converter: WindowsFixtureConverter;
  adapter: WindowsCalcAdapter;
  fixtureCsv: Buffer;
  gt: GroundTruth;
  trace: TraceEvent[];
  hygieneTimeoutMs: number;
  corruption: CorruptionAudit | undefined;
  onFaultApplied(detail: string): void;
}

interface TrialBody {
  steps: RunOutcome["steps"];
  guardFailure?: GuardFailure;
  verdict: Verdict;
  completed: boolean;
  xlsxPath: string | null;
}

/** Uniform uncertain outcome for a precondition that never let the trial run. */
function abortTrial(guardFailure: GuardFailure, reason: string): TrialBody {
  return {
    steps: [],
    guardFailure,
    verdict: { status: "uncertain", reasons: [reason] },
    completed: false,
    xlsxPath: null,
  };
}

/**
 * Everything before cleanup. Kept separate so runTrial's finally is the
 * single, unconditional cleanup path — including thrown harness errors.
 */
async function runTrialBody(ctx: TrialBodyContext): Promise<TrialBody> {
  const { options, guestDir, converter, adapter, gt, trace, corruption, onFaultApplied } = ctx;

  // 1. Adapter availability: the health probe is only meaningful when the
  //    control plane answers. "Could not look" is never "contaminated".
  try {
    await options.client.ping();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return abortTrial(
      {
        step: -1,
        phase: "precondition",
        predicateName: "adapter-available",
        observed: message,
        reason: `agent unreachable: ${message}`,
      },
      `could not look: agent unreachable — ${message}`,
    );
  }

  // 2. Guest health (M1-019). Runs BEFORE convert/launch: once the trial has
  //    launched Calc, its own soffice and run dir would look like residue.
  if (!options.skipGuestHealth) {
    let finding: GuestHealthFinding;
    try {
      finding = await probeGuestHealth({
        client: options.client,
        runRoot: guestDir,
        timeoutMs: ctx.hygieneTimeoutMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return abortTrial(
        {
          step: -1,
          phase: "precondition",
          predicateName: "guest-health",
          observed: message,
          reason: `guest health could not be determined: ${message}`,
        },
        `could not look: guest health probe failed — ${message}`,
      );
    }
    if (guestContaminated(finding)) {
      const observed = describeGuestHealth(finding);
      return abortTrial(
        {
          step: -1,
          phase: "precondition",
          predicateName: "guest-contaminated",
          observed,
          reason: `guest contaminated: ${observed}`,
        },
        `could not look: guest contaminated — ${observed}; refusing to read a foreign document`,
      );
    }
  }

  // 3. Fixture convert.
  try {
    await converter.convert(ctx.fixtureCsv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return abortTrial(
      {
        step: -1,
        phase: "precondition",
        predicateName: "fixture-convert",
        observed: message,
        reason: `fixture convert failed: ${message}`,
      },
      `could not look: fixture convert failed — ${message}`,
    );
  }
  const xlsxPath = converter.lastXlsxPath;
  if (!xlsxPath) throw new Error("fixture convert produced no guest path");
  adapter.setXlsxPath(xlsxPath);

  // 4. Launch Calc on the fixture with the UNO socket, wait for observability.
  let launchFailure: GuardFailure | undefined;
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

  // 5. Run the guarded program (skipped when the launch itself failed).
  const program = windowsProgramFor(options.params);
  let killUnconfirmed = false;
  const programAdapter =
    options.killAfterStep === undefined
      ? adapter
      : killAfterStepAdapter(
          adapter,
          options.killAfterStep,
          options.client,
          () => {
            killUnconfirmed = true;
          },
          options.auditKill ? onFaultApplied : undefined,
        );
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

  // 5b. Recovery ladder (ADR-0006, M1-011): only for a genuine mid-program
  //     interruption — steps already executed + a structured GuardFailure.
  //     Launch failures and convert failures have no known-good point to
  //     resume from and stay on the plain path.
  let recovered = outcome;
  const recoveryEvents: TraceEvent[] = [];
  if (options.recovery && !killUnconfirmed && !outcome.completed && outcome.steps.length > 0) {
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
      if (corruption) corruption.recoveryEvents = result.attempts.map((attempt) => attempt.event);
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

  // 6. Verdict: the independent UnoVerifier over the live document and file.
  const intent = intentFor(options.params);
  const verifier = unoVerifierOverAgent(options.client, options.unoSocket);
  let verdict: Verdict;
  try {
    verdict = await verifier.verify(intent, xlsxPath);
  } catch (error) {
    verdict = {
      status: "uncertain",
      reasons: [
        `could not look: verifier failed — ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  if (corruption) {
    corruption.actionKinds = [
      ...new Set(finalOutcome.steps.map((step) => String(step.action.kind))),
    ];
    const persisted = await verifier.readPersisted(xlsxPath);
    if ("error" in persisted) {
      corruption.persistedReadError = persisted.error;
    } else {
      corruption.persistedValue = persisted.cells[gt.cellRef] ?? null;
    }
  }
  trace.push(...recoveryEvents);

  return {
    steps: finalOutcome.steps,
    guardFailure: finalOutcome.guardFailure,
    verdict,
    completed: finalOutcome.completed,
    xlsxPath,
  };
}

/** Never throws: a failed cleanup is evidence, not a verdict change. */
async function cleanupAfterTrial(
  options: TrialOptions,
  guestDir: string,
  converter: WindowsFixtureConverter,
  timeoutMs: number,
): Promise<GuestCleanupResult> {
  try {
    return await cleanupTrialGuest({
      client: options.client,
      runRoot: guestDir,
      runDirName: converter.lastRunDir ? guestBasename(converter.lastRunDir) : undefined,
      profileDirName: converter.lastProfileDir
        ? guestBasename(converter.lastProfileDir)
        : undefined,
      timeoutMs,
    });
  } catch (error) {
    return {
      killed: [],
      removed: [],
      residue: [],
      errors: [`cleanup threw: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/**
 * ADR-0007's trace vocabulary is closed and owned by M1-012, so cleanup
 * outcomes use its free-form `fault-injection` detail bucket: `cleanup` for
 * the always-emitted summary, `cleanup-failed` for residue/errors.
 */
function cleanupTraceEvents(cleanup: GuestCleanupResult): TraceEvent[] {
  const timestamp = new Date().toISOString();
  const events: TraceEvent[] = [
    {
      type: "fault-injection",
      timestamp,
      fault: "cleanup",
      detail: `killed=[${cleanup.killed.join(",")}] removed=[${cleanup.removed.join(",")}] residue=[${cleanup.residue.join(",")}]`,
    },
  ];
  if (cleanup.residue.length > 0 || cleanup.errors.length > 0) {
    events.push({
      type: "fault-injection",
      timestamp,
      fault: "cleanup-failed",
      detail: `residue=[${cleanup.residue.join(",")}] errors=[${cleanup.errors.join(",")}] — next guest-health check will abort`,
    });
  }
  return events;
}

/** runProgram, with adapter/UNO failures folded into a guard-failure outcome. */
/**
 * Inject the kill after the Nth action dispatch, before the runner observes
 * its postcondition. Stop the trial if the agent cannot confirm termination.
 */
function killAfterStepAdapter(
  inner: AppAdapter,
  afterStep: number,
  client: AgentClient,
  onUnconfirmed: () => void,
  onKilled?: (detail: string) => void,
): AppAdapter {
  let dispatched = 0;
  return {
    observe: () => inner.observe(),
    capabilities: () => inner.capabilities(),
    issueRef: (nodeId: string) => inner.issueRef?.(nodeId) ?? null,
    async act(action) {
      const result = await inner.act(action);
      dispatched += 1;
      if (dispatched === afterStep && result.outcome !== "failed") {
        process.stderr.write(
          `[kill-fault] requesting termination of soffice.bin after action ${dispatched}\n`,
        );
        let details = "agent did not report a terminated process";
        try {
          const { killed, errors } = await client.kill({ image_name: "soffice.bin" });
          if (killed.length > 0) {
            onKilled?.(`killed soffice.bin after action ${dispatched}`);
            return result;
          }
          if (errors.length > 0) details = `kill reported: ${errors.join("; ")}`;
        } catch (error) {
          details = error instanceof Error ? error.message : String(error);
        }
        onUnconfirmed();
        return {
          outcome: "failed",
          details: `kill after action ${dispatched} unconfirmed: ${details}`,
        };
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
  instruction?: string;
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
    ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
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
