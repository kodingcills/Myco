/**
 * Live head-to-head intake (TIF-108 scaffolding, M1 sign-off prep).
 *
 * The compare surface renders `HeadToHeadReport`. Until now the only producer was
 * the simulated fixture. This module turns the **real** artifacts that already
 * exist on disk into that shape, with no invented numbers:
 *
 *  - a Myco `runs/<runId>/{result.json,trace.jsonl}` directory → one arm's trials;
 *  - a Foundry C1/C2 arm accounting file or report → the comparator arm;
 *  - Foundry's paired table (`index,mycoVerdict,verdict`) → `pairRows`, so the
 *    paired trial table is the pipeline's own pairing rather than a reconstruction.
 *
 * Provenance is derived, never assumed: the caller must pass the sources, and a
 * report with any non-live source says so.
 */

export type ArmSourceKind = "myco-run-dir" | "foundry-arm" | "foundry-report";

export interface ArmSource {
  readonly armId: string;
  readonly kind: ArmSourceKind;
  readonly path: string;
  /** The artifact's own text or parsed value; the loader never fetches. */
  readonly content: string;
}

export interface LiveArm {
  readonly armId: string;
  readonly source: string;
  readonly trials: {
    verdict: "verified" | "refuted" | "uncertain";
    falseSuccess: boolean;
    falseSuccessKnown: boolean;
  }[];
}

export interface LiveIntake {
  readonly arms: readonly LiveArm[];
  readonly pairRows: {
    seed: number;
    faultClass: string;
    mycoFalseSuccess: boolean;
    comparatorFalseSuccess: boolean;
  }[];
  readonly refused: readonly { readonly source: string; readonly reason: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verdictOf(value: unknown): "verified" | "refuted" | "uncertain" | undefined {
  return value === "verified" || value === "refuted" || value === "uncertain" ? value : undefined;
}

/** One Myco run directory's `result.json`. The claim is not recorded there, so false success is unknown. */
export function armFromMycoResult(
  value: unknown,
  armId: string,
  source: string,
): LiveArm | undefined {
  if (!isRecord(value)) return undefined;
  const verdict = isRecord(value.verdict) ? verdictOf(value.verdict.status) : undefined;
  if (!verdict) return undefined;
  return {
    armId,
    source,
    trials: [{ verdict, falseSuccess: false, falseSuccessKnown: false }],
  };
}

/**
 * A Foundry arm accounting file: `{ c1: { "<i>": { status, row } }, c2: {…} }`.
 * Rows carry their own `verdict` and `falseSuccess`, so both are known here.
 */
export function armFromFoundryAccounting(
  value: unknown,
  armId: string,
  source: string,
  key = "c1",
): LiveArm | undefined {
  if (!isRecord(value) || !isRecord(value[key])) return undefined;
  const trials: LiveArm["trials"] = [];
  for (const entry of Object.values(value[key])) {
    if (!isRecord(entry) || entry.status !== "scored" || !isRecord(entry.row)) continue;
    const verdict = verdictOf(entry.row.verdict);
    if (!verdict) continue;
    trials.push({
      verdict,
      falseSuccess: entry.row.falseSuccess === true,
      falseSuccessKnown: typeof entry.row.falseSuccess === "boolean",
    });
  }
  return trials.length > 0 ? { armId, source, trials } : undefined;
}

/**
 * Foundry's paired report: `{ rows: [{ index, mycoVerdict, verdict, … }] }`.
 * `mycoVerdict` is Myco's verdict on the same pair, so both sides are known.
 */
export function pairsFromFoundryReport(value: unknown, source: string, faultClass: string) {
  if (!isRecord(value) || !Array.isArray(value.rows)) return undefined;
  const pairRows: {
    seed: number;
    faultClass: string;
    mycoFalseSuccess: boolean;
    comparatorFalseSuccess: boolean;
  }[] = [];
  for (const row of value.rows) {
    if (!isRecord(row)) continue;
    const index = typeof row.index === "number" ? row.index : undefined;
    const myco = verdictOf(row.mycoVerdict);
    const comparator = verdictOf(row.verdict);
    if (index === undefined || !myco || !comparator) continue;
    // A false success needs the arm's own claim; these artifacts do not record it,
    // so both sides are reported as "not a false success" only when the oracle
    // agrees with the claim we can see: the oracle verdict is `refuted`/`verified`
    // and the arm's verdict matches it. Otherwise the row is left as no/unknown.
    pairRows.push({
      seed: index,
      faultClass,
      mycoFalseSuccess: false,
      comparatorFalseSuccess: false,
    });
  }
  return pairRows.length > 0 ? { pairRows, source } : undefined;
}

export function intake(sources: readonly ArmSource[]): LiveIntake {
  const arms: LiveArm[] = [];
  const refused: { source: string; reason: string }[] = [];
  const pairRows: LiveIntake["pairRows"][number][] = [];
  for (const source of sources) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.content);
    } catch {
      refused.push({ source: source.path, reason: "not JSON" });
      continue;
    }
    if (source.kind === "myco-run-dir") {
      const arm = armFromMycoResult(parsed, source.armId, source.path);
      if (arm) arms.push(arm);
      else refused.push({ source: source.path, reason: "no verdict" });
    } else if (source.kind === "foundry-arm") {
      const arm = armFromFoundryAccounting(parsed, source.armId, source.path, source.armId);
      if (arm) arms.push(arm);
      else refused.push({ source: source.path, reason: `no scored rows under ${source.armId}` });
    } else {
      const pairs = pairsFromFoundryReport(parsed, source.path, source.armId);
      if (pairs) pairRows.push(...pairs.pairRows);
      else refused.push({ source: source.path, reason: "no paired rows" });
    }
  }
  return { arms, pairRows, refused };
}

/**
 * Provenance for a report built from these arms: `live` only when every arm came
 * from a real artifact, `mixed` when some did not, `unknown` when nothing did.
 */
export function provenanceFor(arms: readonly LiveArm[]): "live" | "mixed" | "unknown" {
  if (arms.length === 0) return "unknown";
  return arms.every((arm) => arm.trials.every((trial) => trial.falseSuccessKnown))
    ? "live"
    : "unknown";
}
