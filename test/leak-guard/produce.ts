/**
 * Runs every outward-bound writer on fixtures and scans what it produced: every output file
 * AND its log output (TIF-98 leak guard, part 1). Shared by `test/leak-guard/` (CI) and
 * `pnpm leak-guard` (the builder preflight), so both scan exactly the same outputs.
 *
 * A writer that cannot produce its output on the fixture is a finding (`unscannable`), not
 * a skip: the guard fails closed.
 *
 * Adding a writer: append a `Producer` to `PRODUCERS`. The Q3 replayable bundle (#553) and
 * the closed episode/dataset exports (#556, #559) register here when they land (TO FILE on
 * TIF-98); `test/leak-guard/routing.test.ts` fails if an outward writer module exists that
 * neither routes through `src/leak-guard/serialize.ts` nor is listed as pending.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  draftEpisode,
  EPISODE_REAL_PLANNERS,
  type EpisodeDraft,
} from "../../src/dataset/episode.ts";
import { type ExportCandidate, exportDataset as exportTrackU } from "../../src/dataset/export.ts";
import { main as episodesMain } from "../../src/episode/cli.ts";
import { EpisodeRecorder } from "../../src/episode/recorder.ts";
import { EpisodeStore } from "../../src/episode/store.ts";
import type { Identity } from "../../src/leak-guard/detect.ts";
import { type Finding, scanDir, scanLog } from "../../src/leak-guard/scan.ts";
import { draft, HOST } from "../episode/helpers.ts";

export interface Produced {
  /** The directory the writer wrote (scanned whole). */
  readonly outDir: string;
  /** Everything the writer logged (stdout, stderr, returned messages). */
  readonly log: string;
}

export interface Producer {
  readonly name: string;
  /** Writes into a fresh scratch directory; `outDir` must be inside `scratch`. */
  run(scratch: string): Promise<Produced> | Produced;
}

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, done: () => void): void {
    this.text += chunk.toString();
    done();
  }
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** The data-capture episode export (`myco-episodes export`, src/episode/export.ts). */
const episodeExport: Producer = {
  name: "episode-export",
  async run(scratch) {
    const store = join(scratch, "store");
    const s = EpisodeStore.open(store, { simulated: true, host: HOST });
    for (let i = 0; i < 3; i++) {
      const rec = new EpisodeRecorder({ host: HOST });
      rec.action({ kind: "type", text: `value-${i}` });
      rec.state("persisted", "text/csv", new TextEncoder().encode(`id,v\nA,${i}\n`), 0);
      const snap = rec.snapshot();
      const r = s.record(
        draft({
          actions: snap.actions,
          observations: snap.observations,
          task: { ...draft().task, id: `t-${i}` },
          provenance: { ...draft().provenance, runId: `run-${i}`, trialKey: `trial-${i}` },
        }),
        snap.blobs,
      );
      if (r.status !== "written") throw new Error(`fixture episode ${i} not written`);
    }
    const out = join(scratch, "dataset");
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await episodesMain(["export", "--from", store, "--out", out, "--simulated"], {
      stdout,
      stderr,
    });
    if (code !== 0) throw new Error(`episode export exited ${code}`);
    return { outDir: out, log: stdout.text + stderr.text };
  },
};

/** Track U's dataset export (src/dataset/export.ts). */
const datasetExport: Producer = {
  name: "dataset-export",
  run(scratch) {
    const doc = Buffer.from("id,qty\nEMP-0001,42\n");
    const fixture = sha("pristine fixture");
    const instruction = 'Set record EMP-0001, column qty, to "42", and save.';
    const d: EpisodeDraft = {
      outcome: "verified",
      simulated: false,
      task: {
        id: "task-1",
        family: "calc-record-edit",
        taskSetVersion: null,
        faultClass: null,
        instruction,
        instructionSha256: sha(instruction),
        fixtureSha256: fixture,
      },
      actions: [
        { kind: "launch", app: "localc fixture.csv" },
        { kind: "type", text: "42" },
        { kind: "key", keys: "ctrl+s" },
      ],
      observations: [{ afterAction: 0, text: "opened" }],
      withheld: 0,
      agentClaim: "done",
      gate: { verdict: "verified", accepted: true, reasonCodes: ["ORACLE_PASS"], oracle: null },
      groundTruth: {
        source: "independent-grader",
        graderVersion: "false-completion-grader/1",
        status: "pass",
        targetSatisfied: true,
        mismatchCount: 0,
        fixtureSha256: fixture,
        persistedSha256: sha(doc),
      },
      arm: "hcu+shell",
      plannerModelId: [...EPISODE_REAL_PLANNERS][0] as string,
      startedAt: "2026-11-26T15:00:00.000Z",
      endedAt: "2026-11-26T15:01:00.000Z",
      source: "gated-trial",
      runId: "run-1",
      trialKey: "task-1:run-1",
      persisted: doc,
    };
    const candidate: ExportCandidate = {
      episode: draftEpisode(d),
      fixtureSha256: fixture,
      gate: {
        apiVersion: "myco.gate/v1",
        verdict: "verified",
        accepted: true,
        reasonCodes: ["ORACLE_PASS"],
        request: { taskId: "task-1", runId: "run-1" },
      },
      capture: { path: "doc.csv", format: "csv", bytes: doc },
      desktop: {
        backend: "local-process/1",
        isolation: "process",
        networkEnforced: false,
        image: "myco-linux-desktop/1",
      },
    };
    const out = join(scratch, "dataset");
    const r = exportTrackU([candidate], {
      outDir: out,
      now: () => new Date("2026-11-26T16:00:00.000Z"),
    });
    return { outDir: out, log: JSON.stringify({ excluded: r.excluded }) };
  },
};

export const PRODUCERS: readonly Producer[] = [episodeExport, datasetExport];

export interface ProducerScan {
  readonly findings: Finding[];
  readonly producers: string[];
}

/**
 * Runs each producer in its own scratch directory and scans its output and log. `mutate`
 * lets the revert check plant a leak into a produced output before the scan.
 */
export async function runProducers(
  identity: Identity,
  producers: readonly Producer[] = PRODUCERS,
  mutate?: (name: string, produced: Produced) => Produced,
): Promise<ProducerScan> {
  const findings: Finding[] = [];
  for (const p of producers) {
    const scratch = mkdtempSync(join(tmpdir(), "myco-leak-guard-"));
    try {
      let produced: Produced;
      try {
        produced = await p.run(scratch);
      } catch {
        // The error text may itself carry a value; only the class is reported.
        findings.push({ file: `writer:${p.name}`, line: 0, class: "unscannable" });
        continue;
      }
      if (mutate !== undefined) produced = mutate(p.name, produced);
      findings.push(...scanDir(produced.outDir, `writer:${p.name}`, identity));
      findings.push(...scanLog(produced.log, `writer:${p.name}/<log>`, identity));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return { findings, producers: producers.map((p) => p.name) };
}
