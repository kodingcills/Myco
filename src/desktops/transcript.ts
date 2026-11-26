/**
 * The line protocol a desktop agent uses to report its steps on stdout (track U). The
 * harness, not the agent, turns these into dataset steps; the gate never reads them.
 *
 *   MYCO-STEP {"tool":"<name>","input":{...},"observation":"<text>"|null}
 *   MYCO-CLAIM {"done":true|false,"text":"<claim>"}
 *
 * Other lines are ignored. Any malformed protocol line, or more than one claim, makes the
 * whole transcript malformed (fail closed: a run with a malformed transcript is not
 * exported). No claim line means "not claimed done".
 */
import type { DatasetStep } from "../dataset/export.ts";

export const STEP_PREFIX = "MYCO-STEP ";
export const CLAIM_PREFIX = "MYCO-CLAIM ";
const TOOL = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type Transcript =
  | {
      readonly ok: true;
      readonly steps: DatasetStep[];
      readonly claim: { readonly done: boolean; readonly text: string };
    }
  | { readonly ok: false; readonly code: "TRANSCRIPT_MALFORMED"; readonly line: number };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseTranscript(stdout: string): Transcript {
  const steps: DatasetStep[] = [];
  let claim: { done: boolean; text: string } | null = null;
  const lines = stdout.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, "");
    const isStep = line.startsWith(STEP_PREFIX);
    const isClaim = line.startsWith(CLAIM_PREFIX);
    if (!isStep && !isClaim) continue;
    let body: unknown;
    try {
      body = JSON.parse(line.slice(isStep ? STEP_PREFIX.length : CLAIM_PREFIX.length));
    } catch {
      return { ok: false, code: "TRANSCRIPT_MALFORMED", line: i + 1 };
    }
    if (!isPlainObject(body)) return { ok: false, code: "TRANSCRIPT_MALFORMED", line: i + 1 };
    if (isStep) {
      const { tool, input, observation } = body;
      if (
        typeof tool !== "string" ||
        !TOOL.test(tool) ||
        !isPlainObject(input) ||
        !(observation === null || typeof observation === "string")
      ) {
        return { ok: false, code: "TRANSCRIPT_MALFORMED", line: i + 1 };
      }
      steps.push({
        index: steps.length,
        action: { tool, input },
        observation: observation === null ? null : { kind: "text", text: observation },
      });
    } else {
      if (claim !== null || typeof body.done !== "boolean" || typeof body.text !== "string") {
        return { ok: false, code: "TRANSCRIPT_MALFORMED", line: i + 1 };
      }
      claim = { done: body.done, text: body.text };
    }
  }
  return { ok: true, steps, claim: claim ?? { done: false, text: "" } };
}
