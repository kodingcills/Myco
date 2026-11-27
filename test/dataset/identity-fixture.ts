/**
 * A compact exportable candidate for the identity tests (test/dataset/identity*.test.ts), the
 * same shape as test/dataset/allowlist.test.ts's: a positive, gate-verified, grader-pass episode
 * whose free text and ids the caller chooses.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  draftEpisode,
  EPISODE_REAL_PLANNERS,
  type EpisodeDraft,
} from "../../src/dataset/episode.ts";
import {
  type ExportCandidate,
  ExportRefused,
  exportDataset,
  validateContainer,
} from "../../src/dataset/export.ts";
import type { HygieneOptions } from "../../src/dataset/hygiene.ts";

export const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export const FIXTURE_SHA = sha("pristine fixture");
export const DOC = Buffer.from("id,qty\nEMP-0001,42\n");
const REAL_PLANNER = [...EPISODE_REAL_PLANNERS][0] as string;

export interface Ids {
  readonly taskId?: string;
  readonly runId?: string;
}

/** A positive candidate; `ids` keeps the gate bound to the task and run it names. */
export function candidate(over: Partial<EpisodeDraft> = {}, ids: Ids = {}): ExportCandidate {
  const taskId = ids.taskId ?? "task-1";
  const runId = ids.runId ?? "run-1";
  const draft: EpisodeDraft = {
    outcome: "verified",
    simulated: false,
    task: {
      id: taskId,
      family: "calc-record-edit",
      taskSetVersion: null,
      faultClass: null,
      instruction: "Set the cell.",
      instructionSha256: sha("Set the cell."),
      fixtureSha256: FIXTURE_SHA,
    },
    actions: [{ kind: "type", text: "42" }],
    observations: [{ afterAction: 0, text: "ok" }],
    withheld: 0,
    agentClaim: "done",
    gate: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], oracle: null },
    groundTruth: {
      source: "independent-grader",
      graderVersion: "false-completion-grader/1",
      status: "pass",
      targetSatisfied: true,
      mismatchCount: 0,
      fixtureSha256: FIXTURE_SHA,
      persistedSha256: sha(DOC),
    },
    arm: "hcu+shell",
    plannerModelId: REAL_PLANNER,
    startedAt: "2026-11-26T15:00:00.000Z",
    endedAt: "2026-11-26T15:01:00.000Z",
    source: "gated-trial",
    runId,
    trialKey: `${taskId}:${runId}`.slice(0, 128),
    persisted: DOC,
    ...over,
  };
  return {
    episode: draftEpisode(draft),
    fixtureSha256: FIXTURE_SHA,
    gate: {
      apiVersion: "myco.gate/v1",
      verdict: "verified",
      accepted: true,
      reasonCodes: ["ORACLE_PASS"],
      request: { taskId, runId },
    },
    capture: { path: "doc.csv", format: "csv", bytes: DOC },
    desktop: {
      backend: "local-process/1",
      isolation: "process",
      networkEnforced: false,
      image: "myco-linux-desktop/1",
    },
  };
}

function everyFile(root: string): string {
  let s = "";
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else s += readFileSync(join(root, p), "utf8");
    }
  };
  walk("");
  return s;
}

/** Export one candidate: the refusal or the written bytes and the container's problems. */
export function attempt(c: ExportCandidate, hygiene: HygieneOptions) {
  const b = mkdtempSync(join(tmpdir(), "myco-u-idx-"));
  const dir = join(b, "ds");
  try {
    exportDataset([c], { outDir: dir, hygiene });
    return {
      refused: null as ExportRefused | null,
      written: everyFile(dir),
      valid: validateContainer(dir, hygiene),
    };
  } catch (e) {
    if (e instanceof ExportRefused) return { refused: e, written: "", valid: [] as string[] };
    throw e;
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
}
