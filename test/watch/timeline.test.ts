/**
 * Replay join (spec #589 §2.2, build PR B1): RS-01, RS-02, RS-03.
 *
 * Every decision-log line here is written by a real gate (`createGate`) bound to one trial,
 * through its own `onDecision`; frames are captured between calls by `recordTrial`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runMockDemo } from "../../src/gate/demo.ts";
import {
  bindingHolds,
  currentAnchor,
  type JoinInput,
  joinTimeline,
  logAnchors,
  logLines,
  type ManifestRead,
  parseLoggedDecision,
  parseManifest,
  readManifest,
  TIMELINE_CODES,
  type TimelineJoin,
  type TimelineRecord,
  type TrialBinding,
} from "../../src/watch/timeline.ts";
import {
  manifestBytes,
  manifestOf,
  type RecordedTrial,
  reanchor,
  recordTrial,
  type Step,
} from "./timeline-fixture.ts";

const R: TrialBinding = { taskId: "df-s02", runId: "run-r" };
const S = "run-s";
const LISTED = new Set([R.runId, S]);
const OWN = { taskId: R.taskId, runId: R.runId, claim: "all saved" };

function input(trial: RecordedTrial, over: Partial<JoinInput> = {}): JoinInput {
  return {
    binding: trial.binding,
    listedRuns: LISTED,
    manifest: manifestOf(trial.records),
    frameCount: trial.frames.length,
    frameBytes: (i) => trial.frames[i] ?? null,
    log: trial.log,
    ...over,
  };
}

const join_ = (trial: RecordedTrial, over: Partial<JoinInput> = {}) =>
  joinTimeline(input(trial, over));

function pins(join: TimelineJoin): (number | null)[] {
  if (!join.ok) throw new Error(`join failed: ${join.code}`);
  return join.decisions.map((d) => d.frame);
}

/** Rewrite one log line's JSON (by ordinal) and return the new log. */
function rewriteLine(log: Buffer, ordinal: number, edit: (v: Record<string, unknown>) => void) {
  let seen = 0;
  const out = log
    .toString("utf8")
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) return line;
      seen += 1;
      if (seen !== ordinal) return line;
      const value = JSON.parse(line) as Record<string, unknown>;
      edit(value);
      return JSON.stringify(value);
    });
  return Buffer.from(out.join("\n"));
}

function rewriteAll(log: Buffer, edit: (v: Record<string, unknown>, ordinal: number) => void) {
  let seen = 0;
  return Buffer.from(
    log
      .toString("utf8")
      .split("\n")
      .map((line) => {
        if (line.trim().length === 0) return line;
        seen += 1;
        const value = JSON.parse(line) as Record<string, unknown>;
        edit(value, seen);
        return JSON.stringify(value);
      })
      .join("\n"),
  );
}

/** The brute-force reference: walk frames in order, the pin is the last one finished before d. */
function reference(trial: RecordedTrial): (number | null)[] {
  const ordinals = logLines(trial.log).map((l) => l.ordinal);
  return ordinals.map((d) => {
    let best: number | null = null;
    for (const r of trial.records)
      if (r.logAfter.lines < d && (best === null || r.frame > best)) best = r.frame;
    return best;
  });
}

describe("join rule (RS-01)", () => {
  it("one decision per frame: each pins to the frame captured just before it", async () => {
    const trial = await recordTrial(R, [
      { frame: "a" },
      { call: OWN },
      { frame: "b" },
      { call: OWN },
      { frame: "c" },
    ]);
    expect(pins(join_(trial))).toEqual([0, 1]);
  });

  it("several decisions between two frames all pin to the earlier frame, in ordinal order", async () => {
    const trial = await recordTrial(R, [
      { frame: "a" },
      { call: OWN },
      { call: OWN },
      { call: OWN },
      { frame: "b" },
    ]);
    const join = join_(trial);
    expect(pins(join)).toEqual([0, 0, 0]);
    if (join.ok)
      expect(join.decisions.map((d) => [d.ordinal, d.call])).toEqual([
        [1, 1],
        [2, 2],
        [3, 3],
      ]);
  });

  it("a straddling frame is never before its decision: the decision pins to the frame before", async () => {
    const trial = await recordTrial(R, [
      { frame: "a" },
      { straddle: "b", during: OWN },
      { frame: "c" },
    ]);
    const join = join_(trial);
    expect(pins(join)).toEqual([0]);
    if (join.ok) expect(join.frames.map((f) => f.straddles)).toEqual([[], [1], []]);
  });

  it("a decision before the first frame is unpinned (TL_NO_FRAME_BEFORE slot), not an error", async () => {
    const trial = await recordTrial(R, [{ call: OWN }, { frame: "a" }, { call: OWN }]);
    expect(pins(join_(trial))).toEqual([null, 0]);
    expect(TIMELINE_CODES).toContain("TL_NO_FRAME_BEFORE");
  });

  it("a decision after the last frame pins to the last frame", async () => {
    const trial = await recordTrial(R, [{ frame: "a" }, { frame: "b" }, { call: OWN }]);
    expect(pins(join_(trial))).toEqual([1]);
  });

  it("property: random interleavings agree with the brute-force reference", async () => {
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 40; round += 1) {
      const steps: Step[] = [];
      const n = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < n; i += 1) {
        const roll = rand();
        if (roll < 0.4) steps.push({ frame: `f${i}` });
        else if (roll < 0.8) steps.push({ call: OWN });
        else steps.push({ straddle: `s${i}`, during: OWN });
      }
      const trial = await recordTrial(R, steps);
      const join = join_(trial);
      expect(join.ok).toBe(true);
      expect(pins(join)).toEqual(reference(trial));
      // Pins never depend on checkedAt: reverse-equal clocks give the same pins.
      const flat = rewriteAll(trial.log, (v) => {
        v.checkedAt = "2026-11-27T09:00:00.000Z";
      });
      const flatJoin = join_(trial, {
        log: flat,
        manifest: manifestOf(reanchor(trial.records, flat)),
      });
      expect(pins(flatJoin)).toEqual(reference(trial));
    }
  });

  it("an ASSIGNMENT_MISMATCH call naming run s pins on r's timeline, marked, and nowhere on s's", async () => {
    const trial = await recordTrial(R, [
      { frame: "a" },
      { call: { taskId: R.taskId, runId: S, claim: "done" } },
      { frame: "b" },
      { call: OWN },
    ]);
    const join = join_(trial);
    expect(join.ok).toBe(true);
    if (!join.ok) return;
    expect(join.decisions.map((d) => [d.frame, d.namedAnotherTrial, d.reasonCodes])).toEqual([
      [0, true, ["ASSIGNMENT_MISMATCH", "CLAIM_RECORDED"]],
      [1, false, ["ORACLE_FAIL", "CLAIM_RECORDED"]],
    ]);
    // The same log given as s's log: its lines are r's gate's, so the binding breaks for s.
    const asS = join_(trial, { binding: { taskId: R.taskId, runId: S } });
    expect(asS).toEqual({ ok: false, code: "TL_RUN" });
    const sTrial = { ...trial, binding: { taskId: R.taskId, runId: S } };
    const sRecords = trial.records.map((r) => ({ ...r, runId: S }));
    expect(joinTimeline(input(sTrial, { manifest: manifestOf(sRecords) }))).toEqual({
      ok: false,
      code: "TL_LOG_BINDING",
    });
  });

  // §1.2 S1 and S2: each pre-evidence rejection the bound gate logs for a request naming s.
  const REJECTIONS: readonly [string, unknown, readonly string[]][] = [
    ["UNKNOWN_FIELD", { taskId: R.taskId, runId: S, extra: 1 }, ["UNKNOWN_FIELD"]],
    ["INVALID_REQUEST", { taskId: R.taskId, runId: S, claim: 5 }, ["INVALID_REQUEST"]],
    [
      "ORACLE_INPUT_REJECTED",
      { taskId: R.taskId, runId: S, state: "x", claim: "done" },
      ["ORACLE_INPUT_REJECTED", "CLAIM_RECORDED"],
    ],
    [
      "UNSUPPORTED_API_VERSION",
      { apiVersion: "myco.gate/v9", taskId: R.taskId, runId: S },
      ["UNSUPPORTED_API_VERSION"],
    ],
    [
      "ASSIGNMENT_MISMATCH",
      { taskId: "other", runId: S, claim: "done" },
      ["ASSIGNMENT_MISMATCH", "CLAIM_RECORDED"],
    ],
  ];

  for (const [name, request, codes] of REJECTIONS) {
    it(`binding holds, attribution unchanged: a ${name} call naming s joins on r`, async () => {
      const steps = (foreign: unknown): Step[] => [
        { frame: "a" },
        { call: OWN },
        { frame: "b" },
        { call: foreign },
        { frame: "c" },
        { call: OWN },
      ];
      const trial = await recordTrial(R, steps(request));
      const join = join_(trial);
      expect(join.ok).toBe(true);
      if (!join.ok) return;
      const line = join.decisions[1];
      expect(line).toMatchObject({ frame: 1, namedAnotherTrial: true, verdict: "uncertain" });
      expect(line?.reasonCodes).toEqual(codes);
      // Every other pin is as in the fixture without the foreign id (an own-id call there).
      const control = await recordTrial(R, steps(OWN));
      expect(pins(join)).toEqual(pins(join_(control)));
      // Rewriting request.runId on the rejection line to any other listed run moves nothing.
      for (const other of [R.runId, S, "run-t"]) {
        const log = rewriteLine(trial.log, 2, (v) => {
          (v.request as Record<string, unknown>).runId = other;
        });
        const listed = new Set([...LISTED, "run-t"]);
        const rejoin = join_(trial, {
          log,
          listedRuns: listed,
          manifest: manifestOf(reanchor(trial.records, log)),
        });
        expect(pins(rejoin)).toEqual(pins(join));
      }
    });
  }

  it("a request.runId rewrite on a verdict line past the assignment check gives TL_LOG_BINDING", async () => {
    const trial = await recordTrial(R, [{ frame: "a" }, { call: OWN }, { frame: "b" }]);
    const log = rewriteLine(trial.log, 1, (v) => {
      (v.request as Record<string, unknown>).runId = S;
    });
    const join = join_(trial, { log, manifest: manifestOf(reanchor(trial.records, log)) });
    expect(join).toEqual({ ok: false, code: "TL_LOG_BINDING" });
    expect("decisions" in join).toBe(false);
  });
});

describe("the shared line-count and prefix function", () => {
  it("counts complete non-blank lines; malformed lines count; a trailing partial line does not", () => {
    const log = Buffer.from('{"a":1}\n\n   \nnot json\n{"b":2}\n{"partial"');
    expect(logLines(log).map((l) => l.ordinal)).toEqual([1, 2, 3]);
    const anchors = logAnchors(log);
    expect(anchors).toHaveLength(4);
    expect(currentAnchor(log)).toEqual({ lines: 3, prefixSha256: anchors[3] });
    // The prefix of line k covers bytes up to and including its newline.
    const k2 = Buffer.from('{"a":1}\n\n   \nnot json\n');
    expect(currentAnchor(k2).prefixSha256).toBe(anchors[2]);
  });
});

describe("fail closed (RS-02)", () => {
  let trial: RecordedTrial;
  beforeAll(async () => {
    trial = await recordTrial(R, [
      { frame: "a" },
      { call: OWN },
      { frame: "b" },
      { call: OWN },
      { frame: "c" },
    ]);
  });
  const withRecords = (edit: (r: TimelineRecord[]) => unknown[]) => ({
    manifest: manifestOf(edit(trial.records.map((r) => ({ ...r })))),
  });
  const expectCode = (join: TimelineJoin, code: string) => {
    expect(join).toEqual({ ok: false, code });
    expect("decisions" in join).toBe(false);
  };

  it("the honest fixture joins", () => {
    expect(pins(join_(trial))).toEqual([0, 1]);
  });

  it("TL_SCHEMA: an unknown field, a missing field, a value outside its type, an over-long line", () => {
    expectCode(
      join_(
        trial,
        withRecords((r) => [{ ...r[0], extra: 1 }, r[1], r[2]]),
      ),
      "TL_SCHEMA",
    );
    expectCode(
      join_(
        trial,
        withRecords((r) => {
          const { frameSha256: _drop, ...rest } = r[0] as TimelineRecord;
          return [rest, r[1], r[2]];
        }),
      ),
      "TL_SCHEMA",
    );
    expectCode(
      join_(
        trial,
        withRecords((r) => [{ ...r[0], frame: "0" }, r[1], r[2]]),
      ),
      "TL_SCHEMA",
    );
    expectCode(
      join_(
        trial,
        withRecords((r) => [{ ...r[0], frame: -1 }, r[1], r[2]]),
      ),
      "TL_SCHEMA",
    );
    const long = Buffer.from(`${JSON.stringify({ pad: "x".repeat(5000) })}\n`);
    expect(parseManifest(long)).toEqual({ kind: "malformed" });
    expectCode(join_(trial, { manifest: parseManifest(Buffer.from("not json\n")) }), "TL_SCHEMA");
  });

  it("TL_RUN: a record names another run", () => {
    expectCode(
      join_(
        trial,
        withRecords((r) => [{ ...r[0], runId: S }, r[1], r[2]]),
      ),
      "TL_RUN",
    );
    expectCode(
      join_(
        trial,
        withRecords((r) => [{ ...r[0], runId: "unlisted" }, r[1], r[2]]),
      ),
      "TL_RUN",
    );
  });

  it("TL_GAP: ordinals are not 0..n-1, or n differs from the frame count", () => {
    expectCode(
      join_(
        trial,
        withRecords((r) => [r[0], r[2]]),
      ),
      "TL_GAP",
    );
    expectCode(
      join_(trial, { frameCount: 4, frameBytes: (i) => trial.frames[i] ?? Buffer.from("x") }),
      "TL_GAP",
    );
  });

  it("TL_DUPLICATE: two records share one frame ordinal", () => {
    expectCode(
      join_(
        trial,
        withRecords((r) => [r[0], r[1], r[2], r[1]]),
      ),
      "TL_DUPLICATE",
    );
  });

  it("TL_FRAME_DIGEST: a frame swapped or edited after capture", () => {
    expectCode(
      join_(trial, {
        frameBytes: (i) => (i === 1 ? Buffer.from("edited") : (trial.frames[i] ?? null)),
      }),
      "TL_FRAME_DIGEST",
    );
    expectCode(join_(trial, { frameBytes: (i) => trial.frames[2 - i] ?? null }), "TL_FRAME_DIGEST");
    expectCode(join_(trial, { frameBytes: () => null }), "TL_FRAME_DIGEST");
  });

  it("TL_ORDER: logBefore > logAfter within a frame", () => {
    expectCode(
      join_(
        trial,
        withRecords((r) => [r[0], { ...r[1], logBefore: r[2]?.logAfter }, r[2]]),
      ),
      "TL_ORDER",
    );
  });

  it("TL_ORDER: the next frame's logBefore is below this frame's logAfter", () => {
    expectCode(
      join_(
        trial,
        withRecords((r) => [r[0], r[1], { ...r[2], logBefore: r[0]?.logBefore }]),
      ),
      "TL_ORDER",
    );
  });

  it("TL_LOG_AHEAD: the log was truncated below a record's line count", () => {
    const truncated = Buffer.from(`${trial.log.toString().split("\n")[0]}\n`);
    expectCode(join_(trial, { log: truncated }), "TL_LOG_AHEAD");
    expectCode(join_(trial, { log: Buffer.alloc(0) }), "TL_LOG_AHEAD");
  });

  it("TL_LOG_PREFIX: a bad logBefore hash with a good logAfter hash", () => {
    const bad = "0".repeat(64);
    expectCode(
      join_(
        trial,
        withRecords((r) => [r[0], { ...r[1], logBefore: { lines: 1, prefixSha256: bad } }, r[2]]),
      ),
      "TL_LOG_PREFIX",
    );
  });

  it("TL_LOG_PREFIX: a good logBefore hash with a bad logAfter hash", () => {
    const bad = "0".repeat(64);
    expectCode(
      join_(
        trial,
        withRecords((r) => [r[0], { ...r[1], logAfter: { lines: 1, prefixSha256: bad } }, r[2]]),
      ),
      "TL_LOG_PREFIX",
    );
  });

  it("TL_LOG_PREFIX: a line edited, inserted, removed or reordered under the anchors", () => {
    const lines = trial.log.toString().split("\n");
    const edited = rewriteLine(trial.log, 1, (v) => {
      v.verdict = "verified";
    });
    expectCode(join_(trial, { log: edited }), "TL_LOG_PREFIX");
    expectCode(
      join_(trial, { log: Buffer.from([lines[0], lines[0], lines[1], ""].join("\n")) }),
      "TL_LOG_PREFIX",
    );
    expectCode(
      join_(trial, { log: Buffer.from([lines[1], lines[0], ""].join("\n")) }),
      "TL_LOG_PREFIX",
    );
  });

  it("a rewritten line that breaks both its prefix and the binding reports TL_LOG_PREFIX first", () => {
    const log = rewriteLine(trial.log, 1, (v) => {
      (v.request as Record<string, unknown>).runId = S;
    });
    expectCode(join_(trial, { log }), "TL_LOG_PREFIX");
  });

  describe("TL_LOG_BINDING: the mock demo's single shared log given as one run's log", () => {
    let shared: Buffer;
    beforeAll(async () => {
      const out = mkdtempSync(join(tmpdir(), "myco-timeline-demo-"));
      const report = await runMockDemo({ outDir: out });
      shared = readFileSync(report.auditLog);
    }, 120_000);

    for (const binding of [
      { taskId: "df-s01", runId: "demo-df-s01" },
      { taskId: "df-s02", runId: "demo-df-s02" },
    ]) {
      it(`as ${binding.runId}'s log`, () => {
        expect(logLines(shared)).toHaveLength(4);
        const frame = Buffer.from("frame 0");
        const record = {
          schema: "myco.watch-timeline/1",
          runId: binding.runId,
          frame: 0,
          frameSha256: createHash("sha256").update(frame).digest("hex"),
          logBefore: currentAnchor(Buffer.alloc(0)),
          logAfter: currentAnchor(Buffer.alloc(0)),
        };
        const join = joinTimeline({
          binding,
          listedRuns: new Set(["demo-df-s01", "demo-df-s02"]),
          manifest: manifestOf([record]),
          frameCount: 1,
          frameBytes: () => frame,
          log: shared,
        });
        expectCode(join, "TL_LOG_BINDING");
      });
    }
  });

  it("TL_LOG_BINDING: another gate's verdict line in this trial's log (anchors re-recorded)", async () => {
    const shared: string[] = [];
    const other = await recordTrial(
      { taskId: "df-s02", runId: S },
      [{ call: { taskId: "df-s02", runId: S } }],
      { sharedLog: shared },
    );
    const mixed = Buffer.concat([trial.log, other.log]);
    expectCode(
      join_(trial, { log: mixed, manifest: manifestOf(reanchor(trial.records, mixed)) }),
      "TL_LOG_BINDING",
    );
  });

  it("TL_MALFORMED: a malformed line at or below the last pinned decision", () => {
    const lines = trial.log.toString().split("\n");
    const log = Buffer.from([lines[0], "{not json", lines[1], ""].join("\n"));
    const join = join_(trial, { log, manifest: manifestOf(reanchor(trial.records, log)) });
    expectCode(join, "TL_MALFORMED");
    // A malformed trailing line after the last decision (a write in progress) is fine.
    const tail = Buffer.concat([trial.log, Buffer.from("{not json\n")]);
    expect(pins(join_(trial, { log: tail }))).toEqual([0, 1]);
  });

  it("TL_CLOCK_SKEW: checkedAt goes backwards between consecutive decisions", () => {
    const log = rewriteLine(trial.log, 2, (v) => {
      v.checkedAt = "2026-01-01T00:00:00.000Z";
    });
    expectCode(
      join_(trial, { log, manifest: manifestOf(reanchor(trial.records, log)) }),
      "TL_CLOCK_SKEW",
    );
  });

  it("TL_NO_TIMELINE: no manifest, or a manifest that is a symlink or not a regular file", () => {
    expectCode(join_(trial, { manifest: { kind: "absent" } }), "TL_NO_TIMELINE");
    const dir = mkdtempSync(join(tmpdir(), "myco-timeline-file-"));
    expect(readManifest(join(dir, "timeline.jsonl"))).toEqual({ kind: "absent" });
    const real = join(dir, "real.jsonl");
    writeFileSync(real, manifestBytes(trial.records));
    expect(pins(join_(trial, { manifest: readManifest(real) }))).toEqual([0, 1]);
    symlinkSync(real, join(dir, "timeline.jsonl"));
    expect(readManifest(join(dir, "timeline.jsonl"))).toEqual({ kind: "absent" });
    mkdirSync(join(dir, "sub.jsonl"));
    expect(readManifest(join(dir, "sub.jsonl"))).toEqual({ kind: "absent" });
  });

  it("a manifest line still being written is not read yet", () => {
    const bytes = manifestBytes(trial.records);
    const partial: ManifestRead = parseManifest(Buffer.concat([bytes, Buffer.from('{"schema"')]));
    expect(partial).toEqual({
      kind: "records",
      records: JSON.parse(`[${bytes.toString().trim().split("\n").join(",")}]`),
    });
  });
});

describe("clock (RS-03)", () => {
  let trial: RecordedTrial;
  let honest: (number | null)[];
  beforeAll(async () => {
    trial = await recordTrial(R, [
      { frame: "a" },
      { call: OWN },
      { call: OWN },
      { frame: "b" },
      { straddle: "c", during: OWN },
      { frame: "d" },
      { call: OWN },
    ]);
    honest = pins(join_(trial));
    expect(honest).toEqual([0, 0, 1, 3]);
  });
  const shifted = (edit: (ms: number, ordinal: number) => number) => {
    const log = rewriteAll(trial.log, (v, ordinal) => {
      v.checkedAt = new Date(edit(Date.parse(v.checkedAt as string), ordinal)).toISOString();
    });
    return join_(trial, { log, manifest: manifestOf(reanchor(trial.records, log)) });
  };

  it("checkedAt shifted +1 h or -1 h: the same order and pins", () => {
    expect(pins(shifted((ms) => ms + 3_600_000))).toEqual(honest);
    expect(pins(shifted((ms) => ms - 3_600_000))).toEqual(honest);
  });

  it("checkedAt equal on all lines: the same order and pins", () => {
    expect(pins(shifted(() => Date.parse("2026-11-27T10:00:00Z")))).toEqual(honest);
  });

  it("checkedAt reversed: TL_CLOCK_SKEW, the join refused (so export is refused)", () => {
    expect(shifted((_ms, ordinal) => Date.parse("2026-11-27T10:00:00Z") - ordinal * 1000)).toEqual({
      ok: false,
      code: "TL_CLOCK_SKEW",
    });
  });
});

describe("the binding check on the gate's real line shapes (§1.2)", () => {
  it("an own-run verdict line holds; a foreign evidence ref breaks (a)", async () => {
    const trial = await recordTrial(R, [{ call: OWN }]);
    const line = logLines(trial.log)[0];
    const decision = line && parseLoggedDecision(line.bytes);
    expect(decision).not.toBeNull();
    if (!decision) return;
    expect(bindingHolds(decision, R)).toBe(true);
    expect(bindingHolds({ ...decision, evidenceRunIds: [S] }, R)).toBe(false);
    // (b): a foreign id on a line that is not a pre-evidence rejection.
    expect(bindingHolds({ ...decision, requestRunId: S }, R)).toBe(false);
    expect(
      bindingHolds(
        {
          ...decision,
          requestRunId: S,
          evidenceRunIds: [],
          hasOracle: false,
          verdict: "uncertain",
          accepted: false,
          reasonCodes: ["ASSIGNMENT_MISMATCH", "CLAIM_RECORDED", "CLAIM_RECORDED"],
        },
        R,
      ),
    ).toBe(false);
    // The exact pre-evidence shape holds; each single deviation from it breaks (b).
    const shape = {
      ...decision,
      requestRunId: S,
      evidenceRunIds: [],
      hasOracle: false,
      hasCheckpoints: false,
      hasCorrections: false,
      verdict: "uncertain" as const,
      accepted: false,
      reasonCodes: ["ASSIGNMENT_MISMATCH" as const, "CLAIM_RECORDED" as const],
    };
    expect(bindingHolds(shape, R)).toBe(true);
    for (const deviation of [
      { reasonCodes: ["STATE_MISSING" as const] },
      { reasonCodes: ["CLAIM_RECORDED" as const] },
      { reasonCodes: [] },
      { verdict: "refuted" as const },
      { accepted: true },
      { hasOracle: true },
      { hasCheckpoints: true },
      { hasCorrections: true },
    ])
      expect(bindingHolds({ ...shape, ...deviation }, R)).toBe(false);
  });

  it("a malformed line parses to null and is never a decision", () => {
    for (const bad of [
      "{",
      "[]",
      '{"verdict":"maybe"}',
      '{"verdict":"verified","accepted":true,"reasonCodes":["NOPE"],"evidenceRefs":[],"request":{},"checkedAt":"2026-11-27T00:00:00Z"}',
    ])
      expect(parseLoggedDecision(Buffer.from(bad))).toBeNull();
  });
});
