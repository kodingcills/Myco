/**
 * TIF-268 - a SIMULATED trial environment and planner for the `hcu+shell` runner's `dry-run`:
 * the whole path (plan, ledger, resume, progress, pack, grader input) at $0, with no VM, no
 * `claude` and no network. Never evidence: the ledger header says `simulated`, trial keys
 * start `sim-`, and every row's planner is `simulated:hcu-shell-dry-run`, which TIF-274's
 * `--evidence` check refuses (it is not a Claude model id).
 *
 * The simulated agent clicks once, reads the document back with the shell, and claims done
 * without editing anything; the captured document is the unchanged published fixture (CSV, the
 * fake-app format the grader accepts), so the independent grader fails every satisfiable row.
 * That is the point: the pipeline is exercised, nothing is "verified".
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groundTruth } from "../../tasks/intent.ts";
import { createShellPolicy } from "../hcu-shell/shell-tool.ts";
import type { HcuShellPlanner } from "../hcu-shell/trial.ts";
import { PROBE_SCREENSHOT } from "./planner.ts";
import {
  type FcTask,
  type PreparedTrial,
  SIMULATED_PLANNER,
  TASK_BUNDLE,
  TRIAL_SNAPSHOT,
  type TrialEnvironment,
} from "./runner.ts";

export function simulatedPlanner(): HcuShellPlanner {
  let turn = 0;
  return {
    paid: false,
    async act(t) {
      const calls = [{ model: SIMULATED_PLANNER, usage: { prompt: 0, completion: 0 } }];
      const step = turn++ % 3;
      if (step === 0) return { calls, decision: { tool: "click", arguments: { x: 10, y: 10 } } };
      if (step === 1 && t.shellHistory.length === 0)
        return { calls, decision: { shell: "sha256", path: "c:/sim/work/task.xlsx" } };
      turn = 0;
      return { calls, decision: "done" };
    },
  };
}

export function simulatedEnvironment(repoRoot: string): TrialEnvironment {
  return {
    simulated: true,
    async prepare(task: FcTask): Promise<PreparedTrial> {
      const fixture = readFileSync(join(repoRoot, TASK_BUNDLE, task.fixtureFile));
      const params = {
        fixtureSeed: task.fixtureSeed,
        rowKey: task.intent.rowKey,
        column: task.intent.column,
        newValue: task.intent.newValue,
      } as PreparedTrial["params"];
      const truth = task.satisfiable ? groundTruth(params) : null;
      const target =
        truth === null
          ? { cellRef: "B2", previousValue: "", expected: task.intent.newValue }
          : {
              cellRef: truth.cellRef,
              previousValue: truth.previousValue,
              expected: truth.expectedValue,
            };
      const sha = createHash("sha256").update(fixture).digest("hex");
      return {
        params,
        target,
        bootClass: null,
        async release() {},
        prepared: {
          driver: {
            hostVersion: "sim",
            guestVersion: "sim",
            pipeReachable: true,
            sessionIdentityMatches: true,
          },
          snapshot: TRIAL_SNAPSHOT,
          resetMs: 0,
          fixtureSha256: sha,
          acPower: true,
          caffeinate: false,
          loadAvg1: 0,
          shellPolicy: createShellPolicy({
            style: "windows",
            documentPath: "c:/sim/work/task.xlsx",
            documentDir: "c:/sim/work",
            scratchDir: "c:/sim/scratch",
            groundTruthDirs: ["c:/sim/harness"],
          }),
          async connectGui() {
            return {
              screenshot: async () => PROBE_SCREENSHOT,
              execute: async () => ({
                outcome: "delivered",
                deliveryMode: "foreground",
                escalated: false,
              }),
            };
          },
          shell: {
            run: async (request) => ({
              output: sha,
              accesses: [{ operation: "read", path: request.path }],
            }),
          },
          async closeTransport() {},
          judge: async () => ({ kind: "unavailable" }),
          audit: async () => false,
          capturePersisted: async () => ({ format: "csv", bytes: new Uint8Array(fixture) }),
        },
      };
    },
  };
}
