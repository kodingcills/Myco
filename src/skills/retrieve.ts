/**
 * Track M retrieval: which active skills apply to a task.
 *
 * Scoped by task family (exact match) and ranked by similarity (Jaccard overlap of the
 * abstract feature tokens). Revoked and quarantined skills are never returned. What comes
 * back is ADVICE: it is labelled `advisory: true` and `evidence: false`, it never reaches
 * the gate (myco.gate/v1 takes only taskId/runId/claim) or the grader, and a warm run is
 * verified exactly like a cold one.
 */
import type { SkillState, SkillStore } from "./store.ts";

export const SKILLS_API_VERSION = "myco.skills/v1";
export const DEFAULT_LIMIT = 3;
export const MAX_LIMIT = 5;
/** Minimum Jaccard similarity for a skill to be served. */
export const MIN_SIMILARITY = 0.5;

export interface RetrievalQuery {
  readonly taskFamily: string;
  readonly features: readonly string[];
  readonly limit?: number;
}

/** What the agent (or the warm-arm harness) receives for one skill. */
export interface SkillAdvice {
  readonly skillId: string;
  readonly taskFamily: string;
  readonly similarity: number;
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  /** Digests and references only, so the agent can cite which outcome a skill came from. */
  readonly provenance: {
    readonly runId: string;
    readonly ledgerEntrySha256: string;
    readonly verdictSha256: string;
    readonly gradeSha256: string;
    readonly simulated: boolean;
  };
}

export interface RetrievalResult {
  readonly apiVersion: typeof SKILLS_API_VERSION;
  readonly advisory: true;
  readonly evidence: false;
  readonly skills: readonly SkillAdvice[];
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function advice(s: SkillState, similarity: number): SkillAdvice {
  const p = s.record.provenance;
  return {
    skillId: s.record.skillId,
    taskFamily: s.record.taskFamily,
    similarity: Math.round(similarity * 1000) / 1000,
    preconditions: [...s.record.preconditions],
    steps: [...s.record.steps],
    provenance: {
      runId: p.runId,
      ledgerEntrySha256: p.ledgerRef.entrySha256,
      verdictSha256: p.verdictSha256,
      gradeSha256: p.gradeSha256,
      simulated: p.simulated,
    },
  };
}

export function retrieve(store: SkillStore, q: RetrievalQuery): RetrievalResult {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const ranked = store
    .active()
    .filter((s) => s.record.taskFamily === q.taskFamily)
    .map((s) => ({ s, sim: jaccard(s.record.features, q.features) }))
    .filter((x) => x.sim >= MIN_SIMILARITY)
    .sort((x, y) => y.sim - x.sim || x.s.admittedSeq - y.s.admittedSeq)
    .slice(0, limit);
  return {
    apiVersion: SKILLS_API_VERSION,
    advisory: true,
    evidence: false,
    skills: ranked.map((x) => advice(x.s, x.sim)),
  };
}
