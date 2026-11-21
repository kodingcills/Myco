import { ImageOff, Zap } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import tokens from "../../../docs/design/tokens.json";
import { actionLabel, markerLabels, type StepRow, stepLabel } from "../data/steps.ts";
import { useViewer } from "../store.ts";
import { useScreenshot } from "./Screenshots.tsx";
import { Missing } from "./SourceRef.tsx";
import { VerdictBadge } from "./VerdictBadge.tsx";

const localTime = new Intl.DateTimeFormat(undefined, {
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  timeZoneName: "short",
});

const guardSummary = (row: StepRow, phase: "pre" | "post") => {
  const guards = row.guards.filter(({ value }) => value.phase === phase);
  if (!guards.length) return undefined;
  const results = guards.flatMap(({ value }) => value.results);
  return `${phase} ${results.filter(({ passed }) => passed === true).length}/${results.length}`;
};

function StepOption({
  row,
  index,
  total,
  digits,
  selected,
  onSelect,
}: {
  row: StepRow;
  index: number;
  total: number;
  digits: number;
  selected: boolean;
  onSelect(step: number): void;
}) {
  const image = useScreenshot(row.screenshot?.value);
  const action = row.actions[0] && actionLabel(row.actions[0].value.action);
  const pre = guardSummary(row, "pre");
  const post = guardSummary(row, "post");
  const version = `v${row.record.stateVersionBefore}→v${row.record.stateVersionAfter}`;
  const stamp = Date.parse(row.timestamp ?? "");
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: The listbox owns focus via aria-activedescendant.
    // biome-ignore lint/a11y/useKeyWithClickEvents: The parent listbox handles keyboard selection.
    <div
      role="option"
      id={`step-row-${row.step}`}
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      data-step-row
      data-marker={row.markers[0]}
      data-recovery={row.recovers !== undefined || undefined}
      onClick={() => onSelect(row.step)}
    >
      <span className="type-data-strong" data-step-index>
        {stepLabel(row.step, digits)}
      </span>
      <span data-step-thumb title={image ? undefined : "Screenshot not recorded"}>
        {image ? (
          <img src={image} alt="Step screenshot" />
        ) : (
          <ImageOff aria-label="Screenshot not recorded" />
        )}
      </span>
      <span className="type-data truncate" title={action}>
        {action ?? <Missing />}
      </span>
      {row.markers.length > 0 && (
        <span data-step-marks>
          {row.markers.map((marker) => (
            <span
              key={marker}
              title={markerLabels[marker]}
              aria-label={markerLabels[marker]}
              role="img"
            >
              {marker === "fault" ? (
                <Zap aria-hidden="true" />
              ) : (
                <VerdictBadge
                  size="sm"
                  label={
                    marker === "failed"
                      ? "Failed"
                      : marker === "recovered"
                        ? "Recovered"
                        : "Unknown"
                  }
                />
              )}
            </span>
          ))}
        </span>
      )}
      <span className="type-data-small whitespace-nowrap">
        {pre ?? <Missing />} · {post ?? <Missing />}
      </span>
      <span className="type-data-small">{version}</span>
      <span
        className="type-data-small"
        data-step-time
        title={Number.isFinite(stamp) ? localTime.format(stamp) : undefined}
      >
        {row.offset === undefined ? (
          <Missing />
        ) : (
          `${(row.offset >= 0 ? "+" : "") + row.offset.toFixed(2)}s`
        )}
      </span>
    </div>
  );
}

export function StepList({
  rows,
  index,
  digits,
}: {
  rows: StepRow[];
  index: Map<number, number>;
  digits: number;
}) {
  const step = useViewer((state) => state.selection.step);
  const selectStep = useViewer((state) => state.selectStep);
  const virtual = useRef<VirtuosoHandle>(null);
  const list = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ startIndex: 0, endIndex: -1 });
  const selected = step === undefined ? undefined : index.get(step);
  const [finding, setFinding] = useState(false);
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const query = search.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? rows.filter((row) =>
            [
              stepLabel(row.step, digits),
              ...row.actions.map(({ value }) => actionLabel(value.action)),
            ].some((value) => value.toLowerCase().includes(query)),
          )
        : [],
    [query, digits, rows],
  );

  useLayoutEffect(() => {
    if (selected !== undefined) virtual.current?.scrollIntoView({ index: selected });
  }, [selected]);
  useLayoutEffect(() => {
    if (finding) input.current?.focus();
  }, [finding]);

  return (
    <div data-step-list>
      {finding && (
        <form
          data-raw-find
          onSubmit={(event) => {
            event.preventDefault();
            const found =
              matches.find((row) => index.get(row.step)! > (selected ?? -1)) ?? matches[0];
            if (found) selectStep(found.step);
          }}
        >
          <input
            ref={input}
            aria-label="Find in steps"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setFinding(false);
                setSearch("");
                list.current?.focus();
              }
            }}
          />
          <span role="status" className="type-data-small whitespace-nowrap">
            {query && (matches.length ? `${matches.length} matches` : "No matches")}
          </span>
          <button type="submit" data-button>
            Next
          </button>
        </form>
      )}
      <div
        ref={list}
        data-step-options
        role="listbox"
        aria-label="Run steps"
        tabIndex={0}
        aria-activedescendant={
          selected !== undefined && selected >= window.startIndex && selected <= window.endIndex
            ? `step-row-${step}`
            : undefined
        }
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            setFinding(true);
            input.current?.select();
          }
        }}
      >
        {rows.length ? (
          <Virtuoso
            ref={virtual}
            data={rows}
            initialTopMostItemIndex={selected ?? 0}
            rangeChanged={setWindow}
            fixedItemHeight={tokens.layout.rowHeight.default}
            computeItemKey={(_, row) => row.step}
            itemContent={(position, row) => (
              <StepOption
                row={row}
                index={position}
                total={rows.length}
                digits={digits}
                selected={position === selected}
                onSelect={(step) => {
                  selectStep(step);
                  list.current?.focus({ preventScroll: true });
                }}
              />
            )}
          />
        ) : (
          <p className="p-3">
            <Missing />
          </p>
        )}
      </div>
    </div>
  );
}
