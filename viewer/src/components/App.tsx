import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import { PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseHeadToHead } from "../data/head-to-head.ts";
import { joinSteps } from "../data/steps.ts";
import { droppedFiles, selectionName } from "../open-files.ts";
import { type Mode, useActiveRun, useViewer } from "../store.ts";
import { CompareApp } from "./HeadToHead.tsx";
import { Inspector } from "./Inspector.tsx";
import { OpenPicker, OpenScreen } from "./OpenScreen.tsx";
import { Proof } from "./Proof.tsx";
import { layoutNumber, RunsSidebar } from "./RunsSidebar.tsx";
import { Screenshots } from "./Screenshots.tsx";
import { Scrubber } from "./Scrubber.tsx";
import { SourceChip } from "./SourceRef.tsx";
import { StepList } from "./StepList.tsx";
import { VerdictBar } from "./VerdictBar.tsx";

const shortcuts = [
  ["Mod+O", "Open a run"],
  ["Mod+B", "Toggle Runs sidebar"],
  ["Mod+D", "Toggle source Inspector"],
  ["F6 / Shift+F6", "Next / previous region"],
  ["2 / 3", "Why / Proof"],
  ["↑ / ↓", "Move through steps, runs, or comparisons"],
  ["J / K", "Next / previous step"],
  ["[ / ]", "Previous / next flagged step"],
  ["← / →", "Move playhead by one step (Shift: ten)"],
  ["+ / −", "Zoom the timeline"],
  ["Shift+drag", "Draw a timeline range"],
  ["R", "Toggle Inspector Detail / Raw"],
  ["Home / End", "First / last step or run"],
  ["Enter", "Open the focused run, step, or persisted source"],
  ["Delete", "Remove the focused run from the sidebar"],
  ["Mod+1…9", "Jump to a run"],
  ["Mod+Shift+[ / ]", "Previous / next run"],
  ["Esc", "Close an overlay or clear selection"],
  ["Mod+F", "Find in steps or Raw"],
  ["?", "Show shortcuts"],
];

function useNarrowViewport() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const update = () => setNarrow(innerWidth < layoutNumber("--layout-min-viewport-width"));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return narrow;
}

function focusMode(mode: Mode) {
  const selector = mode === "why" ? "[data-step-options]" : '[data-comparison][tabindex="0"]';
  (
    document.querySelector<HTMLElement>(selector) ??
    document.querySelector<HTMLElement>('[data-verdict-bar] [aria-selected="true"]')
  )?.focus({ preventScroll: true });
}

function focusRegion(name: string, lastFocus: Map<string, HTMLElement>) {
  const region = document.querySelector<HTMLElement>(`[data-region="${name}"]`);
  if (!region) return;
  const previous = lastFocus.get(name);
  const key = previous?.dataset.focusKey ?? previous?.getAttribute("aria-label");
  const replacement =
    key &&
    [...region.querySelectorAll<HTMLElement>("[data-focus-key], [aria-label]")].find(
      (element) =>
        (element.dataset.focusKey ?? element.getAttribute("aria-label")) === key &&
        element.getClientRects().length,
    );
  const target =
    (previous && region.contains(previous) && previous.getClientRects().length
      ? previous
      : undefined) ||
    replacement ||
    [
      ...region.querySelectorAll<HTMLElement>(
        '[data-inspector-tabs] [aria-selected="true"], [data-step-options], [data-comparison][tabindex="0"]',
      ),
    ].find((element) => element.getClientRects().length) ||
    [...region.querySelectorAll<HTMLElement>('[tabindex="0"], button:not([disabled])')].find(
      (element) => element.tabIndex >= 0 && element.getClientRects().length,
    ) ||
    region;
  target.focus({ preventScroll: true });
  return target;
}

export function App() {
  const run = useActiveRun();
  const mode = useViewer((state) => state.mode);
  const setMode = useViewer((state) => state.setMode);
  const source = useViewer((state) => state.selection.source);
  const inspector = useViewer((state) => state.inspectorOpen);
  const data = run?.data;
  const { result, events, screenshots } = data ?? {};
  const step = useViewer((state) => state.selection.step);
  const { rows, index, flagged } = useMemo(() => {
    const joined = events
      ? joinSteps({ result, events, screenshots })
      : { rows: [], index: new Map<number, number>() };
    return {
      ...joined,
      flagged: joined.rows.flatMap((row, index) => (row.markers.length ? [index] : [])),
    };
  }, [result, events, screenshots]);
  const digits = Math.max(2, String(rows.at(-1)?.step ?? 0).length);
  const sidebar = useViewer((state) => state.sidebarOpen);
  const narrow = useNarrowViewport();
  const showSidebar = sidebar ?? !narrow;
  const [center, setCenter] = useState<HTMLElement | null>(null);
  const [picker, setPicker] = useState(false);
  const [help, setHelp] = useState(false);
  const [mod, setMod] = useState(false);
  const [drag, setDrag] = useState(false);
  const dragDepth = useRef(0);
  const [dropError, setDropError] = useState<string>();
  const [compareError, setCompareError] = useState<string>();
  const compareInput = useRef<HTMLInputElement>(null);
  const comparison = useViewer((state) => state.comparison);
  useEffect(() => {
    const url = new URLSearchParams(location.search).get("compare");
    if (!url) return;
    let cancelled = false;
    void fetch(url)
      .then((response) => response.json())
      .then((value: unknown) => {
        const report = parseHeadToHead(value);
        if (!cancelled && report) useViewer.getState().openComparison(url, report);
      })
      .catch(() => {
        if (!cancelled) setCompareError("That report could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const openTrigger = useRef<HTMLButtonElement>(null);
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef(new Map<string, HTMLElement>());
  const panelFallback = useRef<{ panel: string; element: HTMLElement }>(null);
  const restorePanel = useRef<string>(null);

  const focusAfterModeChange = useRef<Mode>(null);
  useLayoutEffect(() => {
    if (focusAfterModeChange.current !== mode) return;
    focusAfterModeChange.current = null;
    focusMode(mode);
  }, [mode]);

  useLayoutEffect(() => {
    const reopened = restorePanel.current === "runs" ? showSidebar : inspector;
    if (!reopened || !restorePanel.current) return;
    focusRegion(restorePanel.current, lastFocus.current);
    restorePanel.current = null;
  }, [showSidebar, inspector]);

  useEffect(() => {
    function trackFocus(event: FocusEvent) {
      if (!(event.target instanceof HTMLElement)) return;
      const region = event.target.closest<HTMLElement>("[data-region]")?.dataset.region;
      if (region) lastFocus.current.set(region, event.target);
    }
    function cycleRegion(backwards: boolean) {
      const regions = [...document.querySelectorAll<HTMLElement>("[data-region]")];
      const current = regions.findIndex((region) => region.contains(document.activeElement));
      const index =
        current < 0
          ? backwards
            ? regions.length - 1
            : 0
          : (current + (backwards ? -1 : 1) + regions.length) % regions.length;
      const region = regions[index]?.dataset.region;
      if (region) focusRegion(region, lastFocus.current);
    }
    function togglePanel(panel: "runs" | "inspector", open: boolean) {
      const active = document.activeElement;
      if (open && active?.closest("[data-region]")?.getAttribute("data-region") === panel) {
        const fallback = focusRegion(panel === "runs" ? "verdict" : "center", lastFocus.current);
        if (fallback) panelFallback.current = { panel, element: fallback };
      } else if (!open && panelFallback.current?.panel === panel) {
        if (active === panelFallback.current.element) restorePanel.current = panel;
        panelFallback.current = null;
      }
      useViewer.setState(panel === "runs" ? { sidebarOpen: !open } : { inspectorOpen: !open });
    }
    function keys(event: KeyboardEvent) {
      setMod(event.metaKey || event.ctrlKey);
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      )
        return;
      const state = useViewer.getState();
      const modified = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const editable =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          event.target.matches("input:not([type=range]), textarea, select"));
      if (modified && key === "o") {
        event.preventDefault();
        setDropError(undefined);
        openTrigger.current?.focus();
        setPicker(true);
      } else if (modified && key === "b") {
        event.preventDefault();
        togglePanel("runs", showSidebar);
      } else if (modified && key === "d" && state.selection.run) {
        event.preventDefault();
        togglePanel("inspector", state.inspectorOpen);
      } else if (event.key === "F6") {
        event.preventDefault();
        cycleRegion(event.shiftKey);
      } else if (modified && !event.shiftKey && /^[1-9]$/.test(key)) {
        const target = state.runs[Number(key) - 1];
        if (target) {
          event.preventDefault();
          state.activate(target);
        }
      } else if (
        modified &&
        event.shiftKey &&
        ["BracketLeft", "BracketRight"].includes(event.code)
      ) {
        const index = state.runs.findIndex(({ key }) => key === state.selection.run);
        const target = state.runs[index + (event.code === "BracketLeft" ? -1 : 1)];
        if (target) {
          event.preventDefault();
          state.activate(target);
        }
      } else if (
        !modified &&
        !event.altKey &&
        !editable &&
        !help &&
        !picker &&
        state.selection.run &&
        (key === "2" || key === "3")
      ) {
        event.preventDefault();
        const nextMode = key === "2" ? "why" : "proof";
        if (state.mode === nextMode) focusMode(nextMode);
        else {
          focusAfterModeChange.current = nextMode;
          state.setMode(nextMode);
        }
      } else if (
        !modified &&
        !event.altKey &&
        !editable &&
        !help &&
        !picker &&
        state.selection.run
      ) {
        const inList =
          event.target instanceof HTMLElement && event.target.matches("[data-step-options]");
        const arrowMovesStep = !(event.target instanceof HTMLInputElement);
        const current =
          state.selection.step === undefined ? undefined : index.get(state.selection.step);
        let next: number | undefined;
        if (key === "j" || (arrowMovesStep && key === "arrowdown")) next = (current ?? -1) + 1;
        if (key === "k" || (arrowMovesStep && key === "arrowup"))
          next = current === undefined ? 0 : current - 1;
        if (inList && key === "home") next = 0;
        if (inList && key === "end") next = rows.length - 1;
        if (key === "[") next = flagged.findLast((position) => position < (current ?? rows.length));
        if (key === "]") next = flagged.find((position) => position > (current ?? -1));
        if (next !== undefined && rows.length) {
          event.preventDefault();
          state.selectStep(rows[Math.min(rows.length - 1, Math.max(0, next))]!.step);
        } else if (inList && key === "enter" && rows.length) {
          event.preventDefault();
          if (current === undefined) state.selectStep(rows[0]!.step);
          useViewer.setState({ inspectorOpen: true });
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>("[data-inspector-tabs] [aria-selected='true']")
              ?.focus(),
          );
        } else if (key === "r") {
          event.preventDefault();
          useViewer.setState({
            mode: state.selection.source ? state.mode : "why",
            inspectorOpen: true,
            inspectorTab: state.inspectorTab === "raw" ? "detail" : "raw",
          });
        }
      }
      if (!modified && !editable && key === "?") {
        helpTrigger.current?.focus();
        setHelp((open) => !open);
      } else if (
        event.key === "Escape" &&
        !help &&
        !picker &&
        !document.activeElement?.closest('[role="menu"]')
      ) {
        if (narrow && state.inspectorOpen && (state.mode === "why" || state.selection.source))
          togglePanel("inspector", true);
        else state.select({ run: state.selection.run });
      }
    }
    function modifiers(event: KeyboardEvent) {
      setMod(event.metaKey || event.ctrlKey);
    }
    function blur() {
      setMod(false);
    }
    document.addEventListener("focusin", trackFocus);
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", modifiers);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("focusin", trackFocus);
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", modifiers);
      window.removeEventListener("blur", blur);
    };
  }, [help, narrow, picker, showSidebar, index, rows, flagged]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The shared center resets on run or mode changes.
  useEffect(() => {
    center?.scrollTo(0, 0);
  }, [center, mode, run?.key]);

  const parseError = run?.data.parseErrors[0];
  const error = compareError ?? dropError ?? run?.error;
  if (comparison) return <CompareApp />;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The window-wide drop zone has an equivalent keyboard picker.
    <div
      data-app
      data-dragging={drag || undefined}
      onChangeCapture={(event) => {
        if (event.target instanceof HTMLInputElement && event.target.type === "file") {
          setDropError(undefined);
        }
      }}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          dragDepth.current++;
          setDrag(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDrag(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDrag(false);
        setDropError(undefined);
        void droppedFiles(event.dataTransfer)
          .then((files) => {
            if (files.length) void useViewer.getState().open(selectionName(files), files);
          })
          .catch((error) => setDropError(String(error)));
      }}
    >
      <header data-app-bar>
        {run && (
          <button
            type="button"
            data-button
            aria-label="Toggle Runs sidebar"
            title="Toggle Runs sidebar (Mod+B)"
            aria-pressed={showSidebar}
            onClick={() => useViewer.setState({ sidebarOpen: !showSidebar })}
          >
            <PanelLeft aria-hidden="true" />
          </button>
        )}
        <span className="type-body-strong">myco</span>
        {run && (
          <span className="type-data truncate text-text-secondary" title={run.name}>
            {run.name}
          </span>
        )}
        <div className="grow" />
        {run && (mode === "why" || source) && (
          <button
            type="button"
            data-button
            aria-label="Toggle Inspector"
            title="Toggle Inspector (Mod+D)"
            aria-pressed={inspector}
            onClick={() => useViewer.setState({ inspectorOpen: !inspector })}
          >
            <PanelRight aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          data-button
          onClick={() => compareInput.current?.click()}
          title="Open a head-to-head report"
        >
          Compare
        </button>
        <input
          ref={compareInput}
          hidden
          type="file"
          accept=".json"
          aria-label="Head-to-head report"
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            try {
              const parsed = parseHeadToHead(JSON.parse(await file.text()));
              if (!parsed) {
                setCompareError("That file is not a head-to-head report.");
                return;
              }
              setCompareError(undefined);
              useViewer.getState().openComparison(file.name, parsed);
            } catch {
              setCompareError("That file could not be read as JSON.");
            }
          }}
        />
        <OpenPicker trigger={openTrigger} open={picker} setOpen={setPicker}>
          Open
        </OpenPicker>
        <Popover.Root open={help} onOpenChange={setHelp}>
          <Popover.Trigger
            ref={helpTrigger}
            data-button
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ?
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end">
              <Popover.Popup data-popup className="p-3">
                <Popover.Title className="type-title mb-2">Keyboard shortcuts</Popover.Title>
                <dl data-shortcuts>
                  {shortcuts.map(([key, action]) => (
                    <div key={key}>
                      <dt className="type-data-small">{key}</dt>
                      <dd>{action}</dd>
                    </div>
                  ))}
                </dl>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </header>
      <div data-workspace>
        {run && showSidebar && <RunsSidebar mod={mod} />}
        <Screenshots files={run?.files}>
          <Tabs.Root
            data-run-view
            data-indexed={run && !run.loading && !run.error ? "true" : undefined}
            value={mode}
            onValueChange={(value) => setMode(value as Mode)}
          >
            {run && <VerdictBar run={run} />}
            <div data-run-body>
              <main
                ref={setCenter}
                data-center
                data-region="center"
                aria-label={run ? "Run evidence" : "Open a run"}
                tabIndex={-1}
              >
                {(error || parseError) && (
                  <section role="alert" className="p-3">
                    <h1 className="type-title">Can't read this run</h1>
                    {error && <p className="type-data wrap-anywhere">{error}</p>}
                    {parseError && (
                      <>
                        <p>Incomplete evidence in {parseError.source.file}</p>
                        {parseError.issues.map(({ path, keyword, message }) => (
                          <p
                            key={JSON.stringify([path, keyword, message])}
                            className="type-data wrap-anywhere"
                          >
                            {path} · {keyword} · {message}
                          </p>
                        ))}
                        <SourceChip source={parseError.source} />
                      </>
                    )}
                    <OpenPicker>Open another…</OpenPicker>
                  </section>
                )}
                {!run && !error && <OpenScreen />}
                {run && (!run.error || run.data.result) && (
                  <>
                    <Tabs.Panel value="proof" keepMounted tabIndex={-1} data-proof-panel>
                      <Proof
                        key={run.key}
                        center={center}
                        data={run.data}
                        loading={!run.verdict && run.loading}
                      />
                    </Tabs.Panel>
                    <Tabs.Panel value="why" tabIndex={-1} data-why-panel>
                      <StepList key={run.opened} rows={rows} index={index} digits={digits} />
                    </Tabs.Panel>
                  </>
                )}
              </main>
              {run && inspector && (mode === "why" || source) && (
                <Inspector
                  run={run}
                  row={step === undefined ? undefined : rows[index.get(step) ?? -1]}
                  digits={digits}
                  narrow={narrow}
                />
              )}
            </div>
            {run && <Scrubber key={run.opened} rows={rows} index={index} digits={digits} />}
          </Tabs.Root>
        </Screenshots>
      </div>
    </div>
  );
}
