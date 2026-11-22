/**
 * Head-to-head report input for the viewer (N10).
 *
 * The report is produced by `src/discovery/report.ts`; the viewer only renders
 * it. Parsing is strict enough to refuse a run artifact or a malformed file, so
 * a `result.json` dropped on the Compare screen cannot be mistaken for a report.
 */

export interface HeadToHeadDecision {
  readonly status: "decided" | "refused";
  readonly reason?: string;
  readonly row?: string;
  readonly taskId: string;
  readonly promptVariant: string;
  readonly pairs: number;
  readonly mycoFalseSuccesses: number;
  readonly comparatorFalseSuccesses: number;
  readonly discordantFavouringMyco: number;
  readonly discordantFavouringComparator: number;
  readonly signTestP: number | null;
  readonly mycoFalseSuccessInterval: readonly [number, number] | null;
  readonly comparatorFalseSuccessInterval: readonly [number, number] | null;
  readonly ineligibleRows: number;
  readonly notes: readonly string[];
  readonly pairRows: readonly {
    readonly seed: number;
    readonly faultClass: string;
    readonly mycoFalseSuccess: boolean;
    readonly comparatorFalseSuccess: boolean;
  }[];
}

export interface HeadToHeadArm {
  readonly armId: string;
  readonly label?: string;
  readonly trials: readonly {
    readonly verdict: "verified" | "refuted" | "uncertain";
    readonly falseSuccess: boolean;
    readonly falseSuccessKnown?: boolean;
  }[];
}

export interface HeadToHeadProvenance {
  readonly kind: "live" | "simulated" | "mixed" | "unknown";
  readonly note?: string;
  readonly arms?: readonly {
    readonly armId: string;
    readonly source: string;
    readonly live: boolean;
  }[];
}

export interface HeadToHeadReport {
  readonly decision: HeadToHeadDecision;
  readonly provenance?: HeadToHeadProvenance;
  readonly arms: readonly HeadToHeadArm[];
  readonly notRun?: readonly { readonly armId: string; readonly blocker: string }[];
  readonly evidence?: readonly string[];
  readonly generatedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function interval(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [low, high] = value;
  return typeof low === "number" && typeof high === "number" ? [low, high] : null;
}

export function parseHeadToHead(value: unknown): HeadToHeadReport | undefined {
  if (!isRecord(value) || !isRecord(value.decision) || !Array.isArray(value.arms)) return undefined;
  const decision = value.decision;
  if (
    (decision.status !== "decided" && decision.status !== "refused") ||
    typeof decision.taskId !== "string" ||
    typeof decision.promptVariant !== "string" ||
    typeof decision.pairs !== "number" ||
    typeof decision.mycoFalseSuccesses !== "number" ||
    typeof decision.comparatorFalseSuccesses !== "number" ||
    typeof decision.discordantFavouringMyco !== "number" ||
    typeof decision.discordantFavouringComparator !== "number" ||
    typeof decision.ineligibleRows !== "number" ||
    !Array.isArray(decision.notes) ||
    !Array.isArray(decision.pairRows)
  )
    return undefined;

  const arms: HeadToHeadArm[] = [];
  for (const arm of value.arms) {
    if (!isRecord(arm) || typeof arm.armId !== "string" || !Array.isArray(arm.trials))
      return undefined;
    const trials: HeadToHeadArm["trials"][number][] = [];
    for (const trial of arm.trials) {
      if (
        !isRecord(trial) ||
        (trial.verdict !== "verified" &&
          trial.verdict !== "refuted" &&
          trial.verdict !== "uncertain") ||
        typeof trial.falseSuccess !== "boolean"
      )
        return undefined;
      trials.push({
        verdict: trial.verdict,
        falseSuccess: trial.falseSuccess,
        falseSuccessKnown:
          typeof trial.falseSuccessKnown === "boolean" ? trial.falseSuccessKnown : undefined,
      });
    }
    arms.push({
      armId: arm.armId,
      label: typeof arm.label === "string" ? arm.label : undefined,
      trials,
    });
  }

  const pairRows: HeadToHeadDecision["pairRows"][number][] = [];
  for (const row of decision.pairRows) {
    if (
      !isRecord(row) ||
      typeof row.seed !== "number" ||
      typeof row.faultClass !== "string" ||
      typeof row.mycoFalseSuccess !== "boolean" ||
      typeof row.comparatorFalseSuccess !== "boolean"
    )
      return undefined;
    pairRows.push({
      seed: row.seed,
      faultClass: row.faultClass,
      mycoFalseSuccess: row.mycoFalseSuccess,
      comparatorFalseSuccess: row.comparatorFalseSuccess,
    });
  }

  const notRun: { armId: string; blocker: string }[] = [];
  if (Array.isArray(value.notRun)) {
    for (const arm of value.notRun) {
      if (!isRecord(arm) || typeof arm.armId !== "string" || typeof arm.blocker !== "string")
        return undefined;
      notRun.push({ armId: arm.armId, blocker: arm.blocker });
    }
  }

  let provenance: HeadToHeadProvenance | undefined;
  if (isRecord(value.provenance)) {
    const kind = value.provenance.kind;
    if (kind !== "live" && kind !== "simulated" && kind !== "mixed" && kind !== "unknown")
      return undefined;
    const arms: { armId: string; source: string; live: boolean }[] = [];
    if (Array.isArray(value.provenance.arms)) {
      for (const arm of value.provenance.arms) {
        if (
          !isRecord(arm) ||
          typeof arm.armId !== "string" ||
          typeof arm.source !== "string" ||
          typeof arm.live !== "boolean"
        )
          return undefined;
        arms.push({ armId: arm.armId, source: arm.source, live: arm.live });
      }
    }
    provenance = {
      kind,
      note: typeof value.provenance.note === "string" ? value.provenance.note : undefined,
      arms: arms.length > 0 ? arms : undefined,
    };
  }

  return {
    decision: {
      status: decision.status,
      reason: typeof decision.reason === "string" ? decision.reason : undefined,
      row: typeof decision.row === "string" ? decision.row : undefined,
      taskId: decision.taskId,
      promptVariant: decision.promptVariant,
      pairs: decision.pairs,
      mycoFalseSuccesses: decision.mycoFalseSuccesses,
      comparatorFalseSuccesses: decision.comparatorFalseSuccesses,
      discordantFavouringMyco: decision.discordantFavouringMyco,
      discordantFavouringComparator: decision.discordantFavouringComparator,
      signTestP: numberOrNull(decision.signTestP),
      mycoFalseSuccessInterval: interval(decision.mycoFalseSuccessInterval),
      comparatorFalseSuccessInterval: interval(decision.comparatorFalseSuccessInterval),
      ineligibleRows: decision.ineligibleRows,
      notes: decision.notes.filter((note): note is string => typeof note === "string"),
      pairRows,
    },
    arms,
    provenance,
    notRun: notRun.length > 0 ? notRun : undefined,
    evidence: Array.isArray(value.evidence)
      ? value.evidence.filter((path): path is string => typeof path === "string")
      : undefined,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : undefined,
  };
}
