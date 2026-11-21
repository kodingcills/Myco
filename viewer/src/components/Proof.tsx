import { cloneElement, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { stepLabel } from "../data/steps.ts";
import type { RunData, SourceRef } from "../data/types.ts";
import {
  type CheckItem,
  type ComparatorRow,
  deriveChecks,
  deriveComparatorRows,
  deriveFailuresAndRecovery,
  type FailureRecoveryItem,
} from "../data/verdict.ts";
import { useViewer } from "../store.ts";
import { formatValue, Missing, SourceChip, sourceLabel } from "./SourceRef.tsx";
import { VerdictBadge } from "./VerdictBadge.tsx";

function Comparator({ rows }: { rows: ComparatorRow[] }) {
  const inspect = useViewer((state) => state.inspect);
  const [focused, setFocused] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const comparisonWords = {
    agree: "Agrees",
    disagree: "Disagrees",
    unknown: "Unknown",
    "not recorded": "No comparison recorded",
  };
  const hasClaims = rows.some((row) => row.claimedLabel === "claimed");
  return (
    <section data-comparator aria-label="Comparator">
      <div data-comparison-grid className="type-micro text-text-secondary">
        <span>Field</span>
        <span>{hasClaims ? "Claimed (UI / agent)" : "Claimed (derived)"}</span>
        <span>Persisted (verifier)</span>
      </div>
      {rows.length === 0 && (
        <p className="p-3">
          <Missing />
        </p>
      )}
      {rows.map((row, index) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: Comparator rows form a roving focus group.
        <div
          key={sourceLabel(row.check.source)}
          ref={(node) => {
            refs.current[index] = node;
          }}
          data-comparison-grid
          data-comparison={row.comparison}
          tabIndex={index === Math.min(focused, rows.length - 1) ? 0 : -1}
          onFocus={() => setFocused(index)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter") {
              event.preventDefault();
              inspect(row.persisted.source);
            }
            const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
            if (offset && rows.length > 1) {
              event.preventDefault();
              refs.current[index + offset]?.focus();
            }
          }}
        >
          <div className="type-data text-text-secondary">
            <span data-comparison-mark role="img" aria-label={comparisonWords[row.comparison]}>
              {row.comparison === "agree" ? "=" : row.comparison === "disagree" ? "≠" : ""}
            </span>
            {row.field}
            <SourceChip source={row.check.source} compact />
          </div>
          <div className={row.comparison === "disagree" ? "type-data-strong" : "type-data"}>
            {row.claimed ? (
              <>
                <div>{formatValue(row.claimed.value)}</div>
                {row.claimedLabel === "claimed (derived)" && hasClaims && (
                  <div className="type-small text-text-secondary">{row.claimedLabel}</div>
                )}
                <SourceChip source={row.claimed.source} />
              </>
            ) : (
              <Missing />
            )}
          </div>
          <div
            data-persisted
            className={row.comparison === "disagree" ? "type-data-strong" : "type-data"}
          >
            {row.persisted.status === "value" ? (
              <div>{formatValue(row.persisted.value)}</div>
            ) : row.persisted.status === "not recorded" ? (
              <div>
                <Missing />
              </div>
            ) : (
              <div>{row.persisted.status === "absent" ? "absent" : "could not look"}</div>
            )}
            {row.persisted.status === "could not look" && (
              <div className="type-small text-text-secondary">{row.check.value.reason}</div>
            )}
            <SourceChip source={row.persisted.source} />
          </div>
        </div>
      ))}
    </section>
  );
}

export function CheckRow({ check, virtual }: { check: CheckItem; virtual?: boolean }) {
  const Row = virtual ? "div" : "li";
  const { name, partial_score: partial, reason } = check.value;
  return (
    <Row data-check-row>
      <VerdictBadge label={check.label} />
      <span className="type-data truncate" title={name}>
        {name}
      </span>
      <span className="type-data-small text-text-secondary">w={partial.weight.toFixed(2)}</span>
      <span className="type-data" title={`Partial score ${partial.score.toFixed(2)}`}>
        {partial.score.toFixed(2)}
      </span>
      <span className="type-small truncate text-text-secondary" title={reason}>
        {check.label === "Unknown" ? "could not look · " : ""}
        {reason}
      </span>
      <SourceChip source={check.source} />
    </Row>
  );
}

function failureLabel(item: FailureRecoveryItem) {
  switch (item.kind) {
    case "guardFailure":
      return ["Guard failure", item.value.phase];
    case "guard-failure":
      return ["Guard failure", "guard" in item.value ? item.value.guard.phase : undefined];
    case "recovery":
      return ["Recovery", "event" in item.value ? item.value.event : undefined];
    case "fault-injection":
      return [
        "Fault injection",
        "fault" in item.value ? item.value.fault : undefined,
        "detail" in item.value ? item.value.detail : undefined,
      ];
  }
}

function FailureRow({ item, virtual }: { item: FailureRecoveryItem; virtual?: boolean }) {
  const Row = virtual ? "div" : "li";
  const [label, value, detail] = failureLabel(item);
  const badge =
    label === "Guard failure"
      ? "Failed"
      : label === "Recovery" && value !== "none"
        ? value === "aborted-uncertain"
          ? "Unknown"
          : "Recovered"
        : undefined;
  return (
    <Row data-failure-row>
      {badge && <VerdictBadge size="sm" label={badge} />}
      <span className="type-body-strong">{label}</span>
      <span className="type-data">{value ?? <Missing />}</span>
      {detail && <span className="type-data">{detail}</span>}
      <SourceChip source={item.source} />
      {"alsoRecordedAt" in item && item.alsoRecordedAt && (
        <SourceChip source={item.alsoRecordedAt} />
      )}
    </Row>
  );
}

const VirtualList = forwardRef<HTMLUListElement, React.ComponentPropsWithoutRef<"ul">>(
  ({ children, ...props }, ref) => (
    <ul {...props} ref={ref}>
      {children}
    </ul>
  ),
);
function VirtualItem({ children, ...props }: React.ComponentPropsWithoutRef<"li">) {
  return <li {...props}>{children}</li>;
}
const virtualComponents = { List: VirtualList, Item: VirtualItem };

function EvidenceList<T extends { source: SourceRef }>({
  rows,
  center,
  render,
}: {
  rows: T[];
  center: HTMLElement | null;
  render: (item: T, virtual?: boolean) => React.ReactElement;
}) {
  if (!rows.length)
    return (
      <p className="px-3">
        <Missing />
      </p>
    );
  if (rows.length > 50 && center) {
    return (
      <Virtuoso
        customScrollParent={center}
        data={rows}
        components={virtualComponents}
        computeItemKey={(_, item) => sourceLabel(item.source)}
        itemContent={(_, item) => render(item, true)}
      />
    );
  }
  return (
    <ul>{rows.map((item) => cloneElement(render(item), { key: sourceLabel(item.source) }))}</ul>
  );
}

export function Proof({
  data,
  center,
  loading,
}: {
  data: RunData;
  center: HTMLElement | null;
  loading: boolean;
}) {
  const rows = useMemo(() => deriveComparatorRows(data), [data]);
  const checks = useMemo(() => deriveChecks(data.result), [data.result]);
  const failures = useMemo(() => deriveFailuresAndRecovery(data), [data]);
  const stateChanges = useMemo(
    () =>
      (data.result?.steps ?? []).flatMap((step, index) =>
        step.stateVersionBefore === step.stateVersionAfter
          ? []
          : [
              {
                step,
                path: `/steps/${index}`,
                source: { file: "result.json", path: `/steps/${index}/step` },
              },
            ],
      ),
    [data.result],
  );
  const digits = Math.max(2, String(data.result?.steps.at(-1)?.step ?? 0).length);
  const filter = useViewer((state) => state.filter);
  const checkIndex = useViewer((state) => state.selection.check);
  const filterResult = useRef<HTMLElement>(null);
  useEffect(() => {
    if (filter && document.activeElement?.getAttribute("aria-controls") === "proof-filter") {
      filterResult.current?.focus();
    }
  }, [filter]);
  useEffect(() => {
    if (
      checkIndex === undefined &&
      !loading &&
      !filter &&
      rows.length &&
      center &&
      (document.activeElement === document.body ||
        document.activeElement === center ||
        document.activeElement?.matches("[data-pick-open]"))
    ) {
      center
        .querySelector<HTMLElement>('[data-comparison][tabindex="0"]')
        ?.focus({ preventScroll: true });
    }
  }, [loading, filter, rows.length, center, checkIndex]);

  return (
    <>
      {!filter && <Comparator rows={rows} />}
      {(!filter || filter === "checks") && (
        <section
          aria-label="Checks"
          className="pb-3"
          ref={filter === "checks" ? filterResult : undefined}
          id={filter === "checks" ? "proof-filter" : undefined}
          tabIndex={filter === "checks" ? -1 : undefined}
        >
          <h2 className="px-3 py-2 type-title">Checks</h2>
          <EvidenceList
            rows={checks}
            center={center}
            render={(check, virtual) => <CheckRow check={check} virtual={virtual} />}
          />
        </section>
      )}
      {!filter && (
        <section aria-label="State changes" className="pb-3">
          <h2 className="px-3 py-2 type-title">State changes</h2>
          <EvidenceList
            rows={stateChanges}
            center={center}
            render={({ step, path, source }, virtual) => {
              const Row = virtual ? "div" : "li";
              return (
                <Row data-state-row className="type-data">
                  <span>{stepLabel(step.step, digits)}</span>
                  <SourceChip source={source} compact />
                  <span>v{step.stateVersionBefore}</span>
                  <SourceChip
                    source={{ file: source.file, path: `${path}/stateVersionBefore` }}
                    compact
                  />
                  <span>→</span>
                  <span>v{step.stateVersionAfter}</span>
                  <SourceChip
                    source={{ file: source.file, path: `${path}/stateVersionAfter` }}
                    compact
                  />
                </Row>
              );
            }}
          />
        </section>
      )}
      {filter !== "checks" && (
        <section
          aria-label="Failures & recovery"
          className="pb-3"
          ref={filter ? filterResult : undefined}
          id={filter ? "proof-filter" : undefined}
          tabIndex={filter ? -1 : undefined}
        >
          <h2 className="px-3 py-2 type-title">Failures &amp; recovery</h2>
          <EvidenceList
            rows={failures.filter(
              (item) =>
                !filter ||
                (filter === "recoveries"
                  ? item.kind === "recovery" && "event" in item.value && item.value.event !== "none"
                  : item.kind === "guard-failure" || item.kind === "guardFailure"),
            )}
            center={center}
            render={(item, virtual) => <FailureRow item={item} virtual={virtual} />}
          />
        </section>
      )}
    </>
  );
}
