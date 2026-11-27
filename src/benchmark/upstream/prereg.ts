/**
 * Shape check and analysis gate for the confirmatory R1 on the public OSWorld subset (draft
 * pre-registration docs/benchmark/upstream/r1-public-prereg.json), under the lead's
 * 2026-11-27 ~13:55Z harness ruling (#700 comment 7220110528).
 *
 * `preregProblems` checks the record states what the ruling requires: OSWorld's own harness
 * at the pinned commit, its standard Claude runner, one action layer asserted identical across
 * arms, where DONE is intercepted, exactly the three arms (no gate / gate before DONE /
 * self-check), the upstream evaluate path as grader, and the WAA phase-2 entry.
 *
 * `analyzePublicR1` refuses "shown" (the #652 rule) while:
 *  - the record has any shape problem, is not frozen, has a pending lead ruling, or any field
 *    still says PENDING;
 *  - a row is not LIVE, or was not graded by the upstream evaluate path at the pin (the MOCK
 *    metric runner's `upstream-metric-mock/1` is refused like any other grader);
 *  - the gated LIVE rows do not cover exactly the pre-registered n distinct subset tasks.
 * Only then does it apply the primary outcome: 0 false accepts (the gate accepted DONE and
 * the upstream evaluator did not pass; ungradable counts against the bar). Reasons are codes.
 * It imports nothing from the gate or the gate hook.
 */
import { createHash } from "node:crypto";
import { OSWORLD_HARNESS } from "./pins.ts";
import { OSWORLD_EVALUATE_GRADER } from "./r1-grade.ts";

export const R1_ARMS = ["no-gate", "gate-before-done", "self-check"] as const;
export type R1Arm = (typeof R1_ARMS)[number];
export const GATED_ARM: R1Arm = "gate-before-done";

/** WAA, deferred to phase 2: the entry the record must keep. */
export const WAA_PHASE2_ENTRY =
  "WAA office subset (64 tasks @ eb220c4dcf64) via WAA's own Windows 11 image, in-VM server, evaluators and runner: deferred, not dropped.";

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

/** Canonical JSON: object keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The pre-registration hash quoted in the .md: SHA-256 of the canonical JSON. */
export const preregSha256 = (prereg: unknown) =>
  createHash("sha256").update(canonicalJson(prereg)).digest("hex");

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Codes for every way the record misses what the harness ruling requires. */
export function preregProblems(prereg: PublicR1Prereg, subsetSize: number): string[] {
  const out: string[] = [];
  const harness = obj(prereg.harness);
  if (harness.repo !== OSWORLD_HARNESS.repo || harness.commit !== OSWORLD_HARNESS.commit)
    out.push("HARNESS_NOT_PINNED");
  if (
    !Array.isArray(harness.providerOptions) ||
    canonicalJson(harness.providerOptions) !== canonicalJson(OSWORLD_HARNESS.providers)
  )
    out.push("HARNESS_PROVIDERS_MISSING");
  const runner = obj(prereg.agentRunner);
  if (runner.file !== OSWORLD_HARNESS.agentRunner || runner.commit !== OSWORLD_HARNESS.commit)
    out.push("AGENT_RUNNER_NOT_PINNED");

  const layer = obj(prereg.actionLayer);
  if (layer.identicalAcrossArms !== true) out.push("ACTION_LAYER_NOT_ASSERTED_IDENTICAL");
  if (
    layer.actionSpace !== OSWORLD_HARNESS.actionSpace ||
    layer.observationType !== OSWORLD_HARNESS.observationType ||
    layer.executor !== OSWORLD_HARNESS.controller
  )
    out.push("ACTION_LAYER_NOT_UPSTREAM");

  const arms = Array.isArray(prereg.arms) ? prereg.arms.map(obj) : [];
  if (canonicalJson(arms.map((a) => a.id)) !== canonicalJson(R1_ARMS)) out.push("ARMS_NOT_RULED");
  for (const a of arms) {
    if (a.actionLayer !== "shared") out.push(`ARM_ACTION_LAYER_DIFFERS:${String(a.id)}`);
    if (a.agentRunner !== "shared") out.push(`ARM_RUNNER_DIFFERS:${String(a.id)}`);
    if (a.budget !== "shared") out.push(`ARM_BUDGET_DIFFERS:${String(a.id)}`);
    if ((a.gate === true) !== (a.id === GATED_ARM)) out.push(`ARM_GATE_WRONG:${String(a.id)}`);
  }
  const gi = obj(prereg.gateInterception);
  if (
    canonicalJson(gi.request) !== canonicalJson(["taskId", "runId", "claim"]) ||
    gi.api !== "myco.gate/v1" ||
    gi.failClosed !== true ||
    typeof gi.where !== "string" ||
    typeof gi.how !== "string"
  )
    out.push("GATE_INTERCEPTION_MISSING");

  const grader = obj(prereg.grader);
  if (grader.version !== OSWORLD_EVALUATE_GRADER || grader.path !== OSWORLD_HARNESS.grader)
    out.push("GRADER_NOT_UPSTREAM_EVALUATE");

  const phase2 = Array.isArray(prereg.phase2) ? prereg.phase2 : [];
  if (!phase2.includes(WAA_PHASE2_ENTRY)) out.push("WAA_PHASE2_MISSING");

  if (prereg.subsetSize !== subsetSize || prereg.n !== subsetSize) out.push("SUBSET_SIZE_MISMATCH");
  if (prereg.leadRulingPending.some((p) => /^harness\b/.test(p))) out.push("STALE_HARNESS_PENDING");
  return out;
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
  for (const p of preregProblems(prereg, subsetTaskIds.size)) reasons.push(`PREREG_INVALID:${p}`);
  if (prereg.status !== "frozen") reasons.push("PREREG_NOT_FROZEN");
  if (!Array.isArray(prereg.leadRulingPending) || prereg.leadRulingPending.length > 0)
    reasons.push("LEAD_RULING_PENDING");
  for (const f of pendingFields(prereg)) reasons.push(`FIELD_PENDING:${f}`);

  const gated = rows.filter((r) => r.arm === GATED_ARM);
  if (rows.some((r) => r.label !== "LIVE")) reasons.push("NON_LIVE_ROW");
  if (rows.some((r) => r.graderVersion !== OSWORLD_EVALUATE_GRADER))
    reasons.push("NOT_UPSTREAM_EVALUATE_GRADED");
  if (rows.some((r) => !(R1_ARMS as readonly string[]).includes(r.arm)))
    reasons.push("ROW_ARM_NOT_REGISTERED");
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
