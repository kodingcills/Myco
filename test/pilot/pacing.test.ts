/**
 * Track E: pacing and retries, on a virtual clock with a fake transport. Starts are spaced,
 * concurrency is bounded, rate limits back off and pause the run, and only harness faults
 * are re-run (in place, linked); an agent-side outcome never is.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeDriver, virtualClock } from "../../src/pilot/dry-run.ts";
import {
  BUDGET_EXEMPT_CLASSES,
  ledgerRows,
  loadLedger,
  PROGRESS_FILE,
} from "../../src/pilot/ledger.ts";
import { HarnessFault, PAUSE_FILE, type PilotDriver } from "../../src/pilot/runner.ts";
import { dryRun, tmp } from "./helpers.ts";

const attemptsOf = (dir: string) => loadLedger(join(dir, PROGRESS_FILE)).byTask;

describe("pilot pacing (track E)", () => {
  it("spaces trial starts by the inter-trial delay", async () => {
    const dir = tmp();
    const starts: number[] = [];
    const clock = virtualClock();
    await dryRun(dir, {
      clock,
      driver: fakeDriver({ beforeAgent: () => void starts.push(clock.now()) }),
    });
    expect(starts).toHaveLength(30);
    for (let i = 1; i < starts.length; i++)
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(90_000);
  });

  it("never runs more trials at once than the configured concurrency", async () => {
    const dir = tmp();
    let inFlight = 0;
    let peak = 0;
    const driver = fakeDriver({
      beforeAgent: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
      },
    });
    const { result } = await dryRun(dir, {
      driver,
      pacing: { concurrency: 2, interTrialDelayS: 0 },
    });
    expect(result.status).toBe("complete");
    expect(peak).toBe(2);
    const one = tmp();
    peak = 0;
    await dryRun(one, { driver, pacing: { concurrency: 1, interTrialDelayS: 0 } });
    expect(peak).toBe(1);
  });

  it("a rate limit is a harness fault: backed off, re-run in place, the faulted attempt kept and linked", async () => {
    const dir = tmp();
    let n = 0;
    const clock = virtualClock();
    const driver = fakeDriver({
      beforeAgent: () => {
        if (++n === 3) throw new HarnessFault("rate-limit", "429");
      },
      usage: () => ({
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
    });
    const { result } = await dryRun(dir, { driver, clock });
    expect(result).toMatchObject({ status: "complete", ran: 30, faulted: 1 });
    expect(clock.waits.some((w) => w >= 300_000)).toBe(true);
    const faultedTask = [...attemptsOf(dir).entries()].find(([, a]) => a.length === 2);
    expect(faultedTask).toBeDefined();
    const [first, second] = faultedTask?.[1] ?? [];
    expect(first?.end).toMatchObject({ outcome: "harness-fault", harnessClass: "rate-limit" });
    expect(first?.end?.armRow).toMatchObject({
      claim: "no-claim",
      gate: { called: false, verdict: null },
      accepted: false,
      cause: { kind: "harness", detail: "harness fault: rate-limit" },
    });
    expect(second?.start.supersedes).toBe(first?.start.trialKey);
    expect(second?.end?.outcome).toBe("decided");
  });

  it("pauses (resumable) after maxConsecutiveRateLimits rate limits in a row", async () => {
    const dir = tmp();
    const always: PilotDriver = fakeDriver({
      beforeAgent: () => {
        throw new HarnessFault("rate-limit", "usage limit");
      },
    });
    // Default pacing (no maxAttemptsPerTrial override): rate limits spend no attempt budget.
    const { result } = await dryRun(dir, { driver: always });
    expect(result.status).toBe("paused");
    expect(result.reason).toMatch(/4 rate limits in a row/);
    expect(result.faulted).toBe(4);
    const resumed = await dryRun(dir);
    expect(resumed.result).toMatchObject({ status: "complete", ran: 30 });
    expect(ledgerRows(loadLedger(join(dir, PROGRESS_FILE))).armRows).toHaveLength(30);
  });

  it("under the default pacing a rate-limit spell never strands a trial: paused, then resume completes (round 1, D1)", async () => {
    // The verifier's probe: default pacing (maxAttemptsPerTrial 3 < maxConsecutiveRateLimits 4),
    // the first 4 attempts rate-limited. Rate limits do not spend the attempt budget.
    const dir = tmp();
    let n = 0;
    const limited = fakeDriver({
      beforeAgent: () => {
        if (++n <= 4) throw new HarnessFault("rate-limit", "usage limit");
      },
    });
    const first = await dryRun(dir, { driver: limited });
    expect(first.result).toMatchObject({ status: "paused", faulted: 4, exhausted: [] });
    const resumed = await dryRun(dir);
    expect(resumed.result).toMatchObject({ status: "complete", ran: 30, exhausted: [] });
    const rows = ledgerRows(loadLedger(join(dir, PROGRESS_FILE))).armRows;
    expect(rows).toHaveLength(30);
    const list = attemptsOf(dir).get("fc-v1-001") ?? [];
    expect(list).toHaveLength(5);
    expect(list.slice(0, 4).every((a) => a.end?.harnessClass === "rate-limit")).toBe(true);
    expect(list[4]?.start.supersedes).toBe(list[3]?.start.trialKey);
    expect(list[4]?.end?.outcome).toBe("decided");
  });

  it("rate limits interleaved with other faults: only the other faults spend the budget", async () => {
    const dir = tmp();
    const seq = ["rate-limit", "timeout", "rate-limit", "timeout", "rate-limit"] as const;
    let n = 0;
    const driver = fakeDriver({
      beforeAgent: (ctx) => {
        if (ctx.task.taskId === "fc-v1-001" && n < seq.length)
          throw new HarnessFault(seq[n++] as (typeof seq)[number], "fault");
      },
    });
    const { result } = await dryRun(dir, { driver });
    expect(result).toMatchObject({ status: "complete", ran: 30, exhausted: [] });
    expect(attemptsOf(dir).get("fc-v1-001")).toHaveLength(6);
  });

  it("an auth fault (lost login) pauses at once and spends no attempt; resume completes", async () => {
    const dir = tmp();
    let n = 0;
    const driver = fakeDriver({
      beforeAgent: () => {
        if (++n === 2) throw new HarnessFault("auth", "Invalid API key · Please run /login");
      },
    });
    const { result } = await dryRun(dir, { driver, pacing: { maxAttemptsPerTrial: 1 } });
    expect(result.status).toBe("paused");
    expect(result.reason).toMatch(/not authenticated/);
    expect(result).toMatchObject({ ran: 1, faulted: 1, exhausted: [] });
    const resumed = await dryRun(dir, { pacing: { maxAttemptsPerTrial: 1 } });
    expect(resumed.result).toMatchObject({ status: "complete", ran: 29, skipped: 1 });
  });

  it("never re-runs an agent-side outcome: refuted, not-done and unregistrable trials run once", async () => {
    const dir = tmp();
    const notDone = fakeDriver();
    const driver: PilotDriver & { launched: string[] } = {
      simulated: true,
      launched: notDone.launched,
      transport(ctx) {
        const t = notDone.transport(ctx);
        return { ...t, report: () => ({ claim: "not-done", usage: null }) };
      },
    };
    await dryRun(dir, { driver });
    expect(driver.launched).toHaveLength(30);
    const rows = ledgerRows(loadLedger(join(dir, PROGRESS_FILE))).armRows;
    expect(rows).toHaveLength(30);
    for (const list of attemptsOf(dir).values()) expect(list).toHaveLength(1);
    expect(rows.every((r) => r.claim === "not-done" && !r.accepted)).toBe(true);
    // The credulous default: 12 faulted tasks refuted or unregistrable, each still run once.
    const dir2 = tmp();
    const credulous = fakeDriver();
    await dryRun(dir2, { driver: credulous });
    expect(credulous.launched).toHaveLength(30);
    const rows2 = ledgerRows(loadLedger(join(dir2, PROGRESS_FILE))).armRows;
    expect(rows2.filter((r) => r.gate?.verdict === "refuted")).toHaveLength(9);
    expect(rows2.filter((r) => r.gate?.unregistrable === true)).toHaveLength(3);
  });

  it("stops re-running after maxAttemptsPerTrial harness faults (incomplete, not looping)", async () => {
    const dir = tmp();
    const driver = fakeDriver({
      beforeAgent: (ctx) => {
        if (ctx.task.taskId === "fc-v1-002") throw new HarnessFault("timeout", "slow");
      },
    });
    const { result } = await dryRun(dir, { driver });
    expect(result.status).toBe("incomplete");
    expect(result.exhausted).toEqual(["fc-v1-002"]);
    expect(attemptsOf(dir).get("fc-v1-002")).toHaveLength(3);
    // Resume leaves an exhausted trial alone (no fourth attempt).
    const again = await dryRun(dir);
    expect(again.result.exhausted).toEqual(["fc-v1-002"]);
    expect(attemptsOf(dir).get("fc-v1-002")).toHaveLength(3);
  });

  // Verifier round 2, V-D: an unclassified error result is NOT budget-exempt (it spends the
  // attempt budget; only rate-limit and auth do not), so it cannot loop on the subscription.
  it("an unclassified error-result spends the attempt budget (round 2, V-D)", async () => {
    expect(BUDGET_EXEMPT_CLASSES.has("error-result")).toBe(false);
    const dir = tmp();
    let n = 0;
    const driver = fakeDriver({
      beforeAgent: (ctx) => {
        if (ctx.task.taskId !== "fc-v1-003") return;
        // Fail fast (a plain error stops the run) instead of looping if the budget is not spent.
        if (++n > 5) throw new Error("error-result did not spend the attempt budget");
        throw new HarnessFault("error-result", "unnamed");
      },
    });
    const { result } = await dryRun(dir, { driver });
    expect(result.status).toBe("incomplete");
    expect(result.exhausted).toEqual(["fc-v1-003"]);
    expect(attemptsOf(dir).get("fc-v1-003")).toHaveLength(3);
  });

  // Verifier round 2, V-I: "in a row" means a decided trial resets the count. Two trials each
  // hit 3 rate limits and then decide: 6 limits in total, never 4 in a row, so no pause.
  it("a decided trial resets the consecutive rate-limit count (round 2, V-I)", async () => {
    const dir = tmp();
    const seen = new Map<string, number>();
    const driver = fakeDriver({
      beforeAgent: (ctx) => {
        if (ctx.task.taskId !== "fc-v1-001" && ctx.task.taskId !== "fc-v1-002") return;
        const n = (seen.get(ctx.task.taskId) ?? 0) + 1;
        seen.set(ctx.task.taskId, n);
        if (n <= 3) throw new HarnessFault("rate-limit", "usage limit");
      },
    });
    const { result } = await dryRun(dir, { driver, pacing: { maxConsecutiveRateLimits: 4 } });
    expect(result).toMatchObject({ status: "complete", ran: 30, faulted: 6 });
    expect(attemptsOf(dir).get("fc-v1-001")).toHaveLength(4);
    expect(attemptsOf(dir).get("fc-v1-002")).toHaveLength(4);
  });

  it("an exception that is not a HarnessFault stops the run instead of being retried", async () => {
    const dir = tmp();
    const driver = fakeDriver({
      beforeAgent: () => {
        throw new TypeError("harness bug");
      },
    });
    await expect(dryRun(dir, { driver })).rejects.toThrow(/harness bug/);
    expect(driver.launched).toHaveLength(1);
  });

  it("a PAUSE file stops new starts; removing it and re-running resumes", async () => {
    const dir = tmp();
    let n = 0;
    const driver = fakeDriver({
      beforeAgent: () => {
        if (++n === 5) writeFileSync(join(dir, PAUSE_FILE), "");
      },
    });
    const { result } = await dryRun(dir, { driver });
    expect(result).toMatchObject({ status: "paused", ran: 5 });
    expect((await dryRun(dir)).result.status).toBe("paused");
    rmSync(join(dir, PAUSE_FILE));
    expect((await dryRun(dir)).result).toMatchObject({ status: "complete", ran: 25, skipped: 5 });
  });
});
