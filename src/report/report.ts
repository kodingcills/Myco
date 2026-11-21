/**
 * Developer-facing run report (MVD-007).
 *
 * Renders a schema-valid run directory (`result.json` + `trace.jsonl`) into one
 * self-contained HTML page. The page never computes a verdict of its own: it
 * displays what the evidence says, including the absence of a verdict, and it
 * never presents `uncertain` or a missing verdict as success.
 *
 * Security: every value from the artifacts is HTML-escaped. Nothing is loaded
 * from the network and the page contains no script.
 */

export interface ReportPredicate {
  predicateName?: unknown;
  passed?: unknown;
  observed?: unknown;
}

export interface ReportStep {
  step?: unknown;
  action?: Record<string, unknown>;
  preconditionResults?: ReportPredicate[];
  postconditionResults?: ReportPredicate[];
  stateVersionBefore?: unknown;
  stateVersionAfter?: unknown;
}

export interface ReportCheck {
  name?: unknown;
  passed?: unknown;
  reason?: unknown;
  partial_score?: { score?: unknown; weight?: unknown };
}

export interface ReportVerdict {
  status?: unknown;
  score?: unknown;
  reasons?: unknown[];
  checks?: ReportCheck[];
}

export interface ReportResult {
  recordKind?: unknown;
  runId?: unknown;
  taskId?: unknown;
  taskParams?: Record<string, unknown>;
  startedAt?: unknown;
  steps?: ReportStep[];
  guardFailure?: {
    step?: unknown;
    phase?: unknown;
    predicateName?: unknown;
    observed?: unknown;
    reason?: unknown;
  };
  verdict?: ReportVerdict;
  unresolvedState?: unknown;
}

export interface ReportTraceEvent {
  type?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
}

export interface ReportInput {
  result: ReportResult;
  trace: ReportTraceEvent[];
  /** Names of the artifact files that were read, for the footer. */
  files?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePredicate(value: unknown): ReportPredicate | undefined {
  if (!isRecord(value)) return undefined;
  return { predicateName: value.predicateName, passed: value.passed, observed: value.observed };
}

function parsePredicates(value: unknown): ReportPredicate[] {
  if (!Array.isArray(value)) return [];
  const parsed: ReportPredicate[] = [];
  for (const item of value) {
    const predicate = parsePredicate(item);
    if (predicate) parsed.push(predicate);
  }
  return parsed;
}

function parseStep(value: unknown): ReportStep | undefined {
  if (!isRecord(value)) return undefined;
  return {
    step: value.step,
    action: isRecord(value.action) ? value.action : {},
    preconditionResults: parsePredicates(value.preconditionResults),
    postconditionResults: parsePredicates(value.postconditionResults),
    stateVersionBefore: value.stateVersionBefore,
    stateVersionAfter: value.stateVersionAfter,
  };
}

function parseCheck(value: unknown): ReportCheck | undefined {
  if (!isRecord(value)) return undefined;
  const score = isRecord(value.partial_score) ? value.partial_score : undefined;
  return {
    name: value.name,
    passed: value.passed,
    reason: value.reason,
    partial_score: score ? { score: score.score, weight: score.weight } : undefined,
  };
}

/**
 * Project a parsed `result.json` onto the fields this page displays. Artifacts
 * come from disk, so nothing is assumed: unknown shapes are dropped and missing
 * fields render as `—`. Schema validity is checked separately by the CLI.
 */
export function parseReportResult(value: unknown): ReportResult {
  const record = isRecord(value) ? value : {};
  const verdict = isRecord(record.verdict) ? record.verdict : undefined;
  const checks: ReportCheck[] = [];
  if (verdict && Array.isArray(verdict.checks)) {
    for (const item of verdict.checks) {
      const check = parseCheck(item);
      if (check) checks.push(check);
    }
  }
  const steps: ReportStep[] = [];
  if (Array.isArray(record.steps)) {
    for (const item of record.steps) {
      const step = parseStep(item);
      if (step) steps.push(step);
    }
  }
  const guard = isRecord(record.guardFailure)
    ? {
        step: record.guardFailure.step,
        phase: record.guardFailure.phase,
        predicateName: record.guardFailure.predicateName,
        observed: record.guardFailure.observed,
        reason: record.guardFailure.reason,
      }
    : undefined;
  return {
    recordKind: record.recordKind,
    runId: record.runId,
    taskId: record.taskId,
    taskParams: isRecord(record.taskParams) ? record.taskParams : undefined,
    startedAt: record.startedAt,
    steps,
    guardFailure: guard,
    verdict: verdict
      ? {
          status: verdict.status,
          score: verdict.score,
          reasons: Array.isArray(verdict.reasons) ? verdict.reasons : [],
          checks,
        }
      : undefined,
    unresolvedState: record.unresolvedState,
  };
}

export function parseTraceEvent(value: unknown): ReportTraceEvent {
  return isRecord(value) ? value : {};
}

const STATUS_LABEL: Record<string, string> = {
  verified: "Verified",
  refuted: "Refuted",
  uncertain: "Uncertain",
};

const STATUS_GLYPH: Record<string, string> = {
  verified: "✓",
  refuted: "✗",
  uncertain: "?",
};

/** Escape only the characters that change markup. Quotes are literal here because
 * artifact text is read in prose contexts (`<code>`), where `&#39;` is noise. */
function escapeText(value: unknown): string {
  return escapeHtml(value).replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}

export function escapeHtml(value: unknown): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : String(value);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function text(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function oneLine(value: unknown, max = 120): string {
  const raw = text(value, "");
  const flattened = raw.replace(/\s+/g, " ").trim();
  // Middle-truncate so a long value keeps both its head and its tail: the tail
  // is where "…xlsx" or a version suffix lives, and that is what a reader checks.
  if (flattened.length <= max) return flattened;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${flattened.slice(0, head)}…${flattened.slice(flattened.length - tail)}`;
}

function stepAction(step: ReportStep): string {
  const action = step.action ?? {};
  const kind = typeof action.kind === "string" ? action.kind : "action";
  const parts: string[] = [kind];
  const ref = action.ref;
  if (ref && typeof ref === "object" && "nodeId" in ref && typeof ref.nodeId === "string") {
    parts.push(ref.nodeId);
  }
  if (action.value !== undefined) parts.push(`= ${oneLine(action.value, 80)}`);
  if (action.keys !== undefined) parts.push(oneLine(action.keys, 40));
  if (action.text !== undefined) parts.push(oneLine(action.text, 80));
  return parts.join(" ");
}

function predicateRow(predicate: ReportPredicate): string {
  const passed = predicate.passed;
  const mark =
    passed === true
      ? "passed"
      : passed === false
        ? "failed"
        : passed === null
          ? "unknown"
          : "no result";
  return `<tr class="predicate predicate-${escapeHtml(mark)}">
      <td class="mark" aria-label="${escapeHtml(mark)}">${passed === true ? "✓" : passed === false ? "✗" : "?"}</td>
      <td>${escapeHtml(text(predicate.predicateName, "(unnamed predicate)"))}</td>
      <td class="observed">${escapeHtml(oneLine(predicate.observed, 200))}</td>
    </tr>`;
}

function predicateTable(title: string, predicates: ReportPredicate[] | undefined): string {
  if (!predicates || predicates.length === 0) return "";
  return `<div class="guards">
      <p class="guards-title">${escapeHtml(title)}</p>
      <table class="predicates">
        <tbody>${predicates.map(predicateRow).join("")}</tbody>
      </table>
    </div>`;
}

function stepBlock(step: ReportStep, open: boolean): string {
  const number = typeof step.step === "number" ? step.step : 0;
  const pre = step.preconditionResults ?? [];
  const post = step.postconditionResults ?? [];
  const before = text(step.stateVersionBefore);
  const after = text(step.stateVersionAfter);
  const guards = `${pre.length} pre · ${post.length} post`;
  return `<details class="step"${open ? " open" : ""}>
      <summary>
        <span class="step-no">${escapeHtml(number + 1)}</span>
        <span class="step-action">${escapeHtml(stepAction(step))}</span>
        <span class="step-guards">${escapeHtml(guards)}</span>
        <span class="step-version" title="state version before → after">v${escapeHtml(before)} → v${escapeHtml(after)}</span>
      </summary>
      <div class="step-body">
        ${predicateTable("Preconditions", step.preconditionResults)}
        ${predicateTable("Postconditions", step.postconditionResults)}
        <p class="raw"><span>action</span><code>${escapeHtml(JSON.stringify(step.action ?? {}))}</code></p>
      </div>
    </details>`;
}

function checksTable(checks: ReportCheck[]): string {
  if (checks.length === 0) return "";
  const rows = checks
    .map((check) => {
      const passed = check.passed;
      const mark = passed === true ? "✓" : passed === false ? "✗" : "?";
      const state = passed === true ? "passed" : passed === false ? "failed" : "unknown";
      const weight = check.partial_score?.weight;
      const score = check.partial_score?.score;
      const share =
        typeof weight === "number" ? `${typeof score === "number" ? score : "—"} / ${weight}` : "—";
      return `<tr class="check check-${state}">
          <td class="mark" aria-label="${escapeHtml(state)}">${mark}</td>
          <td>
            <p class="check-name">${escapeHtml(text(check.name, "(unnamed check)"))}</p>
            <p class="check-reason">${escapeHtml(text(check.reason, "No reason recorded."))}</p>
          </td>
          <td class="check-score" title="score / weight">${escapeHtml(share)}</td>
        </tr>`;
    })
    .join("");
  return `<table class="checks">
      <thead><tr><th scope="col"><span class="sr-only">Result</span></th><th scope="col">Check against persisted state</th><th scope="col">Score</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function traceSummary(trace: ReportTraceEvent[]): {
  events: number;
  observations: number;
  actions: number;
  recoveries: ReportTraceEvent[];
  faults: ReportTraceEvent[];
  guardFailures: ReportTraceEvent[];
  first?: string;
  last?: string;
} {
  const timestamps = trace
    .map((event) => event.timestamp)
    .filter((value): value is string => typeof value === "string")
    .sort();
  return {
    events: trace.length,
    observations: trace.filter((event) => event.type === "observation").length,
    actions: trace.filter((event) => event.type === "action").length,
    recoveries: trace.filter((event) => event.type === "recovery"),
    faults: trace.filter((event) => event.type === "fault-injection"),
    guardFailures: trace.filter((event) => event.type === "guard-failure"),
    first: timestamps[0],
    last: timestamps[timestamps.length - 1],
  };
}

function specialEvents(trace: ReportTraceEvent[]): string {
  const interesting = trace.filter(
    (event) =>
      event.type === "fault-injection" ||
      event.type === "recovery" ||
      event.type === "guard-failure",
  );
  if (interesting.length === 0) {
    return `<p class="empty">No fault, recovery, or guard-failure events in this trace.</p>`;
  }
  const rows = interesting
    .map((event) => {
      const type = text(event.type, "event");
      let detail = "";
      if (type === "fault-injection") detail = `fault ${text(event.fault)} — ${text(event.detail)}`;
      else if (type === "recovery")
        detail = `${text(event.event)} at state v${text(event.stateVersion)}`;
      else {
        const guard = (event.guard ?? {}) as Record<string, unknown>;
        detail = `step ${text(guard.step)} ${text(guard.phase)}: ${text(guard.predicateName)} — ${text(guard.reason)}`;
      }
      return `<li class="event event-${escapeHtml(type)}">
          <span class="event-type">${escapeHtml(type.replaceAll("-", " "))}</span>
          <span class="event-time">${escapeHtml(shortTime(event.timestamp))}</span>
          <span class="event-detail">${escapeHtml(detail)}</span>
        </li>`;
    })
    .join("");
  return `<ol class="events">${rows}</ol>`;
}

function shortTime(value: unknown): string {
  if (typeof value !== "string") return "—";
  const match = value.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? value;
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

export function renderReport(input: ReportInput): string {
  const { result, trace } = input;
  const rawStatus = result.verdict?.status;
  const status =
    typeof rawStatus === "string" && STATUS_LABEL[rawStatus]
      ? { status: rawStatus, known: true }
      : { status: "none", known: false };
  const steps = result.steps ?? [];
  const checks = result.verdict?.checks ?? [];
  const score = result.verdict?.score;
  const reasons: unknown[] = Array.isArray(result.verdict?.reasons) ? result.verdict.reasons : [];
  const summary = traceSummary(trace);
  const label = status.known ? STATUS_LABEL[status.status] : "No verdict";
  const glyph = status.known ? STATUS_GLYPH[status.status] : "–";
  const recordKind = typeof result.recordKind === "string" ? result.recordKind : "run";
  const failingStep =
    typeof result.guardFailure?.step === "number" ? (result.guardFailure.step as number) : -1;
  const params = result.taskParams ?? {};

  const verdictDetail = status.known
    ? `${checks.length} check${checks.length === 1 ? "" : "s"} against persisted state`
    : recordKind === "session"
      ? "Runtime session record — it records execution only. It is not a success verdict."
      : "This artifact carries no verdict. It is not a success.";

  const scoreText =
    typeof score === "number" ? `Score ${Number.isInteger(score) ? score : score.toFixed(3)}` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Myco run ${escapeHtml(text(result.runId, ""))} — ${escapeHtml(text(result.taskId, "untitled task"))}</title>
<style>
  :root {
    color-scheme: light dark;
    --paper: #fcfcfc;
    --ink: #16181b;
    --muted: #656b73;
    --faint: #8b9199;
    --line: #e6e7e9;
    --rule: #d3d5d8;
    --wash: #f5f5f4;
    --verified: #1d6b43;
    --verified-bg: #eef6f0;
    --refuted: #a2342b;
    --refuted-bg: #fbeeec;
    --uncertain: #8a5b17;
    --uncertain-bg: #faf3e2;
    --none: #4c525a;
    --none-bg: #f1f2f3;
    --link: #1c4f82;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #111214;
      --ink: #e9eaec;
      --muted: #a2a8b0;
      --faint: #7d848d;
      --line: #26282c;
      --rule: #35383d;
      --wash: #181a1d;
      --verified: #6fc593;
      --verified-bg: #14241b;
      --refuted: #f09086;
      --refuted-bg: #2a1716;
      --uncertain: #e0b269;
      --uncertain-bg: #2a2113;
      --none: #aab0b8;
      --none-bg: #1c1e21;
      --link: #8ab6e0;
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 15px/1.5 var(--sans);
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }
  .page { max-width: 960px; margin: 0 auto; padding: 40px 28px 72px; }
  .masthead { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; padding-bottom: 14px; border-bottom: 1px solid var(--rule); }
  .wordmark { font: 600 13px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
  .masthead .meta { color: var(--muted); font: 12px/1.4 var(--mono); text-align: right; }
  h1 { font-size: clamp(26px, 4vw, 38px); line-height: 1.1; letter-spacing: -.02em; font-weight: 650; margin: 28px 0 6px; overflow-wrap: anywhere; }
  .subtitle { color: var(--muted); margin: 0 0 28px; font-size: 14px; overflow-wrap: anywhere; }
  .verdict {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 300px);
    grid-template-areas: "main aside";
    gap: 12px 32px;
    align-items: start;
    padding: 22px 24px;
    border: 1px solid var(--line);
    border-left: 4px solid var(--none);
    background: var(--none-bg);
  }
  .verdict-verified { border-left-color: var(--verified); background: var(--verified-bg); }
  .verdict-refuted { border-left-color: var(--refuted); background: var(--refuted-bg); }
  .verdict-uncertain { border-left-color: var(--uncertain); background: var(--uncertain-bg); }
  .verdict-none { border-left-color: var(--none); background: var(--none-bg); }
  .status { display: flex; align-items: baseline; gap: 12px; }
  .status-glyph { font: 600 22px/1 var(--mono); }
  .status-word { font-size: 28px; line-height: 1; font-weight: 650; letter-spacing: -.015em; }
  .verdict-verified .status { color: var(--verified); }
  .verdict-refuted .status { color: var(--refuted); }
  .verdict-uncertain .status { color: var(--uncertain); }
  .verdict-none .status { color: var(--none); }
  .verdict p { margin: 8px 0 0; color: var(--ink); font-size: 14px; overflow-wrap: anywhere; }
  .verdict-main { grid-area: main; min-width: 0; }
  .verdict .aside { grid-area: aside; text-align: right; color: var(--muted); font: 12px/1.6 var(--mono); white-space: nowrap; }
  .unresolved-flag { color: var(--uncertain); white-space: normal; }
  .unresolved-flag { color: var(--uncertain); white-space: normal; }
  .reasons { margin: 10px 0 0; padding-left: 18px; color: var(--ink); }

  .reasons li { margin: 2px 0; overflow-wrap: anywhere; }
  .reasons code { font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }
  section { margin-top: 36px; }
  h2 { font: 600 12px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin: 0 0 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .cell { background: var(--paper); padding: 14px 16px; min-width: 0; }
  .cell dt { font: 11px/1.4 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
  .cell dd { margin: 4px 0 0; font-size: 14px; overflow-wrap: anywhere; }
  .cell dd.mono { font-family: var(--mono); font-size: 12.5px; }
  table { width: 100%; border-collapse: collapse; }
  .checks { border: 1px solid var(--line); }
  .checks th { text-align: left; font: 11px/1 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .08em; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .checks td { padding: 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .checks tr:last-child td { border-bottom: 0; }
  .mark { width: 26px; font: 600 14px/1.4 var(--mono); text-align: center; }
  .check-passed .mark { color: var(--verified); }
  .check-failed .mark { color: var(--refuted); }
  .check-unknown .mark { color: var(--uncertain); }
  .check-name { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .check-reason { margin: 3px 0 0; color: var(--muted); font-size: 13.5px; overflow-wrap: anywhere; }
  .check-score { font: 12px/1.6 var(--mono); color: var(--muted); white-space: nowrap; text-align: right; }
  .step { border: 1px solid var(--line); border-bottom: 0; }
  .step:last-of-type { border-bottom: 1px solid var(--line); }
  .step summary {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto auto;
    gap: 12px;
    align-items: baseline;
    padding: 11px 14px;
    cursor: pointer;
    list-style: none;
    background: var(--paper);
  }
  .step summary::-webkit-details-marker { display: none; }
  .step summary:hover { background: var(--wash); }
  .step summary:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
  .step[open] summary { background: var(--wash); border-bottom: 1px solid var(--line); }
  .step-no { font: 12px/1.6 var(--mono); color: var(--faint); }
  .step-action { font: 13px/1.5 var(--mono); overflow-wrap: anywhere; }
  .step-guards { font: 11.5px/1.6 var(--mono); color: var(--muted); white-space: nowrap; }
  .step-version { font: 11.5px/1.6 var(--mono); color: var(--faint); white-space: nowrap; }
  .step-body { padding: 6px 14px 14px 60px; }
  .guards { margin-top: 10px; }
  .guards-title { margin: 0 0 4px; font: 11px/1.4 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
  .predicates td { padding: 6px 8px 6px 0; border-bottom: 1px dashed var(--line); font-size: 13px; vertical-align: top; }
  .predicate-name { margin: 0; overflow-wrap: anywhere; }
  .observed { margin: 2px 0 0; }
  .predicates tr:last-child td { border-bottom: 0; }
  .predicates .observed { color: var(--muted); font-family: var(--mono); font-size: 12px; overflow-wrap: break-word; word-break: normal; }
  .predicate-passed .mark { color: var(--verified); }
  .predicate-failed .mark { color: var(--refuted); }
  .raw { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 10px; margin: 12px 0 0; font-size: 12px; }
  .raw span { font: 11px/1.6 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
  .raw code { font: 12px/1.5 var(--mono); overflow-wrap: anywhere; white-space: pre-wrap; }
  .events { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  .events li { display: grid; grid-template-columns: 168px 64px minmax(0, 1fr); gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .event-type { font: 11.5px/1.6 var(--mono); text-transform: uppercase; letter-spacing: .06em; }
  .event-recovery .event-type { color: var(--uncertain); }
  .event-fault-injection .event-type { color: var(--refuted); }
  .event-guard-failure .event-type { color: var(--refuted); }
  .event-time { font: 12px/1.6 var(--mono); color: var(--faint); }
  .event-detail { overflow-wrap: anywhere; }
  .empty { color: var(--muted); font-size: 13.5px; margin: 0; }
  .json { margin: 8px 0 0; padding: 14px 16px; background: var(--wash); border: 1px solid var(--line); overflow-x: auto; font: 12px/1.55 var(--mono); }
  .evidence { margin: 0; padding: 0; list-style: none; }
  .evidence li { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; border-bottom: 1px solid var(--line); font: 12.5px/1.5 var(--mono); overflow-wrap: anywhere; }
  .evidence li span:last-child { color: var(--muted); white-space: nowrap; }
  footer { margin-top: 44px; padding-top: 14px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12.5px; }
  footer p { margin: 4px 0; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @media (max-width: 640px) {
    .page { padding: 24px 16px 48px; }
    .masthead { flex-direction: column; gap: 4px; }
    .masthead .meta { text-align: left; }
    .verdict { grid-template-columns: minmax(0, 1fr); grid-template-areas: "main" "aside"; padding: 18px; }
    .verdict .aside { text-align: left; white-space: normal; }
    .step summary { grid-template-columns: 28px minmax(0, 1fr); }
    .step-guards, .step-version { grid-column: 2; }
    .step-body { padding: 6px 14px 14px 14px; }
    .events li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .checks .check-score { display: none; }
  }
  @media print {
    body { background: #fff; color: #000; }
    .page { max-width: none; padding: 0; }
    .step { break-inside: avoid; }
    a { color: inherit; }
  }
</style>
</head>
<body>
<main class="page">
  <header class="masthead">
    <span class="wordmark">Myco run report</span>
    <span class="meta">${escapeHtml(formatDate(result.startedAt))}</span>
  </header>

  <h1>${escapeHtml(text(result.taskId, "Untitled task"))}</h1>
  <p class="subtitle">run <code>${escapeHtml(text(result.runId))}</code></p>

  <div class="verdict verdict-${escapeHtml(status.known ? status.status : "none")}">
    <div class="verdict-main">
      <div class="status">
        <span class="status-glyph" aria-hidden="true">${escapeHtml(glyph)}</span>
        <span class="status-word">${escapeHtml(label)}</span>
      </div>
      <p>${escapeHtml(verdictDetail)}</p>
      ${
        reasons.length > 0
          ? `<ul class="reasons">${reasons
              .map((reason) => `<li><code>${escapeText(reason)}</code></li>`)
              .join("")}</ul>`
          : ""
      }
    </div>
    <div class="aside">
      ${scoreText ? `<div>${escapeHtml(scoreText)}</div>` : ""}
      <div>${escapeHtml(recordKind)}</div>
      ${typeof result.unresolvedState === "string" ? `<div class="unresolved-flag">unresolved state</div>` : ""}
    </div>
  </div>

  <section aria-labelledby="facts-heading">
    <h2 id="facts-heading">Run facts</h2>
    <dl class="grid">
      <div class="cell"><dt>Task</dt><dd>${escapeHtml(text(result.taskId))}</dd></div>
      <div class="cell"><dt>Started</dt><dd class="mono">${escapeHtml(formatDate(result.startedAt))}</dd></div>
      <div class="cell"><dt>Steps</dt><dd>${escapeHtml(steps.length)}</dd></div>
      <div class="cell"><dt>Duration</dt><dd>${escapeHtml(summary.first && summary.last ? String(Math.max(0, Math.round((Date.parse(summary.last) - Date.parse(summary.first)) / 1000))) + " s" : "—")}</dd></div>
      <div class="cell"><dt>Trace events</dt><dd>${escapeHtml(summary.events)}</dd></div>
      <div class="cell"><dt>Recoveries</dt><dd>${escapeHtml(summary.recoveries.length)}</dd></div>
      <div class="cell"><dt>Faults injected</dt><dd>${escapeHtml(summary.faults.length)}</dd></div>
    </dl>
  </section>

  <section aria-labelledby="checks-heading">
    <h2 id="checks-heading">Checks</h2>
    ${checks.length > 0 ? checksTable(checks) : `<p class="empty">This artifact carries no checks.${status.known ? "" : " That is not a success."}</p>`}
    ${result.guardFailure ? `<div class="verdict verdict-refuted" style="margin-top:16px"><div><div class="status"><span class="status-glyph" aria-hidden="true">!</span><span class="status-word" style="font-size:20px">Guard failed</span></div><p>Step ${escapeHtml(text(result.guardFailure.step))} ${escapeHtml(text(result.guardFailure.phase))} — ${escapeHtml(text(result.guardFailure.predicateName))}: ${escapeHtml(text(result.guardFailure.reason))}</p><p class="mono">obs: ${escapeHtml(text(result.guardFailure.observed))}</p></div></div>` : ""}
  </section>

  <section aria-labelledby="steps-heading">
    <h2 id="steps-heading">Steps</h2>
    ${steps.length > 0 ? steps.map((step) => stepBlock(step, step.step === failingStep)).join("") : `<p class="empty">No steps recorded.</p>`}
  </section>

  <section aria-labelledby="trace-heading">
    <h2 id="trace-heading">Faults, recovery, guard failures</h2>
    ${specialEvents(trace)}
  </section>

  <section aria-labelledby="params-heading">
    <h2 id="params-heading">Task parameters</h2>
    ${Object.keys(params).length > 0 ? `<pre class="json">${escapeHtml(JSON.stringify(params, null, 2))}</pre>` : `<p class="empty">No task parameters recorded.</p>`}
  </section>

  <section aria-labelledby="evidence-heading">
    <h2 id="evidence-heading">Evidence</h2>
    <ul class="evidence">
      ${(input.files ?? ["result.json", "trace.jsonl"]).map((file) => `<li><span>${escapeHtml(file)}</span><span>read</span></li>`).join("")}
    </ul>
    <p class="empty">Rendered from the run's own artifacts. The verdict is the artifact's; this page computes nothing.</p>
  </section>

  <footer>
    <p>Myco evidence schema ADR-0007 · ${escapeHtml(recordKind)} record · ${escapeHtml(text(result.runId))}</p>
    <p>No value on this page was written by hand. If a field is missing it is shown as — and never inferred.</p>
  </footer>
</main>
</body>
</html>
`;
}
