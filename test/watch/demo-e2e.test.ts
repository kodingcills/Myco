/**
 * Live watch view, end to end with the existing mock gate demos (no VM, no model): the
 * timeline the page receives over SSE, as decisions land, matches the gate's own decision
 * log line for line, frames stream for every run, and once the demo is done the view
 * changes no file.
 */
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startWatchDemo, type WatchDemo } from "../../src/watch/demo.ts";
import type { WatchState } from "../../src/watch/server.ts";
import { raw, tempDir, treeSnapshot } from "./helpers.ts";

const demos: WatchDemo[] = [];
afterEach(async () => {
  await Promise.all(demos.splice(0).map((d) => d.server.close()));
});

/** Subscribe to /api/events and collect every `state` message until `stop()`. */
function subscribe(port: number) {
  const states: WatchState[] = [];
  let buffer = "";
  const req = request(
    { host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          const message = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const lines = message.split("\n");
          if (lines.includes("event: state")) {
            const data = lines.find((l) => l.startsWith("data: "));
            if (data) states.push(JSON.parse(data.slice(6)) as WatchState);
          }
          at = buffer.indexOf("\n\n");
        }
      });
    },
  );
  req.on("error", () => {});
  req.end();
  return { states, stop: () => req.destroy() };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The gate's log, read independently of the view. */
function logTimeline(path: string) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .map((r) => ({
      runId: r.request.runId as string,
      verdict: r.verdict as string,
      accepted: r.accepted as boolean,
      reasonCodes: r.reasonCodes as string[],
      checkpoints:
        r.checkpoints === undefined
          ? null
          : {
              total: r.checkpoints.total,
              lastVerified: r.checkpoints.lastVerified,
              verdicts: r.checkpoints.verdicts,
            },
    }));
}

describe.each(["todo-items", "calc-multi-step"] as const)("watch demo %s end to end", (family) => {
  it("streams a timeline matching the gate's decision log, with frames, and stays passive", async () => {
    const demo = await startWatchDemo({ family, outDir: tempDir(), port: 0, pollMs: 20 });
    demos.push(demo);
    const sub = subscribe(demo.server.port);
    const report = await demo.done;
    expect(report.ok).toBe(true);
    const want = logTimeline(demo.decisionLog);
    expect(want.length).toBeGreaterThan(0);
    await until(() => sub.states.at(-1)?.events.length === want.length);
    sub.stop();
    const final = sub.states.at(-1) as WatchState;
    const got = final.events.map((e) => ({
      runId: e.runId,
      verdict: e.verdict,
      accepted: e.accepted,
      reasonCodes: e.reasonCodes,
      checkpoints: e.checkpoints,
    }));
    expect(got).toEqual(want);
    expect(final.skipped).toBe(0);
    // Live: the timeline grew across several pushed states, not one final dump.
    const lengths = new Set(sub.states.map((s) => s.events.length));
    expect(lengths.size).toBeGreaterThan(1);
    // Calls per run are counted in log order; the multi-step retry arm shows the retry.
    if (family === "calc-multi-step") {
      const repaired = final.events.filter((e) => e.runId === "ms-slip-then-repair-retry");
      expect(
        repaired.map((e) => [e.call, e.retry, e.verdict, e.checkpoints?.lastVerified]),
      ).toEqual([
        [1, false, "refuted", 1],
        [2, true, "verified", 3],
      ]);
    } else {
      expect(final.events.map((e) => e.reasonCodes[0])).toEqual([
        "ORACLE_PASS",
        "ORACLE_FAIL",
        "ORACLE_INPUT_REJECTED",
        "ASSIGNMENT_MISMATCH",
      ]);
    }
    // Frames for every run the fake agent drove, each servable.
    for (const run of final.runs) {
      expect(run.frames, run.runId).toBeGreaterThan(0);
      const frame = await raw(demo.server.port, `/frames/${run.runId}/${run.frames - 1}`);
      expect(frame.status).toBe(200);
      expect(frame.headers["content-type"]).toBe("image/svg+xml");
      expect(frame.body.toString()).toContain("mock");
    }
    // Passive after the demo: serving and requests change nothing in the operator dir.
    const before = treeSnapshot(demo.outDir);
    for (const path of ["/", "/api/state", "/watch.js", `/frames/${final.runs[0]?.runId}/0`])
      await raw(demo.server.port, path);
    await raw(demo.server.port, "/api/state", { method: "POST" });
    await new Promise((r) => setTimeout(r, 100));
    expect(treeSnapshot(demo.outDir)).toEqual(before);
  }, 120_000);
});
