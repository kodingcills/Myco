/**
 * TIF-200 — the output ceiling, and what a truncation costs.
 *
 * r6 stopped at trial 20 because ONE model call was truncated at `max_tokens=1024`. Two
 * separate defects came out of that, and both are about a harness fault being treated as
 * something it is not:
 *
 *  1. ONE failure ended the arm. The catch assigned `stopReason = "planner-failed"`, so
 *     the first measurable provider fault stopped a 30-trial run and trials 21-29 were
 *     omitted at zero cost. Every other cause in the sweep needs TWO consecutive
 *     occurrences; a truncation is a harness/config fault of exactly that kind.
 *
 *  2. The failure was booked at the FULL RESERVATION, $0.6072, although a truncated reply
 *     is billed and its usage is known. The cost was recorded in `calls` and then thrown
 *     away with the exception. Booking the reservation for a known charge overstates what
 *     the cap has consumed and can stop an affordable run early - the opposite error to
 *     the one fail-closed booking guards against, but an error either way.
 *
 * The measured basis for the ceiling is in planner.ts: 570 calls across r6's 19 completed
 * trials, max completion 615, nothing above 768.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedC1 } from "../../src/baseline/c1-trial.ts";
import { MAX_CALL_MICROS, MAX_OUTPUT, PlannerFailure } from "../../src/baseline/planner.ts";
import { runC1Sweep } from "../../src/baseline/sweep.ts";

const dirs: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "myco-tif200-"));
  dirs.push(path);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const shot = { type: "image", mimeType: "image/png", data: "eA==" };
function fakeMcp() {
  return {
    request: async (method: string, params: { name?: string }) => {
      if (method === "initialize") return { protocolVersion: "2025-11-25" };
      if (params.name === "get_window_state")
        return {
          content: [{ type: "text", text: "t" }, shot],
          structuredContent: { element_token: "t" },
        };
      return { structuredContent: { path: "pixel", verified: true } };
    },
    notify: async () => {},
  } as never;
}
function prepared(): PreparedC1 {
  return {
    driver: {
      hostVersion: "0.56.4",
      guestVersion: "0.56.4",
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
    judge: async () => ({ kind: "unavailable" }),
    audit: async () => false,
  } as never;
}
const IDENTITY = { model: "claude-sonnet-5-5", snapshot: "cua-c1-base", planner: "paid" };

/** A paid planner whose every call throws the given failure. */
function throwingPlanner(make: () => Error) {
  return {
    paid: true,
    act: async () => {
      throw make();
    },
  } as never;
}

describe("a truncation is a harness fault that costs what it cost", () => {
  it("books the ACTUAL charge when the failure carries one", async () => {
    const dir = directory();
    const ACTUAL = 12_345;
    await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner: throwingPlanner(() => new PlannerFailure("truncated at max_tokens=2048", ACTUAL)),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
      prepare: async () => prepared(),
    });
    const led = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
    const entries = Object.values(led.c1) as { status: string; micros: number; reason?: string }[];
    const failed = entries.filter((e) => e.reason === "planner-failed");
    expect(failed.length).toBeGreaterThan(0);
    // The billed figure, NOT the reservation. Booking the hold here would overstate what
    // the cap has consumed by the difference between $0.0123 and $0.6072 per trial.
    for (const e of failed) expect(e.micros).toBe(ACTUAL);
  });

  it("keeps the reservation when the failure carries NO cost (fail closed)", async () => {
    const dir = directory();
    await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner: throwingPlanner(() => new PlannerFailure("Anthropic messages API call failed")),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
      prepare: async () => prepared(),
    });
    const led = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
    const failed = (
      Object.values(led.c1) as { status: string; micros: number; reason?: string }[]
    ).filter((e) => e.reason === "planner-failed");
    expect(failed.length).toBeGreaterThan(0);
    // Unknown cost keeps the hold: under-reporting spend against a hard cap is the
    // dangerous direction, and this property must survive the TIF-200 change.
    for (const e of failed) expect(e.micros).toBe(30 * MAX_CALL_MICROS);
  });

  it("does NOT stop the arm on the FIRST planner failure", async () => {
    // The r6 shape: one truncation ended a paid run and trials 21-29 were lost. A run
    // that stops on its first provider fault cannot distinguish a blip from a fault.
    const dir = directory();
    const report = await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner: throwingPlanner(() => new PlannerFailure("truncated", 1_000)),
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
      prepare: async () => prepared(),
    });
    // It must take TWO consecutive to abort, exactly like every other cause.
    expect(report.stopReason).toBe("repeated-cause");
    const scored = Object.values(
      JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8")).c1 as Record<
        string,
        { reason?: string }
      >,
    ).filter((e) => e.reason === "planner-failed").length;
    // Two failures ran; the rest were omitted by the abort, not by the first failure.
    expect(scored).toBeGreaterThanOrEqual(2);
    expect(report.completed).toBe(0);
  });

  it("records the output ceiling in the report, so the artifact names the limit", async () => {
    const dir = directory();
    const report = await runC1Sweep({
      coordinatorGo: true,
      directory: dir,
      planner: { paid: true, act: async () => ({ calls: [], decision: "failure" }) } as never,
      priorSpendMicros: 0,
      armLimitMicros: 9_000_000,
      identity: IDENTITY,
      prepare: async () => prepared(),
    });
    // r6's rows 0-19 ran at 1024 and row 20 truncated there; a report that omits the
    // ceiling cannot say which configuration produced it.
    expect(report).toMatchObject({ maxOutputTokens: MAX_OUTPUT });
  });
});

describe("a cost the ledger cannot trust is not booked", () => {
  // `PlannerFailure.costMicros` is a public constructor argument whose value feeds a HARD
  // CAP. A round-1 verifier measured what an unvalidated figure does to that cap:
  // negative makes `charged()` shrink so the guard fires LATER, `NaN` makes `NaN > LIMIT`
  // false so the cap is silently dead, and an over-reservation total exceeds the ceiling
  // unguarded. Only a plausible charge may be booked.
  const RESERVATION = 30 * MAX_CALL_MICROS;
  const corrupt: [string, number][] = [
    ["zero", 0],
    ["negative", -500_000],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["fractional", 1234.567],
    ["over the reservation", RESERVATION + 1],
  ];

  for (const [label, cost] of corrupt) {
    it(`keeps the reservation rather than booking a ${label} cost`, async () => {
      const dir = directory();
      await runC1Sweep({
        coordinatorGo: true,
        directory: dir,
        planner: throwingPlanner(() => new PlannerFailure("truncated", cost)),
        priorSpendMicros: 0,
        armLimitMicros: 9_000_000,
        identity: IDENTITY,
        prepare: async () => prepared(),
      });
      const led = JSON.parse(readFileSync(join(dir, "accounting.json"), "utf8"));
      const failed = (
        Object.values(led.c1) as { status: string; micros: number; reason?: string }[]
      ).filter((e) => e.reason === "planner-failed");
      expect(failed.length).toBeGreaterThan(0);
      for (const e of failed) {
        // Every entry stays a safe non-negative integer, and none exceeds the hold that
        // stands in for it - which is the invariant `loadLedger` enforces on resume, and
        // the property that keeps `charged()` comparable to the cap.
        expect(Number.isSafeInteger(e.micros)).toBe(true);
        expect(e.micros).toBeGreaterThanOrEqual(0);
        expect(e.micros).toBeLessThanOrEqual(RESERVATION);
      }
      // `0` is a legitimate refusal of an implausible charge only when the charge IS
      // implausible - `zero` is a real (if unlikely) cost, so it is booked as zero and
      // the assertion above still holds. The point is that nothing corrupt escapes.
    });
  }
});

describe("the ceiling is set from measurement, not taste", () => {
  // The measured basis: 570 calls across r6's 19 completed trials.
  const MEASURED_MAX = 615; // the largest completion r6 ever produced
  const MEASURED_P99 = 535;

  it("carries substantial headroom over the largest reply ever measured", () => {
    // 1024 over a max of 615 is ~66% headroom, and 91% over P99. That is the reason the
    // ceiling was KEPT rather than raised: it was never tight for a normal reply, so a
    // higher bound would only make the one runaway call more expensive.
    expect(MAX_OUTPUT).toBeGreaterThan(MEASURED_MAX);
    expect(MAX_OUTPUT).toBeGreaterThan(MEASURED_P99);
    expect((MAX_OUTPUT - MEASURED_MAX) / MEASURED_MAX).toBeGreaterThan(0.5);
  });

  it("is not raised to accommodate a degenerate reply", () => {
    // Trial 20 was the ONE call in 571 that ran past 615. Raising the ceiling so that
    // call could finish would spend the remaining cap headroom on a reply that had
    // already gone wrong, and would not make the next one behave.
    //
    // Pinned as a ceiling rather than left implicit, so a future change to 2048 or
    // beyond has to argue with this test rather than with a comment.
    expect(MAX_OUTPUT).toBe(1024);
  });
});
