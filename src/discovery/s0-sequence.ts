/**
 * S0 mock sequence for Direction A (TIF-89).
 *
 * Runs the two scenarios the live window will run, against the mock desktop:
 *   DF-S01 — four clean items. The app saves all four, the oracle confirms, and
 *            the run must be `verified`.
 *   DF-S02 — two of the four carry a `BUG` prefix. The status line claims "saved
 *            4 item(s)" while the store holds two; the run must be `refuted` and
 *            counted as a false success.
 *
 * The point is to exercise the whole path — preflight, act sequence, store read,
 * oracle, evidence, report — so the guest window only adds a kernel. Nothing
 * here is evidence: the report carries `provenance.kind: "simulated"`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DesktopTransport,
  type LiveRunResult,
  type LiveVerification,
  type PersistedStore,
  runDirectionALive,
} from "./live-runner.ts";
import { MockDesktop } from "./mock-desktop.ts";
import type { PreflightProbe } from "./preflight.ts";

export const REVIEWED_PROBE: PreflightProbe = {
  coordinatorGo: true,
  hostLock: true,
  runtimeReachable: true,
  guestReady: true,
  appPresent: true,
  storeReadable: true,
  oraclePresent: true,
  guestClean: true,
};

export const S0_TASKS = [
  {
    id: "df-s01",
    title: "DF-S01 — clean saves verify",
    items: [
      "update the release notes",
      "write the incident summary",
      "verify database connection pool",
      "prepare deployment checklist",
    ],
    expected: "verified",
  },
  {
    id: "df-s02",
    title: "DF-S02 — BUG items are dropped while the UI claims success",
    items: [
      "bug: login page crashes on save",
      "BUG: token expires too early",
      "update the release notes",
      "write the incident summary",
    ],
    expected: "refuted",
  },
] as const;

/** The oracle the live run uses: every requested item must be in the store. */
export function persistedStoreOracle(
  persisted: PersistedStore,
  intent: { items: readonly string[] },
): LiveVerification {
  const missing = intent.items.filter((item) => !persisted.items.includes(item));
  return missing.length === 0
    ? { status: "verified", reasons: [`all ${intent.items.length} items persisted`] }
    : { status: "refuted", reasons: [`not persisted: ${missing.join(", ")}`] };
}

export interface S0Run {
  readonly id: string;
  readonly title: string;
  readonly expected: "verified" | "refuted";
  readonly result: LiveRunResult;
}

export interface S0Sequence {
  readonly runs: readonly S0Run[];
  readonly ok: boolean;
  readonly evidenceDirs: readonly string[];
  readonly reportPath?: string;
}

export interface S0Options {
  readonly transport?: () => DesktopTransport;
  readonly probe?: PreflightProbe;
  readonly verify?: (
    persisted: PersistedStore,
    intent: { items: readonly string[] },
  ) => LiveVerification;
}

export async function runS0Sequence(
  outputDir: string,
  options: S0Options = {},
): Promise<S0Sequence> {
  const transport = options.transport ?? (() => new MockDesktop());
  const probe = options.probe ?? REVIEWED_PROBE;
  const verify = options.verify ?? persistedStoreOracle;
  mkdirSync(outputDir, { recursive: true });
  const runs: S0Run[] = [];
  for (const task of S0_TASKS) {
    const result = await runDirectionALive({
      transport: transport(),
      probe,
      app: {
        command: "python3",
        args: ["dogfood/apps/myco-todo/myco_todo.py"],
        storePath: "~/.local/share/myco-todo/store.json",
        savePoint: { x: 210, y: 284 },
      },
      items: [...task.items],
      verify,
      runsDir: outputDir,
      runId: task.id,
      taskId: task.id === "df-s01" ? "df-s01" : "df-s02",
      simulated: true,
    });
    runs.push({ id: task.id, title: task.title, expected: task.expected, result });
  }
  const reportPath = join(outputDir, "s0-report.md");
  writeFileSync(reportPath, renderS0Report(runs));
  return {
    runs,
    ok: runs.every((run) => run.result.status === run.expected),
    evidenceDirs: runs.flatMap((run) => (run.result.evidenceDir ? [run.result.evidenceDir] : [])),
    reportPath,
  };
}

export function renderS0Report(runs: readonly S0Run[]): string {
  const lines: string[] = ["# S0 mock sequence — Direction A", ""];
  lines.push("Provenance: **simulated** — mock desktop, no guest trials.");
  lines.push("");
  lines.push("| Scenario | Expected | Actual | False success | Missing | UI claim | Evidence |");
  lines.push("|---|---|---|---|---:|---|---|");
  for (const run of runs) {
    lines.push(
      `| ${run.id} | ${run.expected} | ${run.result.status} | ${run.result.falseSuccess ? "yes" : "no"} | ${run.result.missing.length} | ${run.result.claimed || "—"} | ${run.result.evidenceDir ?? "—"} |`,
    );
  }
  lines.push("");
  lines.push("## What this is not");
  lines.push("");
  lines.push("- It is not live evidence: no guest was booted and no kernel was involved.");
  lines.push(
    "- It is not a head-to-head decision: there are no paired trials, so no rule row is claimed.",
  );
  lines.push("- The live arm is not run; the guest window is the only missing piece.");
  return `${lines.join("\n")}\n`;
}

export function renderS0Sequence(sequence: S0Sequence): string {
  const lines: string[] = ["# S0 mock sequence", ""];
  for (const run of sequence.runs) {
    lines.push(
      `- ${run.id}: expected **${run.expected}**, got **${run.result.status}**` +
        (run.result.falseSuccess ? " (false success caught)" : "") +
        (run.result.missing.length > 0 ? `; missing ${run.result.missing.length}` : "") +
        (run.result.claimed ? `; UI claimed "${run.result.claimed}"` : ""),
    );
  }
  lines.push("", sequence.ok ? "SEQUENCE: PASS" : "SEQUENCE: FAIL");
  if (sequence.reportPath) lines.push(`report: ${sequence.reportPath}`);
  return `${lines.join("\n")}\n`;
}
