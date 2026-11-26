/**
 * The line protocol a desktop agent uses to report its steps on stdout (track U). It is the
 * INTERIM stand-in for the canonical episode writer (#542's `EpisodeRecorder`): each step is
 * already a `myco.episode/1` action (the mirrored action schema in `src/dataset/episode.ts`)
 * plus optional status text, so the harness drafts an episode from it with no translation.
 * The gate never reads it.
 *
 *   MYCO-STEP {"action":{"kind":"<episode action kind>",...},"observation":"<text>"|null}
 *   MYCO-CLAIM {"done":true|false,"text":"<claim>"}
 *
 * Other lines are ignored. Any malformed protocol line (an action that is not a valid
 * episode action, a bad observation, more than one claim) makes the whole transcript
 * malformed (fail closed: a run with a malformed transcript is not exported). No claim
 * line means `no-claim`. Status text longer than an episode allows is not truncated: it is
 * withheld and counted (`withheld`), as the episode format counts dropped observations.
 *
 * TO FILE: replace with #542's EpisodeRecorder once it merges.
 */
import { validateSchema } from "../../schemas/validate.ts";
import {
  type AgentClaim,
  EPISODE_MAX_STATUS_TEXT,
  type EpisodeActionBody,
  episodeActionSchema,
} from "../dataset/episode.ts";

export const STEP_PREFIX = "MYCO-STEP ";
export const CLAIM_PREFIX = "MYCO-CLAIM ";

export type Transcript =
  | {
      readonly ok: true;
      readonly actions: EpisodeActionBody[];
      readonly observations: Array<{ readonly afterAction: number; readonly text: string }>;
      readonly withheld: number;
      readonly agentClaim: AgentClaim;
      /** The claim text the agent hands the gate (never written into the episode). */
      readonly claimText: string;
    }
  | { readonly ok: false; readonly code: "TRANSCRIPT_MALFORMED"; readonly line: number };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseTranscript(stdout: string): Transcript {
  const actions: EpisodeActionBody[] = [];
  const observations: Array<{ afterAction: number; text: string }> = [];
  let withheld = 0;
  let claim: { done: boolean; text: string } | null = null;
  const lines = stdout.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "");
    const isStep = line.startsWith(STEP_PREFIX);
    const isClaim = line.startsWith(CLAIM_PREFIX);
    if (!isStep && !isClaim) continue;
    const malformed = { ok: false, code: "TRANSCRIPT_MALFORMED", line: i + 1 } as const;
    let body: unknown;
    try {
      body = JSON.parse(line.slice(isStep ? STEP_PREFIX.length : CLAIM_PREFIX.length));
    } catch {
      return malformed;
    }
    if (!isPlainObject(body)) return malformed;
    if (isStep) {
      const { action, observation } = body;
      if (Object.keys(body).some((k) => k !== "action" && k !== "observation")) return malformed;
      if (!isPlainObject(action) || "seq" in action || "atMs" in action) return malformed;
      if (validateSchema({ seq: 0, atMs: null, ...action }, episodeActionSchema).length > 0) {
        return malformed;
      }
      if (!(observation === null || typeof observation === "string")) return malformed;
      actions.push(action as EpisodeActionBody);
      if (typeof observation === "string") {
        if (observation.length > EPISODE_MAX_STATUS_TEXT) withheld += 1;
        else observations.push({ afterAction: actions.length - 1, text: observation });
      }
    } else {
      if (claim !== null || typeof body.done !== "boolean" || typeof body.text !== "string") {
        return malformed;
      }
      claim = { done: body.done, text: body.text };
    }
  }
  return {
    ok: true,
    actions,
    observations,
    withheld,
    agentClaim: claim === null ? "no-claim" : claim.done ? "done" : "not-done",
    claimText: claim?.text ?? "",
  };
}
