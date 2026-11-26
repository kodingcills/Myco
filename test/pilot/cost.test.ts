/**
 * Track E: pilot cost is a token-derived ESTIMATE, labelled as such; null when unmeasured
 * (never 0); and no record carries a billed-USD field.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COST_BASIS, estimateCost, estimatedCostPerVerified } from "../../src/pilot/cost.ts";
import { fakeDriver } from "../../src/pilot/dry-run.ts";
import {
  ledgerRows,
  loadLedger,
  measuredUsd,
  PROGRESS_FILE,
  pilotStatus,
} from "../../src/pilot/ledger.ts";
import { dryRun, ROOT, tmp } from "./helpers.ts";

const usage = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadInputTokens: 1_000_000,
  cacheCreationInputTokens: 0,
};

describe("pilot cost estimate (track E)", () => {
  it("prices tokens at the frozen rates and labels the result an estimate", () => {
    const e = estimateCost("claude-sonnet-5-5", usage);
    expect(e).toMatchObject({ basis: COST_BASIS, pricedAs: "claude-sonnet-5-5" });
    expect(e.estimatedModelUsd).toBeCloseTo(2 + 1 + 0.1, 9);
    expect(COST_BASIS).toMatch(/estimate/);
    expect(COST_BASIS).toMatch(/not billed/);
  });

  it("is null, never 0, when unmeasured, unpriced or malformed", () => {
    expect(estimateCost("claude-sonnet-5-5", null).estimatedModelUsd).toBeNull();
    expect(estimateCost("simulated:pilot-dry-run", usage).estimatedModelUsd).toBeNull();
    expect(
      estimateCost("claude-sonnet-5-5", { ...usage, inputTokens: -1 }).estimatedModelUsd,
    ).toBeNull();
    expect(estimatedCostPerVerified([0.1, null, 0.2], 3)).toEqual({
      basis: COST_BASIS,
      total: null,
      perVerified: null,
    });
    expect(estimatedCostPerVerified([0.1, 0.2], 0).perVerified).toBeNull();
    expect(estimatedCostPerVerified([0.1, 0.2], 2).perVerified).toBeCloseTo(0.15, 9);
  });

  it("no ledger line carries a billed field; a dry run without usage records null cost", async () => {
    const dir = tmp();
    await dryRun(dir, { driver: fakeDriver() });
    const text = readFileSync(join(dir, PROGRESS_FILE), "utf8");
    // No JSON key names a bill (the basis string says "not billed USD"; that is a value).
    expect(text).not.toMatch(/"[^"]*billed[^"]*":/i);
    const ends = text
      .split("\n")
      .filter((l) => l.includes('"event":"end"'))
      .map(
        (l) =>
          JSON.parse(l) as {
            cost: { estimatedModelUsd: unknown; basis: string };
            armRow: { cost: { modelUsd: unknown } };
          },
      );
    expect(ends).toHaveLength(30);
    for (const e of ends) {
      expect(e.cost.basis).toBe(COST_BASIS);
      expect(e.cost.estimatedModelUsd).toBeNull();
      expect(e.armRow.cost.modelUsd).toBeNull();
    }
  });

  // Verifier round 2, D5: R7's numerator is `status`'s costEstimate.total, built by
  // ledgerRows. A null or missing cost there is unmeasured: null, never counted as 0.
  it("R7's numerator (status costEstimate.total) is null, never 0, when an attempt is unmeasured (round 2, D5)", async () => {
    expect(measuredUsd(null)).toBeNull();
    expect(measuredUsd(undefined)).toBeNull();
    const base = estimateCost("claude-sonnet-5-5", usage);
    expect(measuredUsd({ ...base, estimatedModelUsd: null })).toBeNull();
    expect(measuredUsd({ ...base, estimatedModelUsd: Number.NaN })).toBeNull();
    expect(measuredUsd({ ...base, estimatedModelUsd: -1 })).toBeNull();
    expect(measuredUsd(base)).toBeCloseTo(3.1, 9);
    expect(estimatedCostPerVerified([0.1, Number.NaN], 1).total).toBeNull();

    // The runbook's dry run: every attempt unmeasured, so every cost and the total are null.
    const dir = tmp();
    await dryRun(dir, { driver: fakeDriver() });
    const state = loadLedger(join(dir, PROGRESS_FILE));
    const { costs } = ledgerRows(state);
    expect(costs).toHaveLength(30);
    expect(costs.every((c) => c === null)).toBe(true);
    expect(pilotStatus(state).costEstimate).toEqual({
      basis: COST_BASIS,
      total: null,
      perVerified: null,
    });

    // A measured run with ONE end line whose cost is missing entirely, and one whose
    // estimatedModelUsd key is missing: still null, not the sum of the others.
    const measured = tmp();
    await dryRun(measured, { driver: fakeDriver({ usage: () => usage }) });
    const path = join(measured, PROGRESS_FILE);
    const measuredState = loadLedger(path);
    expect(pilotStatus(measuredState).costEstimate.total).toBeCloseTo(30 * 3.1, 6);
    let edits = 0;
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => {
        if (!l.includes('"event":"end"') || edits >= 2) return l;
        const e = JSON.parse(l) as { cost?: Record<string, unknown> | null };
        if (edits++ === 0) delete e.cost;
        else delete e.cost?.estimatedModelUsd;
        return JSON.stringify(e);
      });
    writeFileSync(path, lines.join("\n"));
    const edited = loadLedger(path);
    expect(ledgerRows(edited).costs.filter((c) => c === null)).toHaveLength(2);
    expect(pilotStatus(edited).costEstimate.total).toBeNull();

    // Through the CLI the runbook names: `status` prints total null, not 0.
    const cli = spawnSync(
      "npx",
      ["tsx", join(ROOT, "scripts", "m2-r1-pilot.ts"), "status", "--out", dir],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(cli.status, cli.stderr).toBe(0);
    const printed = JSON.parse(cli.stdout) as { costEstimate: { total: unknown } };
    expect(printed.costEstimate.total).toBeNull();
  });
});
