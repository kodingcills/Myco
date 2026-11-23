/**
 * The human-readable summary `myco-run` prints (MVD-001 acceptance 3).
 *
 * Acceptance 3 asks for a summary that names three things: **what the agent
 * claimed**, **the observed persisted state**, and **the verdict**. This module
 * renders exactly those, in that order, and nothing that could be mistaken for a
 * measurement it did not take (a mock run says it was a mock run, in the line
 * above the numbers).
 *
 * `--json` renders the same fields as one object so a non-interactive caller
 * (Codex, Claude Code, CI) never has to parse prose.
 */
import type { RunOutcome } from "./myco-run.ts";
import type { ArtifactCheck } from "./run-artifacts.ts";

export interface RunSummary {
  readonly taskId: string;
  readonly taskTitle: string;
  /** `mock` or `live`; carries into `result.json` as `economics.provenance`. */
  readonly transport: string;
  /** What the UI said and what the agent said it did. */
  readonly claim: {
    readonly uiStatusText: string;
    readonly agent: string;
    readonly successClaim: boolean;
  };
  /** What the oracle read out of the store, not what the screen showed. */
  readonly observed: {
    readonly intent: readonly string[];
    readonly persisted: readonly string[];
    readonly missing: readonly string[];
  };
  readonly verdict: {
    readonly status: string;
    readonly expected: string;
    readonly matchesExpected: boolean;
    readonly falseSuccess: boolean;
    readonly reasons: readonly string[];
  };
  readonly artifacts: {
    readonly valid: boolean;
    readonly dir: string;
    readonly problems: readonly string[];
  };
  readonly economics: {
    readonly provenance: string;
    readonly wallClockMs: number;
    readonly wallClockBasis: string;
    readonly modelCost: string;
  };
  readonly exitCode: number;
}

// The UI's success sentence, exactly as `runDirectionALive` recognises it. Kept
// as a literal rather than shared so a change to the runner's wording shows up
// here as a test failure instead of silently widening what counts as a claim.
const UI_SUCCESS_CLAIM: RegExp = /saved\s+\d+\s+item/i;

export function summarize(
  outcome: RunOutcome,
  artifacts: ArtifactCheck,
  exitCode: number,
): RunSummary {
  const { result, task, economics } = outcome;
  return {
    taskId: task.id,
    taskTitle: task.title,
    transport: outcome.transport,
    claim: {
      uiStatusText: result.claimed,
      agent: outcome.claim,
      successClaim: UI_SUCCESS_CLAIM.test(result.claimed),
    },
    observed: {
      intent: [...task.items],
      persisted: [...result.persisted],
      missing: [...result.missing],
    },
    verdict: {
      status: result.status,
      expected: task.expected,
      matchesExpected: result.status === task.expected,
      falseSuccess: result.falseSuccess,
      reasons: [...result.reasons, ...(result.abort ?? [])],
    },
    artifacts: {
      valid: artifacts.ok,
      dir: artifacts.runDir,
      problems: artifacts.problems.map(
        (problem) => `${problem.file} ${problem.path}: ${problem.message}`,
      ),
    },
    economics: {
      provenance: economics.provenance,
      wallClockMs: economics.wallClockMs,
      wallClockBasis: economics.wallClockBasis,
      modelCost: `${economics.modelCost.status} — ${economics.modelCost.reason}`,
    },
    exitCode,
  };
}

export function renderRunSummary(summary: RunSummary): string {
  const lines: string[] = [];
  const label = summary.transport === "mock" ? "MOCK (no guest, no kernel)" : "LIVE";
  lines.push(`myco-run — ${summary.taskId}: ${summary.taskTitle}`);
  lines.push(`transport: ${label}`);
  lines.push("");
  lines.push("1. Claim (what the agent said)");
  lines.push(`   UI status line: ${quote(summary.claim.uiStatusText)}`);
  lines.push(`   agent claim:    ${quote(summary.claim.agent)}`);
  if (summary.verdict.status === "aborted") {
    lines.push("");
    lines.push("VERDICT: aborted — no session was created, so there is no claim to check");
    for (const reason of summary.verdict.reasons) lines.push(`   - ${reason}`);
    lines.push("");
    lines.push(`artifacts: ${summary.artifacts.dir}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push("");
  lines.push("2. Observed persisted state (read from the store, not the screen)");
  for (const item of summary.observed.intent) {
    const kept = summary.observed.persisted.includes(item);
    lines.push(`   ${kept ? "present" : "MISSING"}  ${item}`);
  }
  if (summary.verdict.status === "uncertain") {
    lines.push("   (uncertain: the store read may be incomplete; see the verdict reasons)");
  }
  lines.push("");
  lines.push("3. Verdict");
  lines.push(`   ${summary.verdict.status.toUpperCase()}`);
  for (const reason of summary.verdict.reasons) lines.push(`   - ${reason}`);
  if (summary.verdict.falseSuccess) {
    lines.push("");
    lines.push("   FALSE SUCCESS: the UI claimed the save succeeded and the store disagrees.");
  }
  if (!summary.verdict.matchesExpected) {
    lines.push(
      `   UNEXPECTED: this task is expected to be ${summary.verdict.expected}, and it was not.`,
    );
  }
  lines.push("");
  lines.push(
    `artifacts: ${summary.artifacts.valid ? "VALID" : "INVALID"} (schema + cross-file checks)`,
  );
  lines.push(`   dir: ${summary.artifacts.dir}`);
  for (const problem of summary.artifacts.problems) lines.push(`   ${problem}`);
  lines.push("");
  lines.push(
    `economics: ${summary.economics.wallClockMs} ms wall-clock (${summary.economics.wallClockBasis})`,
  );
  lines.push(`   model cost: ${summary.economics.modelCost}`);
  lines.push("");
  lines.push(`exit: ${summary.exitCode}`);
  return `${lines.join("\n")}\n`;
}

/** Exported so the CLI prints the same quoting in an error line as in the summary. */
export function quote(value: string): string {
  return value.length === 0 ? "(none recorded)" : `"${value}"`;
}
