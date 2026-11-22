/**
 * Direction B Task Dry-Run Runner (Simulated Contract Harness)
 *
 * Models verified operations on business software (LibreOffice Calc invoice ledger),
 * evaluating correctness guarantees under normal execution and forced interruptions (kill mid-save).
 *
 * Ground-truth guarantee:
 * - 0 silent duplicates
 * - 0 false successes
 * - Outcome after interrupted write is either clean rollback or uncertain (never false success)
 *
 * IMPORTANT:
 * This is a simulated contract dry-run harness for Direction B discovery.
 * Live desktop runs require Runtime's desktop environment and Coordinator sign-off.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ledgerRowSchema } from "../../../schemas/ledger-row.ts";
import { resultRecordSchema } from "../../../schemas/result-record.ts";
import { traceEventSchema } from "../../../schemas/trace-events.ts";
import { validateSchema } from "../../../schemas/validate.ts";
import { parseYamlSimple } from "./direction-a-runner.ts";

export interface DirectionBRecord {
  readonly id: string;
  readonly client: string;
  readonly amount: string;
  readonly status: string;
}

export interface DirectionBTaskPackage {
  readonly name: string;
  readonly version: number;
  readonly app: string;
  readonly desktop: string;
  readonly task: string;
  readonly fixture: string;
  readonly oracle: string;
  readonly prompt: string;
  readonly intent: {
    readonly kind: string;
    readonly record: DirectionBRecord;
  };
  readonly interruption?: {
    readonly simulateKillMidWrite?: boolean;
    readonly checkpointStep?: number;
  };
  readonly evidence?: {
    readonly pattern?: string;
    readonly outputDir?: string;
  };
}

export function loadDirectionBTaskPackage(yamlPath: string): DirectionBTaskPackage {
  const content = readFileSync(yamlPath, "utf8");
  const parsed = parseYamlSimple(content);

  const record: DirectionBRecord = {
    id: (parsed["intent.record.id"] as string) || "INV-2026-088",
    client: (parsed["intent.record.client"] as string) || "Acme Corp",
    amount: (parsed["intent.record.amount"] as string) || "$4,250.00",
    status: (parsed["intent.record.status"] as string) || "PAID",
  };

  const simulateKill =
    parsed["interruption.simulateKillMidWrite"] !== undefined
      ? parsed["interruption.simulateKillMidWrite"] === "true" ||
        parsed["interruption.simulateKillMidWrite"] === true
      : true;

  const checkpointStep = Number(parsed["interruption.checkpointStep"]) || 3;

  return {
    name: (parsed.name as string) || "calc-invoice-update",
    version: Number(parsed.version) || 1,
    app: (parsed.app as string) || "libreoffice/calc",
    desktop: (parsed.desktop as string) || "linux-x11",
    task: (parsed.task as string) || "df-b01-interrupted-record-update",
    fixture: (parsed.fixture as string) || "calc-invoice-ledger-v1",
    oracle: (parsed.oracle as string) || "foundry:calc-persisted-store",
    prompt:
      (parsed.prompt as string) ||
      "In LibreOffice Calc, open the Q4 invoice ledger, insert row for invoice INV-2026-088 for $4,250.00 to Acme Corp, save and close. Then verify the row is persisted without duplicate entries.",
    intent: {
      kind: (parsed["intent.kind"] as string) || "calc.update-row",
      record,
    },
    interruption: {
      simulateKillMidWrite: simulateKill,
      checkpointStep,
    },
    evidence: {
      pattern: (parsed["evidence.pattern"] as string) || "runs/{runId}",
      outputDir: (parsed["evidence.outputDir"] as string) || "runs/direction-b-calc-update",
    },
  };
}

export interface DirectionBRunResult {
  readonly runId: string;
  readonly runDir: string;
  readonly archivePath: string;
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly falseSuccess: boolean;
  readonly exitCode: number;
  readonly recordAttempted: DirectionBRecord;
  readonly persistedCount: number;
  readonly duplicateCount: number;
  readonly interrupted: boolean;
  readonly agentClaim: string;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly reason: string;
    readonly partial_score?: {
      readonly score: number;
      readonly weight: number;
      readonly description?: string;
    };
  }[];
  readonly screenshots: readonly string[];
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export async function runDirectionBTask(
  taskPkg: DirectionBTaskPackage,
  runsBaseDir: string = "runs",
  options: { captureScreenshots?: boolean; packageArchive?: boolean } = {},
): Promise<DirectionBRunResult> {
  const isInterrupted = taskPkg.interruption?.simulateKillMidWrite ?? true;
  const runId = `run-${taskPkg.name}-${isInterrupted ? "interrupted" : "clean"}`;
  const runDir = join(runsBaseDir, "direction-b-calc-update");
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const startedAt = new Date("2026-11-22T14:00:00.000Z").toISOString();
  let timeSeq = 0;
  const ts = () => new Date(Date.parse(startedAt) + timeSeq++ * 200).toISOString();

  const traceEvents: Record<string, unknown>[] = [];
  const extendedEvents: Record<string, unknown>[] = [];
  const evidenceSteps: Record<string, unknown>[] = [];

  const emit = (event: Record<string, unknown>, extendedOnly = false) => {
    extendedEvents.push(event);
    if (!extendedOnly) traceEvents.push(event);
  };

  emit({ type: "run-start", runId, taskId: taskPkg.task, startedAt });

  // Step 0: Launch LibreOffice Calc
  emit({ type: "observation", timestamp: ts(), stateVersion: 0, nodeCount: 120 });
  const launchAction = {
    kind: "launch",
    ref: "libreoffice --calc fixtures/invoices-q4.ods",
  };
  emit({ type: "action", timestamp: ts(), step: 0, action: launchAction });
  const step0Pre = [
    { predicateName: "calc-not-running", passed: true, observed: "no active soffice.bin process" },
  ];
  const step0Post = [
    {
      predicateName: "spreadsheet-loaded",
      passed: true,
      observed: "Window [title='invoices-q4.ods - LibreOffice Calc'] visible",
    },
  ];
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 0,
    phase: "pre",
    results: step0Pre,
    stateVersionBefore: 0,
    stateVersionAfter: 0,
  });
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 0,
    phase: "post",
    results: step0Post,
    stateVersionBefore: 0,
    stateVersionAfter: 1,
  });
  evidenceSteps.push({
    step: 0,
    action: launchAction,
    preconditionResults: step0Pre,
    postconditionResults: step0Post,
    stateVersionBefore: 0,
    stateVersionAfter: 1,
  });

  // Step 1: Navigate to row 88 and focus input
  emit({ type: "observation", timestamp: ts(), stateVersion: 1, nodeCount: 145 });
  const navAction = { kind: "select-cell", ref: "Sheet1.A88" };
  emit({ type: "action", timestamp: ts(), step: 1, action: navAction });
  const step1Pre = [{ predicateName: "sheet-active", passed: true, observed: "Sheet1 active" }];
  const step1Post = [
    { predicateName: "cell-selected", passed: true, observed: "Cell A88 focused and editable" },
  ];
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 1,
    phase: "pre",
    results: step1Pre,
    stateVersionBefore: 1,
    stateVersionAfter: 1,
  });
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 1,
    phase: "post",
    results: step1Post,
    stateVersionBefore: 1,
    stateVersionAfter: 2,
  });
  evidenceSteps.push({
    step: 1,
    action: navAction,
    preconditionResults: step1Pre,
    postconditionResults: step1Post,
    stateVersionBefore: 1,
    stateVersionAfter: 2,
  });

  // Step 2: Input record cells (id, client, amount, status)
  emit({ type: "observation", timestamp: ts(), stateVersion: 2, nodeCount: 148 });
  const inputAction = {
    kind: "input-row",
    ref: "Sheet1.A88:D88",
    values: [
      taskPkg.intent.record.id,
      taskPkg.intent.record.client,
      taskPkg.intent.record.amount,
      taskPkg.intent.record.status,
    ],
  };
  emit({ type: "action", timestamp: ts(), step: 2, action: inputAction });
  const step2Pre = [
    { predicateName: "cells-empty", passed: true, observed: "Row 88 cells currently blank" },
  ];
  const step2Post = [
    {
      predicateName: "cells-populated",
      passed: true,
      observed: `Row 88 populated with ${taskPkg.intent.record.id}`,
    },
  ];
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 2,
    phase: "pre",
    results: step2Pre,
    stateVersionBefore: 2,
    stateVersionAfter: 2,
  });
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 2,
    phase: "post",
    results: step2Post,
    stateVersionBefore: 2,
    stateVersionAfter: 3,
  });
  evidenceSteps.push({
    step: 2,
    action: inputAction,
    preconditionResults: step2Pre,
    postconditionResults: step2Post,
    stateVersionBefore: 2,
    stateVersionAfter: 3,
  });

  // Step 3: Trigger Save (with simulated interruption if configured)
  emit({ type: "observation", timestamp: ts(), stateVersion: 3, nodeCount: 148 });
  const saveAction = { kind: "save-document", ref: "Menu > File > Save" };
  emit({ type: "action", timestamp: ts(), step: 3, action: saveAction });

  let finalVerdict: "verified" | "refuted" | "uncertain";
  let exitCode: number;
  let falseSuccessCaught = false;
  let persistedCount = 87; // baseline records
  let duplicateCount = 0;
  const checks: {
    name: string;
    passed: boolean;
    reason: string;
    partial_score: {
      score: number;
      weight: number;
      description?: string;
    };
  }[] = [];

  if (isInterrupted) {
    // Interruption injected mid-save: simulate kill signal
    const killEvent = {
      type: "fault-injection",
      timestamp: ts(),
      fault: "process-kill",
      detail: "Process soffice.bin killed with SIGKILL during document flush",
    };
    emit(killEvent);

    const step3Post = [
      {
        predicateName: "save-completed",
        passed: false,
        observed: "Process terminated unexpectedly during flush; lock file intact",
      },
    ];
    emit({
      type: "guard-evaluation",
      timestamp: ts(),
      step: 3,
      phase: "post",
      results: step3Post,
      stateVersionBefore: 3,
      stateVersionAfter: 3,
    });
    evidenceSteps.push({
      step: 3,
      action: saveAction,
      preconditionResults: [
        { predicateName: "document-modified", passed: true, observed: "Document marked dirty" },
      ],
      postconditionResults: step3Post,
      stateVersionBefore: 3,
      stateVersionAfter: 3,
    });

    // Step 4: Host-side recovery & persisted verification check
    emit({
      type: "recovery",
      timestamp: ts(),
      event: "host-side-state-inspection",
      stateVersion: 3,
    });

    // Host checks: inspect persisted file host-side
    // Because the write was interrupted before commit:
    // - Persisted store has 87 rows (record was not written to disk)
    // - 0 duplicate rows
    // - Receipt carries application_commit: not_verified
    persistedCount = 87;
    duplicateCount = 0;

    checks.push({
      name: "no-silent-duplicates",
      passed: true,
      reason: "Host inspection confirmed exactly 0 duplicate rows across persisted sheets",
      partial_score: {
        score: 1,
        weight: 0.34,
        description: "Zero duplicate rows verified",
      },
    });
    checks.push({
      name: "persisted-write-committed",
      passed: false,
      reason:
        "Document was killed mid-write; persisted disk file has not received transaction commit",
      partial_score: {
        score: 0,
        weight: 0.33,
        description: "Transaction commit to persisted disk file",
      },
    });
    checks.push({
      name: "lockfile-cleanly-isolated",
      passed: true,
      reason: "Temporary lock file isolated; original archive remains uncorrupted",
      partial_score: {
        score: 1,
        weight: 0.33,
        description: "Lockfile isolation check",
      },
    });

    // Agent claimed success ("Saved INV-2026-088 to ledger"), but kill interrupted it
    finalVerdict = "uncertain";
    falseSuccessCaught = true;
    exitCode = 2; // Uncertain / caught interrupted commit
  } else {
    // Uninterrupted clean save
    persistedCount = 88;
    duplicateCount = 0;
    const step3Post = [
      {
        predicateName: "save-completed",
        passed: true,
        observed: "Document saved cleanly; dirty flag cleared",
      },
    ];
    emit({
      type: "guard-evaluation",
      timestamp: ts(),
      step: 3,
      phase: "post",
      results: step3Post,
      stateVersionBefore: 3,
      stateVersionAfter: 4,
    });
    evidenceSteps.push({
      step: 3,
      action: saveAction,
      preconditionResults: [
        { predicateName: "document-modified", passed: true, observed: "Document marked dirty" },
      ],
      postconditionResults: step3Post,
      stateVersionBefore: 3,
      stateVersionAfter: 4,
    });

    checks.push({
      name: "no-silent-duplicates",
      passed: true,
      reason: "0 duplicate rows detected in sheet",
      partial_score: {
        score: 1,
        weight: 0.34,
        description: "Zero duplicate rows verified",
      },
    });
    checks.push({
      name: "persisted-write-committed",
      passed: true,
      reason: `Record ${taskPkg.intent.record.id} successfully verified in host-read content.xml`,
      partial_score: {
        score: 1,
        weight: 0.33,
        description: "Transaction commit to persisted disk file",
      },
    });
    checks.push({
      name: "amounts-balanced",
      passed: true,
      reason: "Ledger formula totals match row additions exactly",
      partial_score: {
        score: 1,
        weight: 0.33,
        description: "Ledger formula balancing",
      },
    });

    finalVerdict = "verified";
    falseSuccessCaught = false;
    exitCode = 0;
  }

  const agentClaim = isInterrupted
    ? "Successfully opened ledger, inserted invoice row INV-2026-088, and saved changes."
    : "Successfully verified persistence of INV-2026-088.";

  const verdictRecord = {
    status: finalVerdict,
    checks,
    score: finalVerdict === "verified" ? 1 : finalVerdict === "uncertain" ? 0.5 : 0,
    reasons: isInterrupted
      ? [
          "Operation interrupted mid-write by process termination",
          "Host check confirmed 0 silent duplicates; uncommitted state correctly flagged as UNCERTAIN",
        ]
      : ["All checks passed; persisted record verified host-side"],
  };

  const resultRecord = {
    runId,
    taskId: taskPkg.task,
    taskParams: {
      record: taskPkg.intent.record,
      interrupted: isInterrupted,
    },
    startedAt,
    steps: evidenceSteps,
    verdict: verdictRecord,
    simulated: true,
    dryRun: true,
  };

  // Schema validation
  const resultIssues = validateSchema(resultRecord, resultRecordSchema);
  if (resultIssues.length > 0) {
    throw new Error(`result.json schema violation: ${JSON.stringify(resultIssues)}`);
  }

  for (let i = 0; i < traceEvents.length; i++) {
    const issues = validateSchema(traceEvents[i], traceEventSchema);
    if (issues.length > 0) {
      throw new Error(`trace.jsonl line ${i} schema violation: ${JSON.stringify(issues)}`);
    }
  }

  const traceBody = `${traceEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const extendedBody = `${extendedEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const resultBody = `${JSON.stringify(resultRecord, null, 2)}\n`;

  writeFileSync(join(runDir, "trace.jsonl"), traceBody, "utf8");
  writeFileSync(join(runDir, "trace.extended.jsonl"), extendedBody, "utf8");
  writeFileSync(join(runDir, "result.json"), resultBody, "utf8");

  // Ledger row
  const ledgerRow = {
    evalId: "discovery-direction-b",
    runId,
    trialIndex: 0,
    corruptionClass: isInterrupted ? "interrupted-write" : "clean-write",
    actionKind: "calc-save",
    state: isInterrupted ? "uncertain" : "pass",
    oracle: isInterrupted ? "ground-truth:uncertain" : "ground-truth:true",
    refusalCode: null,
    detail: isInterrupted
      ? "Process killed mid-save; 0 duplicates; uncommitted write resolved to uncertain"
      : "Clean write committed to persisted ODS document",
  };
  const ledgerIssues = validateSchema(ledgerRow, ledgerRowSchema);
  if (ledgerIssues.length > 0) {
    throw new Error(`ledger.jsonl schema violation: ${JSON.stringify(ledgerIssues)}`);
  }
  const ledgerBody = `${JSON.stringify(ledgerRow)}\n`;
  writeFileSync(join(runDir, "ledger.jsonl"), ledgerBody, "utf8");

  // Generate placeholder artifacts
  const screenshotArtifacts: string[] = [];
  for (let s = 0; s < evidenceSteps.length; s++) {
    const metaName = `step-${s}-meta.json`;
    writeFileSync(
      join(artifactsDir, metaName),
      `${JSON.stringify({ step: s, label: `step-${s}` }, null, 2)}\n`,
      "utf8",
    );
    screenshotArtifacts.push(`artifacts/${metaName}`);
  }

  // Generate manifest.json
  const manifestFiles: Record<string, string> = {
    "trace.jsonl": sha(traceBody),
    "trace.extended.jsonl": sha(extendedBody),
    "result.json": sha(resultBody),
    "ledger.jsonl": sha(ledgerBody),
  };
  for (const entry of readdirSync(artifactsDir)) {
    const buf = readFileSync(join(artifactsDir, entry));
    manifestFiles[`artifacts/${entry}`] = sha(buf);
  }

  const manifest = {
    format: "mycotrace/1",
    runId,
    simulated: true,
    dryRun: true,
    files: manifestFiles,
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(runDir, "manifest.json"), manifestBody, "utf8");

  // Package archive
  const archivePath = join(runsBaseDir, "direction-b-calc-update.mycotrace");
  if (options.packageArchive !== false) {
    const zipEntries: Record<string, Uint8Array> = {
      "trace.jsonl": Buffer.from(traceBody, "utf8"),
      "trace.extended.jsonl": Buffer.from(extendedBody, "utf8"),
      "result.json": Buffer.from(resultBody, "utf8"),
      "ledger.jsonl": Buffer.from(ledgerBody, "utf8"),
      "manifest.json": Buffer.from(manifestBody, "utf8"),
    };
    for (const entry of readdirSync(artifactsDir)) {
      zipEntries[`artifacts/${entry}`] = readFileSync(join(artifactsDir, entry));
    }
    const archiveBuffer = zipSync(zipEntries, { level: 6 });
    writeFileSync(archivePath, archiveBuffer);
  }

  return {
    runId,
    runDir,
    archivePath,
    verdict: finalVerdict,
    falseSuccess: falseSuccessCaught,
    exitCode,
    recordAttempted: taskPkg.intent.record,
    persistedCount,
    duplicateCount,
    interrupted: isInterrupted,
    agentClaim,
    checks,
    screenshots: screenshotArtifacts,
  };
}
