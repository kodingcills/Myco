import { Tabs } from "@base-ui/react/tabs";
import { type KeyboardEvent, useLayoutEffect, useMemo, useRef } from "react";
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
      {source && <SourceChip source={source} compact subject={`${label} count`} />}
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

/** The bar holds many source chips; they form one Tab stop and move with the arrow keys. */
function useRovingChips() {
  const bar = useRef<HTMLElement>(null);
  const active = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const chips = [...(bar.current?.querySelectorAll<HTMLElement>("[data-source]") ?? [])];
    const current = chips.find((chip) => chip.getAttribute("aria-label") === active.current);
    for (const chip of chips) chip.tabIndex = chip === (current ?? chips[0]) ? 0 : -1;
  });
  return {
    ref: bar,
    onFocus(event: React.FocusEvent) {
      const target = event.target as HTMLElement;
      if (!target.matches("[data-source]")) return;
      active.current = target.getAttribute("aria-label") ?? undefined;
      for (const chip of bar.current?.querySelectorAll<HTMLElement>("[data-source]") ?? []) {
        chip.tabIndex = chip === target ? 0 : -1;
      }
    },
    onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      const key = event.key;
      if (
        !target.matches("[data-source]") ||
        !["ArrowRight", "ArrowLeft", "Home", "End"].includes(key)
      ) {
        return;
      }
      const chips = [...(bar.current?.querySelectorAll<HTMLElement>("[data-source]") ?? [])];
      const at = chips.indexOf(target);
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? chips.length - 1
            : Math.max(0, Math.min(chips.length - 1, at + (key === "ArrowRight" ? 1 : -1)));
      event.preventDefault();
      event.stopPropagation();
      chips[next]?.focus();
    },
  };
}

export function VerdictBar({ run }: { run: OpenedRun }) {
  const roving = useRovingChips();
  const { data, loading, error } = run;
  const waitingForResult = loading && !run.resultReceived;
  const { result, events } = data;
  const verdict = useMemo(() => run.verdict ?? deriveVerdict(data), [run.verdict, data]);
  const verdictFinal = run.verdict !== undefined && !error;
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
      {...roving}
      data-region="verdict"
      data-verdict-bar
      data-verdict={waitingForResult || (error && !result) ? undefined : verdict.label}
      data-verdict-final={verdictFinal ? "true" : undefined}
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
        {verdict.sources[0] && (
          <SourceChip source={verdict.sources[0]} compact subject={`${verdict.label} verdict`} />
        )}
        {(verdict.subtype || verdict.label === "Recovered") &&
          verdict.sources
            .slice(verdict.label === "Recovered" ? 2 : 1)
            .map((source) => (
              <SourceChip
                key={JSON.stringify(source)}
                source={source}
                compact
                subject={`${verdict.label} verdict evidence`}
              />
            ))}
      </div>
      <div data-task data-inline-evidence>
        <h1 className="type-title truncate" title={result?.taskId}>
          {result?.taskId ?? <Missing />}
        </h1>
        {result?.taskId && <SourceChip source={resultSource("/taskId")} compact subject="task" />}
        {result?.taskParams && (
          <SourceChip source={resultSource("/taskParams")} compact subject="task parameters" />
        )}
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
        {result && <SourceChip source={resultSource("/runId")} compact subject="run ID" />}
        {startedLabel && (
          <>
            <span data-run-start className="whitespace-nowrap" title={result?.startedAt}>
              · started {startedLabel}
            </span>
            <SourceChip source={resultSource("/startedAt")} compact subject="start time" />
          </>
        )}
        {result && (
          <>
            <span className="whitespace-nowrap">· {result.steps.length} steps</span>
            <SourceChip source={resultSource("/steps")} compact subject="step count" />
          </>
        )}
      </div>
      <div data-verdict-summary>
        <div data-inline-evidence>
          <span className="whitespace-nowrap">
            Score <span className="type-data">{scored?.score.toFixed(2) ?? <Missing />}</span>
          </span>
          {scored && <SourceChip source={resultSource("/verdict/score")} compact subject="score" />}
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
          {reasonRef && <SourceChip source={reasonRef} compact subject="verdict reason" />}
          {reasons.length > 1 && (
            <SourceChip source={resultSource("/verdict/reasons")} compact subject="all reasons" />
          )}
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
        <Count
          label="guard failures"
          value={verdictFinal ? guards.length : undefined}
          filter="guards"
        />
        <Count
          label="recoveries"
          value={verdictFinal ? recoveries.length : undefined}
          filter="recoveries"
        />
      </fieldset>
      <ModeTabs />
    </section>
  );
}
