/**
 * Track Q (replayable proof): the bundle's reference to the canonical per-attempt record.
 *
 * `myco.episode/1` (data capture, #542, specified in capability spec part 2 #538 §3) is the
 * ONE canonical record of an attempt. A proof bundle does not define a competing one: it is
 * a tamper-evident CONTAINER over an attempt that references the attempt's episode by id
 * and digest (`run.episode`), projects a few of its fields (`run.runId`, `taskId`, `arm`,
 * `simulated`), and carries only Q's own extra fields (the hash chain, evidence digests,
 * the ledger anchor). With the episode in hand the verifier recomputes both the id and the
 * digest and refuses any projected field that disagrees.
 *
 * Bound to #542 (merged on main): an episode is projected ONLY after #542's own
 * `validateEpisode` accepts it as a whole (closed schema, id rule, SEQ / OUTCOME /
 * GROUND_TRUTH / SIMULATED / COST rules, and its cleanliness scan). The id and digest are
 * #542's `episodeIdOf` and `canonicalJson`. Nothing in `src/episode` is changed or
 * re-implemented here: this module only calls it. An episode #542 refuses is refused here
 * (`PROOF_EPISODE`) and is never reported as cross-checked.
 *
 * A refusal carries #542's issue CODES only (a closed enum), never its paths or messages:
 * a path can name an unknown key and a message can quote a value or a blob's file name.
 */

import type { Episode } from "../episode/types.ts";
import {
  canonicalJson,
  type EpisodeIssueCode,
  episodeIdOf,
  validateEpisode,
} from "../episode/validate.ts";
import { sha256Hex } from "./ledger.ts";

export const EPISODE_SCHEMA = "myco.episode/1" as const;

/** The episode fields Q reads, as JSON paths. Changing this list is a reviewed change. */
export const EPISODE_FIELDS_USED = [
  "schema",
  "episodeId",
  "simulated",
  "task.id",
  "harness.arm",
  "provenance.runId",
  "provenance.trialKey",
  "gate.verdict",
  "gate.accepted",
  "gate.reasonCodes",
] as const;

/** What a bundle carries: the reference, never the episode itself. */
export interface EpisodeRef {
  readonly schema: typeof EPISODE_SCHEMA;
  readonly episodeId: string;
  /**
   * sha256 of the episode's canonical JSON, WITHOUT the trailing newline #542's store appends
   * to the file (so it is not the sha256 of the file on disk).
   */
  readonly sha256: string;
}

/** The episode fields a bundle projects into `run` (and the ledger trial key). */
export interface EpisodeProjection {
  readonly ref: EpisodeRef;
  readonly runId: string;
  readonly taskId: string;
  readonly arm: string;
  readonly simulated: boolean;
  readonly trialKey: string | null;
  /** The episode's gate result (null: no gate check), cross-checked against the verdict. */
  readonly gate: {
    readonly verdict: string;
    readonly accepted: boolean;
    readonly reasonCodes: readonly string[] | null;
  } | null;
}

/** #542's id rule (re-exported from `src/episode/validate.ts`, not re-stated). */
export { episodeIdOf };

/** The closed message a refused episode is reported with: #542's issue codes, sorted, unique. */
export function episodeRefusal(codes: readonly EpisodeIssueCode[]): string {
  const unique = [...new Set(codes)].sort();
  return `the episode is not a valid myco.episode/1 (#542 validateEpisode: ${unique.join(", ")})`;
}

/**
 * Validate an episode with #542's `validateEpisode`, then project it. Any issue refuses the
 * episode; the error names #542's codes only.
 */
export function projectEpisode(
  value: unknown,
): { ok: true; projection: EpisodeProjection } | { ok: false; errors: string[] } {
  const issues = validateEpisode(value);
  if (issues.length > 0) return { ok: false, errors: [episodeRefusal(issues.map((i) => i.code))] };
  const ep = value as Episode;
  return {
    ok: true,
    projection: {
      ref: {
        schema: EPISODE_SCHEMA,
        episodeId: ep.episodeId,
        sha256: sha256Hex(canonicalJson(ep)),
      },
      runId: ep.provenance.runId,
      taskId: ep.task.id,
      arm: ep.harness.arm,
      simulated: ep.simulated,
      trialKey: ep.provenance.trialKey,
      gate:
        ep.gate === null
          ? null
          : {
              verdict: ep.gate.verdict,
              accepted: ep.gate.accepted,
              reasonCodes: ep.gate.reasonCodes === null ? null : [...ep.gate.reasonCodes],
            },
    },
  };
}
