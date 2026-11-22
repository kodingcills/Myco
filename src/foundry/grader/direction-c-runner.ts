/**
 * Direction C Task Dry-Run Runner (Simulated Contract Harness)
 *
 * Models branchable desktops for agent experimentation (fork vs intent-log replay).
 * Evaluates whether branching improves verified completion or speed enough to justify
 * its memory/disk snapshot overhead against cheap intent-log replay.
 *
 * Pre-registered parameters (docs/product/mvd-preregistration.md §4.4):
 * - Reset overhead: 21.0 s warm cold restore (m2-05)
 * - Fork overhead: 2.0 s pause (Orgo baseline) + 2048 MB snapshot memory
 *
 * IMPORTANT / CAUTION:
 * This is a simulated contract dry-run harness for Direction C discovery.
 * All timings (e.g. 36.4s / 12.8s / 2048 MB) are modelled estimates, not measured live desktop evidence.
 * These modelled numbers MUST NOT be cited as Direction C kill-criterion evidence.
 * Live evaluation requires runtime fork/snapshot capability and Coordinator sign-off.
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

export interface BranchDefinition {
  readonly name: string;
  readonly valid: boolean;
  readonly defect: string;
}

export interface DirectionCTaskPackage {
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
    readonly branches: readonly BranchDefinition[];
  };
  readonly comparison: {
    readonly linearRetryRestoreSec: number;
    readonly forkSnapshotOverheadSec: number;
    readonly forkMemoryOverheadMb: number;
  };
  readonly evidence?: {
    readonly pattern?: string;
    readonly outputDir?: string;
  };
}

export function loadDirectionCTaskPackage(yamlPath: string): DirectionCTaskPackage {
  const content = readFileSync(yamlPath, "utf8");
  const parsed = parseYamlSimple(content);

  const branches: BranchDefinition[] = [
    { name: "branch-a-legacy", valid: false, defect: "incompatible-protocol" },
    { name: "branch-b-cloud", valid: true, defect: "none" },
  ];

  return {
    name: (parsed.name as string) || "branch-retry-experiment",
    version: Number(parsed.version) || 1,
    app: (parsed.app as string) || "desktop/experiment-workflow",
    desktop: (parsed.desktop as string) || "linux-x11",
    task: (parsed.task as string) || "df-c01-ambiguous-branch-search",
    fixture: (parsed.fixture as string) || "ambiguous-branch-v1",
    oracle: (parsed.oracle as string) || "foundry:branch-search-oracle",
    prompt:
      (parsed.prompt as string) ||
      "In the workflow configuration dialog, locate and configure the production data sink. Two ambiguous plugin paths exist ('v2-legacy-sink' and 'v3-cloud-sink'). Select the verified compatible plugin, apply settings, and verify the persistent connection.",
    intent: {
      kind: (parsed["intent.kind"] as string) || "workflow.branch-search",
      branches,
    },
    comparison: {
      linearRetryRestoreSec: Number(parsed["comparison.linearRetryRestoreSec"]) || 21.0,
      forkSnapshotOverheadSec: Number(parsed["comparison.forkSnapshotOverheadSec"]) || 2.0,
      forkMemoryOverheadMb: Number(parsed["comparison.forkMemoryOverheadMb"]) || 2048,
    },
    evidence: {
      pattern: (parsed["evidence.pattern"] as string) || "runs/{runId}",
      outputDir: (parsed["evidence.outputDir"] as string) || "runs/direction-c-branch-experiment",
    },
  };
}

export interface DirectionCRunResult {
  readonly runId: string;
  readonly runDir: string;
  readonly archivePath: string;
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly exitCode: number;
  readonly armA: {
    readonly strategy: "intent-log-replay";
    readonly attemptsToVerified: number;
    readonly wallClockSec: number;
    readonly memoryOverheadMb: number;
    readonly verdict: string;
  };
  readonly armB: {
    readonly strategy: "memory-snapshot-fork";
    readonly attemptsToVerified: number;
    readonly wallClockSec: number;
    readonly memoryOverheadMb: number;
    readonly verdict: string;
  };
  readonly killCriterionEvaluation: {
    readonly speedupSec: number;
    readonly speedupRatio: number;
    readonly memoryCostMb: number;
    readonly recommendation: string;
  };
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

export async function runDirectionCTask(
  taskPkg: DirectionCTaskPackage,
  runsBaseDir: string = "runs",
  options: { captureScreenshots?: boolean; packageArchive?: boolean } = {},
): Promise<DirectionCRunResult> {
  const runId = `run-${taskPkg.name}-comparison`;
  const runDir = join(runsBaseDir, "direction-c-branch-experiment");
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const startedAt = new Date("2026-11-22T14:15:00.000Z").toISOString();
  let timeSeq = 0;
  const ts = () => new Date(Date.parse(startedAt) + timeSeq++ * 150).toISOString();

  const traceEvents: Record<string, unknown>[] = [];
  const extendedEvents: Record<string, unknown>[] = [];
  const evidenceSteps: Record<string, unknown>[] = [];

  const emit = (event: Record<string, unknown>, extendedOnly = false) => {
    extendedEvents.push(event);
    if (!extendedOnly) traceEvents.push(event);
  };

  emit({ type: "run-start", runId, taskId: taskPkg.task, startedAt });

  // Step 0: Initial environment setup
  emit({ type: "observation", timestamp: ts(), stateVersion: 0, nodeCount: 64 });
  const launchAction = { kind: "launch", ref: "workflow-studio --config test-workflow.json" };
  emit({ type: "action", timestamp: ts(), step: 0, action: launchAction });
  const step0Pre = [
    { predicateName: "clean-environment", passed: true, observed: "Snapshot base initialized" },
  ];
  const step0Post = [
    {
      predicateName: "workflow-dialog-open",
      passed: true,
      observed: "Dialog [title='Sink Configuration'] displayed",
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

  // Step 1: Reach ambiguous decision point (two candidate sinks)
  emit({ type: "observation", timestamp: ts(), stateVersion: 1, nodeCount: 78 });
  const inspectAction = { kind: "inspect-branch-candidates", ref: "ComboBox[name=data-sink]" };
  emit({ type: "action", timestamp: ts(), step: 1, action: inspectAction });
  const step1Pre = [
    { predicateName: "options-visible", passed: true, observed: "Sink dropdown active" },
  ];
  const step1Post = [
    {
      predicateName: "two-candidates-found",
      passed: true,
      observed: "Options: ['v2-legacy-sink', 'v3-cloud-sink']",
    },
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
    action: inspectAction,
    preconditionResults: step1Pre,
    postconditionResults: step1Post,
    stateVersionBefore: 1,
    stateVersionAfter: 2,
  });

  // Step 2: Arm A Simulation (Intent-log replay)
  // Exploration 1 fails (legacy sink incompatible); restores base snapshot (21s); replays intent log (5.2s); applies cloud sink -> verified.
  const armAWallClock = taskPkg.comparison.linearRetryRestoreSec + 5.2 + 10.2; // 36.4s
  const armAAttempts = 2;
  const armAMemory = 0;

  // Step 3: Arm B Simulation (Live VM memory snapshot fork)
  // Reaches branch point; live fork snapshot (2.0s); child 1 checks legacy -> fails; child 2 checks cloud -> verified.
  const armBWallClock = taskPkg.comparison.forkSnapshotOverheadSec + 10.8; // 12.8s
  const armBAttempts = 2;
  const armBMemory = taskPkg.comparison.forkMemoryOverheadMb; // 2048 MB

  // Step 4: Emit verification trace of winning path
  emit({ type: "observation", timestamp: ts(), stateVersion: 2, nodeCount: 82 });
  const verifyBranchAction = {
    kind: "verify-sink-connection",
    target: "v3-cloud-sink",
    protocol: "grpc-tls",
  };
  emit({ type: "action", timestamp: ts(), step: 2, action: verifyBranchAction });
  const step2Pre = [
    { predicateName: "sink-configured", passed: true, observed: "v3-cloud-sink selected" },
  ];
  const step2Post = [
    {
      predicateName: "endpoint-ping-verified",
      passed: true,
      observed: "Sink connection verified: 200 OK",
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
    action: verifyBranchAction,
    preconditionResults: step2Pre,
    postconditionResults: step2Post,
    stateVersionBefore: 2,
    stateVersionAfter: 3,
  });

  const speedupSec = Math.round((armAWallClock - armBWallClock) * 10) / 10;
  const speedupRatio = Math.round((armAWallClock / armBWallClock) * 100) / 100;

  // Pre-declared Kill Criterion:
  // Fork saves 23.6s wall-clock, but requires 2048 MB extra host RAM per candidate branch.
  // When running multiple parallel arms on a development laptop (e.g. 16GB host), RAM contention is critical.
  // NOTE: Modelled estimate only; not measured live desktop evidence and not cited as kill-criterion evidence.
  const recommendation =
    speedupSec > 15
      ? "[MODELED ESTIMATE ONLY - not live evidence] Forking delivers 2.8x modeled speedup under high-latency resets, but 2GB RAM per branch incurs severe host memory pressure. Maintain Direction A wedge."
      : "[MODELED ESTIMATE ONLY - not live evidence] Forking does not justify snapshot complexity; intent-log replay remains the cost-effective default.";

  const checks = [
    {
      name: "winning-branch-verified",
      passed: true,
      reason: "v3-cloud-sink verified healthy and persisted across both arms",
      partial_score: {
        score: 1,
        weight: 0.34,
        description: "Winning branch verified",
      },
    },
    {
      name: "paired-sign-test-evaluated",
      passed: true,
      reason: "Both Arm A and Arm B successfully reach verified state across candidate trials",
      partial_score: {
        score: 1,
        weight: 0.33,
        description: "Paired sign test evaluation",
      },
    },
    {
      name: "resource-cost-recorded",
      passed: true,
      reason: `Arm A: ${armAWallClock}s / ${armAMemory}MB delta; Arm B: ${armBWallClock}s / ${armBMemory}MB delta`,
      partial_score: {
        score: 1,
        weight: 0.33,
        description: "Resource overhead recording",
      },
    },
  ];

  const resultRecord = {
    runId,
    taskId: taskPkg.task,
    taskParams: {
      comparison: {
        armA: {
          strategy: "intent-log-replay",
          wallClockSec: armAWallClock,
          memoryMb: armAMemory,
        },
        armB: {
          strategy: "memory-snapshot-fork",
          wallClockSec: armBWallClock,
          memoryMb: armBMemory,
        },
      },
    },
    startedAt,
    steps: evidenceSteps,
    verdict: {
      status: "verified",
      checks,
      score: 1.0,
      reasons: [
        "Paired evaluation complete: candidate branch resolved correctly",
        `Modeled estimate (not live evidence): fork saves ${speedupSec}s (${speedupRatio}x) at the modeled cost of ${armBMemory}MB RAM`,
      ],
    },
    simulated: true,
    dryRun: true,
  };

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

  const ledgerRow = {
    evalId: "discovery-direction-c",
    runId,
    trialIndex: 0,
    corruptionClass: "ambiguous-branch",
    actionKind: "branch-search",
    state: "pass",
    oracle: "ground-truth:true",
    refusalCode: null,
    detail: `Arm A replay (${armAWallClock}s) vs Arm B fork (${armBWallClock}s, ${armBMemory}MB); winning branch v3-cloud-sink verified`,
  };
  const ledgerIssues = validateSchema(ledgerRow, ledgerRowSchema);
  if (ledgerIssues.length > 0) {
    throw new Error(`ledger.jsonl schema violation: ${JSON.stringify(ledgerIssues)}`);
  }
  const ledgerBody = `${JSON.stringify(ledgerRow)}\n`;
  writeFileSync(join(runDir, "ledger.jsonl"), ledgerBody, "utf8");

  // Step artifacts
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

  // Manifest
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

  // Archive
  const archivePath = join(runsBaseDir, "direction-c-branch-experiment.mycotrace");
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
    verdict: "verified",
    exitCode: 0,
    armA: {
      strategy: "intent-log-replay",
      attemptsToVerified: armAAttempts,
      wallClockSec: armAWallClock,
      memoryOverheadMb: armAMemory,
      verdict: "verified",
    },
    armB: {
      strategy: "memory-snapshot-fork",
      attemptsToVerified: armBAttempts,
      wallClockSec: armBWallClock,
      memoryOverheadMb: armBMemory,
      verdict: "verified",
    },
    killCriterionEvaluation: {
      speedupSec,
      speedupRatio,
      memoryCostMb: armBMemory,
      recommendation,
    },
    checks,
    screenshots: screenshotArtifacts,
  };
}
