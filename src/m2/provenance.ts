/**
 * Evidence provenance for M2 packs (track E follow-on). `checkPack` (`src/m2/evidence.ts`)
 * recomputes R1/R2/R3/R7 from a pack but does not itself refuse rows whose planner is not a
 * Claude model id: a full-size SIMULATED run (100 fc-v1 rows from the TIF-274 dry run, or a
 * pilot dry run topped up), packed with a valid #518 attempt ledger, pin and anchor, passes it
 * with R1 ok. The pack CLI (`scripts/m2-evidence-check.ts`)
 * therefore adds this check, with the shared ledger check's own allowlist
 * (`EVIDENCE_PLANNERS`, `src/benchmark/check.ts`): simulated rows are never evidence.
 *
 * Kept outside `src/m2/evidence.ts` so it does not collide with the in-flight topped-up-runs
 * change there; folding it into `checkPack` is filed as a follow-up.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_PLANNERS } from "../benchmark/check.ts";

/** The marker file every corrections A/B pack carries (`src/pilot/ab.ts`). */
export const EXPERIMENT_FILE = "EXPERIMENT";

/**
 * Errors that make a pack directory not evidence, whatever its numbers say.
 *
 * `abPack` (#554): the pack is a scorecard A/B pack (`myco.m2.ab-pack/1`, `src/m2/ab-pack.ts`),
 * experiment-only by its manifest and never citable for an R row. Its rows are experiment rows
 * by definition, so the row-label refusal does not apply to it; the SIMULATED and EXPERIMENT
 * markers (neither is part of its layout) and the planner allowlist still do. R packs never
 * pass it.
 */
export function packProvenanceErrors(
  dir: string,
  arm: readonly unknown[],
  opts: { readonly abPack?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (existsSync(join(dir, "SIMULATED")))
    errors.push("the pack carries a SIMULATED marker: simulated rows are never evidence");
  // The corrections ON/OFF A/B (`src/pilot/ab.ts`): experiment-only, both arms.
  if (existsSync(join(dir, EXPERIMENT_FILE)))
    errors.push(
      "the pack carries an EXPERIMENT marker: experiment packs are never R1 evidence (both A/B arms)",
    );
  const labelled = arm.filter(
    (r) => r !== null && typeof r === "object" && "experiment" in (r as object),
  ).length;
  if (opts.abPack !== true && labelled > 0)
    errors.push(
      `${labelled} arm row(s) labelled experiment-only: experiment rows are never R1 evidence, the corrections-OFF arm included`,
    );
  const planners = arm.map((r) =>
    r !== null && typeof r === "object"
      ? (r as { plannerModelId?: unknown }).plannerModelId
      : undefined,
  );
  const unproven = planners.filter((p) => typeof p !== "string" || !EVIDENCE_PLANNERS.has(p));
  if (unproven.length > 0) {
    const ids = [...new Set(unproven.map((p) => JSON.stringify(p ?? null)))];
    errors.push(
      `${unproven.length} arm row(s) without evidence provenance (planner ${ids.join(", ")} is not a Claude model id): simulated rows are never evidence`,
    );
  }
  return errors;
}
