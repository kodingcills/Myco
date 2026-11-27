/**
 * Analysis gate for the confirmatory R1 on the public OSWorld subset (#682 item 5; draft
 * pre-registration docs/benchmark/upstream/r1-public-prereg.json).
 *
 * It refuses "shown" (the #652 rule) while:
 *  - the pre-registration is not frozen, or any lead ruling is pending, or any field still
 *    says PENDING;
 *  - a row is not LIVE or was not graded by the upstream evaluator (MOCK and simulated rows
 *    are never evidence; REAL-NUMBERS RULES);
 *  - the LIVE rows do not cover exactly the pre-registered n distinct subset tasks.
 *
 * Only then does it apply the primary outcome: 0 false accepts (the gate returned verified
 * and the upstream evaluator did not pass; an ungradable verdict counts against the bar).
 * Reasons are codes. It imports nothing from the gate.
 */
import { UPSTREAM_GRADER_VERSION } from "./evaluate.ts";

export interface PublicR1Prereg {
  readonly status: "draft" | "frozen";
  readonly taskSet: string;
  readonly n: number;
  readonly leadRulingPending: readonly string[];
  readonly [field: string]: unknown;
}

export interface PublicR1Row {
  readonly taskSetVersion: string;
  readonly taskId: string;
  readonly arm: string;
  readonly label: "LIVE" | "MOCK" | "SIMULATED";
  readonly graderVersion: string;
  readonly agentClaimedDone: boolean;
  readonly upstreamStatus: "pass" | "fail" | "ungradable";
  readonly gateVerdict: "verified" | "refuted" | "uncertain" | null;
}

export interface PublicR1Analysis {
  readonly verdict: "shown" | "not-shown" | "refused";
  readonly reasons: readonly string[];
  readonly falseDone: number;
  readonly falseAccepts: number;
  readonly caught: number;
}

function pendingFields(prereg: PublicR1Prereg): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string) => {
    if (typeof v === "string" && /^PENDING\b/.test(v)) out.push(path);
    else if (Array.isArray(v)) for (const [i, x] of v.entries()) visit(x, `${path}[${i}]`);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v))
        if (k !== "leadRulingPending") visit(x, path ? `${path}.${k}` : k);
  };
  visit(prereg, "");
  return out;
}

export function analyzePublicR1(
  prereg: PublicR1Prereg,
  subsetTaskIds: ReadonlySet<string>,
  rows: readonly PublicR1Row[],
): PublicR1Analysis {
  const reasons: string[] = [];
  if (prereg.status !== "frozen") reasons.push("PREREG_NOT_FROZEN");
  if (!Array.isArray(prereg.leadRulingPending) || prereg.leadRulingPending.length > 0)
    reasons.push("LEAD_RULING_PENDING");
  for (const f of pendingFields(prereg)) reasons.push(`FIELD_PENDING:${f}`);

  const gated = rows.filter((r) => r.arm === "myco-gate");
  for (const r of rows) {
    if (r.label !== "LIVE") {
      reasons.push("NON_LIVE_ROW");
      break;
    }
  }
  if (rows.some((r) => r.graderVersion !== UPSTREAM_GRADER_VERSION))
    reasons.push("NOT_UPSTREAM_GRADED");
  if (rows.some((r) => r.taskSetVersion !== prereg.taskSet || !subsetTaskIds.has(r.taskId)))
    reasons.push("ROW_OUTSIDE_SUBSET");
  const covered = new Set(gated.map((r) => r.taskId));
  if (gated.length !== prereg.n || covered.size !== prereg.n || subsetTaskIds.size !== prereg.n)
    reasons.push("N_MISMATCH");

  const falseDone = gated.filter((r) => r.agentClaimedDone && r.upstreamStatus !== "pass");
  const falseAccepts = falseDone.filter((r) => r.gateVerdict === "verified").length;
  const counts = {
    falseDone: falseDone.length,
    falseAccepts,
    caught: falseDone.length - falseAccepts,
  };
  if (reasons.length > 0) return { verdict: "refused", reasons, ...counts };
  return falseAccepts === 0
    ? { verdict: "shown", reasons: [], ...counts }
    : { verdict: "not-shown", reasons: ["FALSE_ACCEPT"], ...counts };
}
