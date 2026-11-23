/**
 * Artifact contract for `myco-run` (MVD-001 acceptance 3: "schema-valid
 * trace.jsonl + result.json").
 *
 * `writeRunEvidence` already validates what it writes, and `schemas/` already
 * holds the draft-07 subset validator. This module composes those two into the
 * check a *reader* needs: re-parse the files on disk and validate every line, so
 * a validator that was bypassed, a hand-edited file, or a truncated write fails
 * loudly instead of being reported as a good run.
 *
 * It adds the invariants the JSON schema subset cannot express: that the trace
 * belongs to the same run as `result.json`, that a trace opens with `run-start`,
 * and that a verdict is one of the three a reader can act on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { type SchemaIssue, validateSchema } from "../../schemas/validate.ts";
import { isRecord } from "./guards.ts";

export interface ArtifactProblem {
  /** `result.json`, `trace.jsonl`, or one line of the latter. */
  readonly file: string;
  /** Where in the file, `$`-rooted JSON path. */
  readonly path: string;
  readonly message: string;
}

export interface ArtifactCheck {
  readonly ok: boolean;
  readonly runDir: string;
  readonly traceLines: number;
  readonly problems: readonly ArtifactProblem[];
}

const VERDICT_STATUSES: Record<string, true> = {
  verified: true,
  refuted: true,
  uncertain: true,
};

function fromSchema(file: string, issues: readonly SchemaIssue[]): ArtifactProblem[] {
  return issues.map((issue) => ({ file, path: issue.path, message: issue.message }));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Validate one run directory. Every problem is collected — the first bad line
 * does not hide the second — because a reader fixing an artifact needs the list.
 */
export function validateRunDir(runDir: string): ArtifactCheck {
  const problems: ArtifactProblem[] = [];

  const resultText = readIfPresent(join(runDir, "result.json"), problems, "result.json");
  const result = resultText === undefined ? undefined : parseJson(resultText);
  if (resultText !== undefined && result === undefined) {
    problems.push({ file: "result.json", path: "$", message: "not readable JSON" });
  }

  const traceText = readIfPresent(join(runDir, "trace.jsonl"), problems, "trace.jsonl");
  const lines = (traceText ?? "").split("\n").filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    const event = parseJson(line);
    if (event === undefined) {
      problems.push({ file: `trace.jsonl[${index}]`, path: "$", message: "not readable JSON" });
      continue;
    }
    problems.push(...fromSchema(`trace.jsonl[${index}]`, validateSchema(event, traceEventSchema)));
  }

  if (result !== undefined) {
    problems.push(...fromSchema("result.json", validateSchema(result, resultRecordSchema)));
  }

  // Cross-artifact invariants: a file that satisfies its schema is not yet a run
  // a reader can trust.
  if (lines.length === 0) {
    problems.push({
      file: "trace.jsonl",
      path: "$",
      message: "empty trace: a run must record events",
    });
  } else {
    const first = parseJson(lines[0] ?? "");
    if (!isRecord(first) || first.type !== "run-start") {
      problems.push({
        file: "trace.jsonl[0]",
        path: "$.type",
        message: "a trace must open with a run-start event",
      });
    }
  }
  if (isRecord(result) && lines.length > 0) {
    for (const line of lines) {
      const event = parseJson(line);
      if (!isRecord(event) || event.runId === undefined || event.runId === result.runId) continue;
      problems.push({
        file: "trace.jsonl",
        path: "$.runId",
        message: `trace belongs to run "${String(event.runId)}" but result.json is "${String(result.runId)}"`,
      });
      break;
    }
    const verdict = result.verdict;
    const status = isRecord(verdict) ? verdict.status : undefined;
    if (typeof status !== "string" || VERDICT_STATUSES[status] !== true) {
      problems.push({
        file: "result.json",
        path: "$.verdict.status",
        message: `"${String(status)}" is not a verdict a reader can act on`,
      });
    }
  }

  return { ok: problems.length === 0, runDir, traceLines: lines.length, problems };
}

function readIfPresent(
  path: string,
  problems: ArtifactProblem[],
  label: string,
): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    problems.push({ file: label, path: "$", message: `not readable: ${String(error)}` });
    return undefined;
  }
}

export function renderArtifactCheck(check: ArtifactCheck): string {
  const lines: string[] = [];
  lines.push(check.ok ? "ARTIFACTS: VALID" : "ARTIFACTS: INVALID");
  lines.push(`  dir: ${check.runDir}`);
  lines.push(`  trace.jsonl lines: ${check.traceLines}`);
  for (const problem of check.problems) {
    lines.push(`  ${problem.file} ${problem.path}: ${problem.message}`);
  }
  return `${lines.join("\n")}\n`;
}
