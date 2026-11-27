/**
 * Replay scrubber (spec #589 build PR B2, issue #666): `GET /timeline/<run>` over a recorded
 * run directory, per-run decision logs, the MOCK watermark marks, and the route's security.
 *
 * A recorded run here is what a trusted harness leaves: PNG frames and `timeline.jsonl` in
 * `<root>/<runId>/`, and the run's own decision log written by a real gate bound to the trial.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWatchArgs, WatchUsageError } from "../../src/watch/cli.ts";
import { directoryFrameSource, renderedFrameSource } from "../../src/watch/frames.ts";
import { todoFrameSvg } from "../../src/watch/render-frame.ts";
import { startWatchServer, type TimelineView, type WatchServer } from "../../src/watch/server.ts";
import { joinTimeline } from "../../src/watch/timeline.ts";
import { encodePng, MARKER, raw, tempDir, treeSnapshot } from "./helpers.ts";
import { manifestBytes, manifestOf, type RecordedTrial, recordTrial } from "./timeline-fixture.ts";

const TASK = "df-s02";
const RUN = "run-r";
const OTHER = "run-s";
const OWN = { taskId: TASK, runId: RUN, claim: `all saved ${MARKER}` };

const open: WatchServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function serve(opts: Parameters<typeof startWatchServer>[0]): Promise<WatchServer> {
  const server = await startWatchServer({ pollMs: 20, ...opts });
  open.push(server);
  return server;
}

/** A distinct 2x2 RGBA PNG per frame. */
function pngFrame(index: number): Buffer {
  const v = (index * 37) % 256;
  return encodePng({
    width: 2,
    height: 2,
    colorType: 6,
    raw: Buffer.from([0, v, 0, 0, 255, v, 255, 0, 255, 0, v, 0, 255, 255, v, 2, 3, 255]),
  });
}

interface RecordedDir {
  readonly root: string;
  readonly log: string;
  readonly trial: RecordedTrial;
}

/** Record a trial with a real bound gate and lay it out as a recorded run directory. */
async function recordedRun(
  steps: Parameters<typeof recordTrial>[1] = [
    { frame: "a" },
    { call: OWN },
    { frame: "b" },
    { call: { taskId: TASK, runId: OTHER, claim: "done" } },
    { frame: "c" },
    { call: OWN },
  ],
  runId = RUN,
): Promise<RecordedDir> {
  const trial = await recordTrial({ taskId: TASK, runId }, steps, { encode: pngFrame });
  const root = tempDir("myco-replay-run-");
  const dir = join(root, runId);
  mkdirSync(dir);
  for (const [i, bytes] of trial.frames.entries())
    writeFileSync(join(dir, `frame-${String(i).padStart(3, "0")}.png`), bytes);
  writeFileSync(join(dir, "timeline.jsonl"), manifestBytes(trial.records));
  const log = join(tempDir("myco-replay-log-"), `${runId}.jsonl`);
  writeFileSync(log, trial.log);
  return { root, log, trial };
}

async function timeline(server: WatchServer, runId: string): Promise<TimelineView> {
  const r = await raw(server.port, `/timeline/${runId}`);
  expect(r.status).toBe(200);
  return JSON.parse(r.body.toString("utf8")) as TimelineView;
}

describe("GET /timeline/<run> (RS-04 on a recorded run)", () => {
  it("serves the join of the run's own log, frames and manifest: each decision on its frame", async () => {
    const rec = await recordedRun();
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    const view = await timeline(server, RUN);
    const reference = joinTimeline({
      binding: { taskId: TASK, runId: RUN },
      listedRuns: new Set([RUN]),
      manifest: manifestOf(rec.trial.records),
      frameCount: 3,
      frameBytes: (i) => rec.trial.frames[i] ?? null,
      log: rec.trial.log,
    });
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(view.joined).toBe(true);
    expect(view.code).toBeNull();
    expect(view.frameCount).toBe(3);
    expect(view.decisions).toEqual(reference.decisions);
    expect(view.decisions.map((d) => [d.call, d.verdict, d.frame, d.namedAnotherTrial])).toEqual([
      [1, "refuted", 0, false],
      [2, "uncertain", 1, true],
      [3, "refuted", 2, false],
    ]);
  });

  it("is machine-marked mock with the MOCK watermark; frames carry X-Myco-Mock; no run is real", async () => {
    const rec = await recordedRun();
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    const view = await timeline(server, RUN);
    expect(view.mock).toBe(true);
    expect(view.watermark).toBe("MOCK · NOT EVIDENCE");
    expect(server.state().realRuns).toEqual([]);
    for (let i = 0; i < 3; i += 1) {
      const frame = await raw(server.port, `/frames/${RUN}/${i}`);
      expect(frame.status).toBe(200);
      expect(frame.headers["x-myco-mock"]).toBe("1");
    }
  });

  it("carries closed fields only: no digest, path, claim, reason text or evidence ref", async () => {
    const rec = await recordedRun();
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    const body = (await raw(server.port, `/timeline/${RUN}`)).body.toString("utf8");
    expect(body).not.toContain(MARKER);
    expect(body).not.toMatch(/[0-9a-f]{64}/);
    expect(body).not.toContain(rec.root);
    expect(body).not.toContain(".myco-todo.json");
    for (const key of ["reasons", "evidenceRefs", "claim", "checkedAt", "prefixSha256", "oracle"])
      expect(body).not.toContain(`"${key}"`);
    const view = JSON.parse(body) as TimelineView;
    expect(Object.keys(view).sort()).toEqual(
      ["code", "decisions", "frameCount", "frames", "joined", "mock", "runId", "watermark"].sort(),
    );
    for (const d of view.decisions)
      expect(Object.keys(d).sort()).toEqual(
        [
          "accepted",
          "call",
          "frame",
          "namedAnotherTrial",
          "ordinal",
          "reasonCodes",
          "verdict",
        ].sort(),
      );
  });

  it("an invalid join serves the code and pins nothing (frame edited after capture)", async () => {
    const rec = await recordedRun();
    writeFileSync(join(rec.root, RUN, "frame-001.png"), pngFrame(9));
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    const view = await timeline(server, RUN);
    expect(view).toMatchObject({
      joined: false,
      code: "TL_FRAME_DIGEST",
      decisions: [],
      frames: [],
    });
    expect(view.mock).toBe(true);
  });

  it("a symlinked manifest is never followed (TL_NO_TIMELINE)", async () => {
    const rec = await recordedRun();
    const manifest = join(rec.root, RUN, "timeline.jsonl");
    const elsewhere = join(tempDir(), "real.jsonl");
    writeFileSync(elsewhere, readFileSync(manifest));
    unlinkSync(manifest);
    symlinkSync(elsewhere, manifest);
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    expect(await timeline(server, RUN)).toMatchObject({ joined: false, code: "TL_NO_TIMELINE" });
  });

  it("no own log means no join: a plain log shared by two listed runs is no run's own log", async () => {
    const rec = await recordedRun();
    const server = await serve({
      runs: [RUN, OTHER],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN, OTHER])),
    });
    expect(await timeline(server, RUN)).toMatchObject({ joined: false, code: "TL_NO_TIMELINE" });
  });

  it("the binding needs the operator's task: with no single listed task the join is refused", async () => {
    const rec = await recordedRun();
    for (const tasks of [[], [TASK, "df-s01"]]) {
      const server = await serve({
        runs: [RUN],
        tasks,
        decisionLog: rec.log,
        frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
      });
      expect(await timeline(server, RUN)).toMatchObject({ joined: false, code: "TL_LOG_BINDING" });
    }
  });

  it("per-run own logs: each run joins from its own log, and its live events come only from it", async () => {
    const r = await recordedRun();
    const s = await recordedRun([{ frame: "x" }, { call: { taskId: TASK, runId: OTHER } }], OTHER);
    const root = tempDir("myco-replay-two-");
    for (const rec of [r, s]) {
      const runId = rec.trial.binding.runId;
      mkdirSync(join(root, runId));
      for (const [i, bytes] of rec.trial.frames.entries())
        writeFileSync(join(root, runId, `frame-${String(i).padStart(3, "0")}.png`), bytes);
      writeFileSync(join(root, runId, "timeline.jsonl"), manifestBytes(rec.trial.records));
    }
    const server = await serve({
      runs: [RUN, OTHER],
      tasks: [TASK],
      decisionLogs: new Map([
        [RUN, r.log],
        [OTHER, s.log],
      ]),
      frames: directoryFrameSource(root, "per-run", new Set([RUN, OTHER])),
    });
    expect((await timeline(server, RUN)).decisions.map((d) => d.frame)).toEqual([0, 1, 2]);
    expect((await timeline(server, OTHER)).decisions.map((d) => d.verdict)).toEqual(["refuted"]);
    // r's call naming s is r's call: under per-run logs it is never shown under s.
    const events = server.state().events;
    expect(events.filter((e) => e.runId === OTHER)).toHaveLength(1);
    expect(events.filter((e) => e.runId === RUN)).toHaveLength(2);
  });

  it("sealed layout: the manifest is read from captured/frames/timeline.jsonl", async () => {
    const trial = await recordTrial({ taskId: TASK, runId: RUN }, [{ frame: "a" }, { call: OWN }], {
      encode: pngFrame,
    });
    const vault = tempDir("myco-replay-vault-");
    const frames = join(vault, RUN, "captured", "frames");
    mkdirSync(frames, { recursive: true });
    for (const [i, bytes] of trial.frames.entries())
      writeFileSync(join(frames, `f${i}.png`), bytes);
    writeFileSync(join(frames, "timeline.jsonl"), manifestBytes(trial.records));
    const log = join(tempDir(), "log.jsonl");
    writeFileSync(log, trial.log);
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: log,
      frames: directoryFrameSource(vault, "sealed", new Set([RUN])),
    });
    const view = await timeline(server, RUN);
    expect(view).toMatchObject({ joined: true, mock: true, watermark: "MOCK · NOT EVIDENCE" });
    expect(view.decisions.map((d) => d.frame)).toEqual([0]);
  });

  it("rendered (demo) runs are mock and every rendered frame draws its own MOCK watermark", async () => {
    const frames = renderedFrameSource(new Set([RUN]));
    frames.push(
      RUN,
      todoFrameSvg({ stateVersion: 1, entryText: "", listRows: [], statusText: "" }, 1),
    );
    const server = await serve({ runs: [RUN], frames });
    expect(server.state().realRuns).toEqual([]);
    const view = await timeline(server, RUN);
    expect(view).toMatchObject({ mock: true, joined: false, code: "TL_NO_TIMELINE" });
    const frame = await raw(server.port, `/frames/${RUN}/0`);
    expect(frame.headers["x-myco-mock"]).toBe("1");
    expect(frame.body.toString("utf8")).toContain(">MOCK</text>");
    expect(frame.body.toString("utf8")).toContain("MOCK · NOT EVIDENCE");
  });
});

describe("the /timeline route keeps the watch security model (RS-13, B2 rows)", () => {
  it("read-only: a full scrub changes no byte under the run, the log or the manifest", async () => {
    const rec = await recordedRun();
    const before = [treeSnapshot(rec.root), readFileSync(rec.log)];
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    for (let i = 0; i < 5; i += 1) await timeline(server, RUN);
    for (let i = 0; i < 3; i += 1) await raw(server.port, `/frames/${RUN}/${i}`);
    expect(treeSnapshot(rec.root)).toEqual(before[0]);
    expect(readFileSync(rec.log)).toEqual(before[1]);
  });

  it("every non-GET method is 405; unlisted runs 404; traversal and encoded forms 400", async () => {
    const rec = await recordedRun();
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
      const r = await raw(server.port, `/timeline/${RUN}`, { method });
      expect(r.status, method).toBe(405);
    }
    expect((await raw(server.port, `/timeline/${OTHER}`)).status).toBe(404);
    expect((await raw(server.port, "/timeline/")).status).toBe(404);
    expect((await raw(server.port, `/timeline/${RUN}/0`)).status).toBe(404);
    for (const path of [
      "/timeline/..",
      "/timeline/../etc",
      `/timeline/${RUN}?x=1`,
      "/timeline/%2e%2e",
      `/timeline/${RUN}%2f..`,
      "/timeline\\..",
      `/timeline/./${RUN}`,
    ]) {
      const r = await raw(server.port, path);
      expect([400, 404], path).toContain(r.status);
      expect(r.body.toString("utf8")).not.toContain("decisions");
    }
    const r = await raw(server.port, `/timeline/${RUN}`, {
      headers: { origin: "http://evil.test" },
    });
    expect(r.status).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("the response is bounded: at most maxEvents decisions", async () => {
    const steps = [{ frame: "a" }, ...Array.from({ length: 6 }, () => ({ call: OWN }))];
    const rec = await recordedRun(steps);
    const server = await serve({
      runs: [RUN],
      tasks: [TASK],
      maxEvents: 4,
      decisionLog: rec.log,
      frames: directoryFrameSource(rec.root, "per-run", new Set([RUN])),
    });
    const view = await timeline(server, RUN);
    expect(view.decisions.map((d) => d.call)).toEqual([3, 4, 5, 6]);
  });
});

describe("myco watch --decision-log <runId>=<file> (per-run own logs)", () => {
  const base = ["--run", RUN, "--run", OTHER];
  it("parses one own log per listed run", () => {
    const args = parseWatchArgs([
      ...base,
      "--decision-log",
      `${RUN}=/a.jsonl`,
      "--decision-log",
      `${OTHER}=/b.jsonl`,
    ]);
    expect([...(args.decisionLogs ?? new Map())]).toEqual([
      [RUN, "/a.jsonl"],
      [OTHER, "/b.jsonl"],
    ]);
    expect(args.decisionLog).toBeUndefined();
  });

  it("a plain --decision-log is unchanged", () => {
    const args = parseWatchArgs([...base, "--decision-log", "/x.jsonl"]);
    expect(args.decisionLog).toBe("/x.jsonl");
    expect(args.decisionLogs).toBeUndefined();
  });

  it("refuses a run's log twice, a shared path, mixed forms, and two plain logs", () => {
    for (const argv of [
      [...base, "--decision-log", `${RUN}=/a`, "--decision-log", `${RUN}=/b`],
      [...base, "--decision-log", `${RUN}=/a`, "--decision-log", `${OTHER}=/a`],
      [...base, "--decision-log", `${RUN}=/a`, "--decision-log", "/b"],
      [...base, "--decision-log", "/a", "--decision-log", "/b"],
      ["--demo", "todo-items", "--decision-log", "/a"],
    ])
      expect(() => parseWatchArgs(argv), argv.join(" ")).toThrow(WatchUsageError);
  });

  it("the server refuses a per-run log for a run that is not listed", async () => {
    await expect(
      startWatchServer({ runs: [RUN], decisionLogs: new Map([[OTHER, "/x"]]) }),
    ).rejects.toThrow();
  });

  it("frame digests in the manifest are sha256 of the captured bytes (as served raw)", async () => {
    const rec = await recordedRun();
    const record = rec.trial.records[0];
    const bytes = readFileSync(join(rec.root, RUN, "frame-000.png"));
    expect(record?.frameSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
