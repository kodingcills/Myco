import { AlertTriangle, FileWarning } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { deriveVerdict } from "../data/verdict.ts";
import { type OpenedRun, useViewer } from "../store.ts";
import { VerdictBadge } from "./VerdictBadge.tsx";

export function layoutNumber(token: string) {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token));
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

function RunMarker({ run }: { run: OpenedRun }) {
  const verdict = useMemo(() => run.verdict ?? deriveVerdict(run.data), [run.verdict, run.data]);
  if (run.error || run.data.parseErrors.length > 0) {
    return <FileWarning aria-label="Can't read file" role="img" />;
  }
  if (run.loading && !run.resultReceived)
    return <span data-loading-dot aria-label="Loading" role="img" />;
  return <VerdictBadge label={verdict.label} subtype={verdict.subtype} size="sm" />;
}

export function RunsSidebar({ mod }: { mod: boolean }) {
  const runs = useViewer((state) => state.runs);
  const selected = useViewer((state) => state.selection.run);
  const width = useViewer((state) => state.railWidth);
  const activate = useViewer((state) => state.activate);
  const remove = useViewer((state) => state.remove);
  const [focusKey, setFocusKey] = useState<string>();
  const rows = useRef(new Map<string, HTMLDivElement>());
  const rail = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; width: number }>(null);
  const tabKey = runs.find(({ key }) => key === focusKey)?.key ?? selected ?? runs[0]?.key;

  function resize(next: number) {
    const min = layoutNumber("--layout-left-rail-bounds-min");
    const max = layoutNumber("--layout-left-rail-bounds-max");
    useViewer.setState({ railWidth: Math.max(min, Math.min(next, max)) });
  }

  return (
    <aside
      ref={rail}
      data-rail
      data-region="runs"
      aria-label="Runs sidebar"
      style={{ width }}
      tabIndex={-1}
    >
      <div data-run-tree role="tree" aria-label="Runs opened this session">
        {runs.map((run, index) => {
          const task = run.error ? "Can't read file" : (run.data.result?.taskId ?? run.name);
          const isSimulated = Boolean(
            run.data.manifest?.simulated ||
              run.data.manifest?.dryRun ||
              (run.data.result && "simulated" in run.data.result && run.data.result.simulated) ||
              (run.data.result && "dryRun" in run.data.result && run.data.result.dryRun),
          );
          return (
            <div
              key={run.key}
              ref={(node) => {
                if (node) rows.current.set(run.key, node);
                else rows.current.delete(run.key);
              }}
              data-run-row
              data-focus-key={run.key}
              role="treeitem"
              aria-selected={run.key === selected}
              title={run.name}
              tabIndex={tabKey === run.key ? 0 : -1}
              onFocus={() => setFocusKey(run.key)}
              onClick={(event) => {
                event.currentTarget.focus();
                activate(run);
              }}
              onKeyDown={(event) => {
                let next: OpenedRun | undefined;
                switch (event.key) {
                  case "ArrowUp":
                    next = runs[index - 1];
                    break;
                  case "ArrowDown":
                    next = runs[index + 1];
                    break;
                  case "Home":
                    next = runs[0];
                    break;
                  case "End":
                    next = runs.at(-1);
                    break;
                  case "Enter":
                    activate(run);
                    break;
                  case "Delete": {
                    next = runs[index + 1] ?? runs[index - 1];
                    remove(run.key);
                    if (!next) rail.current?.focus();
                    break;
                  }
                  default:
                    return;
                }
                event.preventDefault();
                if (next) rows.current.get(next.key)?.focus();
              }}
            >
              <RunMarker run={run} />
              <span className="type-body-strong truncate" title={task}>
                {task}
              </span>
              {isSimulated && (
                <span
                  data-simulated-badge
                  className="type-data-small inline-flex items-center gap-1 px-1 border border-border-strong rounded-control text-text-primary bg-bg-surface3 whitespace-nowrap"
                  title="Simulated / dry-run harness"
                >
                  <AlertTriangle
                    className="size-3 shrink-0 text-text-primary"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  Simulated
                </span>
              )}
              {mod && index < 9 ? (
                <kbd data-kbd>
                  {navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl+"}
                  {index + 1}
                </kbd>
              ) : (
                <time
                  className="type-data-small text-text-secondary"
                  dateTime={new Date(run.opened).toISOString()}
                >
                  {relative.format(-Math.floor((Date.now() - run.opened) / 60_000), "minute")}
                </time>
              )}
            </div>
          );
        })}
      </div>
      <input
        type="range"
        data-resize
        aria-label="Runs sidebar width"
        aria-keyshortcuts="ArrowLeft ArrowRight Home End"
        min={layoutNumber("--layout-left-rail-bounds-min")}
        max={layoutNumber("--layout-left-rail-bounds-max")}
        value={width ?? layoutNumber("--layout-left-rail")}
        onChange={(event) => resize(event.currentTarget.valueAsNumber)}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: rail.current?.offsetWidth ?? 0 };
        }}
        onPointerMove={(event) => {
          if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
    </aside>
  );
}
