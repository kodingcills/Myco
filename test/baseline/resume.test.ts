/**
 * `--resume` for c1-sweep (TIF-187-resume).
 *
 * Two arms in this workstream died mid-run and were restarted from trial 0 - r3 by
 * host sleep, arm-003d's r2 at trial 5's reset - and each restart re-bought rows
 * that had already been scored. The ledger existed for exactly this reason and
 * nothing used it to continue.
 *
 * The properties tested here are the ones whose ABSENCE cost money or corrupted a
 * result:
 *
 *  1. a crash at trial k reruns only the unfinished trials, not the finished ones
 *  2. spend is not double-counted across the resume
 *  3. a different manifest/model/snapshot is refused rather than blended
 *  4. the abort-early rule still fires across a resume boundary
 *
 * `prepare` is the seam: it is supplied by the live wrapper and is the only part
 * that touches the guest, so a throw or a counter here simulates a crash without a
 * VM. Every test is host-side.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedC1 } from "../../src/baseline/c1-trial.ts";
import { STEP_BUDGET } from "../../src/baseline/c1-trial.ts";
import { MAX_CALL_MICROS, type Planner } from "../../src/baseline/planner.ts";

// The guard's own reservation for a paid planner (sweep.ts: MAX_TRIAL_MICROS).
const MAX_TRIAL_MICROS = STEP_BUDGET * MAX_CALL_MICROS;

import { runC1Sweep } from "../../src/baseline/sweep.ts";

const RESET = "cua-c1-base";

/**
 * Minimal MCP stub, matching `c1-live.test.ts` exactly.
 *
 * The SHAPES matter: a `get_window_state` reply without the image content does
 * not fail loudly, it yields "guest screenshot unavailable" and every trial is
 * omitted - which looks like a resume bug and is not one.
 */
function fakeMcp() {
  return {
    request: async (method: string, params: { name?: string }) => {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (params.name === "get_window_state")
        return {
          content: [{ type: "text", text: "secret tree" }, shot],
          structuredContent: { element_token: "tree" },
        };
      return { structuredContent: { path: "pixel", verified: true } };
    },
    notify: async () => {},
  } as never;
}
const shot = { type: "image", mimeType: "image/png", data: "eA==" } as const;
const IDENTITY = { model: "claude-sonnet-5-5", snapshot: RESET, planner: "paid" };

const directories: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "myco-resume-test-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A paid planner whose per-trial cost is one call, so spend is predictable.
 *
 * The decision VARIES per trial on purpose. A planner that answers identically
 * every time produces rows with an identical action signature, and the
 * abort-early rule then stops the sweep after two - correctly, since that is the
 * "measuring the harness" shape. These tests are about resume, so they must keep
 * the run alive to reach trial 30.
 */
function planner(): Planner {
  let n = 0;
  return {
    paid: true,
    act: async () => ({
      calls: [
        { model: "claude-sonnet-5-5", usage: { prompt: 1_000, completion: 100, cost: 0.001 } },
      ],
      // `pixelAction` pins the argument COUNT: click takes {x,y} and the other
      // tools take {x,y,text|key}. Getting this wrong yields "invalid pixel
      // action" and the trial is omitted rather than scored.
      // The ACTION SIGNATURE is part of the abort key, so the tool mix must
      // differ between consecutive trials. A cycle of length N repeats every N
      // trials and trips the rule; a tool chosen by an ever-growing count does
      // not. `n` is shared with the coordinate, so each trial is distinct.
      decision: decisionFor(n++),
    }),
  } as never;
}

/**
 * A decision whose TOOL MIX varies with the trial number.
 *
 * The abort key includes the action signature, so a fixed tool trips
 * `repeated-cause` after two rows however the coordinates differ. Cycling gives
 * consecutive rows different mixes. `pixelAction` also pins the argument COUNT -
 * click takes {x,y}, the others take three - so the shape is built per tool.
 */
function decisionFor(n: number) {
  // A UNIQUE tool per trial is what keeps the signature distinct: the abort key
  // is `scored:verdict:reason:actions=<tool>x<count>,...`, so two trials using the
  // same tool the same number of times are the same cause however their
  // coordinates differ.
  //
  // `press_key` is deliberately avoided except on a small fraction: the harness
  // records a Save attempt on it, and these tests are not about saving.
  const base = { x: n + 1, y: n + 2 };
  if (n % 2 === 0) return { tool: "click", arguments: base };
  return { tool: "type_text", arguments: { ...base, text: `v${n}` } };
}

/**
 * A prepare that succeeds for the first `failAfter` calls, then throws.
 *
 * Models a crash: the trials before the throw are scored and durable, the one
 * that throws is omitted, and nothing after it ever runs.
 */
function crashingPrepare(failAfter: number, throwTimes = 1, tick: { n: number } = nextTick()) {
  let seen = 0;
  let thrown = 0;
  return async () => {
    seen += 1;
    // Throw for `throwTimes` consecutive calls after `failAfter` successes.
    //
    // A REAL crash kills the process, so exactly ONE interruption is recorded
    // and nothing after it runs. Throwing forever would instead produce two
    // consecutive interruptions, which is a different shape: the repeated-cause
    // rule fires and the run is stopped by design rather than cut short. Tests
    // that want a resumable state need the one-interruption shape.
    if (seen > failAfter && thrown < throwTimes) {
      thrown += 1;
      throw new Error("simulated crash: guest vanished mid-trial");
    }
    return prepared(tick);
  };
}

/**
 * The per-sweep judge counter.
 *
 * Deliberately NOT a default argument on `prepared`: `prepared()` is called once
 * per trial, so a fresh counter each call would hand the abort rule the same
 * verdict forever and stop the run at row 2. Each test takes one tick and passes
 * it to every `prepared()` call in that sweep.
 */
function nextTick() {
  return { n: 0 };
}

/**
 * A prepared trial whose judge verdict ALTERNATES per trial.
 *
 * `tick` is taken per sweep rather than kept module-scoped: a shared counter
 * accumulates across tests, so which verdict lands on which trial depends on
 * execution order and the abort rule then fires in one ordering and not another.
 */
function prepared(tick: { n: number } = nextTick()): PreparedC1 {
  return {
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
      // READY: a not-ready driver makes every trial `driver-unreachable`, which
      // stops the sweep after the first row and never consults the planner.
      pipeReachable: true,
      sessionIdentityMatches: true,
    },
    resetMs: 1,
    acPower: true,
    caffeinate: true,
    loadAvg1: 0,
    window: { pid: 1, window_id: 2 },
    connect: async () => fakeMcp(),
    closeTransport: async () => {},
    // The verdict alternates so consecutive trials carry different abort keys.
    // Everything else about the row is identical, so without this the run would
    // stop at row 2 under the repeated-cause rule.
    // STRICTLY alternating, so no two consecutive trials share a verdict and the
    // abort key (verdict + reason + action signature) always differs.
    judge: async () =>
      ({
        kind: tick.n++ % 2 === 0 ? "persisted" : "driver-action",
        actual: "wrong",
        expected: "right",
      }) as never,
    audit: async () => false,
  } as never;
}

function ledgerOf(dir: string) {
  return JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
}
function scoredIndexes(dir: string): number[] {
  const led = ledgerOf(dir);
  return Object.entries(led.c1 as Record<string, { status: string }>)
    .filter(([, e]) => e.status === "scored")
    .map(([k]) => Number(k))
    .sort((a, b) => a - b);
}

describe("c1-sweep --resume", () => {
  it("reruns only the unfinished trials after a crash at trial k", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    // Crash after two trials complete. The throw happens once, because a real
    // process death leaves exactly ONE interruption: throwing on every call would
    // produce two consecutive interruptions and the abort rule would stop the run
    // by design, which is a different shape from being cut short.
    const tick = nextTick();
    await runC1Sweep({ ...base, prepare: crashingPrepare(2, 1, tick) });
    const afterCrash = scoredIndexes(dir);
    // Trial 2 is the one that threw, so it is omitted; the rest scored.
    expect(afterCrash).toContain(0);
    expect(afterCrash).toContain(1);
    const omittedIdx = Object.entries(ledgerOf(dir).c1 as Record<string, { status: string }>)
      .filter(([, e]) => e.status !== "scored")
      .map(([k]) => Number(k));
    expect(omittedIdx).toEqual([2]);

    // The resume must NOT re-execute 0 and 1. Counting prepare calls is the
    // direct measure: a resume that restarted from zero would call prepare 30
    // times rather than 28.
    //
    // The crash cause is raised only ONCE here. Throwing on every call would
    // trip the repeated-cause rule at the second resumed trial - correct
    // behaviour, but it stops the run and this test is about what gets
    // re-executed, not about the abort rule (which has its own test below).
    let prepares = 0;
    const resumeTick = nextTick();
    const report = await runC1Sweep({
      ...base,
      resume: true,
      prepare: async () => {
        prepares += 1;
        if (prepares === 1) throw new Error("simulated crash: guest vanished mid-trial");
        return prepared(resumeTick);
      },
    });

    // ONLY trial 2 is re-executed: the 29 scored trials are skipped, and a run
    // that restarted from zero would call prepare 30 times. This is the whole
    // point of the feature.
    expect(prepares).toBe(1);
    // The finished rows are still there and still the SAME rows.
    const after = scoredIndexes(dir);
    for (const i of [0, 1]) expect(after).toContain(i);
    // And the run completes rather than restarting.
    expect(report.rows.length).toBe(30);
  });

  it("does not double-count the spend the first attempt already committed", async () => {
    const dir = directory();
    const tick = nextTick();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 1_000_000,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    await runC1Sweep({ ...base, prepare: crashingPrepare(2, 1, tick) });
    const first = ledgerOf(dir);
    const committed = Object.values(first.c1 as Record<string, { status: string; micros: number }>)
      .filter((e) => e.status === "scored")
      .reduce((t, e) => t + e.micros, 0);
    expect(committed).toBeGreaterThan(0);

    // THE DISCRIMINATING VALUE. Committed cash must be counted EXACTLY ONCE.
    //
    // `charged(ledger.c1)` already includes the rows the first attempt scored, so
    // the guard sees that spend through the ledger. A resume that ALSO folded it
    // into prior spend counted it twice and shrank the usable budget by the exact
    // amount already paid - on a real arm that wastes money already spent, and it
    // is a plausible mistake because "prior = original + committed" reads like the
    // careful thing to do.
    //
    // prior 7,000,000 with committed ~870k and a 607,200 reservation:
    //   counted once (correct) : 7,000,000 + 870,000 + 607,200 = 8,477,200  -> RUNS
    //   counted twice (bug)    : 7,870,000 + 870,000 + 607,200 = 9,347,200  -> OMITS
    const reservation = MAX_TRIAL_MICROS;
    const ceiling = 9_000_000;
    const prior = 7_000_000;
    // The once-counted total must fit, or this test cannot distinguish the two.
    expect(prior + committed + reservation).toBeLessThan(ceiling);
    // The twice-counted total must NOT fit, or the buggy version would also run.
    expect(prior + committed + committed + reservation).toBeGreaterThan(ceiling);

    let prepares = 0;
    const report = await runC1Sweep({
      ...base,
      priorSpendMicros: prior,
      resume: true,
      prepare: async () => {
        prepares += 1;
        return prepared(nextTick());
      },
    });

    // Trials ARE admitted: the committed cash fits under the ceiling once.
    expect(prepares).toBeGreaterThan(0);
    // And the run never exceeds the project ceiling.
    expect(prior + report.combinedChargedMicros).toBeLessThanOrEqual(ceiling);
  });

  it("refuses to resume when the model differs from the original run", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    await runC1Sweep({ ...base, prepare: crashingPrepare(2) });

    await expect(
      runC1Sweep({
        ...base,
        resume: true,
        identity: { ...IDENTITY, model: "some-other-model" },
        prepare: async () => prepared(),
      }),
    ).rejects.toThrow(/model differs/);
  });

  it("refuses to resume when the snapshot differs from the original run", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    await runC1Sweep({ ...base, prepare: crashingPrepare(2) });

    await expect(
      runC1Sweep({
        ...base,
        resume: true,
        identity: { ...IDENTITY, snapshot: "cua-c1-other" },
        prepare: async () => prepared(),
      }),
    ).rejects.toThrow(/snapshot differs/);
  });

  it("refuses to resume a ledger whose manifest checksum does not match", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    await runC1Sweep({ ...base, prepare: crashingPrepare(2) });

    // Rewrite the recorded checksum: the manifest is the task set, so a ledger
    // from a different one cannot be extended, whatever the model says.
    const path = join(dir, "accounting.json");
    const led = JSON.parse(readFileSync(path, "utf8"));
    led.manifestSha256 = "0".repeat(64);
    writeFileSync(path, JSON.stringify(led, null, 2));

    await expect(
      runC1Sweep({ ...base, resume: true, prepare: async () => prepared() }),
    ).rejects.toThrow(/manifest mismatch/);
  });

  it("refuses to resume a ledger that records no identity at all", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    await runC1Sweep({ ...base, prepare: crashingPrepare(2) });

    const path = join(dir, "accounting.json");
    const led = JSON.parse(readFileSync(path, "utf8"));
    delete led.identity;
    writeFileSync(path, JSON.stringify(led, null, 2));

    // A ledger that cannot say what produced it must not be extended: assuming
    // compatibility is how two different experiments become one artifact.
    await expect(
      runC1Sweep({ ...base, resume: true, prepare: async () => prepared() }),
    ).rejects.toThrow(/no run identity/);
  });

  it("keeps the abort-early rule working across a resume boundary", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    // Run 1 leaves EXACTLY ONE interruption: trial 0 throws, and every later
    // trial scores. The tick must be shared across the whole sweep, otherwise
    // each `prepared()` call starts its own judge counter, every row gets the
    // same verdict, and run 1 aborts on repeated-cause by itself - which would
    // make this test pass without the resume replay ever being exercised.
    let n = 0;
    const tick = nextTick();
    const first = await runC1Sweep({
      ...base,
      prepare: async () => {
        n += 1;
        if (n === 1) throw new Error("simulated crash: guest vanished mid-trial");
        return prepared(tick);
      },
    });
    const after = ledgerOf(dir);
    const interrupted = Object.entries(
      after.c1 as Record<string, { status: string; reason?: string }>,
    )
      .filter(([, e]) => e.status === "omitted" && e.reason === "trial-interrupted")
      .map(([k]) => k);
    expect(interrupted).toEqual(["0"]);
    // Precondition: run 1 did NOT abort, so any repeated-cause later is the
    // resume's doing and not an artefact of the first run.
    const reasons1 = Object.values(after.c1 as Record<string, { reason?: string }>).map(
      (e) => e.reason,
    );
    expect(reasons1).not.toContain("repeated-cause");
    expect(first.completed).toBe(29);

    // Resume and interrupt the SAME way on the re-attempt. That is the second
    // consecutive identical cause, and the rule MUST fire.
    //
    // The mutation this catches: drop the cause replay for a rerunnable omission
    // and the counter restarts at zero, so the resume sees one failure and
    // quietly keeps going - the fault the rule exists to catch, hidden by the act
    // of resuming.
    const report = await runC1Sweep({
      ...base,
      resume: true,
      prepare: async () => {
        throw new Error("simulated crash: guest vanished mid-trial");
      },
    });
    // The stop is named in the report rather than looked for in the ledger: every
    // remaining trial was already scored, so nothing is left to be OMITTED with
    // `repeated-cause`. Asserting on the ledger would only hold when unscored
    // trials remain, and would pass vacuously here.
    expect(report).toMatchObject({ stopReason: "repeated-cause" });
    // Trial 0 stays omitted, so the run is partial - 29 of 30 - and the stop
    // reason is what says the shortfall was a harness decision, not a long tail.
    expect(report.partial).toBe(true);
  });

  it("writes a checkable identity into a fresh run so a later resume can use it", async () => {
    const dir = directory();
    await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
      prepare: crashingPrepare(5),
    });
    const led = ledgerOf(dir);
    expect(led.identity).toEqual(IDENTITY);
    // And the checkpoint is a real file, not a temp file left behind.
    expect(existsSync(join(dir, "accounting.json"))).toBe(true);
    expect(existsSync(join(dir, "accounting.json.tmp"))).toBe(false);
  });

  it("leaves a deliberate spend-limit stop alone rather than re-buying it", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      identity: IDENTITY,
    };
    // An arm limit too small to hold one reservation stops every trial as
    // spend-limit - a DECISION, not a crash.
    await runC1Sweep({ ...base, armLimitMicros: 0, prepare: async () => prepared() });
    const led0 = ledgerOf(dir);
    const reasons0 = Object.values(led0.c1 as Record<string, { reason?: string }>).map(
      (e) => e.reason,
    );
    expect(reasons0.every((r) => r === undefined || r === "spend-limit")).toBe(true);

    // A resume must not reinterpret that as work to do: re-running would re-buy
    // exactly what the ceiling stopped.
    let prepares = 0;
    await runC1Sweep({
      ...base,
      armLimitMicros: 9_000_000,
      resume: true,
      prepare: async () => {
        prepares += 1;
        return prepared();
      },
    });
    expect(prepares).toBe(0);
  });

  it("resumes without re-running when every trial already finished", async () => {
    const dir = directory();
    const base = {
      coordinatorGo: true,
      directory: dir,
      planner: planner(),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
    };
    // A prepare that always succeeds means the whole manifest completes.
    const tick = nextTick();
    const first = await runC1Sweep({ ...base, prepare: async () => prepared(tick) });
    expect(first.completed).toBe(30);

    let prepares = 0;
    const second = await runC1Sweep({
      ...base,
      resume: true,
      prepare: async () => {
        prepares += 1;
        return prepared();
      },
    });
    // Nothing to do, so nothing is executed or charged.
    expect(prepares).toBe(0);
    expect(second.completed).toBe(30);
    expect(second.c1ChargedMicros).toBe(first.c1ChargedMicros);
  });
});
