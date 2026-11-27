import { PREREG_JSON, PREREG_MD } from "../src/pilot/ab-prereg.ts";
import type { JsonSchema } from "./validate.ts";

/**
 * Corrections ON/OFF A/B evidence pack (TIF-274; the scorecard's experiment row `AB`). A pack is
 * one directory under `docs/research/experiments/m2-<name>/`, like an R pack, but it is a
 * DIFFERENT kind: its manifest is `myco.m2.ab-pack/1`, it is evidence for the experiment row only,
 * and it can never list an R row (the manifest has no `rows`; `src/m2/evidence.ts`'s R-pack check
 * refuses this manifest and refuses A/B rows in every R pack). Layout:
 *
 *  - `pack.json`                this manifest;
 *  - `on/`, `off/`              each arm's run: `arm.jsonl`, `grades.jsonl`, `ops.jsonl` (one
 *                               trial-ops row per arm row, `myco.m2.trial-ops/1`) and
 *                               `run-config.json`;
 *  - `stage0/on/arm.jsonl`,
 *    `stage0/off/arm.jsonl`     Stage 1 only: Stage 0's ledgers, so its trials are excluded.
 *
 * The check is `src/m2/ab-pack.ts` (it runs `src/m2/corrections-ab.ts` with `evidence: true`).
 */
export const m2AbPackManifestSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "row", "stage", "evidenceUse"],
  properties: {
    schema: { const: "myco.m2.ab-pack/1" },
    /** The scorecard's experiment row; never an R row. */
    row: { const: "AB" },
    stage: { type: "integer", enum: [0, 1] },
    /** Said in the manifest, and enforced: A/B rows are never R1 evidence. */
    evidenceUse: { const: "experiment-only (never R1 evidence)" },
    /**
     * Stage 1 only (required there): the committed pre-registration file and the sha256 the pack
     * declares for it. The file is pinned to exactly track E's pre-registration, `PREREG_MD` or
     * `PREREG_JSON` (`src/pilot/ab-prereg.ts`, #549), so a pack cannot bind a design file
     * committed after its run. The check hashes the file itself, and still requires it to be
     * inside the repository once symlinks are resolved, outside the pack and outside
     * `docs/research/experiments/` (`preregLocation`, #554 round 1, D2).
     */
    preregistration: {
      type: "object",
      additionalProperties: false,
      required: ["file", "sha256"],
      properties: {
        file: { type: "string", enum: [PREREG_MD, PREREG_JSON] },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
  },
};
