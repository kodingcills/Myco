/**
 * Viewer fixture runs (gui-spec §6.1 folder form, §8 perf budgets).
 *
 * Deterministic, synthetic run folders for the run viewer: one per display verdict
 * (Verified, Recovered, False success, Unknown) plus 1,000- and 10,000-step traces for the
 * §8 budgets. These are NOT task fixtures: they contain no Foundry oracle, no hidden-split
 * material, and describe an imaginary `myco-todo` session. Same input -> byte-identical output.
 *
 * `trace.jsonl` is strictly valid against `schemas/trace-events.ts` (closed). The §6.4
 * `claim` event does not exist in that schema yet, so claim events ship in a separate
 * `trace.extended.jsonl` (the same lines plus `claim`) and the viewer treats it as the
 * additive-event input. Until the schema owners land `claim`, `trace.jsonl` alone must render
 * the Comparator as `claimed (derived)`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ViewerKind = "verified" | "recovered" | "false-success" | "unknown";

export interface ViewerRunSpec {
  readonly name: string;
  readonly kind: ViewerKind;
  readonly steps: number;
}

export interface ViewerRun {
  readonly name: string;
  readonly kind: ViewerKind;
  readonly traceLines: readonly string[];
  readonly extendedTraceLines: readonly string[];
  readonly result: Record<string, unknown>;
  readonly ledgerLines: readonly string[];
}

const BASE_MS = Date.UTC(2026, 10, 21, 12, 0, 0);
const iso = (n: number) => new Date(BASE_MS + n * 37).toISOString();
const TARGET = "call mom";
const FILLER = [
  "Edit [name=new-item] focused",
  "List [name=items] rows=",
  "Button [name=Add] enabled",
  "Status [name=status] text=",
  "Window [name=myco-todo] foreground",
];

/** A UIA-ish observation string, ~250 bytes, so 10k steps land near the spec's ~50 MB. */
const observed = (step: number, k: number) =>
  `${FILLER[(step + k) % FILLER.length]}${(step % 40) + 1} | ${"uia ".repeat(100).trim()}`;

export function buildViewerRun(spec: ViewerRunSpec): ViewerRun {
  const { name, kind, steps } = spec;
  if (steps < 4) throw new Error("a viewer run needs at least 4 steps");
  const runId = `viewer-${name}`;
  const taskId = "ef-todo-silent-drop-v2";
  const taskParams = { items: ["buy milk", TARGET] };
  const trace: string[] = [];
  const extended: string[] = [];
  const emit = (event: Record<string, unknown>, claimOnly = false) => {
    const line = JSON.stringify(event);
    extended.push(line);
    if (!claimOnly) trace.push(line);
  };
  let seq = 0;
  const ts = () => iso(seq++);
  const evidenceSteps: Record<string, unknown>[] = [];
  const recoverAt = kind === "recovered" ? Math.floor(steps / 2) : -1;
  const lastStep = steps - 1;

  emit({ type: "run-start", runId, taskId, startedAt: iso(0) });
  let version = 0;
  for (let step = 0; step < steps; step++) {
    const before = version;
    emit({
      type: "observation",
      timestamp: ts(),
      stateVersion: before,
      nodeCount: 40 + (step % 7),
    });
    const action =
      step === lastStep - 1
        ? { kind: "type", ref: "Edit[name=new-item]", text: TARGET }
        : { kind: step % 5 === 4 ? "press" : "click", ref: `Button[name=Add#${step % 9}]` };
    emit({ type: "action", timestamp: ts(), step, action });
    const pre = [{ predicateName: "target-visible", passed: true, observed: observed(step, 0) }];
    emit({
      type: "guard-evaluation",
      timestamp: ts(),
      step,
      phase: "pre",
      results: pre,
      stateVersionBefore: before,
      stateVersionAfter: before,
    });
    const failedHere = step === recoverAt;
    if (failedHere) {
      emit({
        type: "fault-injection",
        timestamp: ts(),
        fault: "delayed-save",
        detail: "save acknowledged 800 ms late",
      });
      emit({
        type: "guard-failure",
        timestamp: ts(),
        step,
        phase: "postcondition",
        guard: {
          step,
          phase: "postcondition",
          predicateName: "row-visible",
          observed: "no new row",
          reason: "row did not appear within timeout",
        },
      });
      emit({
        type: "recovery",
        timestamp: ts(),
        event: "retry-after-refresh",
        stateVersion: before,
      });
    } else {
      version += 1;
    }
    const post = [
      { predicateName: "row-visible", passed: !failedHere, observed: observed(step, 1) },
    ];
    emit({
      type: "guard-evaluation",
      timestamp: ts(),
      step,
      phase: "post",
      results: post,
      stateVersionBefore: before,
      stateVersionAfter: version,
    });
    emit({
      type: "observation",
      timestamp: ts(),
      stateVersion: version,
      nodeCount: 41 + (step % 7),
    });
    // Padding observations bring a step to ~10 events, the spec's sizing basis.
    for (let k = 0; k < 4; k++)
      emit({ type: "observation", timestamp: ts(), stateVersion: version, nodeCount: 40 + k });
    if (kind === "false-success" && step === lastStep) {
      const claim = (source: "agent" | "app-ui", field: string, value: string) =>
        emit({ type: "claim", timestamp: ts(), step, source, field, value }, true);
      claim("app-ui", "status", "Saved 2 items");
      claim("agent", "items[1].text", TARGET);
    }
    evidenceSteps.push({
      step,
      action,
      preconditionResults: pre,
      postconditionResults: post,
      stateVersionBefore: before,
      stateVersionAfter: version,
    });
  }

  const chk = (n: string, passed: boolean | null, reason: string) => ({
    name: n,
    passed,
    reason,
    partial_score: { score: passed === true ? 1 : 0, weight: 0.5 },
  });
  const verdict =
    kind === "false-success"
      ? {
          status: "refuted",
          checks: [
            chk("item-buy-milk-persisted", true, "persisted item matches intent"),
            chk(
              "item-call-mom-persisted",
              false,
              `persisted store has no item "${TARGET}"; screen showed "Saved 2 items"`,
            ),
          ],
          score: 0.5,
          reasons: ["persisted state disagrees with the UI's claim"],
        }
      : kind === "unknown"
        ? {
            status: "uncertain",
            checks: [
              chk("item-buy-milk-persisted", true, "persisted item matches intent"),
              chk("item-call-mom-persisted", null, "store file unreadable: evidence unavailable"),
            ],
            score: 0.5,
            reasons: ["could not read persisted state"],
          }
        : {
            status: "verified",
            checks: [
              chk("item-buy-milk-persisted", true, "persisted item matches intent"),
              chk("item-call-mom-persisted", true, "persisted item matches intent"),
            ],
            score: 1,
            reasons: [],
          };

  const result: Record<string, unknown> = {
    runId,
    taskId,
    taskParams,
    startedAt: iso(0),
    steps: evidenceSteps,
    verdict,
    ...(kind === "unknown" ? { unresolvedState: "persistence file unreadable after run" } : {}),
  };
  const oracle =
    kind === "false-success"
      ? "ground-truth:false"
      : kind === "unknown"
        ? "verifier:uncertain"
        : "verifier:verified+ground-truth";
  const state = kind === "false-success" ? "failure" : kind === "unknown" ? "uncertain" : "pass";
  const ledgerLines = [
    JSON.stringify({
      evalId: "viewer-fixtures",
      runId,
      trialIndex: 0,
      corruptionClass: kind === "recovered" ? "delayed-save" : "none",
      actionKind: "type",
      state,
      oracle,
      refusalCode: null,
    }),
  ];
  return { name, kind, traceLines: trace, extendedTraceLines: extended, result, ledgerLines };
}

export const VIEWER_RUNS: readonly ViewerRunSpec[] = [
  { name: "verified", kind: "verified", steps: 12 },
  { name: "recovered", kind: "recovered", steps: 12 },
  { name: "false-success", kind: "false-success", steps: 12 },
  { name: "unknown", kind: "unknown", steps: 12 },
];
export const PERF_RUNS: readonly ViewerRunSpec[] = [
  { name: "perf-1000", kind: "verified", steps: 1000 },
  { name: "perf-10000", kind: "verified", steps: 10000 },
];

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Write one run in the §6.1 folder layout with a `manifest.json`. Returns the directory. */
export function writeViewerRun(root: string, run: ViewerRun): string {
  const dir = join(root, run.name);
  mkdirSync(dir, { recursive: true });
  const files: Record<string, string> = {
    "trace.jsonl": `${run.traceLines.join("\n")}\n`,
    "result.json": `${JSON.stringify(run.result, null, 2)}\n`,
    "ledger.jsonl": `${run.ledgerLines.join("\n")}\n`,
  };
  if (run.kind === "false-success")
    files["trace.extended.jsonl"] = `${run.extendedTraceLines.join("\n")}\n`;
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  const manifest = {
    format: "mycotrace/1",
    runId: run.result.runId,
    files: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, sha(b)])),
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}
