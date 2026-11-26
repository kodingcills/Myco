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

/** Errors that make a pack directory not evidence, whatever its numbers say. */
export function packProvenanceErrors(dir: string, arm: readonly unknown[]): string[] {
  const errors: string[] = [];
  if (existsSync(join(dir, "SIMULATED")))
    errors.push("the pack carries a SIMULATED marker: simulated rows are never evidence");
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
