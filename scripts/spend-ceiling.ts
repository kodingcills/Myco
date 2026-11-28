/**
 * Parse the spend-ceiling environment variables the launcher passes down.
 *
 * Extracted from the CLI entry point so the parsing is unit-testable: it is the
 * one place a STRING becomes a spend limit, and a mistake here is invisible until
 * a run overspends. The empty-string defect lived exactly here - `Number("")` is
 * 0, and 0 is a valid prior spend, so an empty variable read as "nothing spent
 * before" and restored the allowance the seed exists to remove.
 */
export interface SpendCeiling {
  priorSpendMicros: number;
  remainingMicros: number;
}

/**
 * Strictly a non-empty run of digits.
 *
 * Deliberately not `Number(x)` with an `isSafeInteger` check afterwards: that
 * accepts `""`, `" 42 "`, `"0x10"` and `"1.5"`, and only the first of those is a
 * plausible operator mistake while all four are wrong. Requiring digits rejects
 * them without a special case for each.
 */
function parseMicros(name: string, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * Throws unless BOTH are present and each is a safe non-negative integer with a
 * positive remaining budget. Fail-closed on every path: a caller that cannot
 * state the project's prior spend must not silently receive an unbounded ceiling.
 */
export function parseSpendCeiling(env: NodeJS.ProcessEnv): SpendCeiling {
  const priorSpendMicros = parseMicros("MYCO_PRIOR_SPEND_MICROS", env);
  const remainingMicros = parseMicros("MYCO_ARM_LIMIT_MICROS", env);
  if (
    !Number.isSafeInteger(priorSpendMicros) ||
    priorSpendMicros < 0 ||
    !Number.isSafeInteger(remainingMicros) ||
    remainingMicros <= 0
  )
    throw new Error(
      "MYCO_PRIOR_SPEND_MICROS and MYCO_ARM_LIMIT_MICROS must both be set to safe non-negative integers; the spend ceiling is the project's, not this directory's",
    );
  return { priorSpendMicros, remainingMicros };
}
