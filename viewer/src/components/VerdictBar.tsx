import { Tabs } from "@base-ui/react/tabs";
import { useMemo } from "react";
import type { SourceRef } from "../data/types.ts";
import { deriveChecks, deriveFailuresAndRecovery, deriveVerdict } from "../data/verdict.ts";
import { type OpenedRun, type ProofFilter, useViewer } from "../store.ts";
import { Missing, SourceChip } from "./SourceRef.tsx";
import { VerdictBadge } from "./VerdictBadge.tsx";

function resultSource(path: string): SourceRef {
  return { file: "result.json", path };
}

function Count({
  label,
  value,
  filter,
  source,
}: {
  label: string;
  value?: number | string;
  filter: ProofFilter;
  source?: SourceRef;
}) {
  const active = useViewer((state) => state.filter === filter);
  const toggle = useViewer((state) => state.toggleFilter);
  return (
    <span data-count>
      <button
        type="button"
        data-button
        aria-pressed={active}
        aria-controls={active ? "proof-filter" : undefined}
        title={`Show all ${label} and their sources`}
        onClick={() => toggle(filter)}
      >
        {label} <span className="type-data">{value ?? <Missing />}</span>
      </button>
      {source && <SourceChip source={source} compact />}
    </span>
  );
}

export function ModeTabs() {
  return (
    <Tabs.List aria-label="View mode" data-modes activateOnFocus>
      <Tabs.Tab value="why" data-button aria-keyshortcuts="2">
        <span className="type-data-small">2</span> Why
      </Tabs.Tab>
      <Tabs.Tab value="proof" data-button aria-keyshortcuts="3">
        <span className="type-data-small">3</span> Proof
      </Tabs.Tab>
    </Tabs.List>
  );
}

const dayTime = new Intl.DateTimeFormat(undefined, {
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

export function VerdictBar({ run }: { run: OpenedRun }) {
  const { data, loading, error } = run;
  const waitingForResult = loading && !run.resultReceived;
  const { result, events } = data;
  const verdict = useMemo(() => deriveVerdict(data), [data]);
  const failures = useMemo(() => deriveFailuresAndRecovery(data), [data]);
  const guards = failures.filter(
    (item) => item.kind === "guardFailure" || item.kind === "guard-failure",
  );
  const recoveries = failures.filter(
    (item) => item.kind === "recovery" && "event" in item.value && item.value.event !== "none",
  );
  const checks = useMemo(() => deriveChecks(result), [result]);
  const scored = result?.recordKind !== "session" ? result?.verdict : undefined;
  const started = result?.startedAt && new Date(result.startedAt);
  const startedLabel =
    started && Number.isFinite(started.getTime()) ? dayTime.format(started) : result?.startedAt;
  const checksSource = scored
    ? resultSource("/verdict/checks")
    : result?.recordKind === "session" && result.checks
      ? resultSource("/checks")
      : undefined;
  const reasons = scored?.reasons ?? [];
  const reasonRef =
    verdict.reason?.source ?? (reasons.length ? resultSource("/verdict/reasons") : undefined);
  return (
    <section
      data-region="verdict"
      data-verdict-bar
      data-verdict={waitingForResult || (error && !result) ? undefined : verdict.label}
      data-verdict-final={!loading && !error ? "true" : undefined}
      aria-label="Verdict bar"
      tabIndex={-1}
    >
      <div data-verdict-heading>
        <div role="status">
          {waitingForResult ? (
            <span className="type-verdict">Loading</span>
          ) : error && !result ? (
            <span className="type-title">Can't read file</span>
          ) : (
            <VerdictBadge size="xl" label={verdict.label} subtype={verdict.subtype} />
          )}
        </div>
      </div>
      <div data-verdict-sources>
        {verdict.sources[0] && <SourceChip source={verdict.sources[0]} compact />}
        {(verdict.subtype || verdict.label === "Recovered") &&
          verdict.sources
            .slice(verdict.label === "Recovered" ? 2 : 1)
            .map((source) => <SourceChip key={JSON.stringify(source)} source={source} compact />)}
      </div>
      <div data-task data-inline-evidence>
        <h1 className="type-title truncate" title={result?.taskId}>
          {result?.taskId ?? <Missing />}
        </h1>
        {result?.taskId && <SourceChip source={resultSource("/taskId")} compact />}
        {result?.taskParams && <SourceChip source={resultSource("/taskParams")} compact />}
        {loading && (
          <span className="type-data-small whitespace-nowrap text-text-tertiary">
            {events.length.toLocaleString()} events
          </span>
        )}
      </div>
      <div data-run-line data-inline-evidence className="type-data-small text-text-tertiary">
        <span data-run-id className="truncate" title={result?.runId}>
          {result?.runId ?? <Missing />}
        </span>
        {result && <SourceChip source={resultSource("/runId")} compact />}
        {startedLabel && (
          <>
            <span data-run-start className="whitespace-nowrap" title={result?.startedAt}>
              · started {startedLabel}
            </span>
            <SourceChip source={resultSource("/startedAt")} compact />
          </>
        )}
        {result && (
          <>
            <span className="whitespace-nowrap">· {result.steps.length} steps</span>
            <SourceChip source={resultSource("/steps")} compact />
          </>
        )}
      </div>
      <div data-verdict-summary>
        <div data-inline-evidence>
          <span className="whitespace-nowrap">
            Score <span className="type-data">{scored?.score.toFixed(2) ?? <Missing />}</span>
          </span>
          {scored && <SourceChip source={resultSource("/verdict/score")} compact />}
        </div>
        <div data-inline-evidence>
          <span
            className="type-small truncate text-text-secondary"
            title={[
              verdict.reason?.value,
              ...reasons.filter((reason) => reason !== verdict.reason?.value),
            ]
              .filter(Boolean)
              .join("\n")}
          >
            {verdict.reason?.value ?? reasons[0] ?? <Missing />}
          </span>
          {reasonRef && <SourceChip source={reasonRef} compact />}
          {reasons.length > 1 && <SourceChip source={resultSource("/verdict/reasons")} compact />}
        </div>
      </div>
      <fieldset data-counts aria-label="Evidence counts">
        <Count
          label="checks"
          value={
            checksSource
              ? `${checks.filter(({ value }) => value.passed === true).length}/${checks.length}`
              : undefined
          }
          filter="checks"
          source={checksSource}
        />
        <Count label="guard failures" value={loading ? undefined : guards.length} filter="guards" />
        <Count
          label="recoveries"
          value={loading ? undefined : recoveries.length}
          filter="recoveries"
        />
      </fieldset>
      <ModeTabs />
    </section>
  );
}
