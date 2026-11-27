/**
 * Test helper: a recorded mock run directory, as a trusted harness leaves it. PNG frames and
 * `timeline.jsonl` in `<root>/<runId>/`, and the run's own decision log, every line written by
 * a real gate bound to the trial (`recordTrial`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHAPES_ONLY } from "../../src/proof/identity.ts";
import type { MockPreviewInput } from "../../src/watch/clip/mock-preview.ts";
import { directoryFrameSource } from "../../src/watch/frames.ts";
import { joinTimeline, readManifest } from "../../src/watch/timeline.ts";
import { encodePng, tempDir } from "./helpers.ts";
import { manifestBytes, type RecordedTrial, recordTrial, type Step } from "./timeline-fixture.ts";

export const TASK = "df-s02";
export const RUN = "run-r";
export const OWN = { taskId: TASK, runId: RUN, claim: "all saved" };

/** A distinct 64x48 RGB PNG per frame: a gradient keyed by the frame index. */
export function pngFrame(index: number, width = 64, height = 48): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * row + 1 + x * 3;
      raw[o] = (x * 4 + index * 40) & 0xff;
      raw[o + 1] = (y * 5) & 0xff;
      raw[o + 2] = (index * 70) & 0xff;
    }
  }
  return encodePng({ width, height, colorType: 2, raw });
}

export interface RecordedDir {
  readonly root: string;
  readonly log: string;
  readonly trial: RecordedTrial;
}

export const DEFAULT_STEPS: readonly Step[] = [
  { frame: "a" },
  { call: OWN },
  { frame: "b" },
  { frame: "c" },
  { call: OWN },
  { frame: "d" },
];

export async function recordedRun(
  steps: readonly Step[] = DEFAULT_STEPS,
  runId = RUN,
): Promise<RecordedDir> {
  const trial = await recordTrial({ taskId: TASK, runId }, steps, {
    encode: (i) => pngFrame(i),
  });
  const root = tempDir("myco-clip-run-");
  mkdirSync(join(root, runId));
  for (const [i, bytes] of trial.frames.entries())
    writeFileSync(join(root, runId, `frame-${String(i).padStart(3, "0")}.png`), bytes);
  writeFileSync(join(root, runId, "timeline.jsonl"), manifestBytes(trial.records));
  const log = join(tempDir("myco-clip-log-"), `${runId}.jsonl`);
  writeFileSync(log, trial.log);
  return { root, log, trial };
}

export function previewInput(rec: RecordedDir, from: number, to: number): MockPreviewInput {
  const source = directoryFrameSource(rec.root, "per-run", new Set([RUN]));
  const join_ = joinTimeline({
    binding: { taskId: TASK, runId: RUN },
    listedRuns: new Set([RUN]),
    manifest: readManifest(join(rec.root, RUN, "timeline.jsonl")),
    frameCount: source.count(RUN),
    frameBytes: (i) => source.read(RUN, i)?.bytes ?? null,
    log: rec.trial.log,
  });
  return {
    runId: RUN,
    taskId: TASK,
    from,
    to,
    join: join_,
    frame: (i) => source.read(RUN, i),
    needles: [],
    guard: SHAPES_ONLY,
  };
}
