import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { PanelRightClose } from "lucide-react";
import { cloneElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import tokens from "../../../docs/design/tokens.json";
import { loadRunFiles } from "../data/loaders.ts";
import { type StepRow, stepLabel } from "../data/steps.ts";
import type { SourceRef } from "../data/types.ts";
import { findTraceEntry, type InspectorTab, type OpenedRun, useViewer } from "../store.ts";
import { useScreenshotAsset } from "./Screenshots.tsx";
import { formatValue, Missing, SourceChip, sourceLabel } from "./SourceRef.tsx";

function sourceValue(run: OpenedRun, source: SourceRef) {
  const { data } = run;
  if ("line" in source) {
    if (source.file === "ledger.jsonl")
      return data.ledger.find(
        (entry) => "line" in entry.source && entry.source.line === source.line,
      )?.value;
    return findTraceEntry(data, source)?.event;
  }
  let value: unknown =
    source.file === "result.json"
      ? data.result
      : source.file === "manifest.json"
        ? data.manifest
        : undefined;
  for (const key of source.path
    .slice(1)
    .split("/")
    .filter((_, index) => index || source.path)) {
    const decoded = key.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, decoded)) return undefined;
    value = Reflect.get(value, decoded);
  }
  return value;
}

async function readSource(run: OpenedRun, source: SourceRef) {
  if ("line" in source) {
    const entry = findTraceEntry(run.data, source);
    if (entry?.raw !== undefined) return entry.raw;
  }
  let value = sourceValue(run, source);
  if (value !== undefined) return JSON.stringify(value, null, 2);
  const text = await (await loadRunFiles(run.files)).read(source.file)?.text();
  if (text === undefined) return undefined;
  if ("line" in source) return text.split(/\r?\n/)[source.line - 1];
  if (!source.path) return text;
  try {
    value = JSON.parse(text);
    for (const key of source.path.slice(1).split("/")) {
      const decoded = key.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!value || typeof value !== "object" || !Object.hasOwn(value, decoded)) return undefined;
      value = Reflect.get(value, decoded);
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function Raw({ run, source, row }: { run: OpenedRun; source?: SourceRef; row?: StepRow }) {
  const [sourceText, setText] = useState<{ source: SourceRef; run: OpenedRun; text?: string }>();
  const [copyStatus, setCopyStatus] = useState("");
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState<number>();
  const inspector = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const virtualRaw = useRef<VirtuosoHandle>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const header = useRef<HTMLElement>(null);
  const label = source ? sourceLabel(source) : row?.events[0] && sourceLabel(row.events[0].source);
  // Event types outside the schema are kept as extended evidence and cannot change a verdict.
  const extended =
    source && "line" in source ? findTraceEntry(run.data, source)?.kind === "extended" : false;
  const text = source
    ? sourceText?.source === source && sourceText.run === run
      ? sourceText.text
      : undefined
    : row?.events.length
      ? row.events.map(({ raw, event }) => raw ?? JSON.stringify(event)).join("\n")
      : undefined;
  useEffect(() => {
    setText(undefined);
    setCopyStatus("");
    setMatch(undefined);
    let active = true;
    if (source) {
      void readSource(run, source).then(
        (raw) => {
          if (active) setText({ source, run, text: raw });
        },
        () => {
          if (active) setText(undefined);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [run, source]);

  useEffect(() => {
    if (source) header.current?.focus({ preventScroll: true });
  }, [source]);

  useEffect(() => {
    if (finding) findInput.current?.focus();
  }, [finding]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (!inspector.current?.closest("[data-inspector]")?.contains(document.activeElement)) return;
      event.preventDefault();
      setFinding(true);
      findInput.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Could not copy");
    }
  }

  const lines = text?.split("\n") ?? [];
  const matches = query.length
    ? lines.flatMap((line, index) =>
        line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? [index] : [],
      )
    : [];
  const hit = match ?? matches[0];

  useEffect(() => {
    if (hit === undefined || !body) return;
    if (virtualRaw.current) virtualRaw.current.scrollToIndex({ index: hit, align: "center" });
    else body.querySelector("[data-raw-match]")?.scrollIntoView({ block: "nearest" });
  }, [hit, body]);

  function rawLine(line: string, index: number) {
    const key = /^\s*"(?:[^"\\]|\\.)*":/.exec(line)?.[0];
    return (
      <div data-json data-raw-match={hit === index || undefined} className="type-data">
        {!source && row?.events[index] && (
          <div className="type-data-small text-text-secondary">
            {sourceLabel(row.events[index].source)}
            {row.events[index].kind === "extended" && <span data-extended> · extended</span>}
          </div>
        )}
        {key ? (
          <>
            <span className="text-text-secondary">{key}</span>
            {line.slice(key.length)}
          </>
        ) : (
          line || " "
        )}
      </div>
    );
  }
  return (
    <div ref={inspector} data-raw>
      <header ref={header} tabIndex={-1}>
        <div data-inspector-actions>
          <span className="type-body-strong">Raw</span>
          {text !== undefined && (
            <button type="button" data-button onClick={() => void copy(text)}>
              Copy
            </button>
          )}
          {label && (
            <button type="button" data-button onClick={() => void copy(label)}>
              Copy path
            </button>
          )}
        </div>
        <div className="type-data-small text-text-secondary wrap-anywhere">
          {label ?? <Missing />}
          {extended && <span data-extended> · extended</span>}
        </div>
        <span role="status" className="sr-only">
          {copyStatus}
        </span>
      </header>
      {finding && (
        <form
          data-raw-find
          onSubmit={(event) => {
            event.preventDefault();
            if (matches.length)
              setMatch(matches[(matches.indexOf(hit ?? -1) + 1) % matches.length]);
          }}
        >
          <input
            ref={findInput}
            aria-label="Find in Raw"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setMatch(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setFinding(false);
                setQuery("");
                setMatch(undefined);
                header.current?.focus();
              }
            }}
          />
          <span role="status" className="type-data-small">
            {query &&
              (matches.length
                ? `${matches.indexOf(hit ?? -1) + 1}/${matches.length}`
                : "No matches")}
          </span>
          <button data-button type="submit">
            Next
          </button>
        </form>
      )}
      <section ref={setBody} data-raw-body aria-label="Raw source">
        {lines.length > 50 && body ? (
          <Virtuoso
            ref={virtualRaw}
            customScrollParent={body}
            data={lines}
            itemContent={(index, line) => rawLine(line, index)}
          />
        ) : (
          <div>
            {text === undefined ? (
              <Missing />
            ) : (
              lines.map((line, index) =>
                // biome-ignore lint/suspicious/noArrayIndexKey: A line's position is its identity in this static source excerpt.
                cloneElement(rawLine(line, index), { key: index }),
              )
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Evidence({ value, source }: { value: unknown; source?: SourceRef }) {
  if (value === undefined) return <Missing />;
  return (
    <div data-detail-evidence>
      <span className="type-data wrap-anywhere">{formatValue(value)}</span>
      {source && <SourceChip source={source} />}
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="type-micro text-text-secondary">{label}</h3>
      {children}
    </section>
  );
}

function Screenshot({ row }: { row: StepRow }) {
  const path = row.screenshot?.value;
  const full = useScreenshotAsset(path, true);
  const thumb = useScreenshotAsset(path);
  if (!path) return <Missing />;
  const image = full.kind === "ready" ? full : thumb.kind === "ready" ? thumb : undefined;
  return (
    <>
      {image ? (
        <Dialog.Root>
          <Dialog.Trigger data-screenshot-trigger aria-label="Enlarge screenshot">
            <img
              src={image.url}
              alt="Step screenshot"
              data-image-size={full.kind === "ready" ? "full" : "preview"}
            />
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop data-screenshot-backdrop />
            <Dialog.Popup data-screenshot-lightbox>
              <Dialog.Title className="sr-only">Step screenshot</Dialog.Title>
              <Dialog.Close data-button>Close</Dialog.Close>
              <img
                src={image.url}
                alt={
                  full.kind === "ready"
                    ? "Step screenshot at original size"
                    : "Step screenshot preview"
                }
              />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : (
        <p role="status" className="text-text-tertiary">
          {full.kind === "unavailable" && thumb.kind === "unavailable"
            ? "Screenshot unavailable"
            : "Loading screenshot"}
        </p>
      )}
      {row.screenshot && <SourceChip source={row.screenshot.source} />}
    </>
  );
}

function Guards({ row, phase }: { row: StepRow; phase: "pre" | "post" }) {
  const guards = row.guards.filter(({ value }) => value.phase === phase);
  if (!guards.length) return <Missing />;
  return guards.map(({ value, source }) => (
    <div key={sourceLabel(source)} data-detail-event>
      {value.results.length ? (
        value.results.map((guard, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Predicate order is part of the recorded evaluation.
          <dl key={index}>
            {Object.entries(guard).map(([key, entry]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  <Evidence value={entry} source={source} />
                </dd>
              </div>
            ))}
          </dl>
        ))
      ) : (
        <Evidence value={value.results} source={source} />
      )}
    </div>
  ));
}

function Detail({
  row,
  run,
  digits,
  check,
}: {
  row?: StepRow;
  run: OpenedRun;
  digits: number;
  check?: number;
}) {
  const result = run.data.result;
  const scored = result?.recordKind !== "session";
  const checks = scored ? result?.verdict.checks : result.checks;
  const checkValue = check === undefined ? undefined : checks?.[check];
  if (checkValue) {
    const path = (scored ? "/verdict/checks/" : "/checks/") + check;
    return (
      <DetailSection label="Check">
        <dl>
          {Object.entries(checkValue).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <Evidence value={value} source={{ file: "result.json", path: `${path}/${key}` }} />
              </dd>
            </div>
          ))}
        </dl>
      </DetailSection>
    );
  }
  const extendedEvents = run.data.events.filter(({ kind }) => kind === "extended");
  if (!row)
    return (
      <DetailSection label="Run summary">
        <Evidence value={run.data.result?.runId} source={{ file: "result.json", path: "/runId" }} />
        <Evidence
          value={run.data.result?.taskId}
          source={{ file: "result.json", path: "/taskId" }}
        />
        {run.data.result && (
          <div>
            Steps{" "}
            <Evidence
              value={run.data.result.steps.length}
              source={{ file: "result.json", path: "/steps" }}
            />
          </div>
        )}
        {extendedEvents.slice(0, 20).map(({ event, source }) => (
          <div key={sourceLabel(source)}>
            Extended event <span className="type-data">{event.type}</span>{" "}
            <SourceChip source={source} />
          </div>
        ))}
        {extendedEvents.length > 20 && (
          <div>+{extendedEvents.length - 20} more extended events</div>
        )}
      </DetailSection>
    );

  const evidence = (field: keyof StepRow["record"]) => (
    <Evidence
      value={row.record[field]}
      source={{ file: "result.json", path: `${row.path}/${field}` }}
    />
  );
  const extra = row.events.filter(
    ({ event }) =>
      !["action", "observation", "guard-evaluation", "decision", "external-effect"].includes(
        event.type,
      ),
  );
  const decisions = row.events.filter(({ event }) => event.type === "decision");
  const effects = row.events.filter(({ event }) => event.type === "external-effect");
  const diff = run.data.artifactPaths.find(
    (path) =>
      path === "artifacts/state-diff.json" || path === `artifacts/state-diff-${row.step}.json`,
  );
  const events = (entries: StepRow["events"]) =>
    entries.length ? (
      entries.map(({ event, source }) => (
        <Evidence key={sourceLabel(source)} value={event} source={source} />
      ))
    ) : (
      <Missing />
    );

  return (
    <>
      <div data-detail-heading>
        <h2 className="type-data-strong">{stepLabel(row.step, digits)}</h2>
        <SourceChip source={{ file: "result.json", path: `${row.path}/step` }} />
      </div>
      <DetailSection label="Screenshot">
        <Screenshot row={row} />
      </DetailSection>
      <DetailSection label="Observed state">
        <dl>
          <div>
            <dt>State version before</dt>
            <dd>{evidence("stateVersionBefore")}</dd>
          </div>
          <div>
            <dt>State version after</dt>
            <dd>{evidence("stateVersionAfter")}</dd>
          </div>
        </dl>
        {row.observations.length ? (
          row.observations.map(({ value, source }) => (
            <dl key={sourceLabel(source)}>
              <div>
                <dt>Observed state version</dt>
                <dd>
                  <Evidence value={value.stateVersion} source={source} />
                </dd>
              </div>
              <div>
                <dt>Node count</dt>
                <dd>
                  <Evidence value={value.nodeCount} source={source} />
                </dd>
              </div>
              <div>
                <dt>Focused element</dt>
                <dd>
                  <Evidence
                    value={"focusedElement" in value ? value.focusedElement : undefined}
                    source={source}
                  />
                </dd>
              </div>
            </dl>
          ))
        ) : (
          <Missing />
        )}
      </DetailSection>
      <DetailSection label="Decision">{events(decisions)}</DetailSection>
      <DetailSection label="Preconditions">
        <Guards row={row} phase="pre" />
      </DetailSection>
      <DetailSection label="Action">
        {row.actions.length ? (
          row.actions.map(({ value, source }) => (
            <dl key={sourceLabel(source)}>
              {Object.entries(value.action).map(([key, entry]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>
                    <Evidence value={entry} source={source} />
                  </dd>
                </div>
              ))}
            </dl>
          ))
        ) : (
          <Missing />
        )}
      </DetailSection>
      <DetailSection label="Postconditions">
        <Guards row={row} phase="post" />
      </DetailSection>
      <DetailSection label="Effects">{events(effects)}</DetailSection>
      <DetailSection label="State diff">
        {diff ? <SourceChip source={{ file: diff, path: "" }} /> : <Missing />}
      </DetailSection>
      {extra.length > 0 && <DetailSection label="Other events">{events(extra)}</DetailSection>}
    </>
  );
}

const inspectorBounds = tokens.layout.inspectorBounds;
const widthKey = "myco-inspector-width";

function savedWidth() {
  try {
    const stored = localStorage.getItem(widthKey);
    return stored ? clampWidth(Number(stored)) : undefined;
  } catch {
    return undefined;
  }
}

function clampWidth(width: number) {
  return Number.isFinite(width)
    ? Math.max(inspectorBounds.min, Math.min(inspectorBounds.max, width))
    : tokens.layout.inspector;
}

export function Inspector({
  run,
  row,
  digits,
  narrow,
}: {
  run: OpenedRun;
  row?: StepRow;
  digits: number;
  narrow: boolean;
}) {
  const source = useViewer((state) => state.selection.source);
  const tab = useViewer((state) => state.inspectorTab);
  const check = useViewer((state) => state.selection.check);
  const detailTab = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus on source navigation only, not ordinary tab changes.
  useLayoutEffect(() => {
    if (source && tab === "detail") detailTab.current?.focus({ preventScroll: true });
  }, [source]);
  const [width, setWidth] = useState(savedWidth);
  const drag = useRef<{ x: number; width: number }>(null);
  const slot = useRef<HTMLDivElement>(null);

  function resize(next: number) {
    const width = clampWidth(next);
    setWidth(width);
    try {
      localStorage.setItem(widthKey, String(width));
    } catch {
      // The in-memory size still works when storage is unavailable.
    }
  }

  return (
    <div
      ref={slot}
      data-inspector-slot
      data-region="inspector"
      tabIndex={-1}
      data-overlay={narrow || undefined}
      style={{ width }}
    >
      <input
        type="range"
        data-resize
        data-inspector-resize
        aria-label="Inspector width"
        min={inspectorBounds.min}
        max={inspectorBounds.max}
        value={width ?? tokens.layout.inspector}
        onChange={(event) => resize(event.currentTarget.valueAsNumber)}
        onPointerDown={(event) => {
          if (event.button !== 0 || !slot.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width: slot.current.offsetWidth };
        }}
        onPointerMove={(event) => {
          if (drag.current) resize(drag.current.width + drag.current.x - event.clientX);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
      <aside aria-label="Inspector">
        <Tabs.Root
          data-inspector
          value={tab}
          onValueChange={(value) => useViewer.setState({ inspectorTab: value as InspectorTab })}
        >
          <header data-inspector-tabs>
            <Tabs.List aria-label="Inspector view" data-modes activateOnFocus>
              <Tabs.Tab
                ref={detailTab}
                data-button
                value="detail"
                data-focus-key="inspector-detail"
              >
                Detail
              </Tabs.Tab>
              <Tabs.Tab
                data-button
                value="raw"
                aria-keyshortcuts="R"
                data-focus-key="inspector-raw"
              >
                Raw
              </Tabs.Tab>
            </Tabs.List>
            <button
              type="button"
              data-button
              aria-label="Close Inspector"
              title="Close Inspector (Mod+D)"
              onClick={() => {
                useViewer.setState({ inspectorOpen: false });
                (
                  document.querySelector<HTMLElement>("[data-step-options]") ??
                  document.querySelector<HTMLElement>(
                    '[data-comparison][tabindex="0"], [data-center]',
                  )
                )?.focus();
              }}
            >
              <PanelRightClose aria-hidden="true" />
            </button>
          </header>
          <Tabs.Panel value="detail" data-detail tabIndex={0}>
            <Detail row={row} run={run} digits={digits} check={check} />
          </Tabs.Panel>
          <Tabs.Panel value="raw" data-raw-tab tabIndex={-1}>
            <Raw run={run} source={source} row={row} />
          </Tabs.Panel>
        </Tabs.Root>
      </aside>
    </div>
  );
}
