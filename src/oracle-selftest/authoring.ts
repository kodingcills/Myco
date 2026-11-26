/**
 * Oracle-authoring cost instrumentation (TIF-271 / M2-09 part 2; R5: "the cost of writing an
 * oracle is measured (time and model cost; hand-written vs agent-written)").
 *
 * Unpaid part: the record, the recorder, and the summary. Nothing here calls a model. An
 * agent-authoring session (paid, gated on Tiffany's go) feeds its per-call usage to an
 * `AuthoringRecorder`; the oracle it produced then goes through the R5 self-test, and the
 * record keeps the self-test summary next to the cost, so "how many agent-written oracles
 * pass" and "what they cost" come from the same rows.
 *
 * Rules carried over from the benchmark ledgers:
 *  - unmeasured is `null`, never 0 (R7): a hand-written oracle has no model cost, and its
 *    author time is `null` unless someone actually timed it;
 *  - simulated records (dry runs, scripted authors) carry `simulated: true` and the summary
 *    refuses them when asked for evidence.
 */

import { authoringRecordSchema } from "../../schemas/oracle-authoring.ts";
import { validateSchema } from "../../schemas/validate.ts";
import type { OracleReport } from "./run.ts";

/**
 * Frozen rates for `claude-sonnet-5-5`, micros (millionths of a USD) per token. The same
 * numbers `src/baseline/planner.ts` uses (`input * 2 + output * 10`, $2 / $10 per MTok);
 * `test/oracle-selftest/authoring.test.ts` pins them against that file's `SONNET`, its
 * `MAX_CALL_MICROS`, and the cost its planner books for one call.
 */
export const FROZEN_RATES = {
  model: "claude-sonnet-5-5",
  inputMicros: 2,
  outputMicros: 10,
} as const;

/** Cost in USD of token totals at the frozen rates (integer micros, then one division). */
function tokensUsd(input: number, output: number): number {
  return (input * FROZEN_RATES.inputMicros + output * FROZEN_RATES.outputMicros) / 1_000_000;
}

function assertPriced(model: string): void {
  if (model !== FROZEN_RATES.model) {
    throw new AuthoringError(
      `no frozen rate for model ${model}; only ${FROZEN_RATES.model} is priced`,
    );
  }
}

export interface CallUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SelfTestSummary {
  readonly pass: boolean;
  readonly claims: readonly string[];
  readonly caughtClaimed: number;
  readonly runsClaimed: number;
}

export interface AuthoringRecord {
  readonly schema: "myco.oracle-authoring/1";
  readonly sessionId: string;
  readonly family: string;
  readonly oracle: string;
  readonly author: "hand" | "agent";
  /** The model that wrote the oracle (agent), or null (hand). */
  readonly authorModelId: string | null;
  readonly simulated: boolean;
  readonly wallClockS: number | null;
  readonly modelCalls: number | null;
  readonly tokens: { readonly input: number | null; readonly output: number | null };
  /** USD at the frozen rates; null when not measured (and always null for a hand author). */
  readonly costUsd: number | null;
  /** The R5 self-test of the oracle this session produced, or null if it never ran. */
  readonly selfTest: SelfTestSummary | null;
}

export class AuthoringError extends Error {
  override name = "AuthoringError";
}

export function costUsd(calls: readonly CallUsage[]): number {
  let micros = 0;
  for (const c of calls) {
    assertPriced(c.model);
    if (
      !Number.isInteger(c.inputTokens) ||
      !Number.isInteger(c.outputTokens) ||
      c.inputTokens < 0 ||
      c.outputTokens < 0
    ) {
      throw new AuthoringError("token counts must be non-negative integers");
    }
    micros += c.inputTokens * FROZEN_RATES.inputMicros + c.outputTokens * FROZEN_RATES.outputMicros;
  }
  return micros / 1_000_000;
}

export function selfTestSummary(report: OracleReport): SelfTestSummary {
  const claimed = report.claims.map((c) => report.perClass[c]);
  return {
    pass: report.pass,
    claims: [...report.claims],
    caughtClaimed: claimed.reduce((n, s) => n + s.caught, 0),
    runsClaimed: claimed.reduce((n, s) => n + s.runs, 0),
  };
}

/**
 * Records one agent-authoring session. The clock is injected so tests are deterministic and
 * a live run can use `performance.now`. Calls must all use one model (a session that mixes
 * models is refused: its cost would not be comparable).
 */
export class AuthoringRecorder {
  readonly #calls: CallUsage[] = [];
  readonly #started: number;
  #finished = false;

  constructor(
    private readonly meta: {
      sessionId: string;
      family: string;
      oracle: string;
      authorModelId: string;
      simulated: boolean;
    },
    private readonly clockMs: () => number,
  ) {
    // Refused up front, not at finish(): a session that cannot be priced must not run.
    assertPriced(meta.authorModelId);
    this.#started = clockMs();
  }

  recordCall(usage: CallUsage): void {
    if (this.#finished) throw new AuthoringError("session already finished");
    if (usage.model !== this.meta.authorModelId) {
      throw new AuthoringError(
        `session ${this.meta.sessionId} is ${this.meta.authorModelId}; got a call from ${usage.model}`,
      );
    }
    this.#calls.push(usage);
  }

  /**
   * A session with zero calls records `costUsd: 0` and zero tokens: that is a measured zero
   * (the recorder saw every call, and there were none), not an unmeasured null counted as 0.
   */
  finish(selfTest: OracleReport | null): AuthoringRecord {
    if (this.#finished) throw new AuthoringError("session already finished");
    this.#finished = true;
    const record: AuthoringRecord = {
      schema: "myco.oracle-authoring/1",
      sessionId: this.meta.sessionId,
      family: this.meta.family,
      oracle: this.meta.oracle,
      author: "agent",
      authorModelId: this.meta.authorModelId,
      simulated: this.meta.simulated,
      wallClockS: (this.clockMs() - this.#started) / 1000,
      modelCalls: this.#calls.length,
      tokens: {
        input: this.#calls.reduce((n, c) => n + c.inputTokens, 0),
        output: this.#calls.reduce((n, c) => n + c.outputTokens, 0),
      },
      costUsd: costUsd(this.#calls),
      selfTest: selfTest === null ? null : selfTestSummary(selfTest),
    };
    assertRecord(record);
    return record;
  }
}

/** A hand-written oracle's record: no model cost, author time only if someone timed it. */
export function handRecord(meta: {
  sessionId: string;
  family: string;
  oracle: string;
  wallClockS: number | null;
  selfTest: OracleReport | null;
}): AuthoringRecord {
  const record: AuthoringRecord = {
    schema: "myco.oracle-authoring/1",
    sessionId: meta.sessionId,
    family: meta.family,
    oracle: meta.oracle,
    author: "hand",
    authorModelId: null,
    simulated: false,
    wallClockS: meta.wallClockS,
    modelCalls: null,
    tokens: { input: null, output: null },
    costUsd: null,
    selfTest: meta.selfTest === null ? null : selfTestSummary(meta.selfTest),
  };
  assertRecord(record);
  return record;
}

export function assertRecord(record: unknown): asserts record is AuthoringRecord {
  const issues = validateSchema(record, authoringRecordSchema);
  if (issues.length > 0)
    throw new AuthoringError(issues.map((i) => `${i.path} ${i.message}`).join("; "));
  const r = record as AuthoringRecord;
  if (r.author === "hand") {
    if (
      r.authorModelId !== null ||
      r.costUsd !== null ||
      r.modelCalls !== null ||
      r.tokens.input !== null ||
      r.tokens.output !== null
    ) {
      throw new AuthoringError("a hand-authored record carries no model, calls, tokens or cost");
    }
    // A scripted stand-in for a person is not a hand-written oracle.
    if (r.simulated) throw new AuthoringError("a hand-authored record cannot be simulated");
    return;
  }
  if (r.authorModelId === null)
    throw new AuthoringError("an agent-authored record names its model");
  assertPriced(r.authorModelId);
  // The cost must be the one the frozen rates give for the recorded usage: a persisted record
  // is evidence only if its cost can be recomputed from its tokens.
  if (r.costUsd !== null) {
    if (r.tokens.input === null || r.tokens.output === null || r.modelCalls === null) {
      throw new AuthoringError("a priced agent record carries its calls and tokens");
    }
    const expected = tokensUsd(r.tokens.input, r.tokens.output);
    if (r.costUsd !== expected) {
      throw new AuthoringError(
        `costUsd ${r.costUsd} is not the frozen-rate cost of its tokens (${expected})`,
      );
    }
  }
  if (r.modelCalls === 0 && ((r.tokens.input ?? 0) > 0 || (r.tokens.output ?? 0) > 0)) {
    throw new AuthoringError("a session with no model calls used no tokens");
  }
}

/** Per author kind: counts, self-test pass rate, and cost/time over the measured records only. */
export interface AuthoringSummary {
  readonly author: "hand" | "agent";
  readonly sessions: number;
  readonly selfTested: number;
  readonly selfTestPassed: number;
  /**
   * R7 (as `src/m2/evidence.ts` applies it): one unmeasured session makes the total and mean
   * unmeasured (null). `measured` and `unmeasured` say how many sessions are which.
   */
  readonly cost: {
    readonly measured: number;
    readonly unmeasured: number;
    readonly totalUsd: number | null;
    readonly meanUsd: number | null;
  };
  readonly wallClock: {
    readonly measured: number;
    readonly unmeasured: number;
    readonly meanS: number | null;
  };
}

/**
 * Summarize authoring records. With `evidence: true`, simulated records are refused (an error)
 * AND left out of the summaries, an agent session with an unmeasured cost is an error, and
 * `ok` is false on any error: read the summaries as evidence only when `ok` is true.
 */
export function summarizeAuthoring(
  records: readonly unknown[],
  opts: { evidence?: boolean } = {},
): { ok: boolean; summaries: AuthoringSummary[]; errors: string[] } {
  const errors: string[] = [];
  const valid: AuthoringRecord[] = [];
  records.forEach((r, i) => {
    try {
      assertRecord(r);
      valid.push(r);
    } catch (e) {
      errors.push(`record ${i}: ${(e as Error).message}`);
    }
  });
  if (records.length === 0) errors.push("no authoring records");
  const ids = new Set<string>();
  for (const r of valid) {
    if (ids.has(r.sessionId)) errors.push(`duplicate sessionId ${r.sessionId}`);
    ids.add(r.sessionId);
  }
  let counted = valid;
  if (opts.evidence === true) {
    const simulated = valid.filter((r) => r.simulated).length;
    if (simulated > 0)
      errors.push(`${simulated} simulated record(s): dry-run records are never evidence`);
    counted = valid.filter((r) => !r.simulated);
    const unpriced = counted.filter((r) => r.author === "agent" && r.costUsd === null).length;
    if (unpriced > 0)
      errors.push(`${unpriced} agent session(s) with an unmeasured cost: R5 measures model cost`);
  }
  const summaries = (["hand", "agent"] as const).map((author): AuthoringSummary => {
    const of = counted.filter((r) => r.author === author);
    const costs = of.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
    const times = of.flatMap((r) => (r.wallClockS === null ? [] : [r.wallClockS]));
    const total = costs.reduce((a, b) => a + b, 0);
    const allCosts = costs.length > 0 && costs.length === of.length;
    const allTimes = times.length > 0 && times.length === of.length;
    return {
      author,
      sessions: of.length,
      selfTested: of.filter((r) => r.selfTest !== null).length,
      selfTestPassed: of.filter((r) => r.selfTest?.pass === true).length,
      cost: {
        measured: costs.length,
        unmeasured: of.length - costs.length,
        totalUsd: allCosts ? total : null,
        meanUsd: allCosts ? total / costs.length : null,
      },
      wallClock: {
        measured: times.length,
        unmeasured: of.length - times.length,
        meanS: allTimes ? times.reduce((a, b) => a + b, 0) / times.length : null,
      },
    };
  });
  return { ok: errors.length === 0, summaries, errors };
}
