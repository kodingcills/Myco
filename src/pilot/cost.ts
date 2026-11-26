/**
 * Pilot cost: a token-derived ESTIMATE, never a bill. The pilot runs on the Claude
 * subscription, so nothing is billed per token; the estimate prices the tokens Claude Code
 * reports at frozen list rates so R7 (total cost of ALL attempts / verified) has a number.
 *
 * There is no billed-USD field anywhere in the pilot's records. `estimatedModelUsd` is null
 * when the tokens were not measured or the model has no frozen rate here: an unmeasured cost
 * is never 0 (R7). The arm row's schema field is `cost.modelUsd`, which the shared check
 * already documents as this estimate (`COST_BASIS` in `src/benchmark/check.ts`).
 *
 * Rates, micros (USD millionths) per token, frozen 2026-11-26 from the published list prices
 * (Sonnet 5.5: $2 in / $10 out per MTok, cache reads $0.10, the rates `src/baseline/planner.ts`
 * already freezes for input and output; Opus 5.5: $4 / $20, cache reads $0.20). Cache writes
 * are priced at 1.25x input (the 5-minute cache write); a 1-hour cache write costs more, so
 * the estimate can undercount it. That is a stated limit of an estimate, not a bill.
 */
import { COST_BASIS } from "../benchmark/check.ts";

export { COST_BASIS };

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

interface Rate {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const FROZEN_RATES_MICROS: Readonly<Record<string, Rate>> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export interface CostEstimate {
  readonly basis: typeof COST_BASIS;
  /** Model whose frozen rate priced the tokens. */
  readonly pricedAs: string;
  readonly tokens: TokenUsage | null;
  /** Token-derived ESTIMATE in USD; null when unmeasured or unpriced (never 0 for unknown). */
  readonly estimatedModelUsd: number | null;
}

function validUsage(u: TokenUsage): boolean {
  return [u.inputTokens, u.outputTokens, u.cacheReadInputTokens, u.cacheCreationInputTokens].every(
    (n) => Number.isSafeInteger(n) && n >= 0,
  );
}

export function estimateCost(model: string, tokens: TokenUsage | null): CostEstimate {
  const rate = Object.hasOwn(FROZEN_RATES_MICROS, model) ? FROZEN_RATES_MICROS[model] : undefined;
  if (tokens === null || rate === undefined || !validUsage(tokens))
    return {
      basis: COST_BASIS,
      pricedAs: model,
      tokens: tokens !== null && validUsage(tokens) ? tokens : null,
      estimatedModelUsd: null,
    };
  const micros =
    tokens.inputTokens * rate.input +
    tokens.outputTokens * rate.output +
    tokens.cacheReadInputTokens * rate.cacheRead +
    tokens.cacheCreationInputTokens * rate.cacheWrite;
  return {
    basis: COST_BASIS,
    pricedAs: model,
    tokens,
    estimatedModelUsd: Math.round(micros) / 1_000_000,
  };
}

/**
 * R7 over pilot attempts: the sum of every attempt's estimate (faulted attempts included)
 * over verified trials. Null when any attempt is unmeasured, or nothing verified.
 */
export function estimatedCostPerVerified(
  estimates: readonly (number | null)[],
  verified: number,
): {
  readonly basis: typeof COST_BASIS;
  readonly total: number | null;
  readonly perVerified: number | null;
} {
  // Anything but a finite non-negative number is unmeasured: null, never counted as 0.
  const total = estimates.some((e) => typeof e !== "number" || !Number.isFinite(e) || e < 0)
    ? null
    : estimates.reduce<number>((s, e) => s + (e as number), 0);
  return {
    basis: COST_BASIS,
    total,
    perVerified: total === null || verified === 0 ? null : total / verified,
  };
}
