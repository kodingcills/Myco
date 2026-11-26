/** Shared fixtures for the episode tests. No VM, no model, no network. */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerTask } from "../../src/benchmark/gated-rows.ts";
import { scriptedDocument } from "../../src/benchmark/r1-dryrun.ts";
import type { BenchmarkTask } from "../../src/benchmark/taskset.ts";
import { type EpisodeDraft, NOT_RECORDED } from "../../src/episode/build.ts";
import type { HostFacts } from "../../src/episode/clean.ts";
import type { EpisodeCapture } from "../../src/episode/gated.ts";
import { gradeCalcRecordEdit } from "../../src/episode/ground-truth.ts";
import type { EpisodeStore } from "../../src/episode/store.ts";
import { GATE_TOOL } from "../../src/gate/mcp-server.ts";
import type { AgentLaunchPlan } from "../../src/integrity/launch.ts";
import { newVaultKey, VerdictVault } from "../../src/integrity/vault.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const BUNDLE = join(ROOT, "benchmark", "false-completion", "fc-v1");
export const TASKS: readonly BenchmarkTask[] = readFileSync(join(BUNDLE, "tasks.jsonl"), "utf8")
  .trimEnd()
  .split("\n")
  .map((l) => JSON.parse(l) as BenchmarkTask);
export const ORACLE_SOURCES = ["src/gate/families.ts", "src/gate/calc-document.ts"].map((p) =>
  join(ROOT, p),
);

/** A fixed host so tests do not depend on the machine (and so its facts can be planted). */
export const HOST: HostFacts = {
  home: "/home/episode-tester",
  tmp: "/var/tmp-episode",
  user: "episode-tester",
};

/** Built at runtime so no key-shaped literal is committed (gitleaks scans every commit). */
export const fakeKey = () => ["sk", "ant", "api03", "x".repeat(24)].join("-");

export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `myco-episode-${prefix}-`));
}

export function task(faultClass: string): BenchmarkTask {
  const found = TASKS.find((t) => t.faultClass === faultClass);
  if (found === undefined) throw new Error(`no ${faultClass} task`);
  return found;
}

export function plan(base: string, env: Record<string, string> = {}): AgentLaunchPlan {
  return {
    mcpConfigPath: join(base, "mcp.json"),
    argv: [
      "-p",
      "episode test",
      "--strict-mcp-config",
      "--tools",
      "",
      "--mcp-config",
      join(base, "mcp.json"),
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      `mcp__myco-gate__${GATE_TOOL}`,
    ],
    mcpServers: { "myco-gate": { command: "myco-gate", args: ["mcp"], env } },
  };
}

export function vaultIn(base: string, name = "vault"): VerdictVault {
  mkdirSync(join(base, "agent"), { recursive: true });
  return new VerdictVault({
    root: join(base, name),
    key: newVaultKey(),
    agentRoots: [join(base, "agent")],
  });
}

export function registry(t: BenchmarkTask) {
  const reg = registerTask(t);
  if (!reg.ok) throw new Error(`${t.taskId} is unregistrable`);
  return reg.registry;
}

/** The honest edit for a task (verified), or the untouched fixture (refuted). */
export const honestDoc = (t: BenchmarkTask) =>
  new TextEncoder().encode(scriptedDocument({ ...t, faultClass: "none" }));
export const pristineDoc = (t: BenchmarkTask) =>
  new Uint8Array(readFileSync(join(BUNDLE, t.fixtureFile)));

export function captureFor(
  store: EpisodeStore,
  t: BenchmarkTask,
  overrides: Partial<EpisodeCapture> = {},
): EpisodeCapture {
  return {
    store,
    task: {
      id: t.taskId,
      taskSetVersion: t.taskSetVersion,
      faultClass: t.faultClass,
      instruction: t.instruction,
      instructionSha256: t.instructionSha256,
      fixtureSha256: t.fixtureSha256,
    },
    harness: { arm: "myco-gate", plannerModelId: "simulated:episode-test", outputCeiling: null },
    trialKey: `ep-${t.taskId}`,
    simulated: true,
    claim: () => "done",
    groundTruth: gradeCalcRecordEdit({
      fixtureCsv: pristineDoc(t),
      fixtureSha256: t.fixtureSha256,
      intent: t.intent,
      columnTypes: t.columnTypes,
      persistedFormat: "csv",
    }),
    ...overrides,
  };
}

/** A minimal valid draft (simulated, verified, graded with no document captured = ungradable). */
export function draft(overrides: Partial<EpisodeDraft> = {}): EpisodeDraft {
  return {
    outcome: "verified",
    simulated: true,
    task: {
      id: "t-1",
      family: "calc-record-edit",
      taskSetVersion: "fc-v1",
      faultClass: "none",
      instruction: "Set the cell.",
      instructionSha256: "a".repeat(64),
      fixtureSha256: "b".repeat(64),
    },
    ...NOT_RECORDED,
    agentClaim: "done",
    gate: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], oracle: null },
    groundTruth: { source: "none", reason: "no-independent-grader" },
    harness: {
      arm: "myco-gate",
      plannerModelId: "simulated:test",
      outputCeiling: null,
      corrections: "off",
      fault: null,
    },
    provenance: { source: "gated-trial", runId: "run-1", trialKey: "trial-1", attemptLedger: null },
    ...overrides,
  };
}
