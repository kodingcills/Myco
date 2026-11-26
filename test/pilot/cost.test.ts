/**
 * Track E: pilot cost is a token-derived ESTIMATE, labelled as such; null when unmeasured
 * (never 0); and no record carries a billed-USD field.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COST_BASIS, estimateCost, estimatedCostPerVerified } from "../../src/pilot/cost.ts";
import { fakeDriver } from "../../src/pilot/dry-run.ts";
import { ATTEMPTS_FILE } from "../../src/pilot/ledger.ts";
import { dryRun, tmp } from "./helpers.ts";

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
    const text = readFileSync(join(dir, ATTEMPTS_FILE), "utf8");
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
});
